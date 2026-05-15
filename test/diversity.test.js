const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FIXED_PERSONAS,
  distinctness,
  selectDiversePersonas,
  pairDistinctnessScore,
  selectReactorPermutation,
} = require('../src/diversity');

const sampleCandidates = [
  {
    id: 'p_001',
    name: 'HCI argument researcher',
    tradition: 'HCI / argumentation systems',
    stance: 'empirical, interaction-driven',
    description:
      'Studies how groups argue, what scaffolds make disagreement productive, and what tools fail.',
  },
  {
    id: 'p_002',
    name: 'Startup strategy commentator',
    tradition: 'Startup-strategy commentariat',
    stance: 'pragmatic, narrative-driven',
    description: 'Writes about early validation, founder behaviour, and signal vs noise in market feedback.',
  },
  {
    id: 'p_003',
    name: 'Cognitive scientist',
    tradition: 'Cognitive science / group deliberation',
    stance: 'theoretical, experimental',
    description:
      'Studies how cognition shifts when individuals deliberate in groups, including known failure modes like groupthink.',
  },
  {
    id: 'p_004',
    name: 'STS scholar',
    tradition: 'Science and Technology Studies',
    stance: 'critical, socio-technical',
    description: 'Frames the design of tools as socio-technical commitments and surfaces the politics embedded in them.',
  },
  {
    id: 'p_005',
    name: 'Argumentation theorist',
    tradition: 'Philosophy of argumentation',
    stance: 'formal, normative',
    description: 'Defines what makes an argument valid, what fallacies look like, and how dialectical structures should work.',
  },
  {
    id: 'p_006',
    name: 'Quasi-clone HCI',
    tradition: 'HCI / argumentation systems',
    stance: 'empirical, interaction-driven',
    description: 'Studies how groups argue and what scaffolds make disagreement productive.',
  },
];

test('FIXED_PERSONAS contains skeptic and builder', () => {
  const ids = FIXED_PERSONAS.map((p) => p.id);
  assert.deepEqual(ids, ['skeptic', 'builder']);
});

test('distinctness returns 0 for identical inputs', () => {
  assert.equal(distinctness(sampleCandidates[0], sampleCandidates[0]), 0);
});

test('distinctness is higher for different traditions', () => {
  const sameField = distinctness(sampleCandidates[0], sampleCandidates[5]);
  const diffField = distinctness(sampleCandidates[0], sampleCandidates[1]);
  assert.ok(diffField > sameField);
});

test('selectDiversePersonas avoids near-clones', () => {
  const selected = selectDiversePersonas(sampleCandidates, { count: 5 });
  const ids = selected.map((p) => p.id);
  // p_001 and p_006 are near-clones; both should not be in the selection.
  assert.equal(
    ids.includes('p_001') && ids.includes('p_006'),
    false,
    `selected near-clones: ${ids.join(',')}`
  );
});

test('selectDiversePersonas selects requested count when pool is big enough', () => {
  const selected = selectDiversePersonas(sampleCandidates, { count: 4 });
  assert.equal(selected.length, 4);
});

test('selectDiversePersonas handles small pools gracefully', () => {
  const selected = selectDiversePersonas(sampleCandidates.slice(0, 2), { count: 5 });
  assert.equal(selected.length, 2);
});

test('pairDistinctnessScore returns a finite number', () => {
  const score = pairDistinctnessScore(sampleCandidates[0], sampleCandidates[1]);
  assert.ok(Number.isFinite(score));
  assert.ok(score >= 0 && score <= 1);
});

test('selectReactorPermutation produces a valid permutation for 4 pairs', () => {
  const personas = sampleCandidates.slice(0, 4);
  const pairs = [
    { sub_question_id: 'sq_001', assigned_pair: ['p_001', 'p_002'] },
    { sub_question_id: 'sq_002', assigned_pair: ['p_001', 'p_003'] },
    { sub_question_id: 'sq_003', assigned_pair: ['p_002', 'p_004'] },
    { sub_question_id: 'sq_004', assigned_pair: ['p_003', 'p_004'] },
  ];
  const assignment = selectReactorPermutation(pairs, personas);
  assert.equal(assignment.length, 4);
  // No pair reacts to itself.
  assignment.forEach((reactor, i) => assert.notEqual(reactor, i));
  // Each pair is reacted to exactly once.
  const reactedTo = new Set(assignment);
  assert.equal(reactedTo.size, assignment.length);
});
