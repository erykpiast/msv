'use strict';

const { runStructuredCall } = require('../anthropic');
const { COORDINATOR_TERRITORIES } = require('./prompts');
const { appendLog } = require('../storage');
const { pairDistinctnessScore } = require('../diversity');

const DEFAULT_TARGET_TERRITORY_COUNT = 5;

// Preferred number of territories a topic-specific persona anchors. This is a
// SOFT target, not a hard cap: assignPersonaPairs spreads personas so nobody
// exceeds it while under-used personas remain, but when a territory's whole
// recommended list is already at the cap it will gracefully reuse the
// best-ranked persona a third (or fourth) time rather than fail. Fixed
// (universal) personas are exempt entirely — they are meant to anchor freely.
const SOFT_PERSONA_CAP = 2;

// The model ranks candidate personas per territory rather than committing to a
// pair, so the schema wants an ordered list, not a 2-element array. We need at
// least two names to seed a pair and a few more to give the deterministic
// assigner room to route around personas that are already at the soft cap.
function personaListBounds(personaCount) {
  return {
    minItems: Math.min(3, Math.max(2, personaCount)),
    maxItems: Math.max(2, personaCount),
  };
}

function territorySchema(personaCount) {
  const { minItems, maxItems } = personaListBounds(personaCount);
  return {
    type: 'object',
    required: ['name', 'description', 'recommended_personas'],
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 20,
        description: 'Short kebab-case label, e.g. "cognitive-load".',
      },
      description: {
        type: 'string',
        minLength: 1,
        description: '1–2 sentences explaining what terrain this covers.',
      },
      rationale: { type: 'string' },
      recommended_personas: {
        type: 'array',
        items: { type: 'string' },
        minItems,
        maxItems,
        description:
          'Persona ids best suited to co-investigate this territory, ranked most-suitable first. The final pair is chosen downstream; just rank by fit and productive tension.',
      },
    },
  };
}

// Schema range is built from the scope judge's target T (see scope_judge.js)
// instead of a hardcoded 3-5 — a tight band around T rather than an exact
// count, since forcing the model to hit T precisely produces worse
// territories than letting it land within +/-1. There is no capacity clamp:
// assignPersonaPairs can staff any T from any non-empty roster (reusing
// personas past the soft cap when it must), so the roster size no longer
// bounds the territory count.
function emitTerritoriesTool(targetCount = DEFAULT_TARGET_TERRITORY_COUNT, personaCount = 0) {
  const minItems = Math.max(2, targetCount - 1);
  const maxItems = targetCount + 1;
  return {
    name: 'emit_territories',
    description: `Emit ${minItems}–${maxItems} broad intellectual territories, each with a ranked list of recommended persona ids.`,
    input_schema: {
      type: 'object',
      required: ['territories'],
      additionalProperties: false,
      properties: {
        territories: {
          type: 'array',
          minItems,
          maxItems,
          items: territorySchema(personaCount),
        },
      },
    },
  };
}

function renderPersonaSummary(personas) {
  return personas
    .map(
      (p) =>
        `- ${p.id} · ${p.name}${p.fixed ? ' (universal — a good default anchor for any territory)' : ''}\n  tradition: ${p.tradition}\n  stance: ${p.stance}`
    )
    .join('\n');
}

function renderPairScores(personas) {
  const rows = [];
  for (let i = 0; i < personas.length; i += 1) {
    for (let j = i + 1; j < personas.length; j += 1) {
      const score = pairDistinctnessScore(personas[i], personas[j]);
      rows.push(`${personas[i].id} × ${personas[j].id} → ${score}`);
    }
  }
  return rows.join('\n');
}

