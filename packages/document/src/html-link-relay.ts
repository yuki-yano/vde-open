export const HTML_LINK_ATTRIBUTE = 'data-vde-document-link';
export const HTML_LINK_HELLO = 'vde-open:document-links';

// Capture the native methods before Interactive author scripts run.
export const HTML_LINK_RELAY = `(() => {
  if (parent === window) return;
  const channel = new MessageChannel();
  const send = channel.port1.postMessage.bind(channel.port1);
  const closest = Function.call.bind(Element.prototype.closest);
  const attribute = Function.call.bind(Element.prototype.getAttribute);
  const targetOf = Function.call.bind(Object.getOwnPropertyDescriptor(Event.prototype, 'target').get);
  const preventDefault = Function.call.bind(Event.prototype.preventDefault);
  const ElementType = Element;
  const Anchor = HTMLAnchorElement;
  const Area = HTMLAreaElement;
  window.addEventListener('click', (event) => {
    const target = targetOf(event);
    if (!(target instanceof ElementType)) return;
    const link = closest(target, 'a[href="#"][${HTML_LINK_ATTRIBUTE}], area[href="#"][${HTML_LINK_ATTRIBUTE}]');
    if (!(link instanceof Anchor || link instanceof Area)) return;
    preventDefault(event);
    if (event.isTrusted) send(attribute(link, '${HTML_LINK_ATTRIBUTE}'));
  }, true);
  parent.postMessage('${HTML_LINK_HELLO}', '*', [channel.port2]);
})();`;
