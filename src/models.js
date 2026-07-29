'use strict';

// Model constants — no project imports to avoid circular dependencies.
const MODEL = 'claude-sonnet-5';
const SYNTHESIZER_MODEL = 'claude-opus-5';
// Separate constant so the nicknamer can be retuned without dragging the
// synthesizer along (cosmetic, batch-mode, latency-sensitive).
const NICKNAMER_MODEL = 'claude-haiku-4-5-20251001';
// Cheap classifier call (topic text in, 1-10 score out) ahead of the
// coordinator — kept independent of NICKNAMER_MODEL so either can be
// retuned without affecting the other, even though both start on haiku.
const SCOPE_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

module.exports = { MODEL, SYNTHESIZER_MODEL, NICKNAMER_MODEL, SCOPE_JUDGE_MODEL };
