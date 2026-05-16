'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reduce, initialState } = require('../../src/tui/dashboard/reducer');

function mkEvent(name, payload = {}) {
  return { name, ts: Date.now(), idea_id: 'test-idea', ...payload };
}

function applyEvents(events, idea = { id: 'test-idea', raw_capture: 'topic' }) {
  return events.reduce((state, event) => reduce(state, event), initialState({ idea }));
}

test('initialState has the correct shape', () => {
  const state = initialState({ idea: { id: 'abc', raw_capture: 'hello' } });
  assert.equal(state.idea.id, 'abc');
  assert.equal(state.idea.raw_capture, 'hello');
  assert.deepEqual(state.stages, {});
  assert.deepEqual(state.workingGroups, {});
  assert.equal(state.api.inflight, 0);
  assert.equal(state.api.total, 0);
  assert.equal(state.api.totalTokens, 0);
  assert.deepEqual(state.recent, []);
  assert.equal(state.completed, false);
  assert.equal(state.failed, false);
});

test('pipeline.stage.start sets stage to running', () => {
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
  ]);
  assert.equal(state.stages.discovery.status, 'running');
  assert.equal(state.stages.discovery.summary, null);
});

test('pipeline.stage.end sets stage to done with summary', () => {
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
    mkEvent('pipeline.stage.end', { stage: 'discovery', summary: { searches: 3 } }),
  ]);
  assert.equal(state.stages.discovery.status, 'done');
  assert.deepEqual(state.stages.discovery.summary, { searches: 3 });
});

test('pipeline.stage.heartbeat leaves state unchanged (except recent)', () => {
  const before = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'forum', stage_index: 6, total_stages: 7 }),
  ]);
  const after = reduce(before, mkEvent('pipeline.stage.heartbeat', { stage: 'forum', seconds: 15 }));
  assert.deepEqual(before.stages, after.stages);
  assert.deepEqual(before.workingGroups, after.workingGroups);
  assert.deepEqual(before.api, after.api);
});

test('wg.start creates a working group cell', () => {
  const state = applyEvents([
    mkEvent('wg.start', { territory_id: 't_001', territory_name: 'commercial-viability' }),
  ]);
  assert.ok(state.workingGroups['t_001']);
  assert.equal(state.workingGroups['t_001'].name, 'commercial-viability');
  assert.equal(state.workingGroups['t_001'].substages.ideation, 'pending');
});

test('wg substage transitions work correctly', () => {
  const events = [
    mkEvent('wg.start', { territory_id: 't_001', territory_name: 'cognitive-load' }),
    mkEvent('wg.ideation.start', { territory_id: 't_001' }),
    mkEvent('wg.ideation.done', { territory_id: 't_001', total_candidates: 8 }),
    mkEvent('wg.adversarial.start', { territory_id: 't_001' }),
    mkEvent('wg.adversarial.done', { territory_id: 't_001', mark_count: 6 }),
    mkEvent('wg.alignment.start', { territory_id: 't_001' }),
    mkEvent('wg.alignment.done', { territory_id: 't_001', move_count: 7, aligned_count: 5 }),
  ];
  const state = applyEvents(events);
  const wg = state.workingGroups['t_001'];
  assert.equal(wg.substages.ideation, 'done');
  assert.equal(wg.substages.adversarial, 'done');
  assert.equal(wg.substages.alignment, 'done');
  assert.equal(wg.substages.researcher, 'pending');
  assert.equal(wg.totalCandidates, 8);
});

