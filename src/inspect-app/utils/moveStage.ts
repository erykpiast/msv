import type { AlignmentMove, AlignmentMoveType, Move, MoveType } from '../../inspect/types';

/** Alignment-stage move type literals. Keep in sync with `AlignmentMoveType`. */
export const ALIGNMENT_MOVE_TYPES: ReadonlySet<AlignmentMoveType> = new Set<AlignmentMoveType>([
  'Propose',
  'Sharpen',
  'Merge',
  'Drop',
  'Defer',
]);

/** Debate-stage move type literals. Keep in sync with `MoveType`. */
export const DEBATE_MOVE_TYPES: ReadonlySet<MoveType> = new Set<MoveType>([
  'Claim',
  'Support',
  'Rebut',
  'Question',
  'Concede',
]);

/**
 * Discriminate alignment vs. debate moves in `WorkingGroupView.moves`.
 *
 * Prefers the `stage` discriminator when present; falls back to checking the
 * `type` against `ALIGNMENT_MOVE_TYPES` for older logs that predate the stage
 * field.
 */
export function isAlignmentMove(m: Move | AlignmentMove): m is AlignmentMove {
  if (m.stage === 'alignment') return true;
  return ALIGNMENT_MOVE_TYPES.has(m.type as AlignmentMoveType);
}
