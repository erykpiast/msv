'use strict';

const MAX_EVENTS = 10_000;
const MAX_SUBSCRIBERS = 20;

function makeSseFrame(type, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // SSE data fields must not contain bare newlines. Each newline starts a new
  // `data:` line so the receiver reassembles the original payload verbatim.
  const escaped = text.replace(/\n/g, '\ndata: ');
  return `event: ${type}\ndata: ${escaped}\n\n`;
}

function createBroker({ ideaId }) {
  // Ring buffer with O(1) push. `head` indexes the oldest element; `size` is
  // the current count. When full, we overwrite at `head` and advance it.
  const ring = new Array(MAX_EVENTS);
  let head = 0;
  let size = 0;

  const subscribers = new Set();
  let lastViewJson = null;

  function ringSnapshot() {
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = ring[(head + i) % MAX_EVENTS];
    return out;
  }

  function publishEvent(env) {
    if (env.idea_id !== ideaId) return false;
    if (size < MAX_EVENTS) {
      ring[(head + size) % MAX_EVENTS] = env;
      size += 1;
    } else {
      ring[head] = env;
      head = (head + 1) % MAX_EVENTS;
    }
    broadcast('event', env);
    return true;
  }

  function publishView(view) {
    lastViewJson = JSON.stringify(view);
    broadcast('view', lastViewJson);
  }

  function broadcast(type, data) {
    const frame = makeSseFrame(type, data);
    const dead = [];
    for (const sub of subscribers) {
      try {
        sub.write(frame);
      } catch {
        dead.push(sub);
      }
    }
    for (const sub of dead) subscribers.delete(sub);
  }

  function subscribe(res) {
    if (subscribers.size >= MAX_SUBSCRIBERS) {
      res.statusCode = 503;
      res.end();
      return () => {};
    }
    subscribers.add(res);

    // Replay ring in batches of 100 to avoid blocking the event loop on reconnect.
    const snapshot = ringSnapshot();
    let i = 0;
    function sendChunk() {
      if (!subscribers.has(res)) return; // client disconnected mid-replay
      const end = Math.min(i + 100, snapshot.length);
      while (i < end) {
        res.write(makeSseFrame('event', snapshot[i++]));
      }
      if (i < snapshot.length) {
        setImmediate(sendChunk);
      } else if (lastViewJson) {
        res.write(makeSseFrame('view', lastViewJson));
      }
    }

    if (snapshot.length > 0) {
      setImmediate(sendChunk);
    } else if (lastViewJson) {
      res.write(makeSseFrame('view', lastViewJson));
    }

    return () => subscribers.delete(res);
  }

  // Test-only access — not part of the public API.
  // `_ring` returns a fresh snapshot array each access so existing tests can
  // use array indexing and `.length` against the logical ring contents.
  // Do not read or mutate from non-test code.
  const api = {
    publishEvent,
    publishView,
    subscribe,
    _subscribers: subscribers,
  };
  Object.defineProperty(api, '_ring', {
    enumerable: true,
    get: ringSnapshot,
  });
  return api;
}

module.exports = { createBroker, makeSseFrame };
