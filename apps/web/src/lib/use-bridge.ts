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

// Start communication with the iframe on screen (spec 11.7). The only peer is this view's iframe (checked with event.source).
// The iframe has no origin (null), so the origin is not checked. The port is handed over once per view.
// Communication ends when the iframe reloads or navigates, when the iframe leaves the screen (grant becomes null), when the view is replaced,
// when the render grant expires, and when the question ends.
// Operations from the HTML are relayed to the daemon tied to the render grant. The daemon also checks the grant is valid every time.
export function useBridge(
  api: Api,
  frame: RefObject<HTMLIFrameElement | null>,
  grant: RenderGrantResult | null,
  request: FeedbackForUi | null,
  // A staged iframe may already have loaded before it becomes the on-screen view.
  frameLoads: RefObject<{ url: string; count: number } | null>,
): BridgeStatus {
  const instanceId = grant?.bridge?.instanceId ?? null;
  const requestId = grant?.bridge?.requestId ?? null;
  const grantKey = grant?.grant ?? null;
  const documentUrl = grant?.documentUrl ?? null;
  const [state, setState] = useState<{ instanceId: string; status: BridgeStatus } | null>(null);
  const hostRef = useRef<BridgeHost | null>(null);

  useEffect(() => {
    if (instanceId === null || requestId === null || grantKey === null) return undefined;
    const element = frame.current;
    let loads = frameLoads.current?.url === documentUrl ? frameLoads.current.count : 0;
    let handed = loads > 1;
    let host: BridgeHost | null = null;
    const closeWith = (reason: BridgeCloseReason) =>
      setState({ instanceId, status: { status: 'closed', reason } });

    const onMessage = (event: MessageEvent) => {
      const target = element?.contentWindow;
      if (!target || event.source !== target || !isHello(event.data, instanceId)) return;
      if (handed) return;
      handed = true;
      const channel = new MessageChannel();
      // If the render grant has expired, end the communication (spec 11.7).
      const relay = async <T>(work: Promise<T>): Promise<T> => {
        try {
          return await work;
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === 'E_RENDER_GRANT_INVALID') {
            // Close after returning the response that reports the expiry.
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
          // The base version is used exactly as the HTML passed it. If another window updated first, it is a conflict.
          updateDraft: (answers, baseDraftVersion) =>
            relay(api.bridgeDraft(grantKey, baseDraftVersion, answers)),
        },
        onClose: closeWith,
      });
      hostRef.current = host;
      // For an opaque-origin iframe, targetOrigin must be '*'. It is used only for this handshake, and no secrets are sent.
      target.postMessage({ type: BRIDGE_PORT, instanceId }, '*', [channel.port2]);
      setState({ instanceId, status: { status: 'connected' } });
    };
    // A second or later load is an iframe reload or navigation. End the communication and do not hand over the port again.
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
  }, [api, frame, instanceId, requestId, grantKey, documentUrl, frameLoads]);

  // When the question ends, end the communication; tell the HTML about draft-answer changes made by other windows.
  // The draft to report is also fetched through the path that checks the render grant. If the grant has expired, end the communication without reporting.
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
  if (frameLoads.current?.url === documentUrl && frameLoads.current.count > 1) {
    return { status: 'closed', reason: 'navigated' };
  }
  return state?.instanceId === instanceId ? state.status : { status: 'waiting' };
}
