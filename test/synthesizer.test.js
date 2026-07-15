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

const { renderFindings, renderFindingsText, runSynthesizer } = require('../src/agents/synthesizer');
const { createMockClient } = require('./mocks/anthropic');

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

test('runSynthesizer passes timeoutMs: 180_000 to the underlying API call', async () => {
  // The synthesizer overrides the default SDK timeout because it emits a
  // ~6.5k-token tool call that routinely runs 60–120s. Asserting the value is
  // forwarded protects against an accidental refactor that drops the override.
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

  assert.equal(capturedTimeout, 180_000);
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

test('renderFindings caps at 30 refs', () => {
  const findings = Array.from({ length: 50 }, (_, i) => ({
    finding_id: `f${i}`,
    source_url: `https://example.com/${i}`,
    content: `content ${i}`,
  }));
  const refs = renderFindings([{ researcher_reports: [{ findings }] }]);
  assert.equal(refs.length, 30);
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
