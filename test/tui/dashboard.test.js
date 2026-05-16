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
