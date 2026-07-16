const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a per-process temp dir so appendLog calls inside
// persona.js don't pollute the developer's real ideas directory. Must happen
// before requiring storage / persona (mirrors test/researcher.test.js).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const {
  runAlignmentMove,
  runIdeation,
  runAdversarialMark,
  runObservation,
  emitOneMove,
  emitPersonaMove,
} = require('../src/agents/persona');

const IDEA = { id: 'i_test', raw_capture: 'topic under investigation' };
const TERRITORY = { id: 't1', name: 'Territory One', description: 'territory description' };
const PERSONA = { id: 'p1', name: 'Persona One', description: 'role desc' };

// --- mock client -------------------------------------------------------
//
// Queues one response per call to client.messages.create; the last response
// in the array is reused for any calls beyond the queue length. Every call's
// params are captured so tests can assert on max_tokens.

function queueClient(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return resp;
      },
    },
  };
}

function toolUseResponse({ name, input, stopReason = 'end_turn', outputTokens = 100 }) {
  return {
    content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
    stop_reason: stopReason,
    usage: { input_tokens: 50, output_tokens: outputTokens },
  };
}

// Simulates generation being cut off (max_tokens) before the forced tool_use
// block ever appeared in the response content.
function truncatedNoToolResponse({ outputTokens }) {
  return {
    content: [{ type: 'text', text: 'thinking about the answer...' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 50, output_tokens: outputTokens },
  };
}

// ---------------------------------------------------------------------
// runAlignmentMove — confirmed-truncation call site (t_005 production bug)
// ---------------------------------------------------------------------

test('runAlignmentMove: retries once when max_tokens truncates before tool_use appears, then succeeds', async () => {
  const validInput = { type: 'Propose', content: 'Merge these two candidate questions.', candidate_id: 'c1' };
  const client = queueClient([
    truncatedNoToolResponse({ outputTokens: 2400 }),
    toolUseResponse({ name: 'emit_alignment_move', input: validInput }),
  ]);

  const move = await runAlignmentMove({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
    candidateQuestions: [
      { candidate_id: 'c1', by_persona_id: 'p1', predicted_confidence: 6, question: 'Q1?' },
    ],
    adversarialMarks: [],
    history: [],
  });

  assert.equal(client.calls.length, 2, 'must retry once rather than crash or give up immediately');
  assert.deepEqual(move, validInput);
  // maxTokens: 1200 -> 2400 per the truncation fix.
  assert.equal(client.calls[0].max_tokens, 2400);
  assert.equal(client.calls[1].max_tokens, 2400);
});

test('runAlignmentMove: retries when tool_use appears but is truncated mid-JSON (missing required field)', async () => {
  const client = queueClient([
    toolUseResponse({
      name: 'emit_alignment_move',
      input: { type: 'Propose' }, // content missing — cut off mid-emit
      stopReason: 'max_tokens',
      outputTokens: 2400,
    }),
    toolUseResponse({
      name: 'emit_alignment_move',
      input: { type: 'Propose', content: 'A complete alignment move.' },
    }),
  ]);

  const move = await runAlignmentMove({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
    candidateQuestions: [
      { candidate_id: 'c1', by_persona_id: 'p1', predicted_confidence: 6, question: 'Q1?' },
    ],
    adversarialMarks: [],
    history: [],
  });

  assert.equal(client.calls.length, 2);
  assert.equal(move.content, 'A complete alignment move.');
});

test('runAlignmentMove: returns null (not a crash, not a broken move) after two truncated attempts', async () => {
  const client = queueClient([
    truncatedNoToolResponse({ outputTokens: 2400 }),
    truncatedNoToolResponse({ outputTokens: 2400 }),
  ]);

  const move = await runAlignmentMove({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
    candidateQuestions: [
      { candidate_id: 'c1', by_persona_id: 'p1', predicted_confidence: 6, question: 'Q1?' },
    ],
    adversarialMarks: [],
    history: [],
  });

  assert.equal(client.calls.length, 2, 'should not retry a third time');
  assert.equal(move, null, 'must not silently propagate a broken/incomplete move');
});

// ---------------------------------------------------------------------
// emitOneMove / emitPersonaMove — debate move emission
// ---------------------------------------------------------------------

const SUB_QUESTION = { id: 'sq1', question: 'Is this a good idea?' };

test('emitOneMove: toolUse null (truncated before tool_use appeared) does not throw; rawMove is null and truncated is true', async () => {
  const client = queueClient([truncatedNoToolResponse({ outputTokens: 2400 })]);

  const result = await emitOneMove({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    persona: PERSONA,
    subQuestion: SUB_QUESTION,
    history: [],
    isOpening: true,
    allowedTypes: ['Claim'],
    constrainedRebut: null,
    logFile: 'pair-sq1',
    attempt: 1,
    feedbackMessages: [],
  });

  assert.equal(result.rawMove, null);
  assert.equal(result.truncated, true);
  // maxTokens: 1400 -> 2400 per the truncation fix.
  assert.equal(client.calls[0].max_tokens, 2400);
});

test('emitPersonaMove: retries once when the first attempt truncates with a missing-field move, then succeeds', async () => {
  const validClaim = {
    type: 'Claim',
    content: 'This idea has strong merit.',
    evidence_basis: 'prior domain knowledge',
    confidence: 6,
    references_move_id: null,
  };
  const client = queueClient([
    // Attempt 1: tool_use appeared but cut off mid-JSON, missing required fields.
    toolUseResponse({
      name: 'emit_move',
      input: { type: 'Claim' },
      stopReason: 'max_tokens',
      outputTokens: 2400,
    }),
    // Attempt 2: complete, valid move.
    toolUseResponse({ name: 'emit_move', input: validClaim }),
  ]);

  const { move, synthesized } = await emitPersonaMove({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    persona: PERSONA,
    subQuestion: SUB_QUESTION,
    history: [],
    sequence: 1,
    isOpening: true,
    logFile: 'pair-sq1',
  });

  assert.equal(client.calls.length, 2, 'must retry once rather than crash or accept the truncated move');
  assert.equal(synthesized, false);
  assert.equal(move.content, validClaim.content);
  assert.equal(move.confidence, validClaim.confidence);
  assert.equal(client.calls[0].max_tokens, 2400);
  assert.equal(client.calls[1].max_tokens, 2400);
});

test('emitPersonaMove: toolUse null on the first attempt (truncated before tool_use appeared) still retries and recovers', async () => {
  const validClaim = {
    type: 'Claim',
    content: 'Another valid claim.',
    evidence_basis: 'reasoning chain',
    confidence: 5,
    references_move_id: null,
  };
  const client = queueClient([
    truncatedNoToolResponse({ outputTokens: 2400 }),
    toolUseResponse({ name: 'emit_move', input: validClaim }),
  ]);

  const { move } = await emitPersonaMove({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    persona: PERSONA,
    subQuestion: SUB_QUESTION,
    history: [],
    sequence: 1,
    isOpening: true,
    logFile: 'pair-sq1',
  });

  assert.equal(client.calls.length, 2);
  assert.equal(move.content, validClaim.content);
});

// ---------------------------------------------------------------------
// runIdeation — no pre-existing retry loop; added as part of this fix
// ---------------------------------------------------------------------

test('runIdeation: retries once when candidate_questions is truncated/empty, then succeeds', async () => {
  const validQuestions = [
    { question: 'Q1?', predicted_answer: 'A1', predicted_confidence: 5, surface_area_rationale: 'r1' },
    { question: 'Q2?', predicted_answer: 'A2', predicted_confidence: 6, surface_area_rationale: 'r2' },
  ];
  const client = queueClient([
    truncatedNoToolResponse({ outputTokens: 5000 }),
    toolUseResponse({ name: 'emit_candidate_questions', input: { candidate_questions: validQuestions } }),
  ]);

  const result = await runIdeation({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
  });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(result.candidate_questions, validQuestions);
  assert.equal(client.calls[0].max_tokens, 5000);
});

test('runIdeation: returns empty candidate_questions (not a crash) after two truncated attempts', async () => {
  const client = queueClient([
    truncatedNoToolResponse({ outputTokens: 5000 }),
    truncatedNoToolResponse({ outputTokens: 5000 }),
  ]);

  const result = await runIdeation({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
  });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(result.candidate_questions, []);
});

// ---------------------------------------------------------------------
// runAdversarialMark — no pre-existing retry loop; added as part of this fix
// ---------------------------------------------------------------------

test('runAdversarialMark: retries once on truncation, then succeeds', async () => {
  const validMarks = [{ candidate_id: 'c1', could_answer_from_priors: true }];
  const client = queueClient([
    truncatedNoToolResponse({ outputTokens: 3200 }),
    toolUseResponse({ name: 'emit_adversarial_marks', input: { marks: validMarks } }),
  ]);

  const result = await runAdversarialMark({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
    candidateQuestions: [{ candidate_id: 'c1', question: 'Q1?', predicted_confidence: 5 }],
  });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(result.marks, validMarks);
  assert.equal(client.calls[0].max_tokens, 3200);
});

// ---------------------------------------------------------------------
// runObservation — reuses working_group.js's existing retry-on-throw path
// ---------------------------------------------------------------------

test('runObservation: throws (rather than crashing on a null-property access) when truncated, so the caller\'s existing retry can catch it', async () => {
  const client = queueClient([truncatedNoToolResponse({ outputTokens: 3200 })]);
  const report = {
    report_id: 'r1',
    outcome: 'useful',
    findings: [{ finding_id: 'f1', confidence_in_source: 6, summary: 's', source_url: 'u' }],
  };

  await assert.rejects(
    () =>
      runObservation({
        client,
        idea: IDEA,
        model: 'test-model',
        budget: null,
        territory: TERRITORY,
        persona: PERSONA,
        report,
        allReports: [report],
      }),
    /truncated|malformed/
  );
  assert.equal(client.calls[0].max_tokens, 3200);
});

test('runObservation: succeeds normally when observations are complete', async () => {
  const client = queueClient([
    toolUseResponse({
      name: 'emit_observations',
      input: { observations: [{ content: 'obs', cited_finding_ids: ['f1'] }] },
    }),
  ]);
  const report = {
    report_id: 'r1',
    outcome: 'useful',
    findings: [{ finding_id: 'f1', confidence_in_source: 6, summary: 's', source_url: 'u' }],
  };

  const result = await runObservation({
    client,
    idea: IDEA,
    model: 'test-model',
    budget: null,
    territory: TERRITORY,
    persona: PERSONA,
    report,
    allReports: [report],
  });

  assert.equal(result.observations.length, 1);
});
