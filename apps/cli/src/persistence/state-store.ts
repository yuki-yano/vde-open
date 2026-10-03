import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { canonicalJson, LIMITS, STATE_FORMAT_VERSION, VdeError } from '@vde-open/shared';

import {
  emptyStatePayload,
  findIntegrityProblem,
  referencedBlobs,
  stateFileSchema,
  type StatePayload,
} from './state-schema.ts';
import type { StoreFs } from './store-fs.ts';

const STATE_FILE = 'state.json';
const PREVIOUS_FILE = 'state.prev.json';
const BLOB_DIR = 'blobs';
const TEMP_PREFIX = '.tmp-';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface Transaction {
  // The next state. Mutate this copy. The current state does not change until the commit succeeds.
  readonly state: StatePayload;
  putBlob(bytes: Uint8Array): string;
}

export interface StateStoreOptions {
  root: string;
  fs: StoreFs;
  // Upper limit on the total stored content. Defaults to the value in spec 7.4.
  blobStoreBytes?: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checksumOf(storeVersion: number, payload: StatePayload): string {
  return sha256(canonicalJson({ formatVersion: STATE_FORMAT_VERSION, storeVersion, payload }));
}

function encodeStateFile(storeVersion: number, payload: StatePayload): Buffer {
  const file = {
    formatVersion: STATE_FORMAT_VERSION,
    storeVersion,
    checksum: checksumOf(storeVersion, payload),
    payload,
  };
  return Buffer.from(`${JSON.stringify(file)}\n`, 'utf8');
}

export interface DecodedState {
  storeVersion: number;
  payload: StatePayload;
}

// Validate and read the state file. Distinguish corruption from an unknown version, and never silently fall back to an empty state for either.
export function decodeStateFile(bytes: Buffer, fileName: string): DecodedState {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new VdeError(
      'E_STATE_CORRUPT',
      `${fileName} cannot be parsed as JSON.`,
      { file: fileName },
      { cause: error },
    );
  }
  const formatVersion = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof formatVersion === 'number' && formatVersion !== STATE_FORMAT_VERSION) {
    throw new VdeError(
      'E_STATE_FORMAT_UNSUPPORTED',
      `${fileName} has formatVersion ${String(formatVersion)}, which this version cannot handle.`,
      { file: fileName, formatVersion, supported: STATE_FORMAT_VERSION },
    );
  }
  const parsed = stateFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new VdeError('E_STATE_CORRUPT', `${fileName} has an invalid structure.`, {
      file: fileName,
    });
  }
  const { storeVersion, checksum, payload } = parsed.data;
  if (checksum !== checksumOf(storeVersion, payload)) {
    throw new VdeError('E_STATE_CORRUPT', `${fileName} has a checksum mismatch.`, {
      file: fileName,
    });
  }
  const problem = findIntegrityProblem(payload);
  if (problem) {
    throw new VdeError('E_STATE_CORRUPT', `${fileName} has inconsistent references.`, {
      file: fileName,
      problem,
    });
  }
  return { storeVersion, payload };
}

export class StateStore {
  readonly root: string;
  readonly #fs: StoreFs;
  readonly #blobStoreBytes: number;
  #payload: StatePayload;
  #storeVersion: number;
  #persisted: boolean;
  #blobSizes: Map<string, number>;
  #queue: Promise<unknown> = Promise.resolve();
  #fatal: VdeError | null = null;
  #closed = false;
  readonly #fatalListeners = new Set<(error: VdeError) => void>();

  private constructor(
    options: StateStoreOptions,
    decoded: DecodedState | null,
    blobSizes: Map<string, number>,
  ) {
    this.root = options.root;
    this.#fs = options.fs;
    this.#blobStoreBytes = options.blobStoreBytes ?? LIMITS.blobStoreBytes;
    this.#payload = decoded?.payload ?? emptyStatePayload();
    this.#storeVersion = decoded?.storeVersion ?? 0;
    this.#persisted = decoded !== null;
    this.#blobSizes = blobSizes;
  }

