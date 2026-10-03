// Communication between the HTML and the host (the management UI) (spec 11.6 and 11.7). The SDK protocolVersion is kept separately from the other versions.
export const BRIDGE_PROTOCOL_VERSION = 1;

// Message type the SDK in the iframe sends to ask the host to start communication.
export const BRIDGE_HELLO = 'vde-bridge-hello';
// Message type the host uses to hand over the MessagePort, exactly once.
export const BRIDGE_PORT = 'vde-bridge-port';

// Operations the HTML may call. Nothing else (submit, ack, cancel, search, read, open and so on) is accepted.
export const BRIDGE_METHODS = ['ready', 'updateDraft'] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];
