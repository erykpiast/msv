'use strict';

/**
 * Orchestrates the six sub-stages of a v5 working group for one territory.
 * Returns a complete pair_debates[] entry.
 *
 * Sub-stages:
 *   5.4a Independent Ideation
 *   5.4b Adversarial Pre-check
 *   5.4c Alignment Debate + deterministic minority-protection post-step
 *   5.4d Researcher Delegation
 *   5.4e Independent Observation
 *   5.4f Pair Debate
 */

const { runIdeation, runAdversarialMark, runAlignmentMove, runObservation, runDebateMove } = require('./agents/persona');
const { runJointResearcher } = require('./agents/researcher');
const {
  ALIGNMENT_MOVE_BUDGET,
  MAX_ALIGNED_QUESTIONS,
  PAIR_MOVE_BUDGET,
  alignmentMoveId,
  debateMoveId,
  validateDebateMove,
  detectConcessionTermination,
  extractSurvivingClaims,
} = require('./moves');
const { appendLog, safeSlug } = require('./storage');
const { CancellationError } = require('./failure');

// territory.id is the canonical key, but coordinator-emitted territory_id is
// preserved as a fallback for any code path that constructs from raw model output.
function territoryKey(territory) {
  return territory?.id || territory?.territory_id || null;
}

// Run fn once, retry once on failure, return fallback on second failure.
// Logs the first failure even when the retry succeeds so the original cause
// is never silently swallowed.
async function withRetry(fn, { logFirstError } = {}) {
  try {
    return { ok: true, value: await fn() };
  } catch (firstErr) {
    if (logFirstError) await logFirstError(firstErr);
    try {
      return { ok: true, value: await fn() };
    } catch (retryErr) {
      return { ok: false, firstError: firstErr, retryError: retryErr };
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-stage progress helpers
// ---------------------------------------------------------------------------

// Ordered list of progress values for a single working group. 'complete' is the
// terminal state set by runWorkingGroupsConcurrently after the WG returns.
// 'debate_complete' is the transient value set by onCheckpoint after debate — it
// becomes 'complete' in the finalisation step. Both are accepted as "debate done".
const SUBSTAGE_ORDER = [
  'pending',
  'ideation_complete',
  'adversarial_complete',
  'alignment_complete',
  'researcher_complete',
  'observation_complete',
  'debate_complete',
  'complete',
];

// Maps a sub-stage name to the progress value that means it has finished.
const SUBSTAGE_DONE_VALUE = {
  ideation: 'ideation_complete',
  adversarial: 'adversarial_complete',
  alignment: 'alignment_complete',
  researcher: 'researcher_complete',
  observation: 'observation_complete',
  debate: 'debate_complete',
};

function isSubStageComplete(progressValue, subStage) {
  const doneValue = SUBSTAGE_DONE_VALUE[subStage];
  if (!doneValue) return false;
  const idx = SUBSTAGE_ORDER.indexOf(progressValue);
  const targetIdx = SUBSTAGE_ORDER.indexOf(doneValue);
  return idx >= 0 && targetIdx >= 0 && idx >= targetIdx;
}

// ---------------------------------------------------------------------------
// Deterministic alignment post-step (spec §6.4 step 3)
// ---------------------------------------------------------------------------

/**
 * Deterministic minority-protection step (load-bearing rule for v5).
 *
 * After the 5.4c alignment debate concludes, this function picks up to 5
 * aligned questions: 3 best-rated jointly + 1 best-remaining per persona,
 * dedup'd by candidate_id, capped at 5.
 *
 * The minority-protection rule guarantees ≥1 surviving question from each
 * pair member when they have any surviving candidates at all. This is the
 * mechanism that lets v5 produce questions a single-agent synthesis would
 * never have asked — a persona's outlier perspective gets a guaranteed slot.
 *
 * The whole v5 hypothesis depends on this rule. Surprise factor for future
 * readers: the alignment debate itself does NOT enforce minority protection
 * — the personas argue for quality only. Minority protection is bolted on
 * deterministically after.
 *
 * Worked example (spec §6.4):
 *   Personas A and B. A ranked: a1(c=8), a2(c=6), a3(c=4). B ranked: b1(c=7), b2(c=5).
 *   Joint ranking: a1, b1, a2, b2, a3. Step 3 picks {a1, b1, a2}.
 *   Step 4: A's next → a3; B's next → b2.
 *   Final: {a1, b1, a2, a3, b2} — origins aligned, aligned, aligned, minority_A, minority_B.
 *
 * Counter-example:
 *   If B's only surviving candidate is b1 and step 3 picks {a1, b1, a2},
 *   step 4 picks a3 for A and SKIPS B (no remaining B candidate). Final: 4 questions.
 *
 * Spec: specs/question-machine.md §6.4 step 3
 *
 * @param {{ alignmentSurvivors: object[], marks: object[], personas: object[] }} opts
 * @returns {object[]} aligned_questions[]
 */
function selectAlignedQuestions({ alignmentSurvivors, marks = [], personas = [] }) {
  const pool = alignmentSurvivors;

  // Count adversarial marks where the OTHER persona said could_answer_from_priors: false.
  const unknownMarkCount = (candidateId, authorPersonaId) =>
    marks.filter(
      (m) =>
        m.candidate_id === candidateId &&
        m.marker_persona_id !== authorPersonaId &&
        m.could_answer_from_priors === false
    ).length;

  const ranked = [...pool].sort((a, b) => {
    const confDiff = (b.predicted_confidence || 0) - (a.predicted_confidence || 0);
    if (confDiff !== 0) return confDiff;
    const markDiff =
      unknownMarkCount(b.candidate_id, b.by_persona_id) -
      unknownMarkCount(a.candidate_id, a.by_persona_id);
    if (markDiff !== 0) return markDiff;
    return a.candidate_id.localeCompare(b.candidate_id);
  });

  // Step 3: top 3 joint picks.
  const chosen = ranked.slice(0, 3).map((c) => ({ ...c, origin: 'aligned' }));
  const chosenIds = new Set(chosen.map((c) => c.candidate_id));

  // Step 4: one minority pick per persona (in deterministic persona-id order).
  const personaIds = personas.length > 0
    ? personas.map((p) => p.id)
    : [...new Set(pool.map((c) => c.by_persona_id))].sort();

  for (const personaId of personaIds) {
    const personaRanked = ranked.filter(
      (c) => c.by_persona_id === personaId && !chosenIds.has(c.candidate_id)
    );
    if (personaRanked.length > 0) {
      const minority = personaRanked[0];
      chosen.push({ ...minority, origin: `minority_${personaId}` });
      chosenIds.add(minority.candidate_id);
    }
  }

  // Cap at 5 (structurally ≤3+2=5 but enforce explicitly).
  return chosen.slice(0, MAX_ALIGNED_QUESTIONS).map((c, i) => ({
    aligned_id: `aq_${c.candidate_id}_${String(i + 1).padStart(3, '0')}`,
    question: c.question,
    origin: c.origin,
    by_persona_id: c.by_persona_id,
    source_candidate_ids: [c.candidate_id],
  }));
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function runWorkingGroup({
  client,
  idea,
  model,
  synthesizerModel,
  budget,
  territory,
  personas,
  bus,
  previousResult,
  wgProgressValue = 'pending',
  onCheckpoint,
  cancellationToken,
}) {
  const territoryId = territoryKey(territory);
  const safeTerritoryId = safeSlug(territoryId);
  const assignedPair = territory.assigned_pair || [];
  const pairPersonas = assignedPair
    .map((pid) => personas.find((p) => p.id === pid))
    .filter(Boolean);

  if (bus) bus.emit('wg.start', {
    territory_id: safeTerritoryId,
    territory_name: territory.name,
    assigned_pair: territory.assigned_pair || [],
    distinctness_score: territory.pair_distinctness_score,
  });

  const result = previousResult
    ? { ...previousResult }
    : {
        // Persist the safe slug as territory_id so all downstream consumers
        // (inspect builder, log filenames, anchor IDs in the SPA) work from
        // the same sanitised value. The full territory object remains in
        // coordinator_decisions.initial.
        territory_id: safeTerritoryId,
        candidate_questions: [],
        adversarial_marks: [],
        aligned_questions: [],
        researcher_reports: [],
        observations: [],
        moves: [],
        surviving_claims: [],
        terminated_by: null,
      };

  // --- 5.4a Independent Ideation ---
  if (bus) bus.emit('wg.ideation.start', { territory_id: safeTerritoryId });
  const ideationLog = `pair-${safeTerritoryId}-ideation`;
  if (!isSubStageComplete(wgProgressValue, 'ideation')) {
    const ideation = await withRetry(
      () =>
        Promise.all(
          pairPersonas.map((persona) =>
            runIdeation({ client, idea, model, budget, territory, persona })
          )
        ),
      {
        logFirstError: (err) =>
          appendLog(idea.id, ideationLog, {
            kind: 'retry_after_error',
            payload: { reason: err.message },
          }),
      }
    );
    if (!ideation.ok) {
      result.terminated_by = 'ideation_failure';
      await appendLog(idea.id, ideationLog, {
        kind: 'abort',
        payload: { reason: ideation.retryError.message, first_error: ideation.firstError.message },
      });
      return result;
    }
    const ideationResults = ideation.value;
    let cqCounter = 0;
    for (const personaResult of ideationResults) {
      for (const cq of personaResult.candidate_questions) {
        cqCounter += 1;
        result.candidate_questions.push({
          candidate_id: `cq_${safeTerritoryId}_${String(cqCounter).padStart(3, '0')}`,
          by_persona_id: personaResult.persona_id,
          ...cq,
        });
      }
      if (bus) bus.emit('wg.ideation.persona.done', {
        territory_id: safeTerritoryId,
        persona_id: personaResult.persona_id,
        candidate_count: personaResult.candidate_questions.length,
      });
    }
    if (cancellationToken?.requested) {
      throw new CancellationError(`cancelled at ${territoryId} ideation`);
    }
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'ideation' });
  }
  if (bus) bus.emit('wg.ideation.done', {
    territory_id: safeTerritoryId,
    total_candidates: result.candidate_questions.length,
  });

  // --- 5.4b Adversarial Pre-check ---
  if (bus) bus.emit('wg.adversarial.start', { territory_id: safeTerritoryId });
  const adversarialLog = `pair-${safeTerritoryId}-adversarial`;
  if (!isSubStageComplete(wgProgressValue, 'adversarial')) {
    try {
      const adversarialResults = await Promise.all(
        pairPersonas.map((persona) => {
          const otherCandidates = result.candidate_questions.filter(
            (c) => c.by_persona_id !== persona.id
          );
          return runAdversarialMark({
            client,
            idea,
            model,
            budget,
            territory,
            persona,
            candidateQuestions: otherCandidates,
          });
        })
      );
      for (const { marks } of adversarialResults) {
        result.adversarial_marks.push(...marks);
      }
    } catch (err) {
      // Failure here doesn't abort; candidates remain unmarked.
      await appendLog(idea.id, adversarialLog, {
        kind: 'partial_failure',
        payload: { reason: err.message },
      });
    }
    if (cancellationToken?.requested) {
      throw new CancellationError(`cancelled at ${territoryId} adversarial`);
    }
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'adversarial' });
  }
  if (bus) bus.emit('wg.adversarial.done', {
    territory_id: safeTerritoryId,
    mark_count: result.adversarial_marks.length,
    partial: false,
  });

  // --- 5.4c Alignment Debate ---
  if (bus) bus.emit('wg.alignment.start', { territory_id: safeTerritoryId });
  const alignmentLog = `pair-${safeTerritoryId}-alignment`;
  if (!isSubStageComplete(wgProgressValue, 'alignment')) {
    let alignmentMoveCount = 0;
    let alignmentHistory = [];
    let survivingCandidateIds = result.candidate_questions.map((c) => c.candidate_id);

    for (let turn = 0; turn < ALIGNMENT_MOVE_BUDGET; turn++) {
      const persona = pairPersonas[turn % 2];
      let move;
      try {
        move = await runAlignmentMove({
          client,
          idea,
          model,
          budget,
          territory,
          persona,
          candidateQuestions: result.candidate_questions,
          adversarialMarks: result.adversarial_marks,
          history: alignmentHistory,
        });
      } catch (err) {
        await appendLog(idea.id, alignmentLog, {
          kind: 'move_error',
          payload: { turn, reason: err.message },
        });
        break;
      }

      if (!move) break;

      const moveRecord = {
        move_id: alignmentMoveId(safeTerritoryId, alignmentMoveCount + 1),
        stage: 'alignment',
        by_persona_id: persona.id,
        ...move,
      };
      alignmentHistory.push(moveRecord);
      result.moves.push(moveRecord);
      alignmentMoveCount += 1;
      if (bus) bus.emit('wg.move', {
        territory_id: safeTerritoryId,
        phase: 'alignment',
        move_id: moveRecord.move_id,
        persona_id: persona.id,
        type: move.type,
      });

      // Drop eliminates the candidate; Defer marks it as "set aside" but does NOT
      // eliminate it (it remains in the surviving set so the deterministic post-step
      // can still pick it as a minority-protection slot if no other candidate exists).
      if (move.type === 'Drop' && move.candidate_id) {
        survivingCandidateIds = survivingCandidateIds.filter((id) => id !== move.candidate_id);
      }

      // Termination signal: an explicit `is_final: true` on the move. The earlier
      // prose substring check (`content.includes('[done]')`) was too fragile —
      // persona content may legitimately mention "[done]" without intending termination.
      if (move.is_final === true) break;
    }

    // Deterministic post-step: build aligned_questions.
    result.aligned_questions = selectAlignedQuestions({
      alignmentSurvivors: result.candidate_questions.filter((c) =>
        survivingCandidateIds.includes(c.candidate_id)
      ),
      marks: result.adversarial_marks,
      personas: pairPersonas,
    });

    if (cancellationToken?.requested) {
      throw new CancellationError(`cancelled at ${territoryId} alignment`);
    }
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'alignment' });
  }

  if (bus) bus.emit('wg.alignment.done', {
    territory_id: safeTerritoryId,
    move_count: (result.moves || []).filter((m) => m.stage === 'alignment').length,
    aligned_count: result.aligned_questions.length,
  });

  if (result.aligned_questions.length < 2) {
    result.terminated_by = 'alignment_failure';
    return result;
  }

  // --- 5.4d Researcher Delegation ---
  // Stream researcher results: each aligned-question researcher runs concurrently
  // but each one's result is processed as it arrives, so a slow researcher cannot
  // block the synchronous shape-assignment loop. Final shape preserves order
  // by aligned_id for downstream determinism.
  const personaLenses = pairPersonas.map((p) => p.id);
  const researcherLog = `pair-${safeTerritoryId}-researcher`;

  if (!isSubStageComplete(wgProgressValue, 'researcher')) {
    async function researchOne(aq) {
      const attempt = await withRetry(
        () =>
          runJointResearcher({
            client,
            idea,
            model,
            budget,
            alignedQuestion: aq,
            territory,
            personaLenses,
            bus,
          }),
        {
          logFirstError: (err) =>
            appendLog(idea.id, researcherLog, {
              kind: 'retry_after_error',
              payload: { aligned_id: aq.aligned_id, reason: err.message },
            }),
        }
      );
      if (attempt.ok) return attempt.value;
      return {
        outcome: 'dead_end',
        findings: [],
        search_trace: [],
        _error: attempt.retryError.message,
      };
    }

    const reports = await Promise.all(result.aligned_questions.map(researchOne));
    let rrCounter = 0;
    for (let i = 0; i < reports.length; i++) {
      const aq = result.aligned_questions[i];
      const report = reports[i];
      rrCounter += 1;
      const findings = (report.findings || []).map((f, fi) => ({
        finding_id: `f_${aq.aligned_id}_${String(fi + 1).padStart(2, '0')}`,
        ...f,
      }));
      result.researcher_reports.push({
        report_id: `rr_${String(rrCounter).padStart(3, '0')}`,
        aligned_id: aq.aligned_id,
        outcome: report.outcome,
        findings,
        search_trace: report.search_trace || [],
      });
    }

    const usefulReportsCheck = result.researcher_reports.filter((r) => r.findings.length > 0);
    if (usefulReportsCheck.length === 0) {
      result.terminated_by = 'all_dead_end';
      // No checkpoint — final loop in runWorkingGroupsConcurrently marks complete.
      return result;
    }

    if (cancellationToken?.requested) {
      throw new CancellationError(`cancelled at ${territoryId} researcher`);
    }
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'researcher' });
  }

  // Compute useful reports and findings index (used by both observation and debate).
  const usefulReports = result.researcher_reports.filter((r) => r.findings.length > 0);
  const allFindings = result.researcher_reports.flatMap((r) => r.findings);

  // --- 5.4e Independent Observation ---
  if (bus) bus.emit('wg.observation.start', { territory_id: safeTerritoryId });
  const observationLog = `pair-${safeTerritoryId}-observation`;
  if (!isSubStageComplete(wgProgressValue, 'observation')) {
    // result.observations is always empty here: the skip-guard above only lets us
    // enter when the observation sub-stage hasn't been checkpointed yet, and the
    // sub-stage is atomic (no per-observation checkpointing).
    let obsCounter = 0;

    const observationWork = pairPersonas.flatMap((persona) =>
      usefulReports.map((report) => ({ persona, report }))
    );

    const observationSettled = await Promise.allSettled(
      observationWork.map(({ persona, report }) =>
        runObservation({
          client,
          idea,
          model,
          budget,
          territory,
          persona,
          report,
          allReports: usefulReports,
        })
      )
    );

    for (let i = 0; i < observationWork.length; i++) {
      const { persona, report } = observationWork[i];
      const settled = observationSettled[i];
      let observations;
      if (settled.status === 'fulfilled') {
        observations = settled.value.observations;
      } else {
        // Retry once.
        try {
          const retry = await runObservation({
            client,
            idea,
            model,
            budget,
            territory,
            persona,
            report,
            allReports: usefulReports,
          });
          observations = retry.observations;
        } catch (retryErr) {
          // Synthesize fallback.
          const firstFindingId = report.findings[0]?.finding_id;
          observations = [
            {
              content: '[synthesized: no observation produced]',
              cited_finding_ids: firstFindingId ? [firstFindingId] : [],
            },
          ];
          await appendLog(idea.id, observationLog, {
            kind: 'synthesized_observation',
            payload: { persona_id: persona.id, report_id: report.report_id, reason: retryErr.message },
          });
        }
      }

      for (const obs of observations) {
        obsCounter += 1;
        result.observations.push({
          observation_id: `o_${safeTerritoryId}_${String(obsCounter).padStart(3, '0')}`,
          by_persona_id: persona.id,
          report_id: report.report_id,
          ...obs,
        });
      }
    }

    if (cancellationToken?.requested) {
      throw new CancellationError(`cancelled at ${territoryId} observation`);
    }
    await onCheckpoint?.({ partialResult: result, completedSubStage: 'observation' });
  }
  if (bus) bus.emit('wg.observation.done', {
    territory_id: safeTerritoryId,
    observation_count: result.observations.length,
  });

  // --- 5.4f Pair Debate ---
  if (bus) bus.emit('wg.debate.start', { territory_id: safeTerritoryId });
  const debateLog = `pair-${safeTerritoryId}-debate`;
  if (!isSubStageComplete(wgProgressValue, 'debate')) {
    let debateMoveCount = 0;
    let debateHistory = [];

    // Opening claims in parallel.
    const openingClaims = await Promise.allSettled(
      pairPersonas.map((persona) =>
        runDebateMove({
          client,
          idea,
          model,
          budget,
          territory,
          persona,
          history: [],
          observations: result.observations,
          findings: allFindings,
          isOpening: true,
        })
      )
    );

    for (let i = 0; i < openingClaims.length; i++) {
      const settled = openingClaims[i];
      const persona = pairPersonas[i];
      if (settled.status !== 'fulfilled' || !settled.value) continue;

      const move = settled.value;
      debateMoveCount += 1;
      const validation = validateDebateMove(move, {
        observations: result.observations,
        findings: allFindings,
      });
      if (!validation.valid) {
        await appendLog(idea.id, debateLog, {
          kind: 'rejected_move',
          payload: { persona_id: persona.id, errors: validation.errors },
        });
        continue;
      }

      const moveRecord = {
        move_id: debateMoveId(safeTerritoryId, debateMoveCount),
        stage: 'debate',
        by_persona_id: persona.id,
        ...move,
      };
      debateHistory.push(moveRecord);
      result.moves.push(moveRecord);
      if (bus) bus.emit('wg.move', {
        territory_id: safeTerritoryId,
        phase: 'debate',
        move_id: moveRecord.move_id,
        persona_id: persona.id,
        type: move.type,
        confidence: move.confidence,
      });
    }

    // Sequential debate turns.
    let debateTurn = debateHistory.length;
    while (debateTurn < PAIR_MOVE_BUDGET) {
      if (detectConcessionTermination(debateHistory)) break;

      const persona = pairPersonas[debateTurn % 2];
      let move;
      try {
        move = await runDebateMove({
          client,
          idea,
          model,
          budget,
          territory,
          persona,
          history: debateHistory,
          observations: result.observations,
          findings: allFindings,
          isOpening: false,
        });
      } catch (err) {
        await appendLog(idea.id, debateLog, {
          kind: 'move_error',
          payload: { turn: debateTurn, reason: err.message },
        });
        break;
      }

      if (!move) break;

      const validation = validateDebateMove(move, {
        observations: result.observations,
        findings: allFindings,
      });

      if (!validation.valid) {
        // Re-prompt once.
        try {
          move = await runDebateMove({
            client,
            idea,
            model,
            budget,
            territory,
            persona,
            history: debateHistory,
            observations: result.observations,
            findings: allFindings,
            isOpening: false,
            repromptReason: validation.errors.join('; '),
          });
          const revalidation = validateDebateMove(move, {
            observations: result.observations,
            findings: allFindings,
          });
          if (!revalidation.valid) {
            await appendLog(idea.id, debateLog, {
              kind: 'rejected_move',
              payload: { turn: debateTurn, errors: revalidation.errors },
            });
            debateTurn += 1;
            continue;
          }
        } catch (err) {
          debateTurn += 1;
          continue;
        }
      }

      debateMoveCount += 1;
      const moveRecord = {
        move_id: debateMoveId(safeTerritoryId, debateMoveCount),
        stage: 'debate',
        by_persona_id: persona.id,
        ...move,
      };
      debateHistory.push(moveRecord);
      result.moves.push(moveRecord);
      if (bus) bus.emit('wg.move', {
        territory_id: safeTerritoryId,
        phase: 'debate',
        move_id: moveRecord.move_id,
        persona_id: persona.id,
        type: move.type,
        confidence: move.confidence,
      });
      debateTurn += 1;
    }

    const debateMovesOnly = debateHistory;
    result.surviving_claims = extractSurvivingClaims(debateMovesOnly).map((sc) => {
      const originatingMove = debateMovesOnly.find((m) => m.move_id === sc.originating_move_id);
      return {
        ...sc,
        evidence_refs: originatingMove?.evidence_refs || [],
      };
    });

    result.terminated_by = detectConcessionTermination(debateHistory)
      ? 'mutual_concession'
      : 'budget_exhausted';

    await onCheckpoint?.({ partialResult: result, completedSubStage: 'debate' });
    if (cancellationToken?.requested) {
      throw new CancellationError(`cancelled at ${territoryId} debate`);
    }
  }

  const debateMoveCountFinal = (result.moves || []).filter((m) => m.stage === 'debate').length;
  if (bus) bus.emit('wg.debate.done', {
    territory_id: safeTerritoryId,
    move_count: debateMoveCountFinal,
    claim_count: result.surviving_claims.length,
    terminated_by: result.terminated_by,
  });

  if (bus) bus.emit('wg.end', {
    territory_id: safeTerritoryId,
    candidate_count: result.candidate_questions.length,
    aligned_count: result.aligned_questions.length,
    report_count: result.researcher_reports.length,
    observation_count: result.observations.length,
    claim_count: result.surviving_claims.length,
    terminated_by: result.terminated_by,
  });

  return result;
}

module.exports = { runWorkingGroup, selectAlignedQuestions, isSubStageComplete, SUBSTAGE_ORDER };
