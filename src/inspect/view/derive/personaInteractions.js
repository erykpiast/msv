const MOVE_TYPES = ['Rebut', 'Concede', 'Question', 'Support'];

function emptyCell() {
  const out = {};
  for (const t of MOVE_TYPES) out[t] = 0;
  return out;
}

function derivePersonaInteractions(debates) {
  // Build a global lookup of move_id -> by_persona_id across every debate first.
  const moveAuthor = new Map();
  for (const debate of debates ?? []) {
    for (const move of debate.moves ?? []) moveAuthor.set(move.move_id, move.by_persona_id);
  }

  const matrix = {};
  function ensure(personaId) {
    if (!matrix[personaId]) matrix[personaId] = {};
    return matrix[personaId];
  }

  for (const debate of debates ?? []) {
    for (const move of debate.moves ?? []) {
      if (move.type === 'Claim') continue;
      if (!MOVE_TYPES.includes(move.type)) continue;
      const refId = move.references_move_id;
      if (!refId) continue;
      const target = moveAuthor.get(refId);
      if (!target || target === move.by_persona_id) continue;
      const row = ensure(move.by_persona_id);
      if (!row[target]) row[target] = emptyCell();
      row[target][move.type] += 1;
    }
  }

  return matrix;
}

module.exports = { derivePersonaInteractions, MOVE_TYPES };
