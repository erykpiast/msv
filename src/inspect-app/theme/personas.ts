// Okabe-Ito (Wong) palette adapted for white backgrounds — the original #F0E442
// yellow fails WCAG AA contrast as a 3px border or as a node fill on white,
// so we substitute a darker gold #E6C200 in slot 4.
const PALETTE = [
  '#E69F00',
  '#56B4E9',
  '#009E73',
  '#E6C200',
  '#0072B2',
  '#D55E00',
  '#CC79A7',
  '#000000',
] as const;

const FIXED_COLOURS: Record<string, string> = {
  skeptic: '#D55E00',
  builder: '#0072B2',
};

export function personaColor(personaId: string | undefined | null): string {
  if (!personaId) return PALETTE[PALETTE.length - 1]!;
  if (FIXED_COLOURS[personaId]) return FIXED_COLOURS[personaId];
  let h = 0;
  for (let i = 0; i < personaId.length; i += 1) {
    h = (h * 31 + personaId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export { PALETTE };
