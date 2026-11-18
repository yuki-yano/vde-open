import type { DocumentService } from '../documents/service.ts';

// Per open document, a generation that advances whenever what a view shows changes: the current revision, or the
// effective script permission (granted, revoked, or granted again). Static -> Interactive -> Static advances it twice,
// so a key issued before never becomes valid again. Focus, reordering, and other documents never advance it.
// The value is `<openEpoch>.<generation>`: a close is told apart by openEpoch, a restart by the daemonId.
export interface ViewEpochs {
  // Compare every open document with what was last seen and advance the changed ones. Call on every document event.
  observe(): void;
  // The current value for an open document.
  of(documentId: string): string;
  readonly size: number;
}

interface Seen {
  openEpoch: number;
  revision: string;
  permission: number | null;
  generation: number;
}

export function createViewEpochs(
  documents: Pick<DocumentService, 'state' | 'openEpoch' | 'interactiveGeneration'>,
): ViewEpochs {
  const seen = new Map<string, Seen>();

  const current = (documentId: string) => {
    const record = documents.state.documents[documentId];
    return {
      openEpoch: documents.openEpoch(documentId),
      revision: record?.currentRevision ?? '',
      permission: documents.interactiveGeneration(documentId),
    };
  };

  const update = (documentId: string): Seen => {
    const now = current(documentId);
    const last = seen.get(documentId);
    let entry: Seen;
    if (last === undefined || last.openEpoch !== now.openEpoch) {
      entry = { ...now, generation: 0 };
    } else if (last.revision !== now.revision || last.permission !== now.permission) {
      entry = { ...now, generation: last.generation + 1 };
    } else {
      return last;
    }
    seen.set(documentId, entry);
    return entry;
  };

  return {
    get size() {
      return seen.size;
    },
    observe() {
      const open = new Set(documents.state.openOrder);
      // Closed documents need no history: a reopen has a new openEpoch.
      for (const documentId of seen.keys()) if (!open.has(documentId)) seen.delete(documentId);
      for (const documentId of open) update(documentId);
    },
    of(documentId) {
      const entry = update(documentId);
      return `${String(entry.openEpoch)}.${String(entry.generation)}`;
    },
  };
}
