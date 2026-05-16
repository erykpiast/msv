'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const {
  ensureStorageDirs,
  ensureIdeaDirs,
  listIdeasByStatus,
  readIdea,
  writeIdea,
  freshInvestigation,
  ideaDir,
  ideaWriteMutex,
  safeSlug,
  atomicWriteText,
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
const { planResume } = require('../resume');
const { CancellationError, classifyError, sanitiseMessage, actionableMessage } = require('../failure');

function parseRunSelection(args) {
  const flags = { restart: false, all: false };
  const positional = [];
  for (const arg of args) {
    if (arg === '--restart') flags.restart = true;
    else if (arg === '--all') flags.all = true;
    else positional.push(arg);
  }
  if (flags.all && flags.restart) {
    return { mode: 'error', reason: '--restart is not allowed with --all' };
  }
  if (!flags.all && positional.length === 0) return { mode: 'usage' };
  if (flags.all) return { mode: 'all' };
  return { mode: 'single', id: positional[0], restartFlag: flags.restart };
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

async function performRestart(idea) {
  const dir = ideaDir(idea.id);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveRoot = path.join(dir, '.attempts', timestamp);
  await fs.mkdir(archiveRoot, { recursive: true });
  const logsDir = path.join(dir, 'logs');
  try {
    await fs.rename(logsDir, path.join(archiveRoot, 'logs'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const snapshot = `${JSON.stringify(idea, null, 2)}\n`;
  await atomicWriteText(path.join(archiveRoot, 'index.json.before-restart'), snapshot);
  idea.investigation = freshInvestigation();
  idea.status = 'pending';
  await ensureIdeaDirs(idea.id);
  await writeIdea(idea);
}

// Persist and honour cancellation. The only place we write index.json from the pipeline.
async function checkpoint(idea, cancellationToken) {
  await ideaWriteMutex(idea.id, () => writeIdea(idea));
  if (cancellationToken?.requested) {
    throw new CancellationError(
      `cancellation requested at stage ${idea.investigation.progress?.current_stage}`
    );
  }
}

// Map each in-progress sub-stage value to the sub-stage name that was running when
// the error occurred (i.e., the sub-stage that HADN'T YET checkpointed).
// Inverse of SUBSTAGE_DONE_VALUE in working_group.js — keep both in sync when
// adding or removing sub-stages.
const NEXT_SUBSTAGE = {
  pending: 'ideation',
  ideation_complete: 'adversarial',
  adversarial_complete: 'alignment',
  alignment_complete: 'researcher',
  researcher_complete: 'observation',
  observation_complete: 'debate',
  debate_complete: null,
};

function inferInFlightWorkingGroup(inv) {
  if (inv?.progress?.current_stage !== '4_working_groups') {
    return { tid: null, subStage: null };
  }
  const wgs = inv.progress.working_groups || {};
  for (const [tid, value] of Object.entries(wgs)) {
    if (value !== 'complete' && value !== 'pending') {
      return { tid, subStage: NEXT_SUBSTAGE[value] || null };
    }
  }
  return { tid: null, subStage: null };
}

async function runWorkingGroupsConcurrently({
  client,
  idea,
  inv,
  personas,
  territories,
  cancellationToken,
}) {
  // Capture which territories were already complete BEFORE allSettled — used below
  // to suppress the per-territory summary for cached ones (we already printed
  // "(cached, complete)" for them). Can't infer from `inv.progress.working_groups`
  // after the fact because the finalisation loop sets every fulfilled WG to
  // 'complete' too.
  const cachedTids = new Set();
  for (const territory of territories) {
    const tid = safeSlug(territory.id || territory.territory_id);
    if ((inv.progress.working_groups[tid] || 'pending') === 'complete') {
      cachedTids.add(tid);
    }
  }

  const settled = await Promise.allSettled(
    territories.map((territory) => {
      const tid = safeSlug(territory.id || territory.territory_id);
      const wgProgressValue = inv.progress.working_groups[tid] || 'pending';
      if (wgProgressValue === 'complete') {
        const existing = inv.pair_debates.find((d) => d.territory_id === tid);
        progress(`→      [${territory.name || tid}] (cached, complete)`);
        return Promise.resolve(existing);
      }
      const previousResult = inv.pair_debates.find((d) => d.territory_id === tid) || null;
      return runWorkingGroup({
        client,
        idea,
        model: inv.model,
        synthesizerModel: inv.synthesizer_model,
        budget: inv.budget,
        territory,
        personas,
        onProgress: (msg) => progress(`→      ${msg}`),
        previousResult,
        wgProgressValue,
        cancellationToken,
        onCheckpoint: async ({ partialResult, completedSubStage }) => {
          // Serialise the entire read-modify-write so two concurrent callbacks for
          // different territories never both observe findIndex === -1 and both push.
          await ideaWriteMutex(idea.id, async () => {
            const idx = inv.pair_debates.findIndex((d) => d.territory_id === tid);
            if (idx >= 0) inv.pair_debates[idx] = partialResult;
            else inv.pair_debates.push(partialResult);
            inv.progress.working_groups[tid] = `${completedSubStage}_complete`;
            await writeIdea(idea);
          });
        },
      });
    })
  );

  // Finalise: mark fulfilled territories complete and ensure their results are in
  // inv.pair_debates (covers territories that returned early without any checkpoint,
  // e.g. ideation_failure).
  await ideaWriteMutex(idea.id, async () => {
    settled.forEach((r, i) => {
      const tid = safeSlug(territories[i].id || territories[i].territory_id);
      if (r.status === 'fulfilled' && r.value) {
        const idx = inv.pair_debates.findIndex((d) => d.territory_id === tid);
        if (idx >= 0) inv.pair_debates[idx] = r.value;
        else inv.pair_debates.push(r.value);
      }
      if (r.status === 'fulfilled') {
        inv.progress.working_groups[tid] = 'complete';
      }
    });
    await writeIdea(idea);
  });

  // Print summary for territories that ran (not cached).
  settled.forEach((result, index) => {
    const territory = territories[index];
    const name = territory.name || territory.id || territory.territory_id;
    const tid = safeSlug(territory.id || territory.territory_id);
    if (cachedTids.has(tid)) return; // already printed "(cached, complete)" above
    if (result.status === 'fulfilled' && result.value) {
      const wg = result.value;
      const subStagesSummary = [
        `${wg.candidate_questions?.length || 0} candidates`,
        `${wg.aligned_questions?.length || 0} aligned`,
        `${wg.researcher_reports?.length || 0} reports`,
        `${wg.observations?.length || 0} observations`,
        `${(wg.moves || []).filter((m) => m.stage === 'debate').length} debate moves`,
        `${wg.surviving_claims?.length || 0} claims`,
        `(${wg.terminated_by})`,
      ].join(', ');
      progress(`→      [${name}] ${subStagesSummary}`);
    } else if (result.status === 'rejected') {
      const reason = result.reason?.message || String(result.reason);
      progress(`→      [${name}] failed: ${reason}`);
    }
  });

  return settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}

async function runPipeline(idea, client, { cancellationToken } = {}) {
  const inv = idea.investigation;
  idea.status = 'investigating';
  if (!inv.started_at) inv.started_at = new Date().toISOString();
  inv.completed_at = null;
  inv.model = MODEL;
  inv.synthesizer_model = SYNTHESIZER_MODEL;
  if (!inv.progress) inv.progress = { current_stage: '1_discovery', working_groups: {} };
  await ensureIdeaDirs(idea.id);
  await writeIdea(idea);

  const id = idea.id;

  // ─────────────────── [1/7] discovery ───────────────────
  if (inv.progress.current_stage === '1_discovery') {
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
    inv.progress.current_stage = '2_diversity';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(
      `→ ${id} [1/7] discovery cached (${inv.perspective_discovery.candidate_personas.length} personas)`
    );
  }

  // ─────────────────── [2/7] diversity ───────────────────
  if (inv.progress.current_stage === '2_diversity') {
    progress(`→ ${id} [2/7] diversity selection…`);
    const selectedDiscovered = selectDiversePersonas(
      inv.perspective_discovery.candidate_personas,
      { count: 5 }
    );
    inv.perspective_discovery.selected_persona_ids = selectedDiscovered.map((p) => p.id);
    progress(
      `→      selected ${selectedDiscovered.length} personas (+ ${FIXED_PERSONAS.map((p) => p.role || p.id).join(', ')})`
    );
    inv.progress.current_stage = '3_coordinator';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(
      `→ ${id} [2/7] diversity cached (${inv.perspective_discovery.selected_persona_ids?.length || 0} selected)`
    );
  }

  // Reconstruct personas from persisted selected_persona_ids (used from here on regardless of
  // whether stage 2 ran or was skipped).
  const selectedDiscovered = (inv.perspective_discovery.selected_persona_ids || [])
    .map((pid) => inv.perspective_discovery.candidate_personas.find((p) => p.id === pid))
    .filter(Boolean);
  const personas = [...selectedDiscovered, ...FIXED_PERSONAS];

  // ─────────────────── [3/7] coordinator ───────────────────
  if (inv.progress.current_stage === '3_coordinator') {
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
    const territories =
      initialDecomposition.territories || initialDecomposition.sub_questions || [];
    inv.coordinator_decisions.initial = {
      decided_at: initialDecomposition.decided_at,
      territories,
    };
    // Seed per-WG progress map so stage 4 has an anchor for every territory.
    for (const t of territories) {
      const tid = safeSlug(t.id || t.territory_id);
      inv.progress.working_groups[tid] = inv.progress.working_groups[tid] || 'pending';
    }
    const territoryNames = territories.map((t) => t.name || t.id || t.territory_id).join(', ');
    progress(`→      ${territories.length} territories: ${territoryNames}`);
    inv.progress.current_stage = '4_working_groups';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(
      `→ ${id} [3/7] coordinator cached (${inv.coordinator_decisions.initial?.territories?.length || 0} territories)`
    );
  }

  const territories = inv.coordinator_decisions.initial.territories;

  // ─────────────────── [4/7] working groups ───────────────────
  let workingGroups;
  if (inv.progress.current_stage === '4_working_groups') {
    progress(
      `→ ${id} [4/7] working groups (${territories.length} parallel pairs · six sub-stages each)…`
    );
    workingGroups = await withHeartbeat('working-groups', () =>
      runWorkingGroupsConcurrently({
        client,
        idea,
        inv,
        personas,
        territories,
        cancellationToken,
      })
    );
    // Results already merged into inv.pair_debates by onCheckpoint callbacks.
    inv.progress.current_stage = '5_cross_pollination';
    await checkpoint(idea, cancellationToken);
  } else {
    workingGroups = inv.pair_debates;
    progress(
      `→ ${id} [4/7] working groups cached (${inv.pair_debates.length}/${territories.length})`
    );
  }

  // ─────────────────── [5/7] cross-pollination ───────────────────
  if (inv.progress.current_stage === '5_cross_pollination') {
    progress(`→ ${id} [5/7] cross-pollination round…`);
    const livePairs = workingGroups
      .filter(
        (wg) =>
          wg &&
          wg.terminated_by !== 'ideation_failure' &&
          (wg.surviving_claims?.length || 0) > 0
      )
      .map((wg) => ({
        territory_id: wg.territory_id,
        assigned_pair:
          territories.find(
            (t) => safeSlug(t.id || t.territory_id) === wg.territory_id
          )?.assigned_pair || [],
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
          if (!claimMap.has(claimId)) claimMap.set(claimId, { claim_id: claimId, reactions: [] });
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

    progress(`→      ${reactionTotal} reactions collected`);

    const totalSurviving = inv.pair_debates.reduce(
      (n, d) => n + (d.surviving_claims?.length || 0),
      0
    );
    if (totalSurviving === 0) {
      progress(`→      WARNING: no surviving claims; synthesis will be empty`);
    }

    inv.progress.current_stage = '6_forum';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(
      `→ ${id} [5/7] cross-pollination cached (${inv.cross_pollination?.length || 0} entries)`
    );
  }

  // ─────────────────── [6/7] forum ───────────────────
  if (inv.progress.current_stage === '6_forum') {
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
    inv.progress.current_stage = '7_synthesis';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(`→ ${id} [6/7] forum cached (${inv.forum?.nodes?.length || 0} nodes)`);
  }

  // ─────────────────── [7/7] synthesis ───────────────────
  if (inv.progress.current_stage === '7_synthesis') {
    progress(`→ ${id} [7/7] synthesis (haiku)…`);
    const synthesis = await withHeartbeat('synthesis', () =>
      runSynthesizer({
        client,
        idea,
        model: inv.synthesizer_model,
        budget: inv.budget,
        forum: inv.forum,
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
    inv.progress.current_stage = 'complete';
    inv.last_failure = null;
    idea.status = 'ready';
    await checkpoint(idea, cancellationToken);
  } else {
    progress(`→ ${id} [7/7] synthesis cached`);
  }

  const queueStats = typeof getStats === 'function' ? getStats() : null;
  const queueInfo = queueStats ? ` (queue: ${queueStats.retried} retries)` : '';
  progress(
    `✓ ${id} ready  (used ${inv.budget.used_executor_calls}/${inv.budget.max_executor_calls} executor calls, ${inv.budget.used_total_tokens}/${inv.budget.max_total_tokens} tokens${queueInfo})`
  );
}

async function runOne(idea, client, { cancellationToken } = {}) {
  try {
    await runPipeline(idea, client, { cancellationToken });
    return { ok: true };
  } catch (error) {
    const reason = classifyError(error);
    // Defensive: idea.investigation may be null if the pipeline threw before
    // initialising it (corrupted-data path). Build a fresh shell so we can
    // still persist last_failure rather than crashing in the catch handler.
    if (!idea.investigation) idea.investigation = freshInvestigation();
    const inv = idea.investigation;
    const stage = inv?.progress?.current_stage || 'unknown';
    const { tid, subStage } = inferInFlightWorkingGroup(inv);
    inv.last_failure = {
      reason,
      stage,
      territory_id: tid,
      sub_stage: subStage,
      error_message: sanitiseMessage(error),
      occurred_at: new Date().toISOString(),
    };
    try {
      await writeIdea(idea);
    } catch (writeErr) {
      process.stderr.write(
        `✗ ${idea.id} also failed to persist last_failure: ${writeErr.message}\n`
      );
    }
    process.stdout.write(`${actionableMessage({ id: idea.id, ...inv.last_failure })}\n`);
    return { ok: false, error };
  }
}

function installSigintHandler(cancellationToken) {
  function onSignal(signal) {
    if (!cancellationToken.requested) {
      cancellationToken.requested = true;
      process.stdout.write(
        `received ${signal}; finishing current sub-stage and saving (press again to force-quit)…\n`
      );
    } else {
      process.stdout.write('force-quitting; partial work may be lost\n');
      // POSIX convention: 128 + signal number. SIGINT = 2, SIGTERM = 15.
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    }
  }
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return function uninstall() {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

async function runRunCommand(args) {
  const selection = parseRunSelection(args);
  if (selection.mode === 'usage') {
    process.stdout.write('Usage: msv run [--all | <id> [--restart]]\n');
    process.exitCode = 1;
    return;
  }
  if (selection.mode === 'error') {
    process.stdout.write(`Error: ${selection.reason}\n`);
    process.exitCode = 1;
    return;
  }

  await ensureStorageDirs();

  if (selection.mode === 'all') {
    const pendingIdeas = await listIdeasByStatus('pending');
    if (pendingIdeas.length === 0) {
      process.stdout.write('nothing to run\n');
      return;
    }
    const client = createClient();
    let readyCount = 0;
    for (const idea of pendingIdeas) {
      const cancellationToken = { requested: false };
      const uninstall = installSigintHandler(cancellationToken);
      try {
        const result = await runOne(idea, client, { cancellationToken });
        if (result.ok) readyCount += 1;
        if (cancellationToken.requested) break;
      } finally {
        uninstall();
      }
    }
    if (readyCount === 0) process.exitCode = 1;
    return;
  }

  // single mode
  const idea = await readIdea(selection.id);
  const plan = planResume(idea, { restartFlag: selection.restartFlag });

  if (plan.mode === 'confirm') {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let answer;
    try {
      answer = (
        await rl.question(`Idea ${idea.id} is already ready; re-run? [y/N] `)
      )
        .trim()
        .toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write(`skipped ${selection.id}\n`);
      return;
    }
    progress(`restart requested; archiving prior state to ${ideaDir(idea.id)}/.attempts/`);
    await performRestart(idea);
  } else if (plan.mode === 'restart') {
    progress(`restart requested; archiving prior state to ${ideaDir(idea.id)}/.attempts/`);
    await performRestart(idea);
  } else if (plan.mode === 'fresh' && idea.status === 'investigating') {
    progress(`→ ${idea.id} ${plan.summary}`);
    idea.investigation = freshInvestigation();
    idea.status = 'pending';
    await writeIdea(idea);
  } else if (plan.mode === 'resume') {
    progress(`→ ${idea.id} ${plan.summary}`);
    if (idea.investigation?.last_failure) {
      const f = idea.investigation.last_failure;
      const where = [f.stage, f.territory_id && `territory ${f.territory_id}`, f.sub_stage]
        .filter(Boolean)
        .join(' / ');
      progress(`   (prior failure: ${f.reason} at ${where}, ${f.occurred_at})`);
    }
  }

  const cancellationToken = { requested: false };
  const uninstall = installSigintHandler(cancellationToken);
  const client = createClient();
  let readyCount = 0;
  try {
    const result = await runOne(idea, client, { cancellationToken });
    if (result.ok) readyCount += 1;
  } finally {
    uninstall();
  }
  if (readyCount === 0) process.exitCode = 1;
}

module.exports = {
  runRunCommand,
  runPipeline,
  runOne,
  performRestart,
  parseRunSelection,
  inferInFlightWorkingGroup,
  checkpoint,
  NEXT_SUBSTAGE,
};
