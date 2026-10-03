import {
  BRIDGE_HELLO,
  BRIDGE_PORT,
  BRIDGE_PROTOCOL_VERSION,
  type FeedbackForUi,
  type RenderGrantResult,
} from '@vde-open/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { ApiError, type Api } from './api.ts';
import { createBridgeHost, type BridgeCloseReason, type BridgeHost } from './bridge-host.ts';

export type BridgeStatus =
  | { status: 'none' }
  | { status: 'waiting' }
  | { status: 'connected' }
  | { status: 'closed'; reason: BridgeCloseReason };

const isHello = (data: unknown, instanceId: string): boolean =>
  typeof data === 'object' &&
  data !== null &&
  (data as Record<string, unknown>)['type'] === BRIDGE_HELLO &&
  (data as Record<string, unknown>)['protocolVersion'] === BRIDGE_PROTOCOL_VERSION &&
  (data as Record<string, unknown>)['instanceId'] === instanceId;

// 表示中のiframeとの通信を始める（仕様11.7）。相手は、この表示のiframe（event.sourceで確かめる）だけ。
// iframeはoriginを持たない（null）ので、originでは確かめない。portは、1つの表示に1回だけ渡す。
// iframeの読み直し・遷移、iframeを画面から外したとき（grantをnullにする）、表示の差し替え、
// 表示の権限の失効、質問の終わりで、通信を終える。
// HTMLからの操作は、表示の権限（grant）に結び付けてdaemonへ中継する。daemonも、権限が有効かを毎回確かめる。
export function useBridge(
  api: Api,
  frame: RefObject<HTMLIFrameElement | null>,
  grant: RenderGrantResult | null,
  request: FeedbackForUi | null,
): BridgeStatus {
  const instanceId = grant?.bridge?.instanceId ?? null;
  const requestId = grant?.bridge?.requestId ?? null;
  const grantKey = grant?.grant ?? null;
  const [state, setState] = useState<{ instanceId: string; status: BridgeStatus } | null>(null);
  const hostRef = useRef<BridgeHost | null>(null);

  useEffect(() => {
    if (instanceId === null || requestId === null || grantKey === null) return undefined;
    const element = frame.current;
    let handed = false;
    let loads = 0;
    let host: BridgeHost | null = null;
    const closeWith = (reason: BridgeCloseReason) =>
      setState({ instanceId, status: { status: 'closed', reason } });

    const onMessage = (event: MessageEvent) => {
      const target = element?.contentWindow;
      if (!target || event.source !== target || !isHello(event.data, instanceId)) return;
      if (handed) return;
      handed = true;
      const channel = new MessageChannel();
      // 表示の権限が失効していたら、通信を終える（仕様11.7）。
      const relay = async <T>(work: Promise<T>): Promise<T> => {
        try {
          return await work;
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === 'E_RENDER_GRANT_INVALID') {
            // 失効を伝える応答を返した後で閉じる。
            setTimeout(() => host?.close('expired'), 0);
          }
          throw reason;
        }
      };
      host = createBridgeHost({
        instanceId,
        port: channel.port1,
        handlers: {
          async ready() {
            const current = await relay(api.bridgeReady(grantKey));
            return {
              protocolVersion: BRIDGE_PROTOCOL_VERSION,
              requestId: current.requestId,
              documentId: current.documentId,
              revision: current.revision,
              questionnaire: current.questionnaire,
              draftVersion: current.draftVersion,
              answers: current.draftAnswers,
            };
          },
          // もとにした版は、HTMLが渡した値のまま使う。別の画面が先に更新していれば、競合になる。
          updateDraft: (answers, baseDraftVersion) =>
            relay(api.bridgeDraft(grantKey, baseDraftVersion, answers)),
        },
        onClose: closeWith,
      });
      hostRef.current = host;
      // opaque originのiframeへは、targetOriginに'*'を使うしかない。このhandshakeだけに使い、秘密は送らない。
      target.postMessage({ type: BRIDGE_PORT, instanceId }, '*', [channel.port2]);
      setState({ instanceId, status: { status: 'connected' } });
    };
    // 2回目以降の読み込みは、iframeの読み直しか遷移。通信を終え、portを渡し直さない。
    const onLoad = () => {
      loads += 1;
      if (loads < 2) return;
      handed = true;
      if (host) host.close('navigated');
      else closeWith('navigated');
    };

    window.addEventListener('message', onMessage);
    element?.addEventListener('load', onLoad);
    return () => {
      window.removeEventListener('message', onMessage);
      element?.removeEventListener('load', onLoad);
      host?.close('replaced');
      hostRef.current = null;
    };
  }, [api, frame, instanceId, requestId, grantKey]);

  // 質問が終わったら通信を終え、別の画面による回答案の変更はHTMLへ知らせる。
  // 知らせる回答案も、表示の権限を確かめる経路で取得する。権限が失効していれば、知らせずに通信を終える。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || request === null || request.requestId !== requestId || grantKey === null) {
      return undefined;
    }
    if (request.status !== 'pending') {
      host.close('request-closed');
      return undefined;
    }
    let cancelled = false;
    void api.bridgeReady(grantKey).then(
      (current) => {
        if (cancelled || current.status !== 'pending') return;
        host.notifyDraft({ answers: current.draftAnswers, draftVersion: current.draftVersion });
      },
      (reason: unknown) => {
        if (reason instanceof ApiError && reason.code === 'E_RENDER_GRANT_INVALID') {
          host.close('expired');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, request, requestId, grantKey]);

  if (instanceId === null) return { status: 'none' };
  return state?.instanceId === instanceId ? state.status : { status: 'waiting' };
}
