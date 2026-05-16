const { deriveConfidenceTrajectory } = require('./derive/confidenceTrajectory');
const { deriveContradictionEdges } = require('./derive/contradictionEdges');
const { derivePersonaInteractions } = require('./derive/personaInteractions');
const { deriveStageDurations } = require('./derive/stageDurations');
const { safeSlug } = require('../../storage');

// Coordinator emits territories with `id` (canonical) and a duplicate `territory_id`
// for older compatibility paths. Anywhere that resolves a territory by key should
// route through this helper so the choice of source field is consistent.
// The key is slugged so it matches the territory_id that working_group.js persisted
// on each pair_debates entry (which is also slugged for filesystem safety).
function territoryKey(t) {
  const raw = t?.id ?? t?.territory_id;
  return raw != null ? safeSlug(raw) : null;
}

function buildBudget(loaderInput) {
  const investigation = loaderInput.index?.investigation ?? {};
  const b = investigation.budget ?? {};
  let runtime_ms = null;
  if (investigation.started_at && investigation.completed_at) {
    const start = Date.parse(investigation.started_at);
    const end = Date.parse(investigation.completed_at);
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      runtime_ms = Math.max(0, end - start);
    }
  }
  return {
    used_executor_calls: b.used_executor_calls ?? 0,
    max_executor_calls: b.max_executor_calls ?? 0,
    used_total_tokens: b.used_total_tokens ?? 0,
    max_total_tokens: b.max_total_tokens ?? 0,
    used_researcher_tool_calls: b.used_researcher_tool_calls ?? undefined,
    max_researcher_tool_calls: b.max_researcher_tool_calls ?? undefined,
    runtime_ms,
  };
}

function buildSubQuestionMap(coordinatorDecisions) {
  const map = new Map();
  for (const which of ['initial', 'spawn']) {
    const decision = coordinatorDecisions?.[which];
    if (!decision || !Array.isArray(decision.sub_questions)) continue;
    for (const sq of decision.sub_questions) map.set(sq.id, sq);
  }
  return map;
}

function buildTerritoryMap(coordinatorDecisions) {
  const map = new Map();
  const territories = coordinatorDecisions?.initial?.territories ?? [];
  for (const t of territories) {
    const key = territoryKey(t);
    if (key) map.set(key, t);
  }
  return map;
}

function buildPersonaIndex(perspectiveDiscovery) {
  const candidates = perspectiveDiscovery?.candidate_personas ?? [];
  const map = new Map();
  for (const p of candidates) map.set(p.id, p);
  return map;
}

function buildDiscovery(loaderInput) {
  const pd = loaderInput.index?.investigation?.perspective_discovery ?? {};
  return {
    search_queries: pd.search_queries ?? [],
    web_search_results: loaderInput.enrichments.discovery.web_search_results ?? [],
    candidate_personas: pd.candidate_personas ?? [],
    selected_persona_ids: pd.selected_persona_ids ?? [],
    fixed_personas: pd.fixed_personas ?? [],
    selection_distinctness: pd.selection_distinctness ?? {},
  };
}

function buildCoordinator(loaderInput) {
  const cd = loaderInput.index?.investigation?.coordinator_decisions ?? {};
  const enrichment = loaderInput.enrichments.coordinator;
  const initial = cd.initial
    ? {
        decided_at: cd.initial.decided_at ?? null,
        sub_questions: cd.initial.sub_questions ?? [],
      }
    : null;
  const spawnRaw = cd.spawn;
  let spawn = null;
  if (spawnRaw) {
    spawn = {
      decided_at: spawnRaw.decided_at ?? null,
      sub_questions: spawnRaw.sub_questions ?? [],
      reason: enrichment.spawn_reason ?? spawnRaw.reason ?? null,
      declined: enrichment.spawn_declined || (spawnRaw.sub_questions ?? []).length === 0,
    };
  } else if (enrichment.spawn_declined) {
    spawn = {
      decided_at: null,
      sub_questions: [],
      reason: enrichment.spawn_reason ?? null,
      declined: true,
    };
  }
  // v5: expose territories
  const territories = cd.initial?.territories ?? [];
  return { initial, spawn, territories };
}

