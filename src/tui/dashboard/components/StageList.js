'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS } = require('../style');

const STATUS_ICON = {
  running: '→',
  done: '✓',
  failed: '✗',
  pending: ' ',
};

const STAGE_LABELS = {
  discovery: '1. Discovery',
  diversity: '2. Diversity',
  coordinator: '3. Coordinator',
  working_groups: '4. Working groups',
  cross_pollination: '5. Cross-pollination',
  forum: '6. Forum',
  synthesis: '7. Synthesis',
};

function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function formatTokens(n) {
  if (!n) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k tok`;
  return `${n} tok`;
}

function StageRow({ name, status, summary, startedAt, endedAt, tokens, now }) {
  const { Box, Text } = getInk();

  const icon = STATUS_ICON[status] || ' ';
  const color = COLORS[status] || COLORS.muted;
  const label = STAGE_LABELS[name] || name;

  let summaryText = '';
  if (status === 'running') {
    summaryText = 'running…';
  } else if (summary && typeof summary === 'object') {
    const parts = [];
    if (summary.searches != null) parts.push(`${summary.searches} searches`);
    if (summary.candidates != null) parts.push(`${summary.candidates} candidates`);
    if (summary.selected != null) parts.push(`${summary.selected} selected`);
    if (summary.territories != null) parts.push(`${summary.territories} territories`);
    if (summary.completed != null) parts.push(`${summary.completed}/${summary.total || '?'} done`);
    if (summary.reactions != null) parts.push(`${summary.reactions} reactions`);
    if (summary.nodes != null) parts.push(`${summary.nodes} nodes`);
    if (summary.contradictions != null && summary.contradictions > 0) parts.push(`${summary.contradictions} contradictions`);
    summaryText = parts.join(' · ') || '';
  }

  // Timing: for running stage, show elapsed; for done, show duration
  let timingText = null;
  if (status === 'running' && startedAt) {
    const elapsed = formatDuration((now || Date.now()) - startedAt);
    if (elapsed) timingText = elapsed;
  } else if (status === 'done' && startedAt && endedAt) {
    const dur = formatDuration(endedAt - startedAt);
    if (dur) timingText = dur;
  }

  const tokText = formatTokens(tokens);
  const statsText = [timingText, tokText].filter(Boolean).join(' · ');

  return React.createElement(
    Box,
    { flexDirection: 'row', gap: 1 },
    React.createElement(Text, { color }, icon),
    React.createElement(Text, { color: COLORS.header }, label.padEnd(22)),
    summaryText
      ? React.createElement(Text, { color: COLORS.muted }, summaryText)
      : null,
    statsText
      ? React.createElement(Text, { color: COLORS.muted }, `  [${statsText}]`)
      : null
  );
}

function StageList({ stages }) {
  const { Box, Text } = React;
  const { useState, useEffect } = React;
  const { Box: InkBox, Text: InkText } = getInk();

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const stageNames = Object.keys(STAGE_LABELS);

  return React.createElement(
    InkBox,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(InkText, { color: COLORS.header, bold: true }, 'Stages'),
    ...stageNames.map((name) => {
      const stage = stages[name];
      return React.createElement(StageRow, {
        key: name,
        name,
        status: stage ? stage.status : 'pending',
        summary: stage ? stage.summary : null,
        startedAt: stage ? stage.startedAt : null,
        endedAt: stage ? stage.endedAt : null,
        tokens: stage ? stage.tokens : 0,
        now,
      });
    })
  );
}

module.exports = StageList;
