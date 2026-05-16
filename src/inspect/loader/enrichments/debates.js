const { bracketTimings } = require('./timings');

function groupResponsesByPersona(records) {
  const byPersona = new Map();
  for (const record of records) {
    if (record.kind !== 'response' && record.kind !== 'synthesized_move') continue;
    const personaId = record.payload?.persona_id;
    if (!personaId) continue;
    if (!byPersona.has(personaId)) byPersona.set(personaId, []);
    byPersona.get(personaId).push(record);
  }
  return byPersona;
}

function enrichDebates(logs, index) {
  const debates = index?.investigation?.pair_debates ?? [];
  const enriched = {};

  for (const debate of debates) {
    const sqId = debate.sub_question_id;
    const logKey = `pair-${sqId}`;
    const records = logs[logKey];
    const baseEntry = {
      timings: bracketTimings(records),
      moves: {},
    };

    if (!records || records.length === 0) {
      enriched[sqId] = baseEntry;
      continue;
    }

    // For each persona, walk their moves in order and zip with their log responses.
    // Log responses always appear in causal order for a given persona, matching the
    // moves[] array order — so a positional zip avoids fragile sequence-number parsing.
    const responsesByPersona = groupResponsesByPersona(records);
    const movesByPersona = new Map();
    for (const move of debate.moves || []) {
      const personaId = move.by_persona_id;
      if (!movesByPersona.has(personaId)) movesByPersona.set(personaId, []);
      movesByPersona.get(personaId).push(move);
    }

    for (const [personaId, personaMoves] of movesByPersona.entries()) {
      const personaResponses = responsesByPersona.get(personaId) || [];
      personaMoves.forEach((move, idx) => {
        const response = personaResponses[idx];
        if (!response) return;
        const payload = response.payload || {};
        baseEntry.moves[move.move_id] = {
          attempt: payload.attempt ?? null,
          synthesized: response.kind === 'synthesized_move',
          usage: payload.usage ?? null,
          stop_reason: payload.stop_reason ?? null,
        };
      });
    }

    enriched[sqId] = baseEntry;
  }

  return enriched;
}

module.exports = { enrichDebates };
