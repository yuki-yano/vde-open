// interactiveのHTMLへ最初のscriptとして入れる、同梱SDK（仕様11.6）。HTMLへ秘密を渡さない。
// 本体との通信は、本体が1回だけ渡すMessagePortだけを使う（仕様11.7）。
// SDKが提供するのは window.vde.ready() と window.vde.feedback（updateDraft、onDraftChanged）だけ。
// 送信・取得済みの印・中止・検索・読み取りや、旧版への回答の確認は提供しない。
import { BRIDGE_HELLO, BRIDGE_PORT, BRIDGE_PROTOCOL_VERSION } from '@vde-open/shared';

// 本体からportを受け取るまで待つ時間。過ぎたら、SDKの呼び出しを失敗させる。
const PORT_WAIT_MS = 10_000;
// portを受け取るまで、通信の開始を求め直す間隔。
const HELLO_INTERVAL_MS = 500;

// configSlotは、表示ごとの設定（JSON）に置き換える位置。設定はinstanceIdとparentOriginだけ。
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
    if (data.type === 'closed') fail(bridgeError('E_BRIDGE_CLOSED', '本体との通信が終わりました。表示し直してください。'));
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
    if (!port) fail(bridgeError('E_BRIDGE_UNAVAILABLE', '本体との通信を始められませんでした。表示し直してください。'));
  }, ${String(PORT_WAIT_MS)});
  var feedback = Object.freeze({
    updateDraft: function (answers, options) {
      if (!options || typeof options.baseDraftVersion !== 'number') {
        return Promise.reject(bridgeError('E_INVALID_ARGUMENT', 'options.baseDraftVersionを指定してください。'));
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
