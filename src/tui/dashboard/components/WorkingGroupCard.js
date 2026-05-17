'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS, STATUS_ICON } = require('../style');
const {
  ALIGNMENT_MOVE_BUDGET,
  PAIR_MOVE_BUDGET,
} = require('../../../moves');

const SUBSTAGE_ORDER = ['ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate'];

// Card width chosen to fit the longest substage label ("adversarial" = 11) plus
// status icon, gap, and a right-aligned counter like "12/12" / "10/10 · web_fetch(…)".
// 32 cols feels right and keeps multiple cards on a typical 120-col terminal.
const CARD_WIDTH = 32;

// progressText returns the right-aligned per-substage progress label.
// `null` means "no counter to display in this state".
function progressText(name, status, wg) {
  if (status === 'pending') return null;
  switch (name) {
    case 'ideation': {
      const total = (wg.assignedPair || []).length || 2;
      const done = wg.personasIdeated || 0;
      if (status === 'running') return `${done}/${total}`;
      return `${wg.candidateCount || 0} cands`;
    }
    case 'adversarial':
      if (status === 'done') return `${wg.markCount || 0} marks`;
      return null;
    case 'alignment':
      return `${wg.alignmentMoves || 0}/${ALIGNMENT_MOVE_BUDGET}`;
    case 'researcher': {
      const total = wg.researcherTotal || 0;
      if (total === 0) return null;
      return `${wg.researcherDone || 0}/${total}`;
    }
    case 'observation':
      if (status === 'done') return `${wg.observationCount || 0} obs`;
      return null;
    case 'debate':
      return `${wg.debateMoves || 0}/${PAIR_MOVE_BUDGET}`;
    default:
      return null;
  }
}

function SubstageRow({ name, status, wg }) {
  const { Box, Text } = getInk();

  // Cards use a denser glyph for pending substages than the stage list.
  const icon = status === 'pending' ? '·' : (STATUS_ICON[status] || ' ');
  const color = COLORS[status] || COLORS.muted;
  const counter = progressText(name, status, wg);

  // Live researcher activity (web_search / web_fetch) shown under the row
  // when running, since it can be long and doesn't fit on the right side.
  const activity = name === 'researcher' && status === 'running' && wg.researcherActivity
    ? wg.researcherActivity.length > CARD_WIDTH - 4
      ? wg.researcherActivity.slice(0, CARD_WIDTH - 5) + '…'
      : wg.researcherActivity
    : null;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      React.createElement(
        Box,
        { flexDirection: 'row', gap: 1 },
        React.createElement(Text, { color }, icon),
        React.createElement(
          Text,
          { color: status === 'pending' ? COLORS.muted : COLORS.header },
          name
        )
      ),
      counter
        ? React.createElement(Text, { color: COLORS.muted }, counter)
        : null
    ),
    activity
      ? React.createElement(Text, { color: COLORS.muted, dimColor: true }, `    ${activity}`)
      : null
  );
}

function WorkingGroupCard({ wg }) {
  const { Box, Text } = getInk();

  const name = wg.name || '(unknown)';
  const displayName = name.length > CARD_WIDTH - 4
    ? name.slice(0, CARD_WIDTH - 5) + '…'
    : name;

  const substages = wg.substages || {};
  const values = Object.values(substages);
  let headerColor = COLORS.pending;
  if (values.some((s) => s === 'failed')) headerColor = COLORS.failed;
  else if (values.some((s) => s === 'running')) headerColor = COLORS.running;
  else if (values.length > 0 && values.every((s) => s === 'done')) headerColor = COLORS.done;

  const pair = wg.assignedPair && wg.assignedPair.length >= 2
    ? `${wg.assignedPair[0]} × ${wg.assignedPair[1]}`
    : null;

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'single',
      paddingX: 1,
      width: CARD_WIDTH,
      flexShrink: 0,
    },
    React.createElement(Text, { color: headerColor, bold: true }, displayName),
    pair
      ? React.createElement(Text, { color: COLORS.muted }, pair)
      : null,
    ...SUBSTAGE_ORDER.map((substage) =>
      React.createElement(SubstageRow, {
        key: substage,
        name: substage,
        status: substages[substage] || 'pending',
        wg,
      })
    )
  );
}

module.exports = WorkingGroupCard;
module.exports.CARD_WIDTH = CARD_WIDTH;