test('researcher progress counter tracks start and done correctly', () => {
  const events = [
    mkEvent('wg.start', { territory_id: 't_001' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_001' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_002' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_003' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_004' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_005' }),
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_001', outcome: 'found', finding_count: 3 }),
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_002', outcome: 'found', finding_count: 2 }),
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_003', outcome: 'dead_end', finding_count: 0 }),
  ];
  const state = applyEvents(events);
  const wg = state.workingGroups['t_001'];
  assert.equal(wg.researcherTotal, 5);
  assert.equal(wg.researcherDone, 3);
});

test('wg.researcher.web_fetch sets researcherActivity to hostname', () => {
  const state = applyEvents([
    mkEvent('wg.start', { territory_id: 't_001' }),
    mkEvent('wg.researcher.web_fetch', { territory_id: 't_001', aligned_id: 'aq_001', url: 'https://ft.com/content/abc' }),
  ]);
  assert.equal(state.workingGroups['t_001'].researcherActivity, 'web_fetch(ft.com)');
});

test('out-of-order wg event auto-creates cell', () => {
  const state = applyEvents([
    mkEvent('wg.ideation.done', { territory_id: 't_999', total_candidates: 5 }),
  ]);
  assert.ok(state.workingGroups['t_999']);
  assert.equal(state.workingGroups['t_999'].substages.ideation, 'done');
});

test('recent events tail caps at 5', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    mkEvent('pipeline.stage.progress', { stage: 'discovery', message: `msg ${i}` })
  );
  const state = applyEvents(events);
  assert.equal(state.recent.length, 5);
});

test('api.call.start increments inflight and total', () => {
  const state = applyEvents([
    mkEvent('api.call.start', { call_id: 1, model: 'claude-3' }),
    mkEvent('api.call.start', { call_id: 2, model: 'claude-3' }),
  ]);
  assert.equal(state.api.inflight, 2);
  assert.equal(state.api.total, 2);
});

test('api.call.end decrements inflight floored at 0', () => {
  const state = applyEvents([
    mkEvent('api.call.start', { call_id: 1 }),
    mkEvent('api.call.end', { call_id: 1, outcome: 'ok' }),
    mkEvent('api.call.end', { call_id: 99, outcome: 'ok' }), // spurious end
  ]);
  assert.equal(state.api.inflight, 0);
});

test('pipeline.complete sets completed flag', () => {
  const state = applyEvents([mkEvent('pipeline.complete', { ok: true })]);
  assert.equal(state.completed, true);
});

test('pipeline.failed sets failed flag and error info', () => {
  const state = applyEvents([
    mkEvent('pipeline.failed', { stage: 'forum', error_message: 'boom' }),
  ]);
  assert.equal(state.failed, true);
  assert.equal(state.error.stage, 'forum');
  assert.equal(state.error.message, 'boom');
});

// --- currentStage tracking ---

test('pipeline.stage.start sets currentStage to the named stage', () => {
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
  ]);
  assert.equal(state.currentStage, 'discovery');
});

test('pipeline.stage.end clears currentStage back to null', () => {
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
    mkEvent('pipeline.stage.end', { stage: 'discovery', summary: {} }),
  ]);
  assert.equal(state.currentStage, null);
});

test('overlapping pipeline.stage.start events — the latter wins', () => {
  // Stages aren't supposed to overlap, but the reducer should still hold a
  // single coherent currentStage so downstream attribution stays well-defined.
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
    mkEvent('pipeline.stage.start', { stage: 'forum', stage_index: 6, total_stages: 7 }),
  ]);
  assert.equal(state.currentStage, 'forum');
});

// --- Per-stage token attribution ---

test('api.call.end attributes tokens to the active stage', () => {
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
    mkEvent('api.call.start', { call_id: 1 }),
    mkEvent('api.call.end', { call_id: 1, outcome: 'ok', input_tokens: 100, output_tokens: 50 }),
  ]);
  assert.equal(state.stages.discovery.tokens, 150);
  assert.equal(state.api.totalTokens, 150);
});

test('multiple api.call.end events in the same stage accumulate tokens', () => {
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
    mkEvent('api.call.start', { call_id: 1 }),
    mkEvent('api.call.end', { call_id: 1, outcome: 'ok', input_tokens: 100, output_tokens: 50 }),
    mkEvent('api.call.start', { call_id: 2 }),
    mkEvent('api.call.end', { call_id: 2, outcome: 'ok', input_tokens: 200, output_tokens: 75 }),
  ]);
  assert.equal(state.stages.discovery.tokens, 425);
  assert.equal(state.api.totalTokens, 425);
});

