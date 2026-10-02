import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';

// StateStoreが使うfile操作。障害注入のため、testではこのinterfaceを差し替える。
export interface StoreFs {
  mkdir(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<Buffer | null>;
  writeFileDurable(path: string, data: Uint8Array, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
  size(path: string): Promise<number | null>;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export const nodeStoreFs: StoreFs = {
  async mkdir(path, mode) {
    await mkdir(path, { recursive: true, mode });
  },

  async readFile(path) {
    try {
      return await readFile(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },

  async writeFileDurable(path, data, mode) {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      mode,
    );
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },

  async rename(from, to) {
    await rename(from, to);
  },

  async syncDirectory(path) {
    // Windowsはdirectoryをfsyncできない。対応する範囲でだけ行う（仕様7.2）。
    if (process.platform === 'win32') return;
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },

  async remove(path) {
    await rm(path, { force: true });
  },

  async list(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  },

  async size(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
};
