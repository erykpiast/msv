// Test: planResume() is the single decision point for what `msv run` does
// with a given idea. Wrong dispatch here means either lost work (treating a
// resumable idea as 'fresh') or infinite loops. Enumerates every branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planResume } = require('../src/resume');

test('pending status → fresh', () => {
  const plan = planResume({ status: 'pending', investigation: {} }, { restartFlag: false });
  assert.equal(plan.mode, 'fresh');
  assert.equal(plan.resumeFrom, null);
});

test('ready status → confirm (existing behaviour)', () => {
  const plan = planResume({ status: 'ready', investigation: {} }, {});
  assert.equal(plan.mode, 'confirm');
  assert.equal(plan.resumeFrom, null);
});

test('investigating + no progress field → fresh (legacy v5 idea)', () => {
  const idea = { status: 'investigating', investigation: { schema_version: 'v5' } };
  assert.equal(planResume(idea, {}).mode, 'fresh');
});

test('investigating + progress null → fresh (crashed before first checkpoint)', () => {
  const idea = { status: 'investigating', investigation: { progress: null } };
  assert.equal(planResume(idea, {}).mode, 'fresh');
});

test('investigating + progress.current_stage set → resume', () => {
  const idea = {
    status: 'investigating',
    investigation: {
      progress: {
        current_stage: '3_coordinator',
        working_groups: {},
      },
    },
  };
  const plan = planResume(idea, {});
  assert.equal(plan.mode, 'resume');
  assert.equal(plan.resumeFrom.stage, '3_coordinator');
  assert.deepEqual(plan.resumeFrom.workingGroups, {});
  assert.match(plan.summary, /resume at stage 3_coordinator/);
});

test('investigating + stage 4 with WG map → resume with descriptive summary', () => {
  const idea = {
    status: 'investigating',
    investigation: {
      progress: {
        current_stage: '4_working_groups',
        working_groups: { t1: 'complete', t2: 'observation_complete' },
      },
    },
  };
  const plan = planResume(idea, {});
  assert.equal(plan.mode, 'resume');
  assert.equal(plan.resumeFrom.stage, '4_working_groups');
  assert.match(plan.summary, /1×complete/);
  assert.match(plan.summary, /1×observation_complete/);
});

test('--restart flag overrides all statuses', () => {
  assert.equal(planResume({ status: 'ready', investigation: {} }, { restartFlag: true }).mode, 'restart');
  assert.equal(planResume({ status: 'pending', investigation: {} }, { restartFlag: true }).mode, 'restart');
  assert.equal(
    planResume(
      { status: 'investigating', investigation: { progress: { current_stage: '4_working_groups', working_groups: {} } } },
      { restartFlag: true }
    ).mode,
    'restart'
  );
});

test('progress.current_stage === "complete" with non-ready status → resume (fast-forwards)', () => {
  // Should-never-happen state but must not crash or loop. Pipeline skip-guards
  // fast-forward every stage and flip status to ready.
  const idea = {
    status: 'investigating',
    investigation: {
      progress: { current_stage: 'complete', working_groups: {} },
    },
  };
  assert.equal(planResume(idea, {}).mode, 'resume');
});

test('missing investigation field → treated as pending with fresh mode', () => {
  // Edge case: idea with no investigation object at all.
  const idea = { status: 'pending', investigation: null };
  assert.equal(planResume(idea, {}).mode, 'fresh');
});
