'use strict';

// Model constants — no project imports to avoid circular dependencies.
const MODEL = 'claude-sonnet-4-6';
const SYNTHESIZER_MODEL = 'claude-haiku-4-5-20251001';
// Separate constant so the nicknamer can be retuned without dragging the
// synthesizer along (cosmetic, batch-mode, latency-sensitive).
const NICKNAMER_MODEL = 'claude-haiku-4-5-20251001';

module.exports = { MODEL, SYNTHESIZER_MODEL, NICKNAMER_MODEL };