test('api.call.end after pipeline.stage.end does NOT attribute to any stage', () => {
  // Once a stage is closed, currentStage is null. The closed stage must
  // freeze at its in-stage total; only api.totalTokens accumulates further.
  const state = applyEvents([
    mkEvent('pipeline.stage.start', { stage: 'discovery', stage_index: 1, total_stages: 7 }),
    mkEvent('api.call.start', { call_id: 1 }),
    mkEvent('api.call.end', { call_id: 1, outcome: 'ok', input_tokens: 100, output_tokens: 50 }),
    mkEvent('pipeline.stage.end', { stage: 'discovery', summary: {} }),
    // This api.call.end fires in between stages, with currentStage === null.
    mkEvent('api.call.start', { call_id: 2 }),
    mkEvent('api.call.end', { call_id: 2, outcome: 'ok', input_tokens: 80, output_tokens: 20 }),
  ]);
  assert.equal(state.currentStage, null);
  // The closed stage stays frozen at 150 — the second call did not leak in.
  assert.equal(state.stages.discovery.tokens, 150);
  // The global counter accumulates regardless of currentStage.
  assert.equal(state.api.totalTokens, 250);
});

test('api.totalTokens accumulates even with no active stage', () => {
  const state = applyEvents([
    // No pipeline.stage.start at all.
    mkEvent('api.call.start', { call_id: 1 }),
    mkEvent('api.call.end', { call_id: 1, outcome: 'ok', input_tokens: 100, output_tokens: 50 }),
  ]);
  assert.equal(state.currentStage, null);
  assert.equal(state.api.totalTokens, 150);
  assert.deepEqual(state.stages, {});
});

// --- wg.failed handling ---

test('wg.failed flips non-done substages to failed and preserves done ones', () => {
  const state = applyEvents([
    mkEvent('wg.start', { territory_id: 't_001', territory_name: 'commercial' }),
    // ideation completes successfully, so its 'done' status must be preserved.
    mkEvent('wg.ideation.start', { territory_id: 't_001' }),
    mkEvent('wg.ideation.done', { territory_id: 't_001', total_candidates: 8 }),
    // researcher is running when the failure hits.
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_001' }),
    mkEvent('wg.failed', { territory_id: 't_001', reason: 'boom' }),
  ]);
  const wg = state.workingGroups['t_001'];
  assert.equal(wg.failed, true);
  assert.equal(wg.failReason, 'boom');
  // Done before failure → stays done.
  assert.equal(wg.substages.ideation, 'done');
  // Running at the moment of failure → flipped to failed.
  assert.equal(wg.substages.researcher, 'failed');
  // Pending substages (not yet started) → flipped to failed so the card
  // freezes in a visually-honest "this WG aborted" state.
  assert.equal(wg.substages.adversarial, 'failed');
  assert.equal(wg.substages.alignment, 'failed');
  assert.equal(wg.substages.observation, 'failed');
  assert.equal(wg.substages.debate, 'failed');
});

// --- wg.researcher.done substage flip ---

test('wg.researcher.done does not flip substage to done until all researchers finish', () => {
  // Start 3 researchers, complete 2 — substage must stay 'running'.
  const partial = applyEvents([
    mkEvent('wg.start', { territory_id: 't_001' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_001' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_002' }),
    mkEvent('wg.researcher.start', { territory_id: 't_001', aligned_id: 'aq_003' }),
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_001', outcome: 'found', finding_count: 1 }),
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_002', outcome: 'found', finding_count: 1 }),
  ]);
  const wgPartial = partial.workingGroups['t_001'];
  assert.equal(wgPartial.researcherTotal, 3);
  assert.equal(wgPartial.researcherDone, 2);
  assert.equal(wgPartial.substages.researcher, 'running', 'substage must stay running while researchers in flight');

  // The final researcher.done flips it.
  const complete = reduce(
    partial,
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_003', outcome: 'found', finding_count: 1 })
  );
  assert.equal(complete.workingGroups['t_001'].researcherDone, 3);
  assert.equal(complete.workingGroups['t_001'].substages.researcher, 'done');
});

