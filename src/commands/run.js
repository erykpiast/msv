const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const {
  ensureStorageDirs,
  ensureIdeaDirs,
  listIdeasByStatus,
  readIdea,
  writeIdea,
  freshInvestigation,
} = require('../storage');
const { createClient, getStats } = require('../anthropic');
const { MODEL, SYNTHESIZER_MODEL } = require('../models');
const {
  FIXED_PERSONAS,
  selectDiversePersonas,
  selectReactorPermutation,
} = require('../diversity');
const { runPerspectiveDiscovery } = require('../agents/discovery');
const { runCoordinatorInitial } = require('../agents/coordinator');
const { runCrossPollinationReaction } = require('../agents/persona');
const { runWorkingGroup } = require('../working_group');
const { aggregateForum } = require('../forum');
const { runSynthesizer } = require('../agents/synthesizer');

function parseRunSelection(args) {
  if (args.length === 0) {
    return { mode: 'usage' };
  }
  if (args[0] === '--all') {
    return { mode: 'all' };
  }
  return { mode: 'single', id: args[0] };
}

function progress(line) {
  process.stdout.write(`${line}\n`);
}

// Print "...still working (Ns)" every HEARTBEAT_MS while fn is in flight so
// long stages (web_search, model calls) don't look stuck.
const HEARTBEAT_MS = 15000;
async function withHeartbeat(label, fn) {
  const start = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`→      [${label}] …still working (${seconds}s)\n`);
  }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function ensureConfirmation(idea) {
  if (idea.status !== 'ready') return true;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await rl.question(`Idea ${idea.id} is already ready; re-run? [y/N] `)
    )
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function resetInvestigation(idea) {
  idea.investigation = freshInvestigation();
  return idea;
}

// Run working groups concurrently; degrade gracefully per territory.
async function runWorkingGroupsConcurrently({ client, idea, inv, personas, territories }) {
  const settled = await Promise.allSettled(
    territories.map((territory) =>
      runWorkingGroup({
        client,
        idea,
        model: inv.model,
        synthesizerModel: inv.synthesizer_model,
        budget: inv.budget,
        territory,
        personas,
        onProgress: (msg) => progress(`→      ${msg}`),
      })
    )
  );

  const succeeded = [];
  settled.forEach((result, index) => {
    const territory = territories[index];
    const name = territory.name || territory.id || territory.territory_id;
    if (result.status === 'fulfilled') {
      const wg = result.value;
      succeeded.push(wg);
      const subStagesSummary = [
        `${wg.candidate_questions.length} candidates`,
        `${wg.aligned_questions.length} aligned`,
        `${wg.researcher_reports.length} reports`,
        `${wg.observations.length} observations`,
        `${wg.moves.filter((m) => m.stage === 'debate').length} debate moves`,
        `${wg.surviving_claims.length} claims`,
        `(${wg.terminated_by})`,
      ].join(', ');
      progress(`→      [${name}] ${subStagesSummary}`);
    } else {
      const reason = result.reason?.message || String(result.reason);
      progress(`→      [${name}] failed: ${reason}`);
    }
  });
  return succeeded;
}

