'use strict';

/**
 * Decide what to do with an idea presented to `msv run`.
 *
 * Returns one of four modes:
 *   'fresh'   – status pending, or investigating with no resume anchor; reset and run from scratch
 *   'resume'  – investigating with a progress pointer; pass existing inv into runPipeline
 *   'restart' – --restart flag passed; archive logs and run fresh
 *   'confirm' – status ready; prompt before re-running
 *
 * @param {object} idea       The loaded idea (post normalizeLoadedIdea).
 * @param {object} [options]
 * @param {boolean} [options.restartFlag]  Whether --restart was passed.
 * @returns {{ mode: string, summary: string, resumeFrom: null | { stage: string, workingGroups: object } }}
 */
function planResume(idea, { restartFlag } = {}) {
  if (restartFlag) {
    return { mode: 'restart', summary: 'restart requested', resumeFrom: null };
  }
  if (idea.status === 'ready') {
    return { mode: 'confirm', summary: 'already ready', resumeFrom: null };
  }
  if (idea.status === 'pending') {
    return { mode: 'fresh', summary: 'pending → fresh run', resumeFrom: null };
  }
  // status === 'investigating'
  const inv = idea.investigation || {};
  const progress = inv.progress;
  if (!progress?.current_stage) {
    return {
      mode: 'fresh',
      summary: 'investigating with no resume anchor — running fresh',
      resumeFrom: null,
    };
  }
  // If current_stage is 'complete' but status is not 'ready', that is a
  // should-never-happen state. Treat as resume — every stage's skip-guard will
  // fast-forward and the final checkpoint will flip status to 'ready'.
  return {
    mode: 'resume',
    summary: describeResume(progress),
    resumeFrom: {
      stage: progress.current_stage,
      workingGroups: progress.working_groups || {},
    },
  };
}

function describeResume(progress) {
  const stage = progress.current_stage;
  if (stage !== '4_working_groups') {
    return `resume at stage ${stage}`;
  }
  const wgs = progress.working_groups || {};
  const counts = Object.values(wgs).reduce((acc, v) => {
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts)
    .map(([k, v]) => `${v}×${k}`)
    .join(', ');
  return `resume at stage 4: ${parts}`;
}

module.exports = { planResume };
