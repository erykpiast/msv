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
const { runBreadthAnalysis } = require('../agents/breadth');
const { getCommitSha } = require('../version');
const { planResume } = require('../resume');
const { CancellationError, classifyError, sanitiseMessage, actionableMessage } = require('../failure');
const { createBus } = require('../bus');
const { selectTui } = require('../tui');
const { attachRecorder } = require('../event_recorder');
const { attachRelay } = require('../event_relay');
const { setBus, resetStats } = require('../api_queue');

const HEARTBEAT_MS = 15_000;

function parseRunSelection(args) {
  const flags = { restart: false, all: false };
  const positional = [];
  for (const arg of args) {
    if (arg === '--restart') flags.restart = true;
    else if (arg === '--all') flags.all = true;
    else if (arg.startsWith('--tui=')) flags.tui = arg.slice('--tui='.length);
    else if (arg === '--verbose-api') flags.verboseApi = true;
    else positional.push(arg);
  }
  if (flags.all && flags.restart) {
    return { mode: 'error', reason: '--restart is not allowed with --all' };
  }
  if (!flags.all && positional.length === 0) return { mode: 'usage' };
  const out = flags.all
    ? { mode: 'all' }
    : { mode: 'single', id: positional[0], restartFlag: flags.restart };
  if (flags.tui !== undefined) out.tui = flags.tui;
  if (flags.verboseApi) out.verboseApi = true;
  return out;
}