async function runPipeline(idea, client) {
  if (idea.status !== 'pending') {
    resetInvestigation(idea);
  }
  idea.status = 'investigating';
  idea.investigation = idea.investigation || freshInvestigation();
  const inv = idea.investigation;
  inv.started_at = new Date().toISOString();
  inv.completed_at = null;
  inv.model = MODEL;
  inv.synthesizer_model = SYNTHESIZER_MODEL;
  await ensureIdeaDirs(idea.id);
  await writeIdea(idea);

  const id = idea.id;

  progress(`→ ${id} [1/7] perspective discovery (interrogative posture)…`);
  const discovery = await withHeartbeat('discovery', () =>
    runPerspectiveDiscovery({
      client,
      idea,
      model: inv.model,
      budget: inv.budget,
      onProgress: (msg) => progress(`→      ${msg}`),
    })
  );
  inv.perspective_discovery.search_queries = discovery.search_queries;
  inv.perspective_discovery.candidate_personas = discovery.candidate_personas;
  progress(
    `→      surveyed ${discovery.search_queries.length} sources, generated ${discovery.candidate_personas.length} candidate personas`
  );
  await writeIdea(idea);

  progress(`→ ${id} [2/7] diversity selection…`);
  const selectedDiscovered = selectDiversePersonas(
    inv.perspective_discovery.candidate_personas,
    { count: 5 }
  );
  inv.perspective_discovery.selected_persona_ids = selectedDiscovered.map((p) => p.id);
  const personas = [...selectedDiscovered, ...FIXED_PERSONAS];
  progress(
    `→      selected ${selectedDiscovered.length} personas (+ ${FIXED_PERSONAS.map((p) => p.role || p.id).join(', ')})`
  );
  await writeIdea(idea);

  progress(`→ ${id} [3/7] coordinator decomposing into territories…`);
  const initialDecomposition = await withHeartbeat('coordinator', () =>
    runCoordinatorInitial({
      client,
      idea,
      model: inv.model,
      budget: inv.budget,
      personas,
    })
  );
  const territories = initialDecomposition.territories || initialDecomposition.sub_questions || [];
  inv.coordinator_decisions.initial = {
    decided_at: initialDecomposition.decided_at,
    territories,
  };
  const territoryNames = territories.map((t) => t.name || t.id || t.territory_id).join(', ');
  progress(`→      ${territories.length} territories: ${territoryNames}`);
  await writeIdea(idea);

  progress(
    `→ ${id} [4/7] working groups (${territories.length} parallel pairs · six sub-stages each)…`
  );
  const workingGroups = await withHeartbeat('working-groups', () =>
    runWorkingGroupsConcurrently({
      client,
      idea,
      inv,
      personas,
      territories,
    })
  );
  inv.pair_debates.push(...workingGroups);
  await writeIdea(idea);

  progress(`→ ${id} [5/7] cross-pollination round…`);
  const livePairs = workingGroups
    .filter((wg) => wg.terminated_by !== 'ideation_failure' && wg.surviving_claims.length > 0)
    .map((wg) => ({
      territory_id: wg.territory_id,
      assigned_pair: territories.find((t) => (t.id || t.territory_id) === wg.territory_id)?.assigned_pair || [],
      workingGroup: wg,
    }));

  let reactionTotal = 0;
  if (livePairs.length >= 2) {
    const assignment = selectReactorPermutation(livePairs, personas);

    const perPairReactions = await withHeartbeat('cross-pollination', () =>
      Promise.all(
      livePairs.map(async (targetPair, i) => {
        const reactorIdx = assignment[i];
        if (reactorIdx == null || reactorIdx < 0) return [];
        const reactorPair = livePairs[reactorIdx];
        const targetClaims = targetPair.workingGroup.surviving_claims || [];
        if (targetClaims.length === 0) return [];

        const reactorPersonas = reactorPair.assigned_pair
          .map((pid) => personas.find((p) => p.id === pid))
          .filter(Boolean);

        const targetAlignedQuestions = targetPair.workingGroup.aligned_questions || [];
        const targetFindings = (targetPair.workingGroup.researcher_reports || []).flatMap(
          (r) => r.findings
        );

        return Promise.all(
          reactorPersonas.map((persona) =>
            runCrossPollinationReaction({
              client,
              idea,
              model: inv.model,
              budget: inv.budget,
              persona,
              reactingPair: reactorPair,
              targetClaims,
              targetAlignedQuestions,
              targetFindings,
              targetTerritory: targetPair.workingGroup.territory_id,
            })
          )
        );
      })
      )
    );

    const claimMap = new Map();
    for (const batch of perPairReactions) {
      for (const reaction of batch) {
        if (!reaction) continue;
        const claimId = reaction.references_claim_id;
        if (!claimId) continue;
        if (!claimMap.has(claimId)) {
          claimMap.set(claimId, { claim_id: claimId, reactions: [] });
        }
        claimMap.get(claimId).reactions.push({
          by_persona_id: reaction.by_persona_id,
          type: reaction.type,
          content: reaction.content,
          confidence: reaction.confidence,
          evidence_basis: reaction.evidence_basis,
        });
        reactionTotal += 1;
      }
    }
    inv.cross_pollination = [...claimMap.values()];
  } else {
    inv.cross_pollination = [];
  }
  await writeIdea(idea);
  progress(`→      ${reactionTotal} reactions collected`);

  const totalSurviving = inv.pair_debates.reduce(
    (n, d) => n + (d.surviving_claims?.length || 0),
    0
  );
  if (totalSurviving === 0) {
    progress(`→      WARNING: no surviving claims; synthesis will be empty`);
  }

  progress(`→ ${id} [6/7] forum aggregation…`);
  const forum = await withHeartbeat('forum', () =>
    aggregateForum({
      client,
      idea,
      model: inv.model,
      budget: inv.budget,
      pairDebates: inv.pair_debates,
      crossPollination: inv.cross_pollination,
    })
  );
  inv.forum = forum;
  const contradictionCount = forum.nodes.filter((n) => n.contradiction_with_node_id).length;
  const deadEndCount = (forum.dead_end_questions || []).length;
  progress(
    `→      ${forum.nodes.length} nodes, ${contradictionCount} contradictions surfaced, ${deadEndCount} dead-end questions preserved`
  );
  await writeIdea(idea);

  progress(`→ ${id} [7/7] synthesis (haiku)…`);
  const synthesis = await withHeartbeat('synthesis', () =>
    runSynthesizer({
      client,
      idea,
      model: inv.synthesizer_model,
      budget: inv.budget,
      forum,
      personas,
      pairDebates: inv.pair_debates,
    })
  );
  inv.synthesis = {
    produced_at: synthesis.produced_at,
    report: synthesis.report,
    headline_findings: synthesis.headline_findings,
    open_tensions: synthesis.open_tensions,
    question_landscape: synthesis.question_landscape || null,
    dead_end_summary: synthesis.dead_end_summary || null,
  };
  inv.completed_at = new Date().toISOString();
  idea.status = 'ready';
  await writeIdea(idea);

  const queueStats = typeof getStats === 'function' ? getStats() : null;
  const queueInfo = queueStats ? ` (queue: ${queueStats.retried} retries)` : '';
  progress(
    `✓ ${id} ready  (used ${inv.budget.used_executor_calls}/${inv.budget.max_executor_calls} executor calls, ${inv.budget.used_total_tokens}/${inv.budget.max_total_tokens} tokens${queueInfo})`
  );

  return { ok: true };
}