function buildDebates(loaderInput) {
  const debates = loaderInput.index?.investigation?.pair_debates ?? [];
  const sqMap = buildSubQuestionMap(loaderInput.index?.investigation?.coordinator_decisions);
  const personaMap = buildPersonaIndex(loaderInput.index?.investigation?.perspective_discovery);
  const enr = loaderInput.enrichments.debates;
  const out = {};

  for (const debate of debates) {
    const sqId = debate.sub_question_id;
    if (!sqId) continue; // v5 debates have territory_id, not sub_question_id
    const sub_question = sqMap.get(sqId) ?? null;
    const assignedPair = sub_question?.assigned_pair ?? [];
    const pair = assignedPair.map((pid) => personaMap.get(pid) ?? { id: pid, name: pid, tradition: '', stance: '', description: '' });
    const moveEnrichments = enr[sqId]?.moves ?? {};
    const moves = (debate.moves ?? []).map((move) => ({
      ...move,
      attempt: moveEnrichments[move.move_id]?.attempt ?? null,
      synthesized: moveEnrichments[move.move_id]?.synthesized ?? false,
      usage: moveEnrichments[move.move_id]?.usage ?? null,
    }));
    const synthesizedCount = moves.filter((m) => m.synthesized).length;
    out[sqId] = {
      sub_question,
      pair,
      moves,
      surviving_claims: debate.surviving_claims ?? [],
      terminated_by: debate.terminated_by ?? null,
      confidence_trajectory: deriveConfidenceTrajectory(debate),
      synthesized_move_count: synthesizedCount,
    };
  }
  return out;
}

function buildWorkingGroups(loaderInput) {
  const debates = loaderInput.index?.investigation?.pair_debates ?? [];
  const territoryMap = buildTerritoryMap(loaderInput.index?.investigation?.coordinator_decisions);
  const personaMap = buildPersonaIndex(loaderInput.index?.investigation?.perspective_discovery);
  const logs = loaderInput.logs ?? {};
  const out = {};

  for (const debate of debates) {
    const tid = debate.territory_id;
    if (!tid) continue; // v4 debates have sub_question_id, not territory_id

    const territory = territoryMap.get(tid) ?? null;
    const assignedPair = territory?.assigned_pair ?? debate.assigned_pair ?? [];
    const pair = assignedPair.map((pid) => personaMap.get(pid) ?? { id: pid, name: pid, tradition: '', stance: '', description: '' });

    // Enrich debate moves from the v5 debate log (pair-{tid}-debate).
    const debateLogKey = `pair-${tid}-debate`;
    const debateRecords = logs[debateLogKey] ?? [];
    const moveEnrichments = buildMoveEnrichmentsFromRecords(debateRecords, debate.moves ?? []);
    const moves = (debate.moves ?? []).map((move) => ({
      ...move,
      attempt: moveEnrichments[move.move_id]?.attempt ?? null,
      synthesized: moveEnrichments[move.move_id]?.synthesized ?? false,
      usage: moveEnrichments[move.move_id]?.usage ?? null,
    }));

    out[tid] = {
      territory,
      pair,
      candidate_questions: debate.candidate_questions ?? [],
      adversarial_marks: debate.adversarial_marks ?? [],
      aligned_questions: debate.aligned_questions ?? [],
      researcher_reports: debate.researcher_reports ?? [],
      observations: debate.observations ?? [],
      moves,
      surviving_claims: debate.surviving_claims ?? [],
      terminated_by: debate.terminated_by ?? null,
      confidence_trajectory: deriveConfidenceTrajectory(debate),
    };
  }
  return out;
}

