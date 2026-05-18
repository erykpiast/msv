'use strict';

const MAX_EVENTS = 10_000;
const MAX_SUBSCRIBERS = 20;

function createBroker({ ideaId }) {
  const ring = [];
  const subscribers = new Set();
  let lastViewJson = null;

  function publishEvent(env) {
    if (env.idea_id !== ideaId) return false;
    ring.push(env);
    if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);
    broadcast('event', env);
    return true;
  }

  function publishView(view) {
    lastViewJson = JSON.stringify(view);
    broadcast('view', lastViewJson);
  }

  function broadcast(type, data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const frame = `event: ${type}\ndata: ${text}\n\n`;
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
    const snapshot = ring.slice();
    let i = 0;
    function sendChunk() {
      if (!subscribers.has(res)) return; // client disconnected mid-replay
      const end = Math.min(i + 100, snapshot.length);
      while (i < end) {
        res.write(`event: event\ndata: ${JSON.stringify(snapshot[i++])}\n\n`);
      }
      if (i < snapshot.length) {
        setImmediate(sendChunk);
      } else if (lastViewJson) {
        res.write(`event: view\ndata: ${lastViewJson}\n\n`);
      }
    }

    if (snapshot.length > 0) {
      setImmediate(sendChunk);
    } else if (lastViewJson) {
      res.write(`event: view\ndata: ${lastViewJson}\n\n`);
    }

    return () => subscribers.delete(res);
  }

  return {
    // Public API
    publishEvent,
    publishView,
    subscribe,
    // Test-only access — not part of the public API.
    // Allows unit tests to assert internal state without parsing SSE wire format.
    // Do not read or mutate from non-test code.
    _ring: ring,
    _subscribers: subscribers,
  };
}

module.exports = { createBroker };