async function withHeartbeat(stage, bus, fn) {
  const start = Date.now();
  const timer = setInterval(() => {
    if (bus) {
      bus.emit('pipeline.stage.heartbeat', {
        stage,
        seconds: Math.round((Date.now() - start) / 1000),
      });
    }
  }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// Tags the stage about to run with the commit SHA of the app build executing it,
// so a run paused and resumed across app versions shows which version produced
// which part of the result (see storage.js freshInvestigation doc).
function recordStageVersion(inv) {
  inv.versions[inv.progress.current_stage] = getCommitSha();
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
  bus,
}) {
  const settled = await Promise.allSettled(
    territories.map((territory) => {
      const tid = safeSlug(territory.id || territory.territory_id);
      const wgProgressValue = inv.progress.working_groups[tid] || 'pending';
      if (wgProgressValue === 'complete') {
        const existing = inv.pair_debates.find((d) => d.territory_id === tid);
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
        bus,
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

  settled.forEach((result, index) => {
    const territory = territories[index];
    if (result.status === 'rejected' && bus) {
      // Always use territory id (never .name, which is a display label) and slug
      // it so it lines up with the territory_id values emitted from the wg internals.
      const territoryId = safeSlug(territory.id || territory.territory_id);
      const reason = result.reason?.message || String(result.reason);
      bus.emit('wg.failed', { territory_id: territoryId, reason });
    }
  });

  return settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}

async function runPipeline(idea, client, { cancellationToken, bus } = {}) {
  const inv = idea.investigation;
  idea.status = 'investigating';
  if (!inv.started_at) inv.started_at = new Date().toISOString();
  inv.completed_at = null;
  inv.model = MODEL;
  inv.synthesizer_model = SYNTHESIZER_MODEL;
  if (!inv.progress) inv.progress = { current_stage: '1_discovery', working_groups: {} };
  await ensureIdeaDirs(idea.id);
  await writeIdea(idea);

  if (bus) bus.emit('pipeline.start', {
    idea_id: idea.id,
    raw_capture: idea.raw_capture,
    model: MODEL,
    synthesizer_model: SYNTHESIZER_MODEL,
    budget: { ...inv.budget },
    resume_from: inv.progress.current_stage,
  });

  // ─────────────────── [1/7] discovery ───────────────────
  if (inv.progress.current_stage === '1_discovery') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 8 });
    const discovery = await withHeartbeat('discovery', bus, () =>
      runPerspectiveDiscovery({
        client,
        idea,
        model: inv.model,
        budget: inv.budget,
        bus,
      })
    );
    inv.perspective_discovery.search_queries = discovery.search_queries;
    inv.perspective_discovery.candidate_personas = discovery.candidate_personas;
    if (bus) bus.emit('pipeline.stage.end', {
      stage: 'discovery',
      summary: {
        searches: discovery.search_queries.length,
        candidates: discovery.candidate_personas.length,
      },
    });
    inv.progress.current_stage = '2_diversity';
    await checkpoint(idea, cancellationToken);
  }

  // ─────────────────── [2/7] diversity ───────────────────
  if (inv.progress.current_stage === '2_diversity') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', { stage: 'diversity', stage_index: 2, total_stages: 8 });
    const selectedDiscovered = selectDiversePersonas(
      inv.perspective_discovery.candidate_personas,
      { count: 5 }
    );
    inv.perspective_discovery.selected_persona_ids = selectedDiscovered.map((p) => p.id);
    if (bus) bus.emit('pipeline.stage.end', {
      stage: 'diversity',
      summary: { selected: selectedDiscovered.length, fixed: FIXED_PERSONAS.length },
    });
    inv.progress.current_stage = '3_coordinator';
    await checkpoint(idea, cancellationToken);
  }

  // Reconstruct personas from persisted selected_persona_ids (used from here on regardless of
  // whether stage 2 ran or was skipped).
  const selectedDiscovered = (inv.perspective_discovery.selected_persona_ids || [])
    .map((pid) => inv.perspective_discovery.candidate_personas.find((p) => p.id === pid))
    .filter(Boolean);
  const personas = [...selectedDiscovered, ...FIXED_PERSONAS];

  // ─────────────────── [3/7] coordinator ───────────────────
  if (inv.progress.current_stage === '3_coordinator') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', { stage: 'coordinator', stage_index: 3, total_stages: 8 });
    const initialDecomposition = await withHeartbeat('coordinator', bus, () =>
      runCoordinatorInitial({
        client,
        idea,
        model: inv.model,
        budget: inv.budget,
        personas,
        bus,
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
    if (bus) bus.emit('pipeline.stage.end', {
      stage: 'coordinator',
      summary: { territories: territories.length },
    });
    inv.progress.current_stage = '4_working_groups';
    await checkpoint(idea, cancellationToken);
  }

  const territories = inv.coordinator_decisions.initial.territories;

  // ─────────────────── [4/7] working groups ───────────────────
  let workingGroups;
  if (inv.progress.current_stage === '4_working_groups') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', {
      stage: 'working_groups',
      stage_index: 4,
      total_stages: 8,
      territory_count: territories.length,
    });
    workingGroups = await withHeartbeat('working_groups', bus, () =>
      runWorkingGroupsConcurrently({
        client,
        idea,
        inv,
        personas,
        territories,
        cancellationToken,
        bus,
      })
    );
    if (bus) bus.emit('pipeline.stage.end', {
      stage: 'working_groups',
      summary: { completed: workingGroups.length, total: territories.length },
    });
    inv.progress.current_stage = '5_cross_pollination';
    await checkpoint(idea, cancellationToken);
  } else {
    workingGroups = inv.pair_debates;
  }

  // ─────────────────── [5/7] cross-pollination ───────────────────
  if (inv.progress.current_stage === '5_cross_pollination') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', {
      stage: 'cross_pollination',
      stage_index: 5,
      total_stages: 8,
    });
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
      const perPairReactions = await withHeartbeat('cross_pollination', bus, () =>
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
                  bus,
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

    if (bus) bus.emit('cross_pollination.done', { reaction_count: reactionTotal });

    const totalSurviving = inv.pair_debates.reduce(
      (n, d) => n + (d.surviving_claims?.length || 0),
      0
    );
    if (totalSurviving === 0 && bus) {
      bus.emit('pipeline.stage.progress', {
        stage: 'cross_pollination',
        message: 'WARNING: no surviving claims; synthesis will be empty',
      });
    }

    if (bus) bus.emit('pipeline.stage.end', {
      stage: 'cross_pollination',
      summary: { reactions: reactionTotal },
    });
    inv.progress.current_stage = '6_forum';
    await checkpoint(idea, cancellationToken);
  }

  // ─────────────────── [6/7] forum ───────────────────
  if (inv.progress.current_stage === '6_forum') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', { stage: 'forum', stage_index: 6, total_stages: 8 });
    const forum = await withHeartbeat('forum', bus, () =>
      aggregateForum({
        client,
        idea,
        model: inv.model,
        budget: inv.budget,
        pairDebates: inv.pair_debates,
        crossPollination: inv.cross_pollination,
        bus,
      })
    );
    inv.forum = forum;
    const contradictionCount = forum.nodes.filter((n) => n.contradiction_with_node_id).length;
    const deadEndCount = (forum.dead_end_questions || []).length;
    if (bus) bus.emit('pipeline.stage.end', {
      stage: 'forum',
      summary: {
        nodes: forum.nodes.length,
        contradictions: contradictionCount,
        dead_ends: deadEndCount,
      },
    });
    inv.progress.current_stage = '7_synthesis';
    await checkpoint(idea, cancellationToken);
  }

  // ─────────────────── [7/8] synthesis ───────────────────
  if (inv.progress.current_stage === '7_synthesis') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', { stage: 'synthesis', stage_index: 7, total_stages: 8 });
    const synthesis = await withHeartbeat('synthesis', bus, () =>
      runSynthesizer({
        client,
        idea,
        model: inv.synthesizer_model,
        budget: inv.budget,
        forum: inv.forum,
        personas,
        pairDebates: inv.pair_debates,
        bus,
      })
    );
    inv.synthesis = {
      produced_at: synthesis.produced_at,
      report: synthesis.report,
      headline_findings: synthesis.headline_findings,
      open_tensions: synthesis.open_tensions,
      question_landscape: synthesis.question_landscape || null,
      dead_end_summary: synthesis.dead_end_summary || null,
      sections: synthesis.sections || null,
      tension_points: synthesis.tension_points || null,
      key_references: synthesis.key_references || null,
      next_pass_proposals: synthesis.next_pass_proposals || null,
      truncated: !!synthesis.truncated,
    };
    if (synthesis.truncated) {
      // Leave current_stage at '7_synthesis' and status off 'ready' so the
      // existing resume logic (planResume: idea.status !== 'ready' → resume)
      // re-enters just this stage on the next run, instead of re-paying for
      // research/debate/forum work that already succeeded.
      inv.last_failure = {
        reason: 'synthesizer_truncated',
        stage: '7_synthesis',
        territory_id: null,
        sub_stage: null,
        error_message: 'Synthesizer response was truncated at max_tokens; partial synthesis persisted.',
        occurred_at: new Date().toISOString(),
      };
    } else {
      // Synthesis succeeded. Advance to the breadth stage rather than marking
      // the run complete — breadth is its own resumable stage (see below) so it
      // can be (re)computed without re-paying for the synthesizer.
      inv.last_failure = null;
      inv.progress.current_stage = '8_breadth';
    }
    if (bus) bus.emit('pipeline.stage.end', { stage: 'synthesis', summary: {} });
    await checkpoint(idea, cancellationToken);
  }

  // ─────────────────── [8/8] breadth ───────────────────
  // Realized-breadth score (issue #33): a single model call that clusters the
  // synthesis findings into distinct areas. It's its own stage so it reads the
  // already-persisted findings and never requires re-running the synthesizer —
  // a reset to '8_breadth' recomputes breadth alone. Non-fatal: a synthesis
  // that already succeeded is never lost to a breadth failure, so this stage
  // always completes the run.
  if (inv.progress.current_stage === '8_breadth') {
    recordStageVersion(inv);
    if (bus) bus.emit('pipeline.stage.start', { stage: 'breadth', stage_index: 8, total_stages: 8 });
    let areas = null;
    try {
      const breadth = await runBreadthAnalysis({
        client,
        idea,
        model: inv.model,
        budget: inv.budget,
        synthesis: inv.synthesis,
        bus,
      });
      if (breadth) {
        inv.synthesis.breadth = breadth;
        areas = breadth.n_areas;
      }
    } catch (err) {
      if (bus) bus.emit('pipeline.stage.progress', {
        stage: 'breadth',
        message: `breadth analysis failed (non-fatal): ${err.message}`,
      });
    }
    inv.completed_at = new Date().toISOString();
    inv.progress.current_stage = 'complete';
    inv.last_failure = null;
    idea.status = 'ready';
    if (bus) bus.emit('pipeline.stage.end', { stage: 'breadth', summary: { areas } });
    await checkpoint(idea, cancellationToken);
  }

  if (bus) {
    const queueStats = typeof getStats === 'function' ? getStats() : null;
    bus.emit('pipeline.complete', {
      idea_id: idea.id,
      ok: true,
      used_executor_calls: inv.budget.used_executor_calls,
      used_total_tokens: inv.budget.used_total_tokens,
      used_researcher_tool_calls: inv.budget.used_researcher_tool_calls,
      retries: queueStats?.retried || 0,
    });
  }
}

