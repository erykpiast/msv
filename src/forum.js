function normalizeClaim(text) {
  return text.trim().toLowerCase();
}

function aggregateForum({ pairDebates = [], crossPollination = [] }) {
  const claimMap = new Map();

  for (const debate of pairDebates) {
    const claims = Array.isArray(debate.claims) ? debate.claims : [];
    for (const claim of claims) {
      const key = normalizeClaim(claim.text || '');
      if (!key) {
        continue;
      }
      if (!claimMap.has(key)) {
        claimMap.set(key, {
          id: `claim-${claimMap.size + 1}`,
          text: claim.text,
          confidence_weight: 0,
          supporting_pairs: [],
          reactions: [],
        });
      }
      const current = claimMap.get(key);
      current.confidence_weight += Number(claim.confidence || 0);
      current.supporting_pairs.push(debate.pair_id || 'unknown-pair');
    }
  }

  const contradictions = [];
  for (const reaction of crossPollination) {
    const key = normalizeClaim(reaction.claim_text || '');
    if (!key || !claimMap.has(key)) {
      continue;
    }
    const entry = claimMap.get(key);
    entry.reactions.push(reaction);
    if (reaction.move_type === 'Rebut') {
      contradictions.push({
        claim_id: entry.id,
        reason: reaction.content || 'Rebuttal surfaced during cross-pollination.',
      });
    }
  }

  const nodes = [...claimMap.values()].sort(
    (a, b) => b.confidence_weight - a.confidence_weight
  );

  return {
    nodes,
    contradictions,
  };
}

module.exports = {
  aggregateForum,
};
