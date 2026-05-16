'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS, REACTION_COLORS } = require('../style');

const REACTION_ORDER = ['Concede', 'Rebut', 'Question'];

// Render order: by reactor territory id, then target territory id. Stable
// ordering matters because the component re-renders on every event and we
// don't want flows jumping around as reactions arrive in non-deterministic
// order across parallel reactor pairs.
function sortedFlows(flows) {
  return Object.values(flows).sort((a, b) => {
    if (a.reactor !== b.reactor) return a.reactor.localeCompare(b.reactor);
    return a.target.localeCompare(b.target);
  });
}

function FlowRow({ flow, labelWidth }) {
  const { Box, Text } = getInk();

  // Build the "Concede:2 · Rebut:1 · Question:1" segment, skipping zero
  // counts so the row stays compact for flows with only one reaction type.
  const segments = REACTION_ORDER
    .filter((type) => (flow[type] || 0) > 0)
    .map((type) =>
      React.createElement(
        Text,
        { key: type, color: REACTION_COLORS[type] || COLORS.muted },
        `${type}:${flow[type]}`
      )
    );

  const label = `${flow.reactor} → ${flow.target}`;

  return React.createElement(
    Box,
    { flexDirection: 'row', gap: 1 },
    React.createElement(
      Text,
      { color: COLORS.header },
      `  ${label.padEnd(labelWidth)}`
    ),
    // Interleave the segments with a "·" separator. We can't use a flex gap
    // because we need a visible character between same-row Texts in ink.
    ...segments.flatMap((seg, i) =>
      i === 0
        ? [seg]
        : [React.createElement(Text, { key: `sep-${i}`, color: COLORS.muted }, '·'), seg]
    )
  );
}

function CrossPollination({ crossPollination }) {
  const { Box, Text } = getInk();

  const flows = sortedFlows(crossPollination.flows || {});
  if (flows.length === 0 && (crossPollination.total || 0) === 0) {
    return null;
  }

  // Pad reactor→target labels to the longest one so all the colored counters
  // line up vertically across rows.
  const longestLabel = flows.reduce((max, f) => {
    const len = `${f.reactor} → ${f.target}`.length;
    return Math.max(max, len);
  }, 0);

  const header = `Cross-pollination · ${crossPollination.total} reaction${crossPollination.total === 1 ? '' : 's'}`;

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(Text, { color: COLORS.header, bold: true, underline: true }, header),
    ...flows.map((flow) =>
      React.createElement(FlowRow, {
        key: `${flow.reactor}→${flow.target}`,
        flow,
        labelWidth: longestLabel,
      })
    )
  );
}

module.exports = CrossPollination;
