const { runStructuredCall } = require('./anthropic');
const { appendLog } = require('./storage');

const CONTRADICTION_TOOL = {
  name: 'emit_contradiction_judgement',
  description:
    'Judge whether two claims contradict. Set contradicts=true only when the claims, in the same domain, cannot both be true.',
  input_schema: {
    type: 'object',
    required: ['contradicts', 'reason'],
    additionalProperties: false,
    properties: {
      contradicts: { type: 'boolean' },
      reason: { type: 'string', minLength: 1 },
    },
  },
};

const CONTRADICTION_SYSTEM = `You decide whether two short claims from a multi-agent debate contradict each other.
- Contradiction means the claims cannot both be true in the same domain.
- Mere differences of emphasis, scope, or framing are not contradictions.
- Always invoke the emit_contradiction_judgement tool. Do not produce free-form text.`;

function applyReactionEffect(node, reaction) {
  if (!reaction) return node;
  const conf = Number(reaction.confidence) || 0;
  if (reaction.type === 'Rebut') {
    if (conf >= 6) node.aggregate_confidence -= 2;
    else node.aggregate_confidence -= 0.5;
  } else if (reaction.type === 'Concede') {
    node.aggregate_confidence += 1;
  } else if (reaction.type === 'Question') {
    node.has_open_question = true;
  }
  node.aggregate_confidence = Math.max(0, Math.min(10, node.aggregate_confidence));
  return node;
}

function attachReactions(claimToNode, crossPollination) {
  for (const entry of crossPollination) {
    const node = claimToNode.get(entry.claim_id);
    if (!node) continue;
    node.reactions = node.reactions || [];
    for (const reaction of entry.reactions || []) {
      node.reactions.push(reaction);
      applyReactionEffect(node, reaction);
    }
  }
}

function buildBaseNodes(pairDebates) {
  const claimToNode = new Map();
  for (const debate of pairDebates) {
    for (const claim of debate.surviving_claims || []) {
      const node = {
        node_id: `n_${String(claimToNode.size + 1).padStart(3, '0')}`,
        claim_id: claim.claim_id,
        working_group_id: debate.sub_question_id,
        content: claim.content,
        aggregate_confidence: Number(claim.confidence_after_debate) || 0,
        contradiction_with_node_id: null,
        has_open_question: false,
        reactions: [],
        survival_rank: null,
      };
      claimToNode.set(claim.claim_id, node);
    }
  }
  return claimToNode;
}

function contradictionKey(a, b) {
  return [a.claim_id, b.claim_id].sort().join('|');
}

async function judgeContradiction({ client, model, budget, idea, a, b }) {
  const { toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system: CONTRADICTION_SYSTEM,
    maxTokens: 400,
    messages: [
      {
        role: 'user',
        content: `Claim A (from working group ${a.working_group_id}, conf ${a.aggregate_confidence.toFixed(
          2
        )}):\n${a.content}\n\nClaim B (from working group ${b.working_group_id}, conf ${b.aggregate_confidence.toFixed(
          2
        )}):\n${b.content}\n\nDo these contradict? Invoke emit_contradiction_judgement.`,
      },
    ],
    tools: [CONTRADICTION_TOOL],
    forceTool: 'emit_contradiction_judgement',
  });

  const result = {
    contradicts: !!toolUse.input.contradicts,
    reason: toolUse.input.reason,
    usage,
  };
  await appendLog(idea.id, 'forum-contradictions', {
    kind: 'response',
    payload: { key: contradictionKey(a, b), result },
  });
  return result;
}

async function aggregateForum({ client, idea, model, budget, pairDebates, crossPollination }) {
  const claimToNode = buildBaseNodes(pairDebates);
  attachReactions(claimToNode, crossPollination);
  const nodes = [...claimToNode.values()];

  // Collect every unique cross-group node pair once, then resolve all
  // contradiction judgements in parallel. Spec §5.6: "one bounded LLM call per
  // cross-group node pair". Running them serially adds 30–70s for N=10 nodes.
  const uniquePairs = [];
  const seen = new Set();
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (nodes[i].working_group_id === nodes[j].working_group_id) continue;
      const key = contradictionKey(nodes[i], nodes[j]);
      if (seen.has(key)) continue;
      seen.add(key);
      uniquePairs.push([nodes[i], nodes[j]]);
    }
  }

  const verdictByKey = new Map();
  const verdicts = await Promise.all(
    uniquePairs.map(([a, b]) =>
      judgeContradiction({ client, model, budget, idea, a, b })
    )
  );
  uniquePairs.forEach(([a, b], index) => {
    verdictByKey.set(contradictionKey(a, b), verdicts[index]);
  });

  for (const node of nodes) {
    let bestNode = null;
    for (const other of nodes) {
      if (other === node) continue;
      if (other.working_group_id === node.working_group_id) continue;
      const verdict = verdictByKey.get(contradictionKey(node, other));
      if (verdict?.contradicts) {
        if (!bestNode || other.aggregate_confidence > bestNode.aggregate_confidence) {
          bestNode = other;
        }
      }
    }
    node.contradiction_with_node_id = bestNode ? bestNode.node_id : null;
  }

  nodes.sort((a, b) => b.aggregate_confidence - a.aggregate_confidence);
  nodes.forEach((node, index) => {
    node.survival_rank = index + 1;
  });

  return {
    constructed_at: new Date().toISOString(),
    nodes,
  };
}

module.exports = {
  aggregateForum,
  applyReactionEffect,
  buildBaseNodes,
  contradictionKey,
};
