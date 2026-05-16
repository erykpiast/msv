'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS, STATUS_ICON } = require('../style');

const SUBSTAGE_LABELS = {
  ideation: 'ideation',
  adversarial: 'adversarial',
  alignment: 'alignment',
  researcher: 'researcher',
  observation: 'observation',
  debate: 'debate',
};

const SUBSTAGE_ORDER = ['ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate'];

function SubstageRow({ name, status, researcherTotal, researcherDone, researcherActivity }) {
  const { Box, Text } = getInk();

  // Cards use a denser glyph for pending substages than the stage list,
  // which keeps the rows visually compact even when several substages
  // haven't started yet.
  const icon = status === 'pending' ? '·' : (STATUS_ICON[status] || ' ');
  const color = COLORS[status] || COLORS.muted;
  const label = SUBSTAGE_LABELS[name] || name;

  let extra = null;
  if (name === 'researcher' && researcherTotal > 0) {
    const progressText = `${researcherDone}/${researcherTotal}`;
    extra = React.createElement(
      Box,
      { flexDirection: 'row', gap: 1 },
      React.createElement(Text, { color: COLORS.muted }, progressText),
      researcherActivity && status === 'running'
        ? React.createElement(
            Text,
            { color: COLORS.muted },
            researcherActivity.length > 30
              ? researcherActivity.slice(0, 30) + '…'
              : researcherActivity
          )
        : null
    );
  }

  return React.createElement(
    Box,
    { flexDirection: 'row', gap: 1 },
    React.createElement(Text, { color }, `  ${icon}`),
    React.createElement(Text, { color: status === 'pending' ? COLORS.muted : COLORS.header }, label.padEnd(12)),
    extra
  );
}

function WorkingGroupCard({ wg, width }) {
  const { Box, Text } = getInk();

  const cardWidth = width || 38;
  const name = wg.name || '(unknown)';
  const displayName = name.length > cardWidth - 4 ? name.slice(0, cardWidth - 7) + '…' : name;

  // Determine overall card status color
  const substages = wg.substages || {};
  const values = Object.values(substages);
  let headerColor = COLORS.pending;
  if (values.some((s) => s === 'failed')) headerColor = COLORS.failed;
  else if (values.some((s) => s === 'running')) headerColor = COLORS.running;
  else if (values.every((s) => s === 'done')) headerColor = COLORS.done;

  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'single', paddingX: 1, width: cardWidth },
    React.createElement(Text, { color: headerColor, bold: true }, displayName),
    ...SUBSTAGE_ORDER.map((substage) =>
      React.createElement(SubstageRow, {
        key: substage,
        name: substage,
        status: substages[substage] || 'pending',
        researcherTotal: wg.researcherTotal || 0,
        researcherDone: wg.researcherDone || 0,
        researcherActivity: wg.researcherActivity || null,
      })
    )
  );
}

module.exports = WorkingGroupCard;
