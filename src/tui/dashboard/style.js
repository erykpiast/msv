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

// Cross-pollination reaction types (from REACTION_MOVE_TYPES in src/moves.js).
// Colors picked so that Concede reads as "softening agreement", Rebut as
// "pushback", Question as "uncertainty".
const REACTION_COLORS = {
  Concede: 'green',
  Rebut: 'red',
  Question: 'yellow',
};

module.exports = { COLORS, STATUS_ICON, REACTION_COLORS };
