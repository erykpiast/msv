'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS } = require('../style');
const WorkingGroupCard = require('./WorkingGroupCard');

const CARD_WIDTH = WorkingGroupCard.CARD_WIDTH;
// Each card sits in the row plus a gap; we use the rendered card width + the
// `gap: 1` column to decide how many cards fit on one row.
const COLUMN_STRIDE = CARD_WIDTH + 1;

function columnsForWidth(terminalWidth) {
  return Math.max(1, Math.floor(terminalWidth / COLUMN_STRIDE));
}

function WorkingGroupGrid({ workingGroups }) {
  const { Box, Text } = getInk();
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

  const cols = columnsForWidth(termWidth);
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
        { key: rowIndex, flexDirection: 'row', gap: 1 },
        ...rowEntries.map(([id, wg]) =>
          React.createElement(WorkingGroupCard, { key: id, wg })
        )
      )
    )
  );
}

module.exports = WorkingGroupGrid;
