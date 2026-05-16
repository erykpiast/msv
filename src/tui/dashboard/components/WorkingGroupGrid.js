'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS } = require('../style');
const WorkingGroupCard = require('./WorkingGroupCard');

function getColumns(terminalWidth) {
  if (terminalWidth >= 160) return 3;
  if (terminalWidth >= 100) return 2;
  return 1;
}

function WorkingGroupGrid({ workingGroups }) {
  const { Box, Text, useStdout } = getInk();
  const { useState, useEffect } = React;

  const [termWidth, setTermWidth] = useState(
    (process.stdout && process.stdout.columns) || 120
  );

  useEffect(() => {
    function onResize() {
      setTermWidth((process.stdout && process.stdout.columns) || 120);
    }
    process.stdout.on('resize', onResize);
    return () => process.stdout.off('resize', onResize);
  }, []);

  const entries = Object.entries(workingGroups || {});

  if (entries.length === 0) {
    return React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { color: COLORS.muted }, 'No working groups yet…')
    );
  }

  const cols = getColumns(termWidth);
  const cardWidth = Math.floor((termWidth - cols * 2 - 2) / cols);

  // Build rows of `cols` cards each
  const rows = [];
  for (let i = 0; i < entries.length; i += cols) {
    rows.push(entries.slice(i, i + cols));
  }

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(Text, { color: COLORS.header, bold: true, underline: true }, 'Working Groups'),
    ...rows.map((rowEntries, rowIndex) =>
      React.createElement(
        Box,
        { key: rowIndex, flexDirection: 'row', gap: 1, flexWrap: 'nowrap' },
        ...rowEntries.map(([id, wg]) =>
          React.createElement(WorkingGroupCard, {
            key: id,
            wg,
            width: cardWidth,
          })
        )
      )
    )
  );
}

module.exports = WorkingGroupGrid;
