'use strict';

const React = require('react');
const App = require('./App');
const { reduce, initialState } = require('./reducer');
const { setInk } = require('./inkExports');

async function attach(bus, { idea } = {}) {
  const ink = await import('ink');
  setInk(ink);
  const { render } = ink;

  let state = initialState({ idea });
  let setReactState = null;
  // Events emitted between bus.onAny(onEvent) and App's useEffect calling
  // registerSetState are reduced into the shadow state but cannot push into
  // React. Track that there is at least one buffered update and flush the
  // latest state once setReactState becomes available.
  let pending = false;

  const onEvent = (env) => {
    state = reduce(state, env);
    if (setReactState) {
      // Reducer always returns a new object on state changes (or the same
      // reference on intentional no-ops like heartbeat), so no extra spread.
      setReactState(state);
    } else {
      pending = true;
    }
  };

  const off = bus.onAny(onEvent);

  const inst = render(
    React.createElement(App, {
      initialState: state,
      registerSetState: (fn) => {
        setReactState = fn;
        if (pending) {
          setReactState(state);
          pending = false;
        }
      },
    })
  );

  function reset() {
    state = initialState({ idea });
    if (setReactState) setReactState(state);
  }

  return {
    cleanup: async () => {
      off();
      inst.unmount();
      await inst.waitUntilExit();
    },
    reset,
    getState: () => state,
  };
}

module.exports = {
  attach,
  App,
  reducer: reduce,
  initialState,
};