async function runOne(idea, client, { cancellationToken, tuiModule, tuiOpts } = {}) {
  const bus = createBus();
  bus.setIdea(idea.id);
  resetStats();
  setBus(bus);

  let recordCleanup = async () => {};
  let tuiCleanup = async () => {};
  let relayCleanup = () => {};
  let failureReport = null;

  try {
    recordCleanup = attachRecorder(bus, { idea });
    relayCleanup = attachRelay(bus);
    if (tuiModule) {
      const tuiResult = await tuiModule.attach(bus, { idea, ...tuiOpts });
      tuiCleanup = tuiResult.cleanup;
    }
    await runPipeline(idea, client, { cancellationToken, bus });
    return { ok: true };
  } catch (error) {
    const reason = classifyError(error);
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
    const actionable = actionableMessage({ id: idea.id, ...inv.last_failure });
    failureReport = `${actionable}\n  ${inv.last_failure.error_message}\n`;
    if (bus) {
      bus.emit('pipeline.failed', {
        stage,
        territory_id: tid,
        sub_stage: subStage,
        reason,
        error_message: sanitiseMessage(error),
        error_stack: error?.stack || '',
        actionable_message: actionable,
      });
    }
    return { ok: false, error };
  } finally {
    if (tuiCleanup) await tuiCleanup();
    if (relayCleanup) relayCleanup();
    if (recordCleanup) await recordCleanup();
    setBus(null);
    // Print AFTER tuiCleanup so the message survives Ink unmounting and isn't
    // interleaved with the dashboard's rendering. Always print, regardless of
    // TUI mode — the dashboard's status line shows a sanitised version but the
    // terminal record needs the actionable message even after the screen tears
    // down.
    if (failureReport) {
      process.stderr.write(failureReport);
    }
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
    process.stdout.write(
      'Usage: msv run [--all | <id> [--restart]] [--tui=dashboard|log|debug|silent] [--verbose-api]\n'
    );
    process.exitCode = 1;
    return;
  }
  if (selection.mode === 'error') {
    process.stdout.write(`Error: ${selection.reason}\n`);
    process.exitCode = 1;
    return;
  }

  await ensureStorageDirs();

  const tuiModule = selectTui({
    explicit: selection.tui,
    isStdoutTty: process.stdout.isTTY,
    isStdinTty: process.stdin.isTTY,
  });
  const tuiOpts = { verboseApi: !!selection.verboseApi };

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
        const result = await runOne(idea, client, { cancellationToken, tuiModule, tuiOpts });
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
    process.stdout.write(`restart requested; archiving prior state to ${ideaDir(idea.id)}/.attempts/\n`);
    await performRestart(idea);
  } else if (plan.mode === 'restart') {
    process.stdout.write(`restart requested; archiving prior state to ${ideaDir(idea.id)}/.attempts/\n`);
    await performRestart(idea);
  } else if (plan.mode === 'fresh' && idea.status === 'investigating') {
    process.stdout.write(`→ ${idea.id} ${plan.summary}\n`);
    idea.investigation = freshInvestigation();
    idea.status = 'pending';
    await writeIdea(idea);
  } else if (plan.mode === 'resume') {
    process.stdout.write(`→ ${idea.id} ${plan.summary}\n`);
    if (idea.investigation?.last_failure) {
      const f = idea.investigation.last_failure;
      const where = [f.stage, f.territory_id && `territory ${f.territory_id}`, f.sub_stage]
        .filter(Boolean)
        .join(' / ');
      process.stdout.write(`   (prior failure: ${f.reason} at ${where}, ${f.occurred_at})\n`);
    }
  }

  const cancellationToken = { requested: false };
  const uninstall = installSigintHandler(cancellationToken);
  const client = createClient();
  let readyCount = 0;
  try {
    const result = await runOne(idea, client, { cancellationToken, tuiModule, tuiOpts });
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