// Deterministic persona assignment — the single source of truth for who
// anchors each territory. The model only ranks candidates (recommended_personas,
// most-suitable first); this function turns those rankings into a concrete
// 2-persona pair per territory while balancing load, so there is no
// LLM-steered cap to drift out of and no corrective-retry loop to fail.
//
// Per territory, from its ranked recommendations (valid ids only, de-duped):
//   1. Fill both slots with the highest-ranked personas still UNDER the soft
//      cap — "assign whoever is left", honouring the model's ranking. Fixed
//      personas count as always-under-cap, so a highly-ranked universal
//      persona is taken in rank order.
//   2. If the recommended list can't fill two slots that way (every remaining
//      recommendation is at the cap), reuse the best-ranked one a further
//      time — choosing by (usage asc, rank asc), i.e. the most-recommended
//      persona for its 3rd use, or the next-recommended if the first already
//      took a 3rd.
//   3. If the recommended list is too short to yield two distinct personas,
//      backfill from the full roster (least-used first, which favours the
//      unlimited fixed personas), so every territory always gets a valid pair.
function assignPersonaPairs(territories, personas) {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const fixedIds = new Set(personas.filter((p) => p.fixed).map((p) => p.id));
  const usage = new Map(personas.map((p) => [p.id, 0]));
  // Fixed personas never accrue overuse pressure — they anchor freely — so
  // treat their load as 0 for every ranking decision below.
  const load = (id) => (fixedIds.has(id) ? 0 : usage.get(id) || 0);

  return territories.map((t, index) => {
    const ranked = [];
    const seen = new Set();
    for (const id of t.recommended_personas || []) {
      if (byId.has(id) && !seen.has(id)) {
        seen.add(id);
        ranked.push(id);
      }
    }

    const chosen = [];
    const rankIndex = (id) => ranked.indexOf(id);

    // Pass 1: honour ranking, skip anyone at the soft cap.
    for (const id of ranked) {
      if (chosen.length === 2) break;
      if (load(id) < SOFT_PERSONA_CAP) chosen.push(id);
    }

    // Pass 2: graceful reuse — everyone recommended is capped, so reuse the
    // least-used (tie-break: best-ranked) recommendation.
    if (chosen.length < 2) {
      const reusable = ranked
        .filter((id) => !chosen.includes(id))
        .sort((a, b) => load(a) - load(b) || rankIndex(a) - rankIndex(b));
      for (const id of reusable) {
        if (chosen.length === 2) break;
        chosen.push(id);
      }
    }

    // Pass 3: recommendation list too short — backfill from the roster,
    // least-used first (which favours the exempt fixed personas).
    if (chosen.length < 2) {
      const backfill = personas
        .map((p) => p.id)
        .filter((id) => !chosen.includes(id))
        .sort((a, b) => load(a) - load(b) || a.localeCompare(b));
      for (const id of backfill) {
        if (chosen.length === 2) break;
        chosen.push(id);
      }
    }

    for (const id of chosen) usage.set(id, (usage.get(id) || 0) + 1);

    const score = pairDistinctnessScore(byId.get(chosen[0]), byId.get(chosen[1]));
    const territoryId = `t_${String(index + 1).padStart(3, '0')}`;
    return {
      id: territoryId,
      territory_id: territoryId,
      name: t.name,
      description: t.description,
      rationale: t.rationale || '',
      assigned_pair: chosen,
      pair_distinctness_score: score,
    };
  });
}

// Returns true when the tool call is unusable because it was cut off mid-JSON:
// either the forced tool never made it into the response (toolUse === null),
// or it did appear but its required `territories` array is missing/malformed
// — the same "truncated but present" case researcher.js's normalizeReport
// guards against for `findings`.
function isUnrecoverableTruncation({ toolUse, truncated }) {
  if (!truncated) return false;
  if (!toolUse) return true;
  return !Array.isArray(toolUse.input && toolUse.input.territories);
}

// A truncated retry can still carry the previous attempt's tool_use block,
// which has no paired tool_result and would otherwise be rejected by the API
// (see synthesizer.js's malformed-payload retry for the same fix, and
// discovery.js's cleanedContent handling for the origin of this pattern).
function dropToolUseBlock(content, toolName) {
  return (content || []).filter((block) => !(block.type === 'tool_use' && block.name === toolName));
}

