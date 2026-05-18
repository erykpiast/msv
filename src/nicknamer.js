'use strict';

// Cosmetic Haiku step that attaches a short, semantically-meaningful nickname
// (two or three kebab-case words) to entities whose IDs are otherwise hard to
// remember (forum nodes n_xxx, moves m_xxx, observations o_xxx, claims c_xxx).
//
// The pipeline never fails because of this module: generateNicknames swallows
// every error and returns an empty Map. Entities without a nickname fall back
// to their ID at the display layer.

const { runStructuredCall } = require('./anthropic');
const { NICKNAMER_MODEL } = require('./models');
const { NICKNAMER_WG, NICKNAMER_FORUM } = require('./agents/prompts');
const { appendLog } = require('./storage');

// Single canonical max length for nicknames. The schema, the prompts, and the
// sanitiser all use this constant — when changing, update prompts.js too.
const MAX_NICKNAME_LEN = 25;

const NICKNAMER_TOOL = {
  name: 'emit_nicknames',
  description:
    `Emit a short, memorable nickname for each provided id. Two or three lowercase kebab-case words, ≤${MAX_NICKNAME_LEN} chars, semantically tied to the item content, unique within this batch.`,
  input_schema: {
    type: 'object',
    required: ['nicknames'],
    additionalProperties: false,
    properties: {
      nicknames: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'nickname'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            nickname: { type: 'string', minLength: 1, maxLength: MAX_NICKNAME_LEN },
          },
        },
      },
    },
  },
};

// Two or three kebab segments only — matches the prompts' "two or three words"
// rule. Dedup suffixes (-2, -3) and claim suffixes (-c2, -c3) are applied
// after this regex passes; they intentionally bypass it.
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+){1,2}$/;
const CONTENT_TRUNCATE = 300;
const CONTEXT_TRUNCATE = 120;

function truncate(s, max = CONTENT_TRUNCATE) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  let nick = raw.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!nick) return null;
  if (nick.length > MAX_NICKNAME_LEN) {
    nick = nick.slice(0, MAX_NICKNAME_LEN).replace(/-$/, '');
  }
  return KEBAB_RE.test(nick) ? nick : null;
}

function deduplicate(pairs) {
  const seen = new Map();
  const out = new Map();
  for (const { id, nickname } of pairs) {
    if (!id || !nickname) continue;
    if (out.has(id)) continue; // first id wins; ignore duplicate id from the model
    let candidate = nickname;
    if (seen.has(candidate)) {
      let n = 2;
      while (seen.has(`${nickname}-${n}`)) n += 1;
      candidate = `${nickname}-${n}`;
    }
    seen.set(candidate, true);
    out.set(id, candidate);
  }
  return out;
}

function buildUserMessage({ kind, items, context }) {
  const header = [];
  if (context?.topic) header.push(`Topic: ${truncate(context.topic, CONTEXT_TRUNCATE)}`);
  if (context?.territoryName) {
    header.push(`Territory: ${truncate(context.territoryName, CONTEXT_TRUNCATE)}`);
  }
  if (Array.isArray(context?.personaNames) && context.personaNames.length) {
    const names = context.personaNames
      .map((n) => String(n ?? '').slice(0, 40))
      .filter(Boolean)
      .join(', ');
    if (names) header.push(`Personas: ${names}`);
  }
  const lines = items.map(({ id, content }) => `- ${id} :: ${truncate(content)}`);
  const kindLabel = kind === 'forum' ? 'forum nodes (surviving claims)' : 'moves and observations';
  return [
    ...header,
    '',
    `Produce one nickname for each of the following ${kindLabel}.`,
    `Constraints: 2 or 3 lowercase kebab-case words, ≤${MAX_NICKNAME_LEN} chars total, semantically tied to the item content, unique within this batch. Avoid generic words like "point", "claim", "item", or numeric suffixes.`,
    '',
    ...lines,
    '',
    'Invoke the emit_nicknames tool.',
  ].join('\n');
}

/**
 * Generate nicknames for a batch of entities. NEVER REJECTS — every error path
 * (API failure, schema mismatch, malformed tool output) resolves to an empty
 * Map. Callers do not need a try/catch.
 *
 * @param {object} client - Anthropic client.
 * @param {object} opts
 * @param {'wg'|'forum'} opts.kind - Selects the system prompt.
 * @param {{id: string, content: string}[]} opts.items - Entities to name.
 * @param {{topic?: string, territoryName?: string, personaNames?: string[]}} [opts.context]
 * @param {number} [opts.maxTokens=1200]
 * @returns {Promise<Map<string,string>>} id → nickname for entities that
 *   received a valid sanitised nickname. Empty when items is empty, when the
 *   LLM call failed, or when nothing in the response passed sanitisation.
 */
