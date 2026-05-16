function deriveConfidenceTrajectory(debate) {
  const moves = debate?.moves ?? [];
  return moves
    .filter((move) => typeof move.confidence === 'number')
    .map((move) => ({
      move_id: move.move_id,
      persona_id: move.by_persona_id,
      confidence: move.confidence,
      type: move.type,
    }));
}

module.exports = { deriveConfidenceTrajectory };