async function runCoordinatorInitial({
  client,
  idea,
  model,
  budget,
  personas,
  bus,
  targetTerritoryCount = DEFAULT_TARGET_TERRITORY_COUNT,
}) {
  const personaSummary = renderPersonaSummary(personas);
  const pairScores = renderPairScores(personas);
  const territoriesTool = emitTerritoriesTool(targetTerritoryCount, personas.length);

  await appendLog(idea.id, 'coordinator', {
    kind: 'request',
    payload: {
      persona_ids: personas.map((p) => p.id),
      target_territory_count: targetTerritoryCount,
    },
  });

  const messages = [
    {
      role: 'user',
      content: `Topic: ${idea.raw_capture}\n\nPersona roster:\n${personaSummary}\n\nPair-distinctness scores (higher = more tension):\n${pairScores}\n\nDecompose the topic into approximately ${targetTerritoryCount} broad territories and, for each, rank the personas best suited to investigate it. Invoke emit_territories.`,
    },
  ];

  const callArgs = {
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system: COORDINATOR_TERRITORIES(targetTerritoryCount),
    // Bumped from 2400. This call forces a single small structured emit (a
    // handful of territories, each a short kebab-case name + 1-2 sentence
    // description + a ranked persona list — nowhere near researcher.js's
    // findings arrays), but it shares the same adaptive-thinking + forced-tool
    // shape that caused silent truncation at persona.js's 1200-token ceiling
    // in production: adaptive thinking competes with the final JSON for the
    // same max_tokens budget, so a tight ceiling can starve the emit even when
    // the emitted payload itself is small. 4000 gives that thinking headroom
    // without reaching for researcher/synthesizer-sized ceilings this schema
    // doesn't need.
    maxTokens: 4000,
    // Bumped from the 60s default (see api_queue.js's isRetryable fix): this
    // call's adaptive thinking routinely runs close to or past 60s, which
    // left almost no wall-clock budget (default 90s) for the queue to retry
    // a genuine timeout. 120s mirrors discovery.js's precedent for its own
    // thinking-heavy calls.
    timeoutMs: 120_000,
    messages,
    tools: [territoriesTool],
    forceTool: 'emit_territories',
  };

  let result = await runStructuredCall(callArgs);

  // Recoverable max_tokens truncation: give the model exactly one more shot
  // at a shorter, complete emit before treating this early, high-leverage
  // decision as lost. This is a cheap, single-shot call (unlike researcher's
  // multi-turn loop), so a retry here is low-cost; if it also truncates or
  // comes back malformed, we fall through and let the error propagate to
  // run.js, which already classifies/checkpoints thrown errors for resume
  // (see src/commands/run.js's per-idea try/catch) rather than silently
  // continuing with partial/garbage territories.
  if (isUnrecoverableTruncation(result)) {
    await appendLog(idea.id, 'coordinator', {
      kind: 'truncation_retry',
      payload: {
        stop_reason: result.response.stop_reason,
        reason: result.toolUse ? 'territories_missing_or_malformed' : 'tool_use_missing',
      },
    });
    const cleanedContent = dropToolUseBlock(result.response.content, 'emit_territories');
    const retryMessages = [
      ...messages,
      ...(cleanedContent.length > 0 ? [{ role: 'assistant', content: cleanedContent }] : []),
      {
        role: 'user',
        content: `Your previous emit_territories call was cut off by the max_tokens limit before it could finish. Re-emit it now via emit_territories — keep it to ${Math.max(2, targetTerritoryCount - 1)} territories with concise descriptions so it fits within budget this time.`,
      },
    ];
    result = await runStructuredCall({ ...callArgs, messages: retryMessages });
  }

  const { response, toolUse, usage } = result;

  if (isUnrecoverableTruncation(result)) {
    throw new Error(
      `Coordinator emit_territories truncated after retry; got stop_reason=${response.stop_reason}`
    );
  }

  // Deterministic assignment owns persona balancing end-to-end: the model's
  // ranked recommendations go in, valid 2-persona pairs come out, no cap to
  // enforce and no corrective retry to fail.
  const territories = assignPersonaPairs(toolUse.input.territories || [], personas);

  await appendLog(idea.id, 'coordinator', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      territory_count: territories.length,
    },
  });

  if (bus) bus.emit('coordinator.territories.emitted', {
    count: territories.length,
    names: territories.map((t) => t.name || t.id || t.territory_id),
  });

  return {
    decided_at: new Date().toISOString(),
    territories,
    usage,
  };
}

module.exports = {
  runCoordinatorInitial,
  isUnrecoverableTruncation,
  emitTerritoriesTool,
  assignPersonaPairs,
  DEFAULT_TARGET_TERRITORY_COUNT,
};