function buildMoveEnrichmentsFromRecords(records, moves) {
  const byPersona = new Map();
  for (const record of records) {
    if (record.kind !== 'response' && record.kind !== 'synthesized_move') continue;
    const personaId = record.payload?.persona_id;
    if (!personaId) continue;
    if (!byPersona.has(personaId)) byPersona.set(personaId, []);
    byPersona.get(personaId).push(record);
  }
  const movesByPersona = new Map();
  for (const move of moves) {
    const pid = move.by_persona_id;
    if (!movesByPersona.has(pid)) movesByPersona.set(pid, []);
    movesByPersona.get(pid).push(move);
  }
  const result = {};
  for (const [pid, personaMoves] of movesByPersona.entries()) {
    const personaResponses = byPersona.get(pid) || [];
    personaMoves.forEach((move, idx) => {
      const response = personaResponses[idx];
      if (!response) return;
      const payload = response.payload || {};
      result[move.move_id] = {
        attempt: payload.attempt ?? null,
        synthesized: response.kind === 'synthesized_move',
        usage: payload.usage ?? null,
      };
    });
  }
  return result;
}

function buildCrossPollinationWithTargets(loaderInput) {
  const cp = loaderInput.index?.investigation?.cross_pollination ?? [];
  const nodes = loaderInput.index?.investigation?.forum?.nodes ?? [];
  const claimToNodeId = new Map();
  for (const node of nodes) claimToNodeId.set(node.claim_id, node.node_id);
  return cp.map((entry) => ({
    claim_id: entry.claim_id,
    reactions: entry.reactions ?? [],
    target_node_id: claimToNodeId.get(entry.claim_id) ?? null,
  }));
}

function buildForum(loaderInput) {
  const forum = loaderInput.index?.investigation?.forum ?? { nodes: [] };
  const nodes = forum.nodes ?? [];
  const verdicts = loaderInput.enrichments.forum.contradiction_verdicts ?? {};
  const contradiction_edges = deriveContradictionEdges(nodes, verdicts);
  return {
    nodes,
    contradiction_edges,
    contradiction_verdicts: verdicts,
    dead_end_questions: forum.dead_end_questions ?? [],
  };
}

function buildSynthesis(loaderInput) {
  const synth = loaderInput.index?.investigation?.synthesis;
  if (!synth) return null;
  return {
    report: synth.report ?? '',
    headline_findings: synth.headline_findings ?? [],
    open_tensions: synth.open_tensions ?? [],
    question_landscape: synth.question_landscape ?? undefined,
    dead_end_summary: synth.dead_end_summary ?? undefined,
  };
}

function buildView(loaderInput) {
  const index = loaderInput.index ?? {};
  const investigation = index.investigation ?? {};
  const schemaVersion = investigation.schema_version ?? 'v4';

  const base = {
    id: index.id,
    raw_capture: index.raw_capture,
    status: index.status,
    parent_id: index.parent_id ?? null,
    captured_at: index.captured_at ?? null,
    last_action_at: index.last_action_at ?? null,
    model: investigation.model ?? null,
    schema_version: schemaVersion,
    budget: buildBudget(loaderInput),
    stages: deriveStageDurations(loaderInput),
    discovery: buildDiscovery(loaderInput),
    coordinator: buildCoordinator(loaderInput),
    cross_pollination: buildCrossPollinationWithTargets(loaderInput),
    forum: buildForum(loaderInput),
    synthesis: buildSynthesis(loaderInput),
    persona_interactions: derivePersonaInteractions(investigation.pair_debates ?? []),
    parse_errors: loaderInput.enrichments.parseErrors.parse_errors ?? [],
  };

  if (schemaVersion === 'v5') {
    return {
      ...base,
      debates: {},
      working_groups: buildWorkingGroups(loaderInput),
    };
  }

  return {
    ...base,
    debates: buildDebates(loaderInput),
    working_groups: {},
  };
}

module.exports = { buildView };
