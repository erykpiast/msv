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

  const onEvent = (env) => {
    state = reduce(state, env);
    if (setReactState) setReactState({ ...state });
  };

  const off = bus.onAny(onEvent);

  const inst = render(
    React.createElement(App, {
      initialState: state,
      registerSetState: (fn) => {
        setReactState = fn;
      },
    })
  );

  function reset() {
    state = initialState({ idea });
    if (setReactState) setReactState({ ...state });
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