test('wg.researcher.done guard — does not flip substage when researcherTotal is 0', () => {
  // Out-of-order event: a researcher.done arrives before any researcher.start.
  // The guard (researcherTotal > 0) prevents the substage from spuriously
  // flipping to 'done' for a WG with no researcher activity yet.
  const state = applyEvents([
    mkEvent('wg.start', { territory_id: 't_001' }),
    mkEvent('wg.researcher.done', { territory_id: 't_001', aligned_id: 'aq_phantom', outcome: 'found', finding_count: 0 }),
  ]);
  const wg = state.workingGroups['t_001'];
  assert.equal(wg.researcherTotal, 0);
  assert.equal(wg.researcherDone, 1);
  // Critical: substage must stay 'pending', not flip to 'done'.
  assert.equal(wg.substages.researcher, 'pending');
});

test('wg.end marks all substages as done', () => {
  const state = applyEvents([
    mkEvent('wg.start', { territory_id: 't_001', territory_name: 'test' }),
    mkEvent('wg.end', {
      territory_id: 't_001',
      candidate_count: 8,
      aligned_count: 5,
      report_count: 5,
      observation_count: 12,
      claim_count: 3,
      terminated_by: 'mutual_concession',
    }),
  ]);
  const wg = state.workingGroups['t_001'];
  for (const substage of ['ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate']) {
    assert.equal(wg.substages[substage], 'done', `${substage} should be done`);
  }
  assert.equal(wg.terminatedBy, 'mutual_concession');
  assert.equal(wg.claimCount, 3);
});

// --- cross-pollination flows ---

test('cross_pollination.reaction buckets reactions by reactor→target with per-type counts', () => {
  const state = applyEvents([
    mkEvent('cross_pollination.reaction', {
      persona_id: 'p_001', reactor_territory: 't_002', target_territory: 't_001',
      type: 'Rebut', confidence: 7,
    }),
    mkEvent('cross_pollination.reaction', {
      persona_id: 'p_002', reactor_territory: 't_002', target_territory: 't_001',
      type: 'Rebut', confidence: 6,
    }),
    mkEvent('cross_pollination.reaction', {
      persona_id: 'p_003', reactor_territory: 't_003', target_territory: 't_001',
      type: 'Concede', confidence: 5,
    }),
    mkEvent('cross_pollination.reaction', {
      persona_id: 'p_001', reactor_territory: 't_002', target_territory: 't_001',
      type: 'Question', confidence: 4,
    }),
  ]);
  assert.equal(state.crossPollination.total, 4);
  const t2t1 = state.crossPollination.flows['t_002→t_001'];
  assert.equal(t2t1.Rebut, 2);
  assert.equal(t2t1.Question, 1);
  assert.equal(t2t1.total, 3);
  const t3t1 = state.crossPollination.flows['t_003→t_001'];
  assert.equal(t3t1.Concede, 1);
  assert.equal(t3t1.total, 1);
});

test('cross_pollination.reaction with missing territories falls back to "?"', () => {
  const state = applyEvents([
    mkEvent('cross_pollination.reaction', {
      persona_id: 'p_001', type: 'Rebut', confidence: 7,
    }),
  ]);
  assert.equal(state.crossPollination.total, 1);
  assert.ok(state.crossPollination.flows['?→?']);
});

test('cross_pollination.done trusts emitter-supplied reaction_count', () => {
  // If the recorder ever drops a reaction, the running total in state will be
  // lower than the emitter's final count. The .done event takes precedence so
  // the header doesn't under-report.
  const state = applyEvents([
    mkEvent('cross_pollination.reaction', {
      reactor_territory: 't_002', target_territory: 't_001', type: 'Rebut',
    }),
    mkEvent('cross_pollination.done', { reaction_count: 12 }),
  ]);
  assert.equal(state.crossPollination.total, 12);
});
