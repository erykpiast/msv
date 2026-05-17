'use strict';

const React = require('react');
const App = require('./App');
const { reduce, initialState } = require('./reducer');
const { setInk } = require('./inkExports');

// Build the bus → reducer wiring used by both the live attach() path and
// the replay tool's dashboard composition. Returns:
//   onEvent        — pass to bus.onAny()
//   makeRegister   — pass as App.registerSetState; flushes buffered updates
//   reset          — replace state with initialState({ idea })
//   getState       — current shadow state
//
// Events that arrive between bus.onAny() and App's useEffect calling
// registerSetState are reduced into the shadow state but cannot push into
// React. `pending` tracks whether there is at least one buffered update and
// the makeRegister helper flushes once setReactState becomes available.
function createDashboardWiring({ idea } = {}) {
  let state = initialState({ idea });
  let setReactState = null;
  let pending = false;

  function onEvent(env) {
    state = reduce(state, env);
    if (setReactState) {
      setReactState(state);
    } else {
      pending = true;
    }
  }

  function makeRegister(fn) {
    setReactState = fn;
    if (pending) {
      setReactState(state);
      pending = false;
    }
  }

  function reset() {
    state = initialState({ idea });
    if (setReactState) setReactState(state);
  }

  return {
    onEvent,
    makeRegister,
    reset,
    getState: () => state,
  };
}

async function attach(bus, { idea } = {}) {
  const ink = await import('ink');
  setInk(ink);
  const { render } = ink;

  const wiring = createDashboardWiring({ idea });
  const off = bus.onAny(wiring.onEvent);

  const inst = render(
    React.createElement(App, {
      initialState: wiring.getState(),
      registerSetState: wiring.makeRegister,
    })
  );

  return {
    cleanup: async () => {
      off();
      inst.unmount();
      await inst.waitUntilExit();
    },
    reset: wiring.reset,
    getState: wiring.getState,
  };
}

module.exports = {
  attach,
  App,
  reducer: reduce,
  initialState,
  createDashboardWiring,
};
