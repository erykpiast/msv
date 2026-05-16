const STAGES_V4 = [
  { key: 'discovery', label: 'Discovery', detail_ref: 'discovery' },
  { key: 'coordinator_initial', label: 'Coordinator — initial', detail_ref: 'coordinator' },
  { key: 'debates', label: 'Pair debates', detail_ref: 'debates' },
  { key: 'cross_pollination', label: 'Cross-pollination', detail_ref: 'forum' },
  { key: 'forum', label: 'Forum', detail_ref: 'forum' },
  { key: 'coordinator_spawn', label: 'Coordinator — spawn', detail_ref: 'coordinator' },
  { key: 'synthesis', label: 'Synthesis', detail_ref: 'synthesis' },
];

const STAGES_V5 = [
  { key: 'discovery', label: 'Discovery', detail_ref: 'discovery' },
  { key: 'coordinator_initial', label: 'Coordinator — territories', detail_ref: 'coordinator' },
  { key: 'debates', label: 'Working groups', detail_ref: 'debates' },
  { key: 'cross_pollination', label: 'Cross-pollination', detail_ref: 'forum' },
  { key: 'forum', label: 'Forum', detail_ref: 'forum' },
  { key: 'synthesis', label: 'Synthesis', detail_ref: 'synthesis' },
];

// Keep STAGES as the v4 default for backward compat with any direct imports.
const STAGES = STAGES_V4;

function computeDuration(started_at, completed_at) {
  if (!started_at || !completed_at) return null;
  const start = Date.parse(started_at);
  const end = Date.parse(completed_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function resolveStatus({ started_at, completed_at, marker }) {
  if (marker === 'skipped') return 'skipped';
  if (marker === 'failed') return 'failed';
  if (!started_at && !completed_at) return 'not_run';
  if (started_at && !completed_at) return 'partial';
  return 'done';
}

function deriveStageDurations(loaderInput) {
  const enr = loaderInput.enrichments;
  const investigation = loaderInput.index?.investigation ?? {};
  const schemaVersion = investigation.schema_version ?? 'v4';
  const debates = investigation.pair_debates ?? [];

  // For v4: bracket timings from pair-{sqId} logs; for v5: pair-{tid}-debate logs.
  const debateBracket = (() => {
    let earliest = null;
    let latest = null;
    for (const debate of debates) {
      const key = debate.sub_question_id ?? debate.territory_id;
      const t = enr.debates[key]?.timings;
      if (!t) continue;
      if (t.started_at && (!earliest || t.started_at < earliest)) earliest = t.started_at;
      if (t.completed_at && (!latest || t.completed_at > latest)) latest = t.completed_at;
    }
    return { started_at: earliest, completed_at: latest };
  })();

  const forumConstructedAt = investigation.forum?.constructed_at ?? null;
  const forumTimings = enr.forum.timings;
  const forumStartedAt = forumTimings.started_at ?? null;
  const forumCompletedAt = forumConstructedAt ?? forumTimings.completed_at ?? null;

  const synth = investigation.synthesis;

  const initialSqCount = investigation.coordinator_decisions?.initial?.sub_questions?.length ?? 0;
  const initialTerritoryCount = investigation.coordinator_decisions?.initial?.territories?.length ?? 0;
  const spawnSqCount = investigation.coordinator_decisions?.spawn?.sub_questions?.length ?? 0;
  const totalMoves = debates.reduce((acc, d) => acc + (d.moves?.length ?? 0), 0);
  const survivingClaims = debates.reduce((acc, d) => acc + (d.surviving_claims?.length ?? 0), 0);
  const forumNodeCount = investigation.forum?.nodes?.length ?? 0;
  const reactionCount = (investigation.cross_pollination ?? []).reduce(
    (acc, cp) => acc + (cp.reactions?.length ?? 0),
    0
  );
  const headlineCount = synth?.headline_findings?.length ?? 0;

  const summaries = {
    discovery: () => {
      const queries = investigation.perspective_discovery?.search_queries?.length ?? 0;
      const selected = investigation.perspective_discovery?.selected_persona_ids?.length ?? 0;
      const candidates = investigation.perspective_discovery?.candidate_personas?.length ?? 0;
      return `${queries} search ${queries === 1 ? 'query' : 'queries'} · ${selected}/${candidates} personas selected`;
    },
    coordinator_initial: () =>
      schemaVersion === 'v5'
        ? `${initialTerritoryCount} ${initialTerritoryCount === 1 ? 'territory' : 'territories'}`
        : `${initialSqCount} sub-question${initialSqCount === 1 ? '' : 's'}`,
    debates: () =>
      schemaVersion === 'v5'
        ? `${debates.length} ${debates.length === 1 ? 'working group' : 'working groups'} · ${totalMoves} moves`
        : `${totalMoves} moves · ${survivingClaims} surviving claim${survivingClaims === 1 ? '' : 's'}`,
    cross_pollination: () => `${reactionCount} reaction${reactionCount === 1 ? '' : 's'}`,
    forum: () => `${forumNodeCount} node${forumNodeCount === 1 ? '' : 's'}`,
    coordinator_spawn: () => {
      if (enr.coordinator.spawn_declined) {
        return enr.coordinator.spawn_reason
          ? `declined — ${enr.coordinator.spawn_reason}`
          : 'declined';
      }
      return `${spawnSqCount} sub-question${spawnSqCount === 1 ? '' : 's'}`;
    },
    synthesis: () => (synth ? `${headlineCount} headline finding${headlineCount === 1 ? '' : 's'}` : ''),
  };

  const stageInputs = {
    discovery: enr.discovery.timings,
    coordinator_initial: enr.coordinator.timings.initial,
    debates: debateBracket,
    cross_pollination: enr.crossPollination.timings,
    forum: { started_at: forumStartedAt, completed_at: forumCompletedAt },
    coordinator_spawn: {
      ...enr.coordinator.timings.spawn,
      marker: enr.coordinator.spawn_declined ? 'skipped' : null,
    },
    synthesis: synth
      ? {
          started_at: enr.synthesis.timings.started_at,
          completed_at: synth.produced_at ?? enr.synthesis.timings.completed_at,
        }
      : { started_at: null, completed_at: null },
  };

  const stages = schemaVersion === 'v5' ? STAGES_V5 : STAGES_V4;
  return stages.map(({ key, label, detail_ref }) => {
    const raw = stageInputs[key] ?? {};
    const started_at = raw.started_at ?? null;
    const completed_at = raw.completed_at ?? null;
    const status = resolveStatus({ started_at, completed_at, marker: raw.marker });
    const summary = status === 'not_run' ? null : summaries[key]?.() ?? null;
    return {
      key,
      label,
      status,
      started_at,
      completed_at,
      duration_ms: computeDuration(started_at, completed_at),
      summary: summary || null,
      detail_ref,
    };
  });
}

module.exports = { deriveStageDurations, STAGES };