  static async open(options: StateStoreOptions): Promise<StateStore> {
    const { root, fs } = options;
    await fs.mkdir(root, DIRECTORY_MODE);
    await fs.mkdir(join(root, BLOB_DIR), DIRECTORY_MODE);

    const current = await fs.readFile(join(root, STATE_FILE));
    let decoded: DecodedState | null = null;
    if (current) {
      decoded = decodeStateFile(current, STATE_FILE);
    } else if ((await fs.size(join(root, PREVIOUS_FILE))) !== null) {
      // Only state.json is missing. Do not roll back on our own; leave it to an explicit repair in doctor.
      throw new VdeError(
        'E_STATE_CORRUPT',
        `${STATE_FILE} is missing and only ${PREVIOUS_FILE} remains.`,
        { file: STATE_FILE },
      );
    }

    // Clean up temporary files from interrupted commits. Committed files are untouched.
    for (const name of await fs.list(root)) {
      if (name.startsWith(TEMP_PREFIX)) await fs.remove(join(root, name));
    }
    const blobSizes = new Map<string, number>();
    for (const name of await fs.list(join(root, BLOB_DIR))) {
      const path = join(root, BLOB_DIR, name);
      if (name.startsWith(TEMP_PREFIX)) {
        await fs.remove(path);
        continue;
      }
      const size = await fs.size(path);
      if (size !== null) blobSizes.set(name, size);
    }
    if (decoded) {
      for (const blob of referencedBlobs(decoded.payload)) {
        if (!blobSizes.has(blob)) {
          throw new VdeError('E_STATE_CORRUPT', 'A blob referenced by the state is missing.', {
            file: STATE_FILE,
            blob,
          });
        }
      }
    }
    return new StateStore(options, decoded, blobSizes);
  }

  get payload(): StatePayload {
    return this.#payload;
  }

  get storeVersion(): number {
    return this.#storeVersion;
  }

  get fatalError(): VdeError | null {
    return this.#fatal;
  }

  onFatal(listener: (error: VdeError) => void): void {
    this.#fatalListeners.add(listener);
  }

  // Every state change goes through here and is committed one at a time (spec 7.2).
  transaction<T>(mutate: (tx: Transaction) => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(() => this.#run(mutate));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async readBlob(blob: string): Promise<Buffer> {
    const bytes = await this.#fs.readFile(join(this.root, BLOB_DIR, blob));
    if (!bytes) throw new VdeError('E_IO', 'The stored content cannot be read.', { blob });
    return bytes;
  }

  // Stop accepting new changes and wait for the in-progress commit to finish.
  // The daemon releases the lock only after this finishes.
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
  }

  #assertWritable(): void {
    if (this.#fatal) {
      throw new VdeError('E_DAEMON_STOPPING', 'The daemon has stopped writing.', {
        cause: this.#fatal.code,
      });
    }
    if (this.#closed) throw new VdeError('E_DAEMON_STOPPING', 'The daemon is stopping.');
  }

