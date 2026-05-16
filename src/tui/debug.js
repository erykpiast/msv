'use strict';

function attach(bus) {
  const off = bus.onAny((env) => {
    process.stdout.write(`${JSON.stringify(env)}\n`);
  });
  return async () => off();
}

module.exports = { attach };
