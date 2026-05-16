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
      return { ...state, recent };

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
            substages: makeSubstages(),
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
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, ideation: 'running' },
        })),
        recent,
      };

    case 'wg.ideation.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, ideation: 'done' },
          totalCandidates: event.total_candidates,
        })),
        recent,
      };

    case 'wg.adversarial.start':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, adversarial: 'running' },
        })),
        recent,
      };

    case 'wg.adversarial.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, adversarial: 'done' },
        })),
        recent,
      };

    case 'wg.alignment.start':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, alignment: 'running' },
        })),
        recent,
      };

    case 'wg.alignment.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, alignment: 'done' },
        })),
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
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          researcherDone: wg.researcherDone + 1,
          researcherActivity: null,
        })),
        recent,
      };

    case 'wg.observation.start':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, observation: 'running' },
        })),
        recent,
      };

    case 'wg.observation.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, observation: 'done' },
        })),
        recent,
      };

    case 'wg.debate.start':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, debate: 'running' },
        })),
        recent,
      };

    case 'wg.debate.done':
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          substages: { ...wg.substages, debate: 'done' },
        })),
        recent,
      };

    case 'wg.move': {
      return {
        ...state,
        workingGroups: updateWg(state.workingGroups, event.territory_id, (wg) => ({
          ...wg,
          moves: [...wg.moves, event].slice(-5),
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
