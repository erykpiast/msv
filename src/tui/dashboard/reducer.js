'use strict';

const SUBSTAGE_NAMES = ['ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate'];

function makeSubstages() {
  return {
    ideation: 'pending',
    adversarial: 'pending',
    alignment: 'pending',
    researcher: 'pending',
    observation: 'pending',
    debate: 'pending',
  };
}

function initialState({ idea }) {
  return {
    idea: idea ? { id: idea.id, raw_capture: idea.raw_capture } : { id: null, raw_capture: null },
    stages: {},
    currentStage: null,
    workingGroups: {},
    // crossPollination.flows is keyed by "<reactor>→<target>"; each value
    // counts reactions by type. Built incrementally as cross_pollination.reaction
    // events arrive, finalised on cross_pollination.done.
    crossPollination: { total: 0, flows: {} },
    api: { inflight: 0, queued: 0, total: 0, totalTokens: 0 },
    recent: [],
    startedAt: null,
    completed: false,
    failed: false,
    error: null,
  };
}

function appendRecent(recent, event) {
  return [...recent, event].slice(-5);
}

function ensureWg(workingGroups, territory_id) {
  if (workingGroups[territory_id]) return workingGroups;
  return {
    ...workingGroups,
    [territory_id]: {
      name: territory_id,
      substages: makeSubstages(),
      researcherTotal: 0,
      researcherDone: 0,
      researcherActivity: null,
      moves: [],
    },
  };
}

function updateWg(workingGroups, territory_id, updater) {
  const wgs = ensureWg(workingGroups, territory_id);
  return {
    ...wgs,
    [territory_id]: updater(wgs[territory_id]),
  };
}

// Helper for the boilerplate-heavy wg.<substage>.start / .done cases that only
// flip a single substage status. Specialized cases (researcher, observation
// when researcher activity needs to be cleared, etc.) handle their own state.
function setSubstage(workingGroups, territory_id, substage, status, extra = {}) {
  return updateWg(workingGroups, territory_id, (wg) => ({
    ...wg,
    substages: { ...wg.substages, [substage]: status },
    ...extra,
  }));
}

