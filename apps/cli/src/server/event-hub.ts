import type { ServerEvent } from '@vde-open/shared';

export type EventListener = (event: ServerEvent) => void;

export interface EventHub {
  // 現在の連番。接続時のhelloに使う。
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

// 更新通知の配信。連番を付けて渡すだけで、保存や再送はしない。
// 受け手は連番の欠けやdaemonIdの変化を見て、stateを取り直す（仕様6.5）。
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
