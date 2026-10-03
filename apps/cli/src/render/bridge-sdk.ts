// The bundled SDK inserted as the first script in interactive HTML (spec 11.6). No secrets are passed to the HTML.
// Communication with the host uses only the MessagePort the host hands over once (spec 11.7).
// The SDK provides only window.vde.ready() and window.vde.feedback (updateDraft, onDraftChanged).
// It does not provide submit, acknowledge, cancel, search, read, or confirmation of answers to an older revision.
import { BRIDGE_HELLO, BRIDGE_PORT, BRIDGE_PROTOCOL_VERSION } from '@vde-open/shared';

// How long to wait for the port from the host. After that, SDK calls fail.
const PORT_WAIT_MS = 10_000;
// Interval for re-requesting the connection until the port arrives.
const HELLO_INTERVAL_MS = 500;

// configSlot marks where the per-view config (JSON) is inserted. The config holds only instanceId and parentOrigin.
export function bridgeSdkScript(configSlot: string): string {
  return `(function (config) {
  'use strict';
  if (window.parent === window || !config || typeof config !== 'object') return;
  var instanceId = String(config.instanceId);
  var parentOrigin = String(config.parentOrigin);
  var parentWindow = window.parent;
  var port = null;
  var closed = null;
  var sequence = 0;
  var pending = new Map();
  var listeners = new Set();
  var waiters = [];
  function bridgeError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }
  function fail(error) {
    if (closed) return;
    closed = error;
    clearInterval(hello);
    pending.forEach(function (entry) { entry.reject(error); });
    pending.clear();
    waiters.splice(0).forEach(function (waiter) { waiter.reject(error); });
    if (port) port.close();
  }
  function onPortMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'response') {
      var entry = pending.get(data.sequence);
      if (!entry) return;
      pending.delete(data.sequence);
      if (data.ok === true) entry.resolve(data.result);
      else entry.reject(bridgeError(String(data.error && data.error.code), String(data.error && data.error.message)));
      return;
    }
    if (data.type === 'event' && data.method === 'draftChanged') {
      listeners.forEach(function (listener) {
        try { listener(data.payload); } catch (error) { setTimeout(function () { throw error; }, 0); }
      });
      return;
    }
    if (data.type === 'closed') fail(bridgeError('E_BRIDGE_CLOSED', 'The connection to the host has closed. Reload the view.'));
  }
  function onWindowMessage(event) {
    if (event.source !== parentWindow || event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(BRIDGE_PORT)} || data.instanceId !== instanceId) return;
    if (port || closed || !event.ports || event.ports.length !== 1) return;
    window.removeEventListener('message', onWindowMessage);
    clearInterval(hello);
    port = event.ports[0];
    port.onmessage = onPortMessage;
    waiters.splice(0).forEach(function (waiter) { waiter.resolve(port); });
  }
  function connected() {
    if (closed) return Promise.reject(closed);
    if (port) return Promise.resolve(port);
    return new Promise(function (resolve, reject) { waiters.push({ resolve: resolve, reject: reject }); });
  }
  function call(method, payload) {
    return connected().then(function (target) {
      return new Promise(function (resolve, reject) {
        sequence += 1;
        pending.set(sequence, { resolve: resolve, reject: reject });
        target.postMessage({ protocolVersion: ${String(BRIDGE_PROTOCOL_VERSION)}, instanceId: instanceId, sequence: sequence, method: method, payload: payload });
      });
    });
  }
  function sendHello() {
    parentWindow.postMessage({ type: ${JSON.stringify(BRIDGE_HELLO)}, protocolVersion: ${String(BRIDGE_PROTOCOL_VERSION)}, instanceId: instanceId }, parentOrigin);
  }
  window.addEventListener('message', onWindowMessage);
  var hello = setInterval(sendHello, ${String(HELLO_INTERVAL_MS)});
  setTimeout(function () {
    if (!port) fail(bridgeError('E_BRIDGE_UNAVAILABLE', 'The connection to the host could not be established. Reload the view.'));
  }, ${String(PORT_WAIT_MS)});
  var feedback = Object.freeze({
    updateDraft: function (answers, options) {
      if (!options || typeof options.baseDraftVersion !== 'number') {
        return Promise.reject(bridgeError('E_INVALID_ARGUMENT', 'options.baseDraftVersion is required.'));
      }
      return call('updateDraft', { answers: answers, baseDraftVersion: options.baseDraftVersion });
    },
    onDraftChanged: function (listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  });
  Object.defineProperty(window, 'vde', {
    value: Object.freeze({ ready: function () { return call('ready', {}); }, feedback: feedback }),
    enumerable: false,
    configurable: false,
    writable: false
  });
  sendHello();
})(${configSlot});`;
}
