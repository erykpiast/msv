export type BusEnvelope = {
  name: string;
  ts: number;
  idea_id: string | null;
  [key: string]: unknown;
};

export type ProgressOverlay = {
  inProgressStages: Set<string>;
  inProgressWg: Set<string>;
  wgSubstage: Map<string, string>;
};

const WG_SUBSTAGE_START: Record<string, string> = {
  'wg.ideation.start':    'ideation',
  'wg.adversarial.start': 'adversarial',
  'wg.alignment.start':   'alignment',
  'wg.researcher.start':  'researcher',
  'wg.observation.start': 'observation',
  'wg.debate.start':      'debate',
};

export function emptyProgress(): ProgressOverlay {
  return {
    inProgressStages: new Set(),
    inProgressWg: new Set(),
    wgSubstage: new Map(),
  };
}

function withStage(prev: ProgressOverlay, stage: unknown, dir: 'in' | 'out'): ProgressOverlay {
  if (typeof stage !== 'string') return prev;
  const next = { ...prev, inProgressStages: new Set(prev.inProgressStages) };
  if (dir === 'in') next.inProgressStages.add(stage);
  else next.inProgressStages.delete(stage);
  return next;
}

function withWgEnd(prev: ProgressOverlay, wgId: unknown): ProgressOverlay {
  if (typeof wgId !== 'string') return prev;
  // Clear both inProgressWg AND wgSubstage when a working group ends.
  // Without clearing wgSubstage, SubStageNode would continue to see its
  // substage as "live" until pipeline.complete fires (H5). On reconnect
  // with seeded events, the stale substage would persist because no
  // cleanup signal replays.
  const nextSubstage = new Map(prev.wgSubstage);
  nextSubstage.delete(wgId);
  const nextWg = new Set(prev.inProgressWg);
  nextWg.delete(wgId);
  return { ...prev, inProgressWg: nextWg, wgSubstage: nextSubstage };
}

function withWgStart(prev: ProgressOverlay, wgId: unknown): ProgressOverlay {
  if (typeof wgId !== 'string') return prev;
  const next = { ...prev, inProgressWg: new Set(prev.inProgressWg) };
  next.inProgressWg.add(wgId);
  return next;
}

function withSubstage(prev: ProgressOverlay, wgId: unknown, substage: string): ProgressOverlay {
  if (typeof wgId !== 'string') return prev;
  const next = { ...prev, wgSubstage: new Map(prev.wgSubstage) };
  next.wgSubstage.set(wgId, substage);
  return next;
}

export function reduceProgress(prev: ProgressOverlay, env: BusEnvelope): ProgressOverlay {
  switch (env.name) {
    case 'pipeline.stage.start': return withStage(prev, env['stage'], 'in');
    case 'pipeline.stage.end':   return withStage(prev, env['stage'], 'out');
    case 'wg.start':             return withWgStart(prev, env['territory_id']);
    case 'wg.end':               return withWgEnd(prev, env['territory_id']);
    case 'wg.failed':
      return withWgEnd(prev, env['territory_id']);
    case 'wg.ideation.start':
    case 'wg.adversarial.start':
    case 'wg.alignment.start':
    case 'wg.researcher.start':
    case 'wg.observation.start':
    case 'wg.debate.start': {
      const substage = WG_SUBSTAGE_START[env.name];
      return substage ? withSubstage(prev, env['territory_id'], substage) : prev;
    }
    case 'pipeline.complete':
    case 'pipeline.failed':
      return emptyProgress();
    default:
      return prev;
  }
}