function reduce(state, event) {
  const name = event.name;
  const recent = appendRecent(state.recent, event);

  switch (name) {
    case 'pipeline.start':
      return {
        ...state,
        idea: { id: event.idea_id, raw_capture: event.raw_capture },
        startedAt: event.ts || Date.now(),
        recent,
      };

    case 'pipeline.stage.start':
      return {
        ...state,
        currentStage: event.stage,
        stages: {
          ...state.stages,
          [event.stage]: { status: 'running', summary: null, startedAt: event.ts, endedAt: null, tokens: 0 },
        },
        recent,
      };

    case 'pipeline.stage.end':
      return {
        ...state,
        currentStage: null,
        stages: {
          ...state.stages,
          [event.stage]: {
            ...state.stages[event.stage],
            status: 'done',
            summary: event.summary || null,
            endedAt: event.ts,
          },
        },
        recent,
      };

    case 'pipeline.stage.heartbeat':
      // Heartbeats are ignored entirely — they don't even count toward recent
      // (otherwise the recent tail would constantly show "heartbeat" lines).
      return state;

    case 'pipeline.complete':
      return {
        ...state,
        completed: true,
        recent,
      };

    case 'pipeline.failed':
      return {
        ...state,
        failed: true,
        error: {
          stage: event.stage,
          message: event.error_message,
        },
        recent,
      };

    case 'wg.start':
      return {
        ...state,
        workingGroups: {
          ...state.workingGroups,
          [event.territory_id]: {
            name: event.territory_name || event.territory_id,
            assignedPair: event.assigned_pair || [],
            substages: makeSubstages(),
            personasIdeated: 0,
            candidateCount: 0,
            markCount: 0,
            alignmentMoves: 0,
            debateMoves: 0,
            observationCount: 0,
            researcherTotal: 0,
            researcherDone: 0,
            researcherActivity: null,
            moves: [],
          },
        },
        recent,
      };

    case 'wg.ideation.start':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'ideation', 'running'),
        recent,
      };

    case 'wg.ideation.persona.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          personasIdeated: (wg.personasIdeated || 0) + 1,
          candidateCount: (wg.candidateCount || 0) + (event.candidate_count || 0),
        })),
        recent,
      };

    case 'wg.ideation.done':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'ideation', 'done', {
          totalCandidates: event.total_candidates,
          candidateCount: event.total_candidates,
        }),
        recent,
      };

    case 'wg.adversarial.start':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'adversarial', 'running'),
        recent,
      };

    case 'wg.adversarial.done':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'adversarial', 'done', {
          markCount: event.mark_count || 0,
        }),
        recent,
      };

    case 'wg.alignment.start':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'alignment', 'running'),
        recent,
      };

    case 'wg.alignment.done':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'alignment', 'done', {
          alignmentMoves: event.move_count || 0,
        }),
        recent,
      };

    case 'wg.researcher.start':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, researcher: 'running' },
          researcherTotal: wg.researcherTotal + 1,
        })),
        recent,
      };

    case 'wg.researcher.web_search':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          researcherActivity: `web_search(${event.query || ''})`,
        })),
        recent,
      };

    case 'wg.researcher.web_fetch': {
      let hostname = event.url || '';
      try {
        hostname = new URL(event.url).hostname;
      } catch (_) {
        // keep as-is if not a valid URL
      }
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          researcherActivity: `web_fetch(${hostname})`,
        })),
        recent,
      };
    }

    case 'wg.researcher.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => {
          const newDone = wg.researcherDone + 1;
          // Only flip the substage to 'done' once every started researcher has
          // also reported done. researcherTotal is incremented per .start, so
          // out-of-order events can produce researcherTotal === 0 here — keep
          // the substage as-is in that case.
          const allDone = wg.researcherTotal > 0 && newDone >= wg.researcherTotal;
          return {
            ...wg,
            researcherDone: newDone,
            researcherActivity: null,
            substages: allDone
              ? { ...wg.substages, researcher: 'done' }
              : wg.substages,
          };
        }),
        recent,
      };

    case 'wg.observation.start':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'observation', 'running'),
        recent,
      };

    case 'wg.observation.done':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'observation', 'done', {
          observationCount: event.observation_count || 0,
        }),
        recent,
      };

    case 'wg.debate.start':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'debate', 'running'),
        recent,
      };

    case 'wg.debate.done':
      return {
        ...state,
        workingGroups: setSubstage(state.workingGroups, event.territory_id, 'debate', 'done', {
          debateMoves: event.move_count || 0,
        }),
        recent,
      };

    case 'wg.move': {
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          moves: [...wg.moves, event].slice(-5),
          alignmentMoves: event.phase === 'alignment' ? (wg.alignmentMoves || 0) + 1 : (wg.alignmentMoves || 0),
          debateMoves: event.phase === 'debate' ? (wg.debateMoves || 0) + 1 : (wg.debateMoves || 0),
        })),
        recent,
      };
    }

    case 'wg.end':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => {
          const doneSubstages = {};
          for (const s of SUBSTAGE_NAMES) doneSubstages[s] = 'done';
          return {
            ...wg,
            substages: doneSubstages,
            alignedCount: event.aligned_count,
            reportCount: event.report_count,
            observationCount: event.observation_count,
            claimCount: event.claim_count,
            terminatedBy: event.terminated_by,
          };
        }),
        recent,
      };

    case 'wg.failed':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => {
          // Flip every non-done substage to 'failed' so the card freezes in a
          // visually-honest state rather than showing a substage still running.
          const substages = {};
          for (const [k, v] of Object.entries(wg.substages)) {
            substages[k] = v === 'done' ? 'done' : 'failed';
          }
          return { ...wg, substages, failed: true, failReason: event.reason };
        }),
        recent,
      };

    case 'cross_pollination.reaction': {
      // Some reactions may arrive with one or both territories null (defensive —
      // older event payloads, or edge cases). Bucket those under "?" so they
      // still count toward the total without crashing the renderer.
      const reactor = event.reactor_territory || '?';
      const target = event.target_territory || '?';
      const key = `${reactor}→${target}`;
      const prev = state.crossPollination.flows[key] || { reactor, target, total: 0 };
      const type = event.type || 'Unknown';
      return {
        ...state,
        crossPollination: {
          total: state.crossPollination.total + 1,
          flows: {
            ...state.crossPollination.flows,
            [key]: {
              ...prev,
              [type]: (prev[type] || 0) + 1,
              total: prev.total + 1,
            },
          },
        },
        recent,
      };
    }

    case 'cross_pollination.done':
      // The total tracked from reactions and the event's reaction_count should
      // agree; if they don't (e.g. reactions were dropped) we trust the explicit
      // count from the emitter, which sees the final batch.
      return {
        ...state,
        crossPollination: {
          ...state.crossPollination,
          total: event.reaction_count != null ? event.reaction_count : state.crossPollination.total,
        },
        recent,
      };

    case 'api.call.start':
      return {
        ...state,
        api: {
          ...state.api,
          inflight: state.api.inflight + 1,
          total: state.api.total + 1,
        },
        recent,
      };

    case 'api.call.end': {
      const callTokens = (event.input_tokens || 0) + (event.output_tokens || 0);
      const updatedStages = state.currentStage && state.stages[state.currentStage]
        ? {
            ...state.stages,
            [state.currentStage]: {
              ...state.stages[state.currentStage],
              tokens: (state.stages[state.currentStage].tokens || 0) + callTokens,
            },
          }
        : state.stages;
      return {
        ...state,
        api: {
          ...state.api,
          inflight: Math.max(0, state.api.inflight - 1),
          totalTokens: (state.api.totalTokens || 0) + callTokens,
        },
        stages: updatedStages,
        recent,
      };
    }

    default:
      return { ...state, recent };
  }
}

module.exports = { reduce, initialState };
