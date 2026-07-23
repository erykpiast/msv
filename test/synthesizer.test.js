'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a temp dir so appendLog calls don't touch the real filesystem.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesizer-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const { renderFindings, renderFindingsText, runSynthesizer, buildEmitSynthesisTool } = require('../src/agents/synthesizer');
const { createMockClient } = require('./mocks/anthropic');
const { readLog } = require('../src/storage');

// Builds a client that captures the `tools[0]` (the built emit_synthesis tool
// definition) passed to messages.stream, then returns the shared mock's
// canned emit_synthesis payload — same capture technique as the existing
// `passes timeoutMs` test below.
function makeSchemaCapturingClient() {
  let capturedTool;
  const client = {
    capturedTool: () => capturedTool,
    messages: {
      stream(params) {
        capturedTool = params.tools?.[0];
        return {
          async finalMessage() {
            return {
              stop_reason: 'tool_use',
              content: [{
                type: 'tool_use',
                id: 'mock',
                name: 'emit_synthesis',
                input: {
                  report: 'Mock. '.repeat(60),
                  headline_findings: ['A.', 'B.', 'C.'],
                  open_tensions: [],
                  sections: [
                    { area_title: 'A', area_summary: 's', key_findings: [{ content: 'c', confidence: 'high' }] },
                    { area_title: 'B', area_summary: 's', key_findings: [{ content: 'c', confidence: 'high' }] },
                  ],
                },
              }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
  return client;
}

// A synthetic forum with `nodeCount` nodes and `sourceCount` deduplicated
// source URLs spread across pairDebates' researcher_reports — big enough to
// push the built schema's maxItems well past today's fixed values.
function buildLargeSynthesizerInputs({ nodeCount, sourceCount }) {
  const inputs = buildSynthesizerInputs();
  inputs.forum.nodes = Array.from({ length: nodeCount }, (_, i) => ({
    node_id: `n_${i}`,
    survival_rank: i + 1,
    working_group_id: `t_${i % 5}`,
    aggregate_confidence: 0.5,
    has_open_question: false,
    contradiction_with_node_id: null,
    content: `Claim number ${i}.`,
    reactions: [],
  }));
  inputs.pairDebates = [{
    researcher_reports: [{
      findings: Array.from({ length: sourceCount }, (_, i) => ({
        finding_id: `f_${i}`,
        source_url: `https://example.com/${i}`,
        content: `content ${i}`,
      })),
    }],
  }];
  return inputs;
}

// Minimal idea/forum/personas/pairDebates the synthesizer can render without
// throwing. The mock client returns a complete `emit_synthesis` payload, so
// these inputs only need to exercise the renderForum/renderPersonas paths.
function buildSynthesizerInputs() {
  return {
    idea: { id: 'i_test', raw_capture: 'A topic for the mock synthesizer.' },
    personas: [
      { id: 'p_001', name: 'Mock Researcher', tradition: 'Empirical', stance: 'Neutral' },
    ],
    forum: {
      nodes: [
        {
          node_id: 'n_001',
          survival_rank: 1,
          working_group_id: 't_001',
          aggregate_confidence: 0.75,
          has_open_question: false,
          contradiction_with_node_id: null,
          content: 'A claim worth surfacing.',
          reactions: [],
        },
      ],
      dead_end_questions: [],
    },
    pairDebates: [],
  };
}

function makeRecordingBus() {
  const events = [];
  return {
    events,
    emit: (name, payload) => events.push({ name, payload }),
  };
}

// ---------------------------------------------------------------------------
// runSynthesizer — integration with mock client
// ---------------------------------------------------------------------------

test('runSynthesizer returns structured payload with sections, tension_points, key_references, next_pass_proposals from the mock', async () => {
  const client = createMockClient();
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  // Top-level shape — the synthesizer must pass through every structured field
  // the schema/mock supplies. Drift in the production mapping (e.g. dropping
  // sections from the return value) shows up here.
  assert.ok(result.produced_at, 'produced_at must be set');
  assert.equal(typeof result.report, 'string');
  assert.ok(Array.isArray(result.headline_findings));
  assert.ok(Array.isArray(result.open_tensions));
  assert.ok(Array.isArray(result.sections), 'sections must be an array');
  assert.ok(result.sections.length >= 2, `sections must have at least 2 entries; got ${result.sections.length}`);
  // Each section must satisfy the schema-shaped fields the consumers depend on.
  for (const section of result.sections) {
    assert.equal(typeof section.area_title, 'string');
    assert.equal(typeof section.area_summary, 'string');
    assert.ok(Array.isArray(section.key_findings) && section.key_findings.length >= 1);
    for (const finding of section.key_findings) {
      assert.equal(typeof finding.content, 'string');
      assert.ok(['high', 'medium', 'low'].includes(finding.confidence));
    }
  }
  assert.ok(Array.isArray(result.tension_points));
  assert.ok(result.tension_points.length >= 1, 'tension_points must be populated from the mock');
  assert.ok(Array.isArray(result.key_references));
  assert.ok(result.key_references.length >= 1, 'key_references must be populated from the mock');
  assert.ok(Array.isArray(result.next_pass_proposals));
  assert.ok(result.next_pass_proposals.length >= 3, 'next_pass_proposals must be populated from the mock');
});

test('runSynthesizer emits synthesizer.done with section_count matching sections.length', async () => {
  const client = createMockClient();
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  const done = bus.events.find((e) => e.name === 'synthesizer.done');
  assert.ok(done, 'synthesizer.done must be emitted');
  // section_count must equal the actual sections.length. The original commit
  // wired this manually; this guards against the count drifting from the
  // payload if either side is refactored independently.
  assert.equal(done.payload.section_count, result.sections.length);
  assert.equal(done.payload.headline_count, result.headline_findings.length);
  assert.equal(done.payload.tension_count, result.open_tensions.length);
  assert.equal(typeof done.payload.has_question_landscape, 'boolean');
  assert.equal(typeof done.payload.has_dead_end_summary, 'boolean');
});

test('runSynthesizer falls back to null for optional structured fields when absent', async () => {
  // Build a client whose emit_synthesis payload omits every optional field —
  // exercises the `payload.X || null` fallbacks at the bottom of runSynthesizer.
  // Using a hand-rolled client (rather than mutating the shared mock fixture)
  // keeps the other tests' assumptions intact.
  const minimalPayload = {
    report: 'A minimal mock synthesis report. '.repeat(8),
    headline_findings: ['One.', 'Two.', 'Three.'],
    open_tensions: [],
    sections: [
      {
        area_title: 'Area A',
        area_summary: 'Framing A.',
        key_findings: [{ content: 'Finding A1.', confidence: 'medium' }],
      },
      {
        area_title: 'Area B',
        area_summary: 'Framing B.',
        key_findings: [{ content: 'Finding B1.', confidence: 'low' }],
      },
    ],
    // tension_points, key_references, next_pass_proposals, question_landscape,
    // dead_end_summary intentionally omitted.
  };
  const client = {
    messages: {
      stream() {
        return {
          async finalMessage() {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input: minimalPayload }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  // The `|| null` fallbacks must produce literal nulls, not undefined, so
  // downstream code that checks for `=== null` (the inspector reads exactly
  // these fields) keeps working.
  assert.equal(result.question_landscape, null);
  assert.equal(result.dead_end_summary, null);
  assert.equal(result.tension_points, null);
  assert.equal(result.key_references, null);
  assert.equal(result.next_pass_proposals, null);
  // sections is required by the schema, so the fallback should never trigger;
  // verifying the present-path keeps the test scope clean.
  assert.ok(Array.isArray(result.sections));
});

test('runSynthesizer passes timeoutMs: 600_000 to the underlying API call', async () => {
  // The synthesizer overrides the default SDK timeout because it emits up to a
  // 32k-token tool call with xhigh effort + adaptive thinking. Asserting the
  // value is forwarded protects against an accidental refactor that drops the
  // override.
  let capturedTimeout;
  const client = {
    messages: {
      stream(_params, opts) {
        capturedTimeout = opts?.timeout;
        return {
          async finalMessage() {
            return {
              stop_reason: 'tool_use',
              content: [{
                type: 'tool_use',
                id: 'mock',
                name: 'emit_synthesis',
                input: {
                  report: 'Mock. '.repeat(60),
                  headline_findings: ['A.', 'B.', 'C.'],
                  open_tensions: [],
                  sections: [
                    { area_title: 'A', area_summary: 's', key_findings: [{ content: 'c', confidence: 'high' }] },
                    { area_title: 'B', area_summary: 's', key_findings: [{ content: 'c', confidence: 'high' }] },
                  ],
                },
              }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  await runSynthesizer({ client, bus, ...inputs });

  assert.equal(capturedTimeout, 600_000);
});

test('runSynthesizer returns truncated: true and partial fields on stop_reason: max_tokens, without throwing', async () => {
  // Simulates the real bug this spec fixes: the tool call hits max_tokens
  // partway through emitting the structured payload, so report/key_references/
  // next_pass_proposals never arrive.
  const partialPayload = {
    headline_findings: ['Only headline made it in.'],
    sections: [
      {
        area_title: 'Area A',
        area_summary: 'Framing A.',
        key_findings: [{ content: 'Finding A1.', confidence: 'medium' }],
      },
      {
        area_title: 'Area B',
        area_summary: 'Framing B.',
        key_findings: [{ content: 'Finding B1.', confidence: 'low' }],
      },
    ],
    // report, key_references, next_pass_proposals, open_tensions: cut off by max_tokens.
  };
  const client = {
    messages: {
      stream() {
        return {
          async finalMessage() {
            return {
              stop_reason: 'max_tokens',
              content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input: partialPayload }],
              usage: { input_tokens: 10, output_tokens: 32000 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.equal(result.truncated, true);
  assert.deepEqual(result.headline_findings, ['Only headline made it in.']);
  assert.ok(Array.isArray(result.sections));
  assert.equal(result.report, undefined);
  assert.equal(result.key_references, null);
  assert.equal(result.next_pass_proposals, null);

  const done = bus.events.find((e) => e.name === 'synthesizer.done');
  assert.equal(done.payload.truncated, true);
});

test('runSynthesizer returns truncated: true when max_tokens hits before the tool block is emitted', async () => {
  // Harsher truncation than the mid-payload case: the model runs out of output
  // tokens before emitting the emit_synthesis tool_use block at all, so the
  // streamed final message carries no tool_use content. runStructuredStreamingCall
  // must not throw its "Expected forced tool call" error here — it must return
  // toolUse: null so runSynthesizer surfaces this as a resumable truncation.
  const client = {
    messages: {
      stream() {
        return {
          async finalMessage() {
            return {
              stop_reason: 'max_tokens',
              content: [{ type: 'text', text: 'Partial thinking, no tool call yet' }],
              usage: { input_tokens: 10, output_tokens: 32000 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.equal(result.truncated, true);
  assert.equal(result.report, undefined);
  assert.deepEqual(result.headline_findings, []);
  assert.equal(result.sections, null);
  assert.equal(result.key_references, null);
  assert.equal(result.next_pass_proposals, null);

  const done = bus.events.find((e) => e.name === 'synthesizer.done');
  assert.equal(done.payload.truncated, true);
});

test('runSynthesizer reports truncated: falsy on a normal completion', async () => {
  const client = createMockClient();
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.ok(!result.truncated);
});

test('runSynthesizer retries once on a malformed (XML-pseudo-tool-call) payload and recovers on the retry', async () => {
  // Reproduces issue #35: a non-truncated response whose array fields are
  // stray XML-`<parameter>` strings instead of JSON arrays.
  const malformedPayload = {
    report: 'Mock. '.repeat(60),
    headline_findings: '<parameter name="headline_findings">["A."]</parameter>',
    open_tensions: [],
    sections: '<parameter name="sections">[{"area_title":"A"}]</parameter>',
  };
  const goodPayload = {
    report: 'Recovered. '.repeat(60),
    headline_findings: ['A.', 'B.', 'C.'],
    open_tensions: [],
    sections: [
      { area_title: 'A', area_summary: 's', key_findings: [{ content: 'c', confidence: 'high' }] },
      { area_title: 'B', area_summary: 's', key_findings: [{ content: 'c', confidence: 'high' }] },
    ],
  };
  let callCount = 0;
  const streamCalls = [];
  const client = {
    messages: {
      stream(params) {
        callCount += 1;
        streamCalls.push(params);
        const input = callCount === 1 ? malformedPayload : goodPayload;
        return {
          async finalMessage() {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.equal(callCount, 2);
  assert.deepEqual(result.headline_findings, ['A.', 'B.', 'C.']);
  assert.equal(result.sections.length, 2);
  assert.equal(result.report, goodPayload.report);

  // The retry's messages must include the corrective user turn.
  const retryMessages = streamCalls[1].messages;
  const lastMessage = retryMessages[retryMessages.length - 1];
  assert.equal(lastMessage.role, 'user');
  assert.match(lastMessage.content, /valid JSON/i);

  const malformedLog = await readLog('i_test', 'synthesizer');
  assert.ok(malformedLog.some((entry) => entry.kind === 'malformed_payload_retry'));
});

test('runSynthesizer falls back to the degraded result when the retry is also malformed', async () => {
  const malformedPayload = {
    report: 'Mock. '.repeat(60),
    headline_findings: '<parameter name="headline_findings">["A."]</parameter>',
    open_tensions: [],
  };
  const client = {
    messages: {
      stream() {
        return {
          async finalMessage() {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input: malformedPayload }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.deepEqual(result.headline_findings, []);
  assert.equal(result.report, malformedPayload.report);

  const malformedLog = await readLog('i_test', 'synthesizer');
  assert.ok(malformedLog.some((entry) => entry.kind === 'malformed_payload_retry'));
  assert.ok(malformedLog.some((entry) => entry.kind === 'malformed_payload'));
});

test('runSynthesizer does not retry a truncated (max_tokens) payload even if shape-diagnosed', async () => {
  const partialPayload = {
    headline_findings: ['Only headline made it in.'],
  };
  let callCount = 0;
  const client = {
    messages: {
      stream() {
        callCount += 1;
        return {
          async finalMessage() {
            return {
              stop_reason: 'max_tokens',
              content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input: partialPayload }],
              usage: { input_tokens: 10, output_tokens: 32000 },
            };
          },
        };
      },
    },
  };
  const bus = makeRecordingBus();
  const inputs = buildSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.equal(callCount, 1);
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------------------
// buildEmitSynthesisTool — schema scaling unit tests
// ---------------------------------------------------------------------------

test('buildEmitSynthesisTool scales sections/key_findings/key_references maxItems above today\'s fixed values for a large investigation', () => {
  const tool = buildEmitSynthesisTool({ nodeCount: 60, totalSourceCount: 150 });
  const props = tool.input_schema.properties;

  assert.ok(props.sections.maxItems > 6, `sections.maxItems should exceed the old fixed 6; got ${props.sections.maxItems}`);
  assert.ok(
    props.sections.items.properties.key_findings.maxItems > 5,
    `key_findings.maxItems should exceed the old fixed 5; got ${props.sections.items.properties.key_findings.maxItems}`
  );
  assert.ok(props.key_references.maxItems > 8, `key_references.maxItems should exceed the old fixed 8; got ${props.key_references.maxItems}`);
});

test('buildEmitSynthesisTool does not scale below today\'s minimums for a small investigation', () => {
  const tool = buildEmitSynthesisTool({ nodeCount: 1, totalSourceCount: 0 });
  const props = tool.input_schema.properties;

  assert.ok(props.sections.maxItems >= props.sections.minItems, 'sections.maxItems must stay at/above its own minItems');
  assert.ok(
    props.sections.items.properties.key_findings.maxItems >= props.sections.items.properties.key_findings.minItems,
    'key_findings.maxItems must stay at/above its own minItems'
  );
  assert.ok(props.key_references.maxItems >= 1, 'key_references.maxItems must stay usable even for a tiny investigation');
});

test('buildEmitSynthesisTool leaves headline_findings, tension_points, next_pass_proposals, open_tensions unscaled regardless of input size', () => {
  const small = buildEmitSynthesisTool({ nodeCount: 1, totalSourceCount: 0 });
  const large = buildEmitSynthesisTool({ nodeCount: 60, totalSourceCount: 150 });

  for (const field of ['headline_findings', 'tension_points', 'next_pass_proposals', 'open_tensions']) {
    assert.equal(
      small.input_schema.properties[field].maxItems,
      large.input_schema.properties[field].maxItems,
      `${field}.maxItems should be identical for small and large inputs`
    );
  }
});

test('runSynthesizer builds a schema with scaled maxItems for a large synthetic investigation', async () => {
  const client = makeSchemaCapturingClient();
  const bus = makeRecordingBus();
  const inputs = buildLargeSynthesizerInputs({ nodeCount: 60, sourceCount: 150 });

  await runSynthesizer({ client, bus, ...inputs });

  const tool = client.capturedTool();
  assert.ok(tool, 'the emit_synthesis tool definition must have been captured');
  const props = tool.input_schema.properties;
  assert.ok(props.sections.maxItems > 6, `expected scaled sections.maxItems > 6; got ${props.sections.maxItems}`);
  assert.ok(props.key_references.maxItems > 8, `expected scaled key_references.maxItems > 8; got ${props.key_references.maxItems}`);
});

test('runSynthesizer logs coverage (sources available vs. rendered/included) in its request and response logs', async () => {
  const client = createMockClient();
  const bus = makeRecordingBus();
  const inputs = buildLargeSynthesizerInputs({ nodeCount: 10, sourceCount: 100 });

  await runSynthesizer({ client, bus, ...inputs });

  // Every test in this file logs to the same idea id, so the log file
  // accumulates entries across tests — take the most recent request/response
  // pair rather than the first, which would belong to an earlier test.
  const entries = await readLog('i_test', 'synthesizer');
  const request = entries.filter((e) => e.kind === 'request').at(-1);
  const response = entries.filter((e) => e.kind === 'response').at(-1);

  assert.equal(request.payload.source_available_count, 100);
  assert.ok(request.payload.finding_ref_count < 100, 'the rendered finding_ref_count should be capped below the full available count');
  assert.equal(response.payload.source_available_count, 100);
  assert.equal(typeof response.payload.key_references_count, 'number');
});

// ---------------------------------------------------------------------------
// renderFindings — unit tests
// ---------------------------------------------------------------------------

test('renderFindings deduplicates source_url across findings', () => {
  const refs = renderFindings([{
    researcher_reports: [
      { findings: [{ finding_id: 'f1', source_url: 'https://x.com', content: 'A' }] },
      { findings: [{ finding_id: 'f2', source_url: 'https://x.com', content: 'B' }] },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'https://x.com');
});

test('renderFindings skips findings with no source_url', () => {
  const refs = renderFindings([{
    researcher_reports: [
      { findings: [{ finding_id: 'f1', content: 'no url here' }] },
      { findings: [{ finding_id: 'f2', source_url: 'https://example.com', content: 'has url' }] },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'https://example.com');
});

test('renderFindings scales its cap above 30 when far more than 30 sources are available', () => {
  const findings = Array.from({ length: 100 }, (_, i) => ({
    finding_id: `f${i}`,
    source_url: `https://example.com/${i}`,
    content: `content ${i}`,
  }));
  const refs = renderFindings([{ researcher_reports: [{ findings }] }]);
  assert.ok(refs.length > 30, `expected more than 30 refs for 100 available sources; got ${refs.length}`);
  assert.ok(refs.length < 100, `expected the scaled cap to still be below the full 100 available; got ${refs.length}`);
});

test('renderFindings keeps today\'s floor behavior when 30 or fewer sources are available', () => {
  const findings = Array.from({ length: 20 }, (_, i) => ({
    finding_id: `f${i}`,
    source_url: `https://example.com/${i}`,
    content: `content ${i}`,
  }));
  const refs = renderFindings([{ researcher_reports: [{ findings }] }]);
  assert.equal(refs.length, 20, 'a small investigation should not have its sources clipped');
});

test('renderFindings sorts by quality: primary before secondary before indirect', () => {
  const refs = renderFindings([{
    researcher_reports: [{
      findings: [
        { finding_id: 'f1', source_url: 'https://indirect.com', content: 'c', quality: 'indirect' },
        { finding_id: 'f2', source_url: 'https://primary.com', content: 'a', quality: 'primary' },
        { finding_id: 'f3', source_url: 'https://secondary.com', content: 'b', quality: 'secondary' },
      ],
    }],
  }]);
  assert.equal(refs[0].url, 'https://primary.com');
  assert.equal(refs[1].url, 'https://secondary.com');
  assert.equal(refs[2].url, 'https://indirect.com');
});

test('renderFindings truncates source_title to 120 chars', () => {
  const longTitle = 'A'.repeat(200);
  const refs = renderFindings([{
    researcher_reports: [{
      findings: [{ finding_id: 'f1', source_url: 'https://x.com', source_title: longTitle, content: 'c' }],
    }],
  }]);
  assert.equal(refs[0].title.length, 120);
});

test('renderFindings truncates content to 200 chars', () => {
  const longContent = 'B'.repeat(300);
  const refs = renderFindings([{
    researcher_reports: [{
      findings: [{ finding_id: 'f1', source_url: 'https://x.com', content: longContent }],
    }],
  }]);
  assert.equal(refs[0].content.length, 200);
});

test('renderFindings handles empty pairDebates', () => {
  assert.deepEqual(renderFindings([]), []);
  assert.deepEqual(renderFindings(null), []);
  assert.deepEqual(renderFindings(undefined), []);
});

// ---------------------------------------------------------------------------
// renderFindingsText — unit tests
// ---------------------------------------------------------------------------

test('renderFindingsText returns placeholder when refs is empty', () => {
  assert.equal(renderFindingsText([]), '(no source URLs in this run)');
});

test('renderFindingsText formats refs with url, title, quality, content', () => {
  const text = renderFindingsText([{
    url: 'https://x.com',
    title: 'Example',
    quality: 'primary',
    content: 'some content',
  }]);
  assert.ok(text.includes('https://x.com'));
  assert.ok(text.includes('Example'));
  assert.ok(text.includes('primary'));
  assert.ok(text.includes('some content'));
});

// ---------------------------------------------------------------------------
// runSynthesizer — citation resolver / repair loop (issue #42)
// ---------------------------------------------------------------------------

// Extends the base fixture with a resolvable finding/node pair, so tests can
// exercise the post-pass resolver's node_id -> evidence_refs -> finding walk
// without hand-rolling the whole forum/pairDebates shape each time.
function buildCitableSynthesizerInputs() {
  const inputs = buildSynthesizerInputs();
  inputs.forum.nodes.push({
    node_id: 'n_002',
    survival_rank: 2,
    working_group_id: 't_001',
    aggregate_confidence: 8,
    has_open_question: false,
    contradiction_with_node_id: null,
    content: 'A cited claim.',
    reactions: [],
    evidence_refs: [{ finding_id: 'f_aq1_01' }],
  });
  inputs.pairDebates = [
    {
      territory_id: 't_001',
      researcher_reports: [
        {
          report_id: 'rr_001',
          findings: [
            { finding_id: 'f_aq1_01', source_url: 'https://example.com/a', source_title: 'Source A' },
          ],
        },
      ],
      observations: [],
    },
  ];
  return inputs;
}

function makeSequencedClient(payloads) {
  let callCount = 0;
  const streamCalls = [];
  return {
    calls: streamCalls,
    callCount: () => callCount,
    messages: {
      stream(params) {
        streamCalls.push(params);
        const input = payloads[Math.min(callCount, payloads.length - 1)];
        callCount += 1;
        return {
          async finalMessage() {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
}

test('runSynthesizer resolves a bare node_id citation in tension_points.sides[].position without a repair round-trip', async () => {
  const payload = {
    report: 'Mock. '.repeat(60),
    headline_findings: ['A.', 'B.', 'C.'],
    open_tensions: [],
    tension_points: [
      {
        title: 'T',
        description: 'Disputed per n_002.',
        sides: [{ label: 'Side A', position: 'This holds per n_002.' }],
        resolution: null,
      },
    ],
  };
  const client = makeSequencedClient([payload]);
  const bus = makeRecordingBus();
  const inputs = buildCitableSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.equal(client.callCount(), 1, 'a fully resolvable payload must not trigger a repair round-trip');
  assert.equal(result.structural_issues, null);
  assert.match(result.tension_points[0].description, /\[Source A\]\(https:\/\/example\.com\/a\)/);
  assert.match(result.tension_points[0].sides[0].position, /\[Source A\]\(https:\/\/example\.com\/a\)/);
  assert.doesNotMatch(result.tension_points[0].description, /n_002/);

  const done = bus.events.find((e) => e.name === 'synthesizer.done');
  assert.equal(done.payload.structural_issue_count, 0);
});

test('runSynthesizer batches unresolved references into one repair prompt and recovers on the retry', async () => {
  const brokenPayload = {
    report: 'Mock. '.repeat(60),
    headline_findings: ['A.', 'B.', 'C.'],
    open_tensions: [],
    tension_points: [
      {
        title: 'T',
        description: 'The claim in n_999 is the strongest.',
        sides: [{ label: 'Side A', position: 'Also see f_bogus_99.' }],
        resolution: null,
      },
    ],
  };
  const fixedPayload = {
    report: 'Mock. '.repeat(60),
    headline_findings: ['A.', 'B.', 'C.'],
    open_tensions: [],
    tension_points: [
      {
        title: 'T',
        description: 'The claim in n_002 is the strongest.',
        sides: [{ label: 'Side A', position: 'No further citation needed.' }],
        resolution: null,
      },
    ],
  };
  const client = makeSequencedClient([brokenPayload, fixedPayload]);
  const bus = makeRecordingBus();
  const inputs = buildCitableSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  assert.equal(client.callCount(), 2, 'exactly one repair round-trip for a single batch of broken refs');
  assert.equal(result.structural_issues, null);
  assert.match(result.tension_points[0].description, /\[Source A\]\(https:\/\/example\.com\/a\)/);

  // The repair prompt must batch both broken refs from the same round in one message.
  const repairMessage = client.calls[1].messages[client.calls[1].messages.length - 1];
  assert.equal(repairMessage.role, 'user');
  assert.match(repairMessage.content, /n_999/);
  assert.match(repairMessage.content, /f_bogus_99/);

  const log = await readLog('i_test', 'synthesizer');
  const attempt = log.find((entry) => entry.kind === 'citation_repair_attempt');
  assert.ok(attempt, 'citation_repair_attempt must be logged');
  assert.equal(attempt.payload.attempt, 1);
  assert.equal(attempt.payload.unresolved_count, 2);
});

test('runSynthesizer caps repair at 2 attempts and redacts remaining unresolved ids, surfacing a CLI warning and structural_issues', async () => {
  const stillBrokenPayload = {
    report: 'Mock. '.repeat(60),
    headline_findings: ['A.', 'B.', 'C.'],
    open_tensions: [],
    tension_points: [
      {
        title: 'T',
        description: 'The claim in n_999 never gets fixed.',
        sides: [{ label: 'Side A', position: 'No citation.' }],
        resolution: null,
      },
    ],
  };
  const client = makeSequencedClient([stillBrokenPayload]); // every call returns the same unresolved payload
  const bus = makeRecordingBus();
  const inputs = buildCitableSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  // 1 initial call + 2 repair attempts = 3 calls total.
  assert.equal(client.callCount(), 3);
  assert.match(result.tension_points[0].description, /\[unverified\]/);
  assert.doesNotMatch(result.tension_points[0].description, /n_999/);
  assert.ok(Array.isArray(result.structural_issues));
  assert.equal(result.structural_issues.length, 1);
  assert.equal(result.structural_issues[0].id, 'n_999');

  const warning = bus.events.find(
    (e) => e.name === 'pipeline.stage.progress' && /internal reference\(s\) in the synthesis could not be resolved/.test(e.payload.message)
  );
  assert.ok(warning, 'a CLI-surfaced warning must be emitted when repair is exhausted');

  const done = bus.events.find((e) => e.name === 'synthesizer.done');
  assert.equal(done.payload.structural_issue_count, 1);

  const log = await readLog('i_test', 'synthesizer');
  const exhausted = log.filter((entry) => entry.kind === 'citation_repair_exhausted');
  assert.equal(exhausted.at(-1).payload.attempts, 2, 'repair must be capped at 2 attempts');
});

// First call emits a well-formed payload carrying an unresolvable id; the
// repair round-trip then truncates at max_tokens before the emit_synthesis
// block lands.
function makeTruncatingRepairClient(initialPayload) {
  let callCount = 0;
  const streamCalls = [];
  return {
    calls: streamCalls,
    callCount: () => callCount,
    messages: {
      stream(params) {
        streamCalls.push(params);
        const isFirst = callCount === 0;
        callCount += 1;
        return {
          async finalMessage() {
            if (isFirst) {
              return {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'mock', name: 'emit_synthesis', input: initialPayload }],
                usage: { input_tokens: 10, output_tokens: 10 },
              };
            }
            return {
              stop_reason: 'max_tokens',
              content: [{ type: 'text', text: 'partial, cut off before the tool call...' }],
              usage: { input_tokens: 10, output_tokens: 10 },
            };
          },
        };
      },
    },
  };
}

test('runSynthesizer keeps the complete pre-repair synthesis and redacts when a repair round-trip truncates', async () => {
  const brokenPayload = {
    report: 'Mock. '.repeat(60),
    headline_findings: ['A.', 'B.', 'C.'],
    open_tensions: [],
    tension_points: [
      {
        title: 'T',
        description: 'The claim in n_999 is the strongest.',
        sides: [{ label: 'Side A', position: 'No citation.' }],
        resolution: null,
      },
    ],
  };
  const client = makeTruncatingRepairClient(brokenPayload);
  const bus = makeRecordingBus();
  const inputs = buildCitableSynthesizerInputs();

  const result = await runSynthesizer({ client, bus, ...inputs });

  // 1 initial call + 1 repair that truncated → stop.
  assert.equal(client.callCount(), 2);
  // A truncated repair must NOT discard the good payload or mark the stage
  // truncated: we return a complete, redacted report instead of forcing a re-run.
  assert.equal(result.truncated, false);
  assert.ok(result.report && result.report.length >= 100, 'the initial good report body must survive');
  assert.match(result.tension_points[0].description, /\[unverified\]/);
  assert.doesNotMatch(result.tension_points[0].description, /n_999/);
  assert.ok(Array.isArray(result.structural_issues));
  assert.equal(result.structural_issues[0].id, 'n_999');

  const warning = bus.events.find(
    (e) => e.name === 'pipeline.stage.progress' && /could not be resolved/.test(e.payload.message)
  );
  assert.ok(warning, 'the redaction warning must still surface on the kept payload');

  const done = bus.events.find((e) => e.name === 'synthesizer.done');
  assert.equal(done.payload.truncated, false);
  assert.equal(done.payload.structural_issue_count, 1);
});