async function generateNicknames(
  client,
  { kind, items, context = {}, maxTokens = 1200, onError } = {}
) {
  if (!Array.isArray(items) || items.length === 0) return new Map();
  if (!client) return new Map();

  const system = kind === 'forum' ? NICKNAMER_FORUM : NICKNAMER_WG;
  const userMessage = buildUserMessage({ kind, items, context });

  let toolUse;
  try {
    const result = await runStructuredCall({
      client,
      system,
      model: NICKNAMER_MODEL,
      maxTokens,
      messages: [{ role: 'user', content: userMessage }],
      tools: [NICKNAMER_TOOL],
      forceTool: 'emit_nicknames',
    });
    toolUse = result.toolUse;
  } catch (err) {
    if (typeof onError === 'function') {
      onError({ reason: 'api_error', message: err?.message || String(err) });
    }
    return new Map();
  }

  const raw = Array.isArray(toolUse?.input?.nicknames) ? toolUse.input.nicknames : [];
  const validIds = new Set(items.map((i) => i.id));
  const cleaned = [];
  for (const { id, nickname } of raw) {
    if (!validIds.has(id)) continue;
    const sane = sanitizeNickname(nickname);
    if (!sane) continue;
    cleaned.push({ id, nickname: sane });
  }
  const deduped = deduplicate(cleaned);
  if (deduped.size === 0 && typeof onError === 'function') {
    onError({
      reason: raw.length === 0 ? 'empty_tool_input' : 'all_rejected',
      received: raw.length,
      valid: cleaned.length,
    });
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Attach helpers — orchestrate one Haiku call per natural batch boundary and
// mutate pipeline entities in place. Exposed for direct unit testing and so
// the orchestrators (working_group.js, forum.js) hold no nickname logic of
// their own.
// ---------------------------------------------------------------------------

// Collect the entities a given sub-stage just produced. Each sub-stage has a
// distinct shape: alignment/debate add moves filtered by `stage`, researcher
// adds findings nested under researcher_reports, observation adds observations.
function collectSubStageItems(subStage, result) {
  switch (subStage) {
    case 'alignment':
      return (result.moves || [])
        .filter((m) => m && m.stage === 'alignment' && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ id: m.move_id, content: `${m.type}: ${m.content}` }));
    case 'researcher':
      return (result.researcher_reports || []).flatMap((r) =>
        (r?.findings || [])
          .filter((f) => f && typeof f.summary === 'string' && f.summary.trim())
          .map((f) => ({ id: f.finding_id, content: f.summary }))
      );
    case 'observation':
      return (result.observations || [])
        .filter((o) => o && typeof o.content === 'string' && o.content.trim())
        .map((o) => ({ id: o.observation_id, content: o.content }));
    case 'debate':
      return (result.moves || [])
        .filter((m) => m && m.stage === 'debate' && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ id: m.move_id, content: `${m.type}: ${m.content}` }));
    default:
      throw new Error(`attachWorkingGroupNicknames: unknown subStage '${subStage}'`);
  }
}

// Apply the nickname Map to the right entity collection. Debate also
// propagates each move's nickname onto its surviving claims (each claim_id is
// `c_${move_id}_${NNN}`; first claim inherits, additional claims get -c2/-c3
// suffixes). This is the only sub-stage where a single Haiku batch hydrates
// two entity types.
function applyNicknames(subStage, result, nicknames) {
  if (subStage === 'alignment' || subStage === 'debate') {
    for (const m of result.moves || []) {
      const nick = nicknames.get(m.move_id);
      if (nick) m.nickname = nick;
    }
    if (subStage === 'debate') {
      const moveNickById = new Map();
      for (const m of result.moves || []) {
        if (m.nickname && m.stage === 'debate') moveNickById.set(m.move_id, m.nickname);
      }
      const perMoveCounter = new Map();
      for (const sc of result.surviving_claims || []) {
        const baseNick = moveNickById.get(sc.originating_move_id);
        if (!baseNick) continue;
        const count = (perMoveCounter.get(sc.originating_move_id) || 0) + 1;
        perMoveCounter.set(sc.originating_move_id, count);
        sc.nickname = count === 1 ? baseNick : `${baseNick}-c${count}`;
      }
    }
    return;
  }
  if (subStage === 'researcher') {
    for (const r of result.researcher_reports || []) {
      for (const f of r?.findings || []) {
        const nick = nicknames.get(f.finding_id);
        if (nick) f.nickname = nick;
      }
    }
    return;
  }
  if (subStage === 'observation') {
    for (const o of result.observations || []) {
      const nick = nicknames.get(o.observation_id);
      if (nick) o.nickname = nick;
    }
  }
}

