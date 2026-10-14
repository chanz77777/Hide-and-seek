// link.js — 同じ PC の別タブ同士をつなぐ（BroadcastChannel）。サーバー不要。
// Link.send(type, data) で送信、Link.on(type, handler) で受信。自分が送ったメッセージは自分には届かない。
(function () {
  'use strict';
  const CHANNEL = 'oekaki-kakurenbo';
  let ch = null;
  try { ch = new BroadcastChannel(CHANNEL); } catch (_) { ch = null; }
  const handlers = {};
  if (ch) ch.onmessage = (e) => {
    const m = e.data; if (!m || !m.type) return;
    (handlers[m.type] || []).forEach((h) => { try { h(m); } catch (err) { console.error(err); } });
  };
  window.Link = {
    available: !!ch,
    send(type, data) { if (ch) ch.postMessage(Object.assign({ type }, data || {})); },
    on(type, handler) { (handlers[type] = handlers[type] || []).push(handler); },
  };
})();
