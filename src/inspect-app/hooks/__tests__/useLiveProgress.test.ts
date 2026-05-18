import { describe, it, expect } from 'vitest';
import { reduceProgress, emptyProgress, type BusEnvelope } from '../useLiveProgress';

function makeEnv(overrides: Partial<BusEnvelope>): BusEnvelope {
  return { name: 'unknown', ts: 0, idea_id: 'test-idea', ...overrides };
}

describe('reduceProgress', () => {
  it('pipeline.stage.start adds the stage to inProgressStages', () => {
    const prev = emptyProgress();
    const next = reduceProgress(prev, makeEnv({ name: 'pipeline.stage.start', stage: 'discovery' }));
    expect(next.inProgressStages.has('discovery')).toBe(true);
    expect(next.inProgressStages.size).toBe(1);
  });

  it('pipeline.stage.end removes the stage from inProgressStages', () => {
    let state = emptyProgress();
    state = reduceProgress(state, makeEnv({ name: 'pipeline.stage.start', stage: 'discovery' }));
    state = reduceProgress(state, makeEnv({ name: 'pipeline.stage.end', stage: 'discovery' }));
    expect(state.inProgressStages.has('discovery')).toBe(false);
    expect(state.inProgressStages.size).toBe(0);
  });

  it('wg.researcher.web_search records query in researcherActivity for the WG', () => {
    const prev = emptyProgress();
    const next = reduceProgress(
      prev,
      makeEnv({ name: 'wg.researcher.web_search', territory_id: 't_001', query: 'market size' })
    );
    expect(next.researcherActivity.get('t_001')).toBe('search: market size');
  });

  it('pipeline.complete clears all overlays (all sets/maps empty)', () => {
    let state = emptyProgress();
    state = reduceProgress(state, makeEnv({ name: 'pipeline.stage.start', stage: 'discovery' }));
    state = reduceProgress(state, makeEnv({ name: 'wg.start', territory_id: 't_001' }));
    state = reduceProgress(
      state,
      makeEnv({ name: 'wg.researcher.web_search', territory_id: 't_001', query: 'test' })
    );
    const next = reduceProgress(state, makeEnv({ name: 'pipeline.complete' }));
    expect(next.inProgressStages.size).toBe(0);
    expect(next.inProgressWg.size).toBe(0);
    expect(next.wgSubstage.size).toBe(0);
    expect(next.researcherActivity.size).toBe(0);
  });

  it('pipeline.failed clears all overlays', () => {
    let state = emptyProgress();
    state = reduceProgress(state, makeEnv({ name: 'pipeline.stage.start', stage: 'debates' }));
    state = reduceProgress(state, makeEnv({ name: 'wg.start', territory_id: 't_002' }));
    const next = reduceProgress(state, makeEnv({ name: 'pipeline.failed' }));
    expect(next.inProgressStages.size).toBe(0);
    expect(next.inProgressWg.size).toBe(0);
    expect(next.wgSubstage.size).toBe(0);
    expect(next.researcherActivity.size).toBe(0);
  });

  it('unknown event names return the previous overlay unchanged (reference equality)', () => {
    const prev = emptyProgress();
    const next = reduceProgress(prev, makeEnv({ name: 'completely.unknown.event' }));
    expect(next).toBe(prev);
  });

  it('wg.start adds territory_id to inProgressWg', () => {
    const prev = emptyProgress();
    const next = reduceProgress(prev, makeEnv({ name: 'wg.start', territory_id: 't_001' }));
    expect(next.inProgressWg.has('t_001')).toBe(true);
    expect(next.inProgressWg.size).toBe(1);
  });

  it('wg.end removes territory_id from inProgressWg', () => {
    let state = emptyProgress();
    state = reduceProgress(state, makeEnv({ name: 'wg.start', territory_id: 't_001' }));
    state = reduceProgress(state, makeEnv({ name: 'wg.end', territory_id: 't_001' }));
    expect(state.inProgressWg.has('t_001')).toBe(false);
    expect(state.inProgressWg.size).toBe(0);
  });

  it('wg.researcher.start sets the substage in wgSubstage', () => {
    const prev = emptyProgress();
    const next = reduceProgress(
      prev,
      makeEnv({ name: 'wg.researcher.start', territory_id: 't_001' })
    );
    expect(next.wgSubstage.get('t_001')).toBe('researcher');
  });

  it('wg.researcher.web_fetch records url in researcherActivity', () => {
    const prev = emptyProgress();
    const result = reduceProgress(prev, {
      name: 'wg.researcher.web_fetch',
      ts: 1,
      idea_id: null,
      territory_id: 'wg_01',
      url: 'https://example.com/page',
    });
    expect(result.researcherActivity.get('wg_01')).toBe('fetch: https://example.com/page');
  });

  it('wg.ideation.start sets substage to ideation', () => {
    const prev = emptyProgress();
    const result = reduceProgress(prev, {
      name: 'wg.ideation.start',
      ts: 1,
      idea_id: null,
      territory_id: 'wg_01',
    });
    expect(result.wgSubstage.get('wg_01')).toBe('ideation');
  });

  it('wg.debate.start sets substage to debate', () => {
    const prev = emptyProgress();
    const result = reduceProgress(prev, {
      name: 'wg.debate.start',
      ts: 1,
      idea_id: null,
      territory_id: 'wg_01',
    });
    expect(result.wgSubstage.get('wg_01')).toBe('debate');
  });
});
