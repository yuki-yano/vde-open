import type { ServerEvent } from '@vde-open/shared';

export type EventListener = (event: ServerEvent) => void;

export interface EventHub {
  // Current sequence number. Used for the hello on connect.
  readonly sequence: number;
  publish(
    event: Pick<
      ServerEvent,
      'type' | 'documentId' | 'revision' | 'requestId' | 'status' | 'draftVersion' | 'acknowledged'
    >,
  ): ServerEvent;
  subscribe(listener: EventListener): () => void;
  readonly subscriberCount: number;
}

// Delivers update notifications. Only attaches a sequence number and passes them on; no storage or redelivery.
// Receivers resync state when they see a gap in the sequence or a change of daemonId (spec 6.5).
export function createEventHub(daemonId: string, catalogVersion: () => number): EventHub {
  const listeners = new Set<EventListener>();
  let sequence = 0;
  return {
    get sequence() {
      return sequence;
    },
    get subscriberCount() {
      return listeners.size;
    },
    publish(event) {
      sequence += 1;
      const full: ServerEvent = {
        type: event.type,
        daemonId,
        sequence,
        catalogVersion: catalogVersion(),
        ...(event.documentId === undefined ? {} : { documentId: event.documentId }),
        ...(event.revision === undefined ? {} : { revision: event.revision }),
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.draftVersion === undefined ? {} : { draftVersion: event.draftVersion }),
        ...(event.acknowledged === undefined ? {} : { acknowledged: event.acknowledged }),
      };
      for (const listener of listeners) listener(full);
      return full;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
