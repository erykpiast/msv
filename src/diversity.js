const FIXED_PERSONAS = [
  {
    id: 'fixed-skeptic',
    label: 'Skeptic',
    tradition: 'Critical rationalism',
    tags: ['skepticism', 'falsification', 'risk'],
    fixed: true,
  },
  {
    id: 'fixed-builder',
    label: 'Builder',
    tradition: 'Pragmatism',
    tags: ['implementation', 'experimentation', 'execution'],
    fixed: true,
  },
];

function jaccardDistance(aTags = [], bTags = []) {
  const a = new Set(aTags);
  const b = new Set(bTags);
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  if (union === 0) {
    return 1;
  }
  return 1 - intersection / union;
}

function scoreCandidate(candidate, selected) {
  if (selected.length === 0) {
    return 1;
  }
  return Math.min(...selected.map((picked) => jaccardDistance(candidate.tags, picked.tags)));
}

function selectDiversePersonas(candidates, { minCount = 5, maxCount = 6 } = {}) {
  if (!Array.isArray(candidates)) {
    throw new Error('candidates must be an array');
  }

  const targetCount = Math.max(minCount, Math.min(maxCount, candidates.length));
  const pool = [...candidates];
  const selected = [];

  while (selected.length < targetCount && pool.length > 0) {
    pool.sort((a, b) => scoreCandidate(b, selected) - scoreCandidate(a, selected));
    selected.push(pool.shift());
  }

  return [...selected, ...FIXED_PERSONAS];
}

module.exports = {
  FIXED_PERSONAS,
  selectDiversePersonas,
  jaccardDistance,
};
