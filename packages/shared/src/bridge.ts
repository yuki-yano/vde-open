// HTMLと本体（管理UI）の間の通信（仕様11.6・11.7）。SDKのprotocolVersionは、ほかのversionと別に持つ。
export const BRIDGE_PROTOCOL_VERSION = 1;

// iframeのSDKが、本体へ通信の開始を求めるmessageの種類。
export const BRIDGE_HELLO = 'vde-bridge-hello';
// 本体が、MessagePortを1回だけ渡すmessageの種類。
export const BRIDGE_PORT = 'vde-bridge-port';

// HTMLから呼べる操作。これ以外（submit、ack、cancel、search、read、openなど）は受け付けない。
export const BRIDGE_METHODS = ['ready', 'updateDraft'] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];