/**
 * Name every entity produced by a single working-group sub-stage. Called
 * incrementally as each sub-stage completes so the dashboard, TUI log, and
 * inspect view see readable handles as soon as entities exist — rather than
 * waiting for the end of the working group.
 *
 * Mutates entities inside `result` in place. Never throws. On empty result,
 * emits `wg.nicknames.failed` with the failure reason.
 *
 * @param {object} args
 * @param {'alignment'|'researcher'|'observation'|'debate'} args.subStage
 */
async function attachWorkingGroupNicknames({
  client,
  idea,
  result,
  territory,
  personas,
  bus,
  territoryId,
  subStage,
}) {
  const items = collectSubStageItems(subStage, result);
  if (items.length === 0) return;

  // Larger WG sub-stages (observation: ~30; researcher findings: ~50–65) need
  // significantly more output tokens than the original 1200 default to encode
  // every {id, nickname} entry. The earlier cap caused silent truncation:
  // runStructuredCall threw, the swallow path returned an empty Map, and the
  // failure was invisible. 4000 fits even the researcher-findings batch with
  // headroom while still bounding cost.
  let failure = null;
  const nicknames = await generateNicknames(client, {
    kind: 'wg',
    items,
    maxTokens: 4000,
    context: {
      topic: idea?.raw_capture,
      territoryName: territory?.name,
      personaNames: (personas || []).map((p) => p?.name).filter(Boolean),
    },
    onError: (info) => {
      failure = info;
    },
  });

  if (nicknames.size === 0) {
    if (bus) bus.emit('wg.nicknames.failed', {
      territory_id: territoryId,
      sub_stage: subStage,
      attempted: items.length,
      reason: failure?.reason || 'unknown',
      detail: failure?.message || null,
    });
    if (idea?.id) {
      await appendLog(idea.id, `pair-${territoryId}-nicknames-${subStage}`, {
        kind: 'failed',
        payload: { attempted: items.length, failure },
      });
    }
    return;
  }

  applyNicknames(subStage, result, nicknames);

  if (bus) bus.emit('wg.nicknames.done', {
    territory_id: territoryId,
    sub_stage: subStage,
    count: nicknames.size,
  });
  if (idea?.id) {
    await appendLog(idea.id, `pair-${territoryId}-nicknames-${subStage}`, {
      kind: 'response',
      payload: { nicknames: Object.fromEntries(nicknames) },
    });
  }
}

/**
 * Name every forum node after ranking. Mutates nodes in place. Never throws.
 */
async function attachForumNicknames({ client, idea, nodes, bus }) {
  const items = (nodes || [])
    .filter((n) => typeof n?.content === 'string' && n.content.trim())
    .map((n) => ({ id: n.node_id, content: n.content }));
  if (items.length === 0) return;

  let failure = null;
  const nicknames = await generateNicknames(client, {
    kind: 'forum',
    items,
    context: { topic: idea?.raw_capture },
    onError: (info) => {
      failure = info;
    },
  });

  if (nicknames.size === 0) {
    if (bus) bus.emit('forum.nicknames.failed', {
      attempted: items.length,
      reason: failure?.reason || 'unknown',
      detail: failure?.message || null,
    });
    if (idea?.id) {
      await appendLog(idea.id, 'forum-nicknames', {
        kind: 'failed',
        payload: { attempted: items.length, failure },
      });
    }
    return;
  }

  for (const n of nodes) {
    const nick = nicknames.get(n.node_id);
    if (nick) n.nickname = nick;
  }

  if (bus) bus.emit('forum.nicknames.done', { count: nicknames.size });
  if (idea?.id) {
    await appendLog(idea.id, 'forum-nicknames', {
      kind: 'response',
      payload: { nicknames: Object.fromEntries(nicknames) },
    });
  }
}

module.exports = {
  generateNicknames,
  attachWorkingGroupNicknames,
  attachForumNicknames,
  // Exported for unit tests.
  sanitizeNickname,
  deduplicate,
  buildUserMessage,
  NICKNAMER_TOOL,
  MAX_NICKNAME_LEN,
};
