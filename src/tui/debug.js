'use strict';

const { sanitizeEnvelope } = require('./sanitize');

function attach(bus) {
  const off = bus.onAny((env) => {
    process.stdout.write(`${JSON.stringify(sanitizeEnvelope(env))}\n`);
  });
  return { cleanup: async () => off() };
}

module.exports = { attach };
