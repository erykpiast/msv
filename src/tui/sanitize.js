'use strict';

// Web-search results and other externally-sourced strings can flow through
// bus payloads into stdout. Strip ANSI escape sequences (CSI and OSC) from
// those strings before writing so a terminal-state-corrupting payload from
// an external source can't muck with our output (or trigger OSC injection
// on terminals that honour it).
//
// We only sanitize top-level string fields in the envelope. Formatters in
// log.js read scalar string fields directly (raw_capture, query, url,
// error_message), and debug.js is meant for jq consumption where nested
// fields are inspected with structured tools. If a nested string ever
// needs to be rendered as plain text, sanitize it at the formatter site.
//
// Pattern matches:
//   CSI:  ESC [ ... <final-byte>
//   OSC:  ESC ] ... BEL
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

function stripAnsi(str) {
  return typeof str === 'string' ? str.replace(ANSI_PATTERN, '') : str;
}

function sanitizeEnvelope(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === 'string' ? stripAnsi(v) : v;
  }
  return out;
}

module.exports = { stripAnsi, sanitizeEnvelope };
