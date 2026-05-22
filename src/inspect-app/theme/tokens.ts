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
  // heightCollapsed is the worst-case rendered card height: 2-line wrapped
  // title + status pip on its own row (Mantine Group wraps when the title is
  // long) + aligned/claims badges + footer with up to two pair-pill rows
  // (PersonaChip labels like "Cognitive Science of Exper…" force the Group to
  // wrap). The visible gap between adjacent cards is `slot − rendered_height`
  // where `slot = heightCollapsed + wgStackGap`; sizing heightCollapsed for
  // the worst-case card means the minimum visible gap is always `wgStackGap`.
  wgBox: { width: 200, heightCollapsed: 180 },
  wgStackGap: 30,
  subStageBox: { width: 170, height: 92 },
  subStageGap: 30,
  headerHeight: 56,
  bannerHeight: 44,
  canvasChrome: {
    base: 260, // header + breadcrumb + tabs + pair-row chrome
    withChart: 460, // base + confidence-chart slot
  },
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
  in_progress: '◍',
};

export const stageStatusColor: Record<StageStatus, string> = {
  done: '#16a34a',
  partial: '#d97706',
  failed: '#dc2626',
  skipped: '#9ca3af',
  not_run: '#9ca3af',
  in_progress: '#3b82f6',
};
