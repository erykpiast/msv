function deriveContradictionEdges(forumNodes, contradictionVerdicts) {
  const nodes = forumNodes ?? [];
  const verdicts = contradictionVerdicts ?? {};
  const claimToNode = new Map();
  for (const node of nodes) claimToNode.set(node.claim_id, node.node_id);

  const seen = new Set();
  const edges = [];

  // Verdict key format: `<claim_id_a>|<claim_id_b>` sorted — same convention as
  // src/forum.js#contradictionKey. Treat it as the authoritative edge source so that
  // every "contradicts: true" verdict appears, not just the single "best" link
  // captured in node.contradiction_with_node_id.
  for (const [key, verdict] of Object.entries(verdicts)) {
    if (!verdict?.contradicts) continue;
    const [claimA, claimB] = key.split('|');
    const nodeA = claimToNode.get(claimA);
    const nodeB = claimToNode.get(claimB);
    if (!nodeA || !nodeB) continue;
    const [from_node_id, to_node_id] = [nodeA, nodeB].sort();
    const dedupKey = `${from_node_id}|${to_node_id}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    edges.push({ from_node_id, to_node_id, reason: verdict.reason ?? '' });
  }

  return edges;
}

module.exports = { deriveContradictionEdges };