  // Delete blobs referenced by neither the current state nor the previous one.
  async collectGarbage(): Promise<number> {
    return this.transactionless(async () => {
      // When the save outcome cannot be guaranteed, do not delete blobs based on the in-memory state.
      this.#assertWritable();
      const keep = referencedBlobs(this.#payload);
      const previous = await this.#fs.readFile(join(this.root, PREVIOUS_FILE));
      if (previous) {
        try {
          for (const blob of referencedBlobs(decodeStateFile(previous, PREVIOUS_FILE).payload)) {
            keep.add(blob);
          }
        } catch {
          // If the previous state cannot be read, we cannot tell what is needed, so delete nothing.
          return 0;
        }
      }
      let removed = 0;
      for (const blob of this.#blobSizes.keys()) {
        if (keep.has(blob)) continue;
        await this.#fs.remove(join(this.root, BLOB_DIR, blob));
        this.#blobSizes.delete(blob);
        removed += 1;
      }
      return removed;
    });
  }

  private transactionless<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #run<T>(mutate: (tx: Transaction) => T | Promise<T>): Promise<T> {
    this.#assertWritable();
    const draft = structuredClone(this.#payload);
    const pendingBlobs = new Map<string, Uint8Array>();
    const result = await mutate({
      state: draft,
      putBlob: (bytes) => {
        const blob = sha256(bytes);
        if (!this.#blobSizes.has(blob)) pendingBlobs.set(blob, bytes);
        return blob;
      },
    });

    if (canonicalJson(draft) === canonicalJson(this.#payload)) return result;
    await this.#commit(draft, pendingBlobs);
    return result;
  }

  async #commit(next: StatePayload, pendingBlobs: Map<string, Uint8Array>): Promise<void> {
    // Step 1: validate the next state's schema, references, and size.
    const problem = findIntegrityProblem(next);
    if (problem) throw new VdeError('E_INTERNAL', 'The next state is inconsistent.', { problem });
    const needed = referencedBlobs(next);
    let blobBytes = 0;
    for (const size of this.#blobSizes.values()) blobBytes += size;
    for (const [blob, bytes] of pendingBlobs) {
      if (needed.has(blob)) blobBytes += bytes.byteLength;
    }
    for (const blob of needed) {
      if (!this.#blobSizes.has(blob) && !pendingBlobs.has(blob)) {
        throw new VdeError('E_INTERNAL', 'The next state references an unsaved blob.', { blob });
      }
    }
    if (blobBytes > this.#blobStoreBytes) {
      throw new VdeError('E_LIMIT_EXCEEDED', 'The total stored content would exceed the limit.', {
        limit: 'blobStoreBytes',
        max: this.#blobStoreBytes,
        actual: blobBytes,
      });
    }
    const storeVersion = this.#storeVersion + 1;
    const encoded = encodeStateFile(storeVersion, next);
    if (encoded.byteLength > LIMITS.metadataStateBytes) {
      throw new VdeError('E_LIMIT_EXCEEDED', 'The state size would exceed the limit.', {
        limit: 'metadataStateBytes',
        max: LIMITS.metadataStateBytes,
        actual: encoded.byteLength,
      });
    }

    const statePath = join(this.root, STATE_FILE);
    const writtenBlobs: Array<[string, number]> = [];
    try {
      // Step 2: write new blobs to temporary files, verify their contents, then rename.
      for (const [blob, bytes] of pendingBlobs) {
        if (!needed.has(blob)) continue;
        const temp = join(this.root, BLOB_DIR, `${TEMP_PREFIX}${blob}-${randomUUID()}`);
        await this.#fs.writeFileDurable(temp, bytes, FILE_MODE);
        const written = await this.#fs.readFile(temp);
        if (!written || sha256(written) !== blob) {
          await this.#fs.remove(temp);
          throw new Error(`Blob content does not match: ${blob}`);
        }
        await this.#fs.rename(temp, join(this.root, BLOB_DIR, blob));
        writtenBlobs.push([blob, bytes.byteLength]);
      }
      if (writtenBlobs.length > 0) await this.#fs.syncDirectory(join(this.root, BLOB_DIR));

      // Step 3: place the previous state at state.prev.json.
      if (this.#persisted) {
        const current = await this.#fs.readFile(statePath);
        if (!current) throw new Error(`${STATE_FILE} has disappeared.`);
        const tempPrevious = join(this.root, `${TEMP_PREFIX}prev-${randomUUID()}`);
        await this.#fs.writeFileDurable(tempPrevious, current, FILE_MODE);
        await this.#fs.rename(tempPrevious, join(this.root, PREVIOUS_FILE));
      }
    } catch (error) {
      // Leftover blobs can be collected by a later GC. state.json is unchanged.
      for (const [blob, size] of writtenBlobs) this.#blobSizes.set(blob, size);
      throw this.#writeFailure(error);
    }
    for (const [blob, size] of writtenBlobs) this.#blobSizes.set(blob, size);

    // Step 4: write the next state to a temporary file and atomically replace state.json.
    const tempState = join(this.root, `${TEMP_PREFIX}state-${randomUUID()}`);
    try {
      await this.#fs.writeFileDurable(tempState, encoded, FILE_MODE);
    } catch (error) {
      await this.#fs.remove(tempState).catch(() => undefined);
      throw this.#writeFailure(error);
    }
    try {
      await this.#fs.rename(tempState, statePath);
    } catch (error) {
      // Even if rename reports failure, read the file to decide whether the replace happened.
      const replaced = await this.#replaceHappened(statePath, encoded);
      if (replaced === false) {
        await this.#fs.remove(tempState).catch(() => undefined);
        throw this.#writeFailure(error);
      }
      throw this.#indeterminate(error);
    }

    // Step 5: sync the directory. From here on, a failure means the outcome cannot be guaranteed.
    try {
      await this.#fs.syncDirectory(this.root);
    } catch (error) {
      throw this.#indeterminate(error);
    }

    // Step 6: switch the in-memory state only after success.
    this.#payload = next;
    this.#storeVersion = storeVersion;
    this.#persisted = true;
  }

  async #replaceHappened(statePath: string, encoded: Buffer): Promise<boolean | null> {
    try {
      const onDisk = await this.#fs.readFile(statePath);
      if (!onDisk) return this.#persisted ? null : false;
      return onDisk.equals(encoded);
    } catch {
      return null;
    }
  }

  #writeFailure(error: unknown): VdeError {
    if (error instanceof VdeError) return error;
    return new VdeError(
      'E_STORAGE_WRITE_FAILED',
      'The state could not be saved. The change was not applied.',
      { reason: (error as NodeJS.ErrnoException).code ?? 'unknown' },
      { cause: error },
    );
  }

  // A failure after the replace. Do not commit memory to either the old or the new state; stop further writes (spec 7.2).
  #indeterminate(error: unknown): VdeError {
    const fatal = new VdeError(
      'E_COMMIT_INDETERMINATE',
      'The outcome of saving the state cannot be guaranteed. The daemon will exit. Please retry.',
      { reason: (error as NodeJS.ErrnoException).code ?? 'unknown' },
      { cause: error },
    );
    this.#fatal = fatal;
    for (const listener of this.#fatalListeners) listener(fatal);
    return fatal;
  }
}
