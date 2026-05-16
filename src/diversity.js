const FIXED_PERSONAS = [
  {
    id: 'skeptic',
    name: 'Skeptic',
    tradition: 'Critical rationalism / failure-mode analysis',
    stance:
      "Steel-manned skepticism. Find the specific assumption that, if wrong, breaks the whole thing.",
    description:
      'Your job is to find the steel-manned version of why this idea fails. Not "this is bad" but "here is the specific assumption that, if wrong, breaks the whole thing." Trace each strong claim to the load-bearing assumption underneath it and stress-test that assumption. Cite real failure cases and adjacent disconfirming evidence. Concede only when the rebut against you would change your mind in real life.',
    fixed: true,
  },
  {
    id: 'builder',
    name: 'Builder',
    tradition: 'Pragmatic execution',
    stance:
      'Honest path-forward. What would actually have to be true for this to work and is that plausible.',
    description:
      'Your job is to argue for the path forward, but honestly. What would actually have to be true for this to work, and is that plausible? Not a cheerleader, not a salesman. Lay out the minimum viable next step and the specific way you would test it. Concede when an opposing rebut surfaces a constraint the path forward cannot route around.',
    fixed: true,
  },
];

function tokenize(text) {
  if (!text || typeof text !== 'string') {
    return new Set();
  }
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((tok) => tok.length >= 3)
  );
}

function jaccardDistance(setA, setB) {
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) {
    return 1;
  }
  return 1 - intersection / union;
}

function fieldDistance(a, b) {
  if (!a || !b) return 1;
  const at = a.toLowerCase().trim();
  const bt = b.toLowerCase().trim();
  if (!at || !bt) return 1;
  return at === bt ? 0 : 1;
}

function distinctness(a, b) {
  if (!a || !b || a === b) return 0;
  const traditionDist = fieldDistance(a.tradition, b.tradition);
  const stanceDist = fieldDistance(a.stance, b.stance);
  const descA = tokenize(`${a.description || ''} ${a.tradition || ''} ${a.stance || ''}`);
  const descB = tokenize(`${b.description || ''} ${b.tradition || ''} ${b.stance || ''}`);
  const descDist = jaccardDistance(descA, descB);
  return 0.4 * traditionDist + 0.3 * stanceDist + 0.3 * descDist;
}

function selectDiversePersonas(candidates, { count = 5 } = {}) {
  if (!Array.isArray(candidates)) {
    throw new Error('candidates must be an array');
  }
  if (candidates.length === 0) {
    return [];
  }

  const targetCount = Math.min(count, candidates.length);
  const pool = candidates.slice();
  const selected = [];

  // Seed with the globally most-distinct candidate so the result doesn't depend
  // on input order. Without this, an arbitrary first pick can anchor the greedy
  // selection toward a corner of the embedding space.
  pool.sort(
    (a, b) =>
      pool.reduce((sum, c) => sum + distinctness(b, c), 0) -
      pool.reduce((sum, c) => sum + distinctness(a, c), 0)
  );
  selected.push(pool.shift());

  while (selected.length < targetCount && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const score = selected.reduce((sum, picked) => sum + distinctness(candidate, picked), 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function pairDistinctnessScore(personaA, personaB) {
  return Number(distinctness(personaA, personaB).toFixed(3));
}

function selectReactorPermutation(pairs, allPersonas) {
  const personaSetOf = (pair) => new Set(pair.assigned_pair);
  const pairCount = pairs.length;

  // Pre-compute distinctness between every pair of working groups.
  const distinctnessSum = (setA, setB) => {
    let total = 0;
    for (const aId of setA) {
      for (const bId of setB) {
        const a = allPersonas.find((p) => p.id === aId);
        const b = allPersonas.find((p) => p.id === bId);
        if (a && b) total += distinctness(a, b);
      }
    }
    return total;
  };

  const scoreMatrix = [];
  for (let i = 0; i < pairCount; i += 1) {
    scoreMatrix.push([]);
    for (let j = 0; j < pairCount; j += 1) {
      scoreMatrix[i].push(
        i === j ? -Infinity : distinctnessSum(personaSetOf(pairs[i]), personaSetOf(pairs[j]))
      );
    }
  }

  // Greedy permutation: assign each pair a reactor pair distinct from itself,
  // forming a permutation (each pair reacted to once, reacts to one).
  const assignment = new Array(pairCount).fill(null);
  const reactedTo = new Set();
  const order = Array.from({ length: pairCount }, (_, i) => i).sort(
    (a, b) =>
      Math.max(...scoreMatrix[b].filter((v) => Number.isFinite(v))) -
      Math.max(...scoreMatrix[a].filter((v) => Number.isFinite(v)))
  );

  for (const i of order) {
    let bestJ = -1;
    let bestScore = -Infinity;
    for (let j = 0; j < pairCount; j += 1) {
      if (j === i || reactedTo.has(j)) continue;
      if (scoreMatrix[i][j] > bestScore) {
        bestScore = scoreMatrix[i][j];
        bestJ = j;
      }
    }
    if (bestJ === -1) {
      for (let j = 0; j < pairCount; j += 1) {
        if (j !== i && !reactedTo.has(j)) {
          bestJ = j;
          break;
        }
      }
    }
    if (bestJ === -1 && pairCount > 1) {
      bestJ = (i + 1) % pairCount;
    }
    assignment[i] = bestJ;
    if (bestJ !== -1) reactedTo.add(bestJ);
  }

  return assignment;
}

module.exports = {
  FIXED_PERSONAS,
  distinctness,
  selectDiversePersonas,
  pairDistinctnessScore,
  selectReactorPermutation,
};
