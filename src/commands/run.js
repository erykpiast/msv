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
const { createClient, DEFAULT_MODEL } = require('../anthropic');
const {
  FIXED_PERSONAS,
  selectDiversePersonas,
  selectReactorPermutation,
} = require('../diversity');
const { runPerspectiveDiscovery } = require('../agents/discovery');
const {
  runCoordinatorInitial,
  runCoordinatorSpawn,
} = require('../agents/coordinator');
const { runPairDebate, runCrossPollinationReaction } = require('../agents/persona');
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

// Run pair debates concurrently and degrade gracefully: a single pair throwing
// (rate-limit, unrecoverable parse failure) does not discard the work of the
// other pairs. The spec requires the synthesizer to run even on partial input.
async function runDebatesConcurrently({
  client,
  idea,
  inv,
  personas,
  subQuestions,
  labelPrefix,
}) {
  const settled = await Promise.allSettled(
    subQuestions.map((sq) => {
      const pairPersonas = sq.assigned_pair
        .map((pid) => personas.find((p) => p.id === pid))
        .filter(Boolean);
      return runPairDebate({
        client,
        idea,
        model: inv.model,
        budget: inv.budget,
        subQuestion: sq,
        personas: pairPersonas,
      });
    })
  );

  const succeeded = [];
  settled.forEach((result, index) => {
    const sq = subQuestions[index];
    if (result.status === 'fulfilled') {
      succeeded.push(result.value);
      const debate = result.value;
      progress(
        `→      ${labelPrefix} ${index + 1} (${debate.sub_question_id}): ${debate.moves.length} moves, ${debate.surviving_claims.length} surviving claims (${debate.terminated_by})`
      );
    } else {
      const reason = result.reason?.message || String(result.reason);
      progress(`→      ${labelPrefix} ${index + 1} (${sq.id}) failed: ${reason}`);
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
  inv.model = DEFAULT_MODEL;
  await ensureIdeaDirs(idea.id);
  await writeIdea(idea);

  const id = idea.id;

  progress(`→ ${id} [1/7] perspective discovery…`);
  const discovery = await runPerspectiveDiscovery({
    client,
    idea,
    model: inv.model,
    budget: inv.budget,
  });
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
    `→      selected ${selectedDiscovered.length} discovered personas (+ ${FIXED_PERSONAS.length} fixed)`
  );
  await writeIdea(idea);

  progress(`→ ${id} [3/7] coordinator decomposing topic…`);
  const initialDecomposition = await runCoordinatorInitial({
    client,
    idea,
    model: inv.model,
    budget: inv.budget,
    personas,
  });
  inv.coordinator_decisions.initial = {
    decided_at: initialDecomposition.decided_at,
    sub_questions: initialDecomposition.sub_questions,
  };
  progress(`→      ${initialDecomposition.sub_questions.length} sub-questions, paired`);
  await writeIdea(idea);

  progress(
    `→ ${id} [4/7] working groups (${initialDecomposition.sub_questions.length} parallel pair debates)…`
  );
  const initialDebates = await runDebatesConcurrently({
    client,
    idea,
    inv,
    personas,
    subQuestions: initialDecomposition.sub_questions,
    labelPrefix: 'pair',
  });
  inv.pair_debates.push(...initialDebates);
  await writeIdea(idea);

  const spawnDecision = await runCoordinatorSpawn({
    client,
    idea,
    model: inv.model,
    budget: inv.budget,
    personas,
    pairDebates: inv.pair_debates,
    existingSubQuestions: initialDecomposition.sub_questions,
  });
  inv.coordinator_decisions.spawn = spawnDecision;
  await writeIdea(idea);

  if (spawnDecision.sub_questions.length > 0) {
    progress(
      `→ ${id} [4b/7] coordinator spawned ${spawnDecision.sub_questions.length} additional sub-question(s)…`
    );
    const spawnedDebates = await runDebatesConcurrently({
      client,
      idea,
      inv,
      personas,
      subQuestions: spawnDecision.sub_questions,
      labelPrefix: 'spawn-pair',
    });
    inv.pair_debates.push(...spawnedDebates);
    await writeIdea(idea);
  }

  progress(`→ ${id} [5/7] cross-pollination round…`);
  const allSubQuestions = [
    ...initialDecomposition.sub_questions,
    ...spawnDecision.sub_questions,
  ];
  const debatesById = new Map(inv.pair_debates.map((d) => [d.sub_question_id, d]));
  // Only sub-questions whose debate actually succeeded contribute to cross-pollination.
  const livePairs = allSubQuestions
    .filter((sq) => debatesById.has(sq.id))
    .map((sq) => ({
      sub_question_id: sq.id,
      assigned_pair: sq.assigned_pair,
      subQuestion: sq,
    }));

  let reactionTotal = 0;
  if (livePairs.length >= 2) {
    const assignment = selectReactorPermutation(livePairs, personas);

    // Each pair's reactions are independent; fan out across pairs and across the
    // two personas inside each reactor pair. This collapses what was ~N sequential
    // batches down to one round-trip.
    const perPairReactions = await Promise.all(
      livePairs.map(async (targetPair, i) => {
        const reactorIdx = assignment[i];
        if (reactorIdx == null || reactorIdx < 0) return [];
        const reactorPair = livePairs[reactorIdx];
        const targetDebate = debatesById.get(targetPair.sub_question_id);
        const targetClaims = targetDebate?.surviving_claims || [];
        if (targetClaims.length === 0) return [];

        const reactorPersonas = reactorPair.assigned_pair
          .map((pid) => personas.find((p) => p.id === pid))
          .filter(Boolean);

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
              targetSubQuestion: targetPair.subQuestion,
            })
          )
        );
      })
    );

    const claimMap = new Map();
    for (const batch of perPairReactions) {
      for (const reaction of batch) {
        const claimId = reaction.references_claim_id;
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
  const forum = await aggregateForum({
    client,
    idea,
    model: inv.model,
    budget: inv.budget,
    pairDebates: inv.pair_debates,
    crossPollination: inv.cross_pollination,
  });
  inv.forum = forum;
  const contradictionCount = forum.nodes.filter((n) => n.contradiction_with_node_id).length;
  progress(`→      ${forum.nodes.length} nodes, ${contradictionCount} contradictions surfaced`);
  await writeIdea(idea);

  progress(`→ ${id} [7/7] synthesis…`);
  const synthesis = await runSynthesizer({
    client,
    idea,
    model: inv.model,
    budget: inv.budget,
    forum,
    personas,
  });
  inv.synthesis = {
    produced_at: synthesis.produced_at,
    report: synthesis.report,
    headline_findings: synthesis.headline_findings,
    open_tensions: synthesis.open_tensions,
  };
  inv.completed_at = new Date().toISOString();
  idea.status = 'ready';
  await writeIdea(idea);

  progress(
    `✓ ${id} ready  (used ${inv.budget.used_executor_calls}/${inv.budget.max_executor_calls} executor calls, ${inv.budget.used_total_tokens}/${inv.budget.max_total_tokens} tokens)`
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
