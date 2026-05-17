'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS } = require('../style');

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function Header({ idea, api, startedAt }) {
  const { Box, Text } = getInk();
  const { useState, useEffect } = React;

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const topicText = idea && idea.raw_capture
    ? `msv investigating ${idea.id || '?'} · ${idea.raw_capture}`
    : 'msv · waiting…';

  const elapsedText = startedAt
    ? `${elapsed}s elapsed`
    : '';

  const tokText = api.totalTokens
    ? `${formatTokens(api.totalTokens)} tokens`
    : '';

  const apiText = `api: ${api.inflight} inflight · ${api.total} calls`;

  const statsText = [apiText, tokText, elapsedText].filter(Boolean).join(' · ');

  return React.createElement(
    Box,
    { flexDirection: 'column', marginBottom: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      React.createElement(Text, { color: COLORS.header, bold: true }, topicText),
      React.createElement(Text, { color: COLORS.muted }, statsText)
    )
  );
}

module.exports = Header;
