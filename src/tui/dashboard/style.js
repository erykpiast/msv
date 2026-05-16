'use strict';

const COLORS = {
  done: 'green',
  running: 'cyan',
  failed: 'red',
  pending: 'gray',
  warn: 'yellow',
  muted: 'gray',
  header: 'white',
};

// Shared status glyphs for the stage list and working-group cards.
// Cards may locally override 'pending' to a denser glyph (e.g. '·') if
// the row layout benefits from it.
const STATUS_ICON = {
  running: '→',
  done: '✓',
  failed: '✗',
  pending: ' ',
};

module.exports = { COLORS, STATUS_ICON };
