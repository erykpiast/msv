import type { StageStatus } from '../../inspect/types';

export const tokens = {
  personaRail: 4,
  moveCardGap: 12,
  highlightPulseMs: 600,
  navbarWidth: 220,
  cardRadius: 8,
  sectionGap: 'xl',
  graphHeight: 520,
  graphRingRadius: 240,
  drawerWidth: 520,
  pipelineColumnX: {
    discovery: 0,
    coordinator: 220,
    workingGroup: 440,
    crossPollination: 720,
    forum: 940,
    synthesis: 1140,
  },
  pipelineRowY: 220,
  stageBox: { width: 180, heightCollapsed: 110 },
  wgBox: { width: 200, heightCollapsed: 96 },
  wgStackGap: 30,
  subStageBox: { width: 170, height: 92 },
  subStageGap: 30,
  headerHeight: 56,
  bannerHeight: 44,
} as const;

export const edgeColors = {
  contradiction: '#dc2626',
  crossPollination: '#9333ea',
  intraCluster: '#9ca3af',
  stageFlow: '#374151',
};

export const stageStatusGlyph: Record<StageStatus, string> = {
  done: '●',
  partial: '◐',
  failed: '✕',
  skipped: '○',
  not_run: '○',
};

export const stageStatusColor: Record<StageStatus, string> = {
  done: '#16a34a',
  partial: '#d97706',
  failed: '#dc2626',
  skipped: '#9ca3af',
  not_run: '#9ca3af',
};
