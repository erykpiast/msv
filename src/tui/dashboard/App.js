'use strict';

const React = require('react');
const { getInk } = require('./inkExports');
const { COLORS } = require('./style');
const Header = require('./components/Header');
const StageList = require('./components/StageList');
const WorkingGroupGrid = require('./components/WorkingGroupGrid');
const RecentEvents = require('./components/RecentEvents');

function App({ initialState, registerSetState }) {
  const { Box, Text, useApp, useInput } = getInk();
  const { useState, useEffect } = React;

  const [state, setState] = useState(initialState);

  useEffect(() => {
    if (registerSetState) {
      registerSetState(setState);
    }
  }, [registerSetState]);

  const { exit } = useApp();

  useInput((input) => {
    if (input === 'q') exit();
  });

  const statusLine = state.completed
    ? React.createElement(Text, { color: COLORS.done, bold: true }, 'Pipeline complete.')
    : state.failed
    ? React.createElement(
        Text,
        { color: COLORS.failed, bold: true },
        `Pipeline failed${state.error ? ': ' + state.error.message : ''}`
      )
    : null;

  return React.createElement(
    Box,
    { flexDirection: 'column', padding: 1 },
    React.createElement(Header, {
      idea: state.idea,
      api: state.api,
      startedAt: state.startedAt,
    }),
    React.createElement(StageList, { stages: state.stages }),
    React.createElement(WorkingGroupGrid, { workingGroups: state.workingGroups }),
    React.createElement(RecentEvents, { recent: state.recent }),
    statusLine,
    React.createElement(Text, { color: COLORS.muted }, 'press q to quit')
  );
}

module.exports = App;
