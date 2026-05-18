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
  researcherActivity: Map<string, string>;
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
    researcherActivity: new Map(),
  };
}

function withStage(prev: ProgressOverlay, stage: unknown, dir: 'in' | 'out'): ProgressOverlay {
  if (typeof stage !== 'string') return prev;
  const next = { ...prev, inProgressStages: new Set(prev.inProgressStages) };
  if (dir === 'in') next.inProgressStages.add(stage);
  else next.inProgressStages.delete(stage);
  return next;
}

function withWg(prev: ProgressOverlay, wgId: unknown, dir: 'in' | 'out'): ProgressOverlay {
  if (typeof wgId !== 'string') return prev;
  const next = { ...prev, inProgressWg: new Set(prev.inProgressWg) };
  if (dir === 'in') next.inProgressWg.add(wgId);
  else next.inProgressWg.delete(wgId);
  return next;
}

function withSubstage(prev: ProgressOverlay, wgId: unknown, substage: string): ProgressOverlay {
  if (typeof wgId !== 'string') return prev;
  const next = { ...prev, wgSubstage: new Map(prev.wgSubstage) };
  next.wgSubstage.set(wgId, substage);
  return next;
}

function withResearcher(prev: ProgressOverlay, wgId: unknown, activity: string): ProgressOverlay {
  if (typeof wgId !== 'string') return prev;
  const next = { ...prev, researcherActivity: new Map(prev.researcherActivity) };
  next.researcherActivity.set(wgId, activity);
  return next;
}

export function reduceProgress(prev: ProgressOverlay, env: BusEnvelope): ProgressOverlay {
  switch (env.name) {
    case 'pipeline.stage.start': return withStage(prev, env['stage'], 'in');
    case 'pipeline.stage.end':   return withStage(prev, env['stage'], 'out');
    case 'wg.start':             return withWg(prev, env['territory_id'], 'in');
    case 'wg.end':               return withWg(prev, env['territory_id'], 'out');
    case 'wg.failed':
      return withWg(prev, env['territory_id'], 'out');
    case 'wg.ideation.start':
    case 'wg.adversarial.start':
    case 'wg.alignment.start':
    case 'wg.researcher.start':
    case 'wg.observation.start':
    case 'wg.debate.start': {
      const substage = WG_SUBSTAGE_START[env.name];
      return substage ? withSubstage(prev, env['territory_id'], substage) : prev;
    }
    case 'wg.researcher.web_search':
      return withResearcher(prev, env['territory_id'], `search: ${env['query']}`);
    case 'wg.researcher.web_fetch':
      return withResearcher(prev, env['territory_id'], `fetch: ${env['url']}`);
    case 'pipeline.complete':
    case 'pipeline.failed':
      return emptyProgress();
    default:
      return prev;
  }
}
