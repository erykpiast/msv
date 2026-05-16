const { deriveConfidenceTrajectory } = require('./derive/confidenceTrajectory');
const { deriveContradictionEdges } = require('./derive/contradictionEdges');
const { derivePersonaInteractions } = require('./derive/personaInteractions');
const { deriveStageDurations } = require('./derive/stageDurations');

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
  // `spawn` is null when the spawn round has not executed at all (the in-flight
  // state). It is a populated object — possibly with declined: true — once the
  // coordinator has emitted either a decision or a `declined` log record.
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
  return { initial, spawn };
}

function buildDebates(loaderInput) {
  const debates = loaderInput.index?.investigation?.pair_debates ?? [];
  const sqMap = buildSubQuestionMap(loaderInput.index?.investigation?.coordinator_decisions);
  const personaMap = buildPersonaIndex(loaderInput.index?.investigation?.perspective_discovery);
  const enr = loaderInput.enrichments.debates;
  const out = {};

  for (const debate of debates) {
    const sqId = debate.sub_question_id;
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
  // Surface the raw verdict map too — the NodeDrawer uses it to show
  // "not the most pointed" contradictions that didn't make the edges cut.
  return { nodes, contradiction_edges, contradiction_verdicts: verdicts };
}

function buildSynthesis(loaderInput) {
  const synth = loaderInput.index?.investigation?.synthesis;
  if (!synth) return null;
  return {
    report: synth.report ?? '',
    headline_findings: synth.headline_findings ?? [],
    open_tensions: synth.open_tensions ?? [],
  };
}

function buildView(loaderInput) {
  const index = loaderInput.index ?? {};
  const investigation = index.investigation ?? {};

  return {
    id: index.id,
    raw_capture: index.raw_capture,
    status: index.status,
    parent_id: index.parent_id ?? null,
    captured_at: index.captured_at ?? null,
    last_action_at: index.last_action_at ?? null,
    model: investigation.model ?? null,
    budget: buildBudget(loaderInput),
    stages: deriveStageDurations(loaderInput),
    discovery: buildDiscovery(loaderInput),
    coordinator: buildCoordinator(loaderInput),
    debates: buildDebates(loaderInput),
    cross_pollination: buildCrossPollinationWithTargets(loaderInput),
    forum: buildForum(loaderInput),
    synthesis: buildSynthesis(loaderInput),
    persona_interactions: derivePersonaInteractions(investigation.pair_debates ?? []),
    parse_errors: loaderInput.enrichments.parseErrors.parse_errors ?? [],
  };
}

module.exports = { buildView };