async function runOne(idea, client) {
  try {
    await runPipeline(idea, client);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`✗ ${idea.id} stage failed: ${message}\n`);
    return { ok: false, error };
  }
}

async function runRunCommand(args) {
  const selection = parseRunSelection(args);
  if (selection.mode === 'usage') {
    process.stdout.write('Usage: msv run [--all | <id>]\n');
    process.exitCode = 1;
    return;
  }

  await ensureStorageDirs();
  const pendingIdeas = await listIdeasByStatus('pending');

  let targets = [];
  if (selection.mode === 'all') {
    if (pendingIdeas.length === 0) {
      process.stdout.write('nothing to run\n');
      return;
    }
    targets = pendingIdeas;
  } else {
    const idea = await readIdea(selection.id);
    if (idea.status === 'ready') {
      // Spec §4.2: confirmation is only for ready ideas. Investigating ideas are
      // the documented manual recovery path (hand-edit status, then re-run).
      const proceed = await ensureConfirmation(idea);
      if (!proceed) {
        process.stdout.write(`skipped ${selection.id}\n`);
        return;
      }
    }
    targets = [idea];
  }

  const client = createClient();
  let readyCount = 0;
  for (const idea of targets) {
    const result = await runOne(idea, client);
    if (result.ok) readyCount += 1;
  }

  if (readyCount === 0) {
    process.exitCode = 1;
  }
}

module.exports = {
  runRunCommand,
  runPipeline,
};
