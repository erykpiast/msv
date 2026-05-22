# Synthesis: Structured Report Format

**Status:** Implemented (commit fbdce38)
**Author:** Eryk Napierała · 2026-05-19
**Related:**
- [`specs/architecture.md`](architecture.md) — pipeline overview; the synthesizer sits at stage 7.
- [`specs/feat-pipeline-inspector-graph.md`](feat-pipeline-inspector-graph.md) — inspect-app where the synthesis leaf drawer renders.
- [`specs/feat-inspect-live-preview.md`](feat-inspect-live-preview.md) — live preview that delivers synthesis as it completes.
- [`specs/question-machine.md`](question-machine.md) — next-pass investigation flow that this spec's "next pass proposals" feeds into.

---

## 1. Overview

The synthesis stage produces the final user-facing output of an investigation run. Today it emits a monolithic prose `report` plus a few parallel arrays (`headline_findings`, `open_tensions`, `question_landscape`, `dead_end_summary`). The format is useful but undifferentiated: a single report block, no links to source material, tensions listed as opaque strings, and no actionable path forward.

This spec redesigns the synthesis output to be:

1. **Structured by topic** — broad thematic areas first, followed by the most interesting specific findings within each.
2. **Linked** — where findings cite source material, the source appears as an inline markdown link (`[title](url)`). The `Markdown.tsx` component already sanitizes and renders `http(s)` links.
3. **Tension-aware** — a dedicated section names the sharpest disagreements between pipeline agents (personas, working groups), including who disagreed and what the crux was.
4. **Reference-anchored** — a "most relevant references" section presents each key source with URL, summary, and observed significance.
5. **Forward-pointing** — a final numbered list proposes specific areas for a follow-up investigation pass.

The changes touch: the synthesizer prompt and tool schema (`synthesizer.js`, `prompts.js`), its input preparation (adds a `renderFindings` pass that surfaces source URLs), the `SynthesisView` type (`types.d.ts`), and the synthesis leaf renderer in the inspect-app (`leafRenderers.tsx`).

---

## 2. Status

Draft.

---

## 3. Authors

Eryk Napierała · 2026-05-19.

---

## 4. Background / Problem Statement

### Current format

```
headline_findings: string[]      // 3–5 bullets
open_tensions: string[]          // ≤3 bullets
report: string                   // 800–1500 words prose
question_landscape: array        // per-territory questions with provenance
dead_end_summary: string         // 1–3 sentences
```

The `report` field is the dominant artifact. It is opinionated prose, which is correct, but it is flat: no heading hierarchy, no distinction between "here is the big picture" and "here is a specific surprising finding," and no links to any source material. Readers have no way to verify a claim or follow up on a finding without manually re-running the search themselves.

The `open_tensions` bullets name a contradiction but are attribute-free: who held the opposing positions, which claims are in conflict, what evidence (if any) could resolve it — all absent.

The `question_landscape` captures what was investigated but is stored separately and is not integrated into the prose flow.

There is no forward pointer. After reading the synthesis, the user's only path to deeper investigation is to re-run `msv run` with a blank topic, losing the prior investigation's context. The `question-machine.md` spec introduces investigation resumption; this spec provides the structured output that makes "resume" useful: a curated list of specific next-pass proposals.

### Why references are missing today

The synthesizer receives `renderForum(forum)` — a text dump of ranked claims with reactions and contradictions. This dump does not include `source_url` or `source_title` from the underlying `Finding` records. The forum-node type does carry `evidence_refs` in the live data (propagated from surviving claims at `forum.js:68`), but those refs are finding IDs, and the synthesizer never receives the corresponding `Finding` objects. As a result, the synthesizer cannot produce links even if instructed to.

Fixing this requires augmenting the synthesizer's input with finding metadata: at minimum, `finding_id`, `source_url`, `source_title`, and the finding's `content`.

---

## 5. Goals

- Replace the flat `report` string with a structured section tree: broad areas → specific findings, all linkable to source.
- Every `source_url` cited in a finding that the synthesizer judges relevant appears as a rendered markdown link.
- A dedicated tension-points section names the sharpest multi-persona or multi-working-group disagreements with enough specificity to understand the crux.
- A "most relevant references" section surfaces the top sources with URL, one-paragraph summary, and key observations.
- A "next pass proposals" section lists 3–6 specific topics worth deeper investigation, ordered by relevance, each with a rationale sentence.
- The `SynthesisView` TypeScript type fully describes the new shape so the inspect-app is type-safe.
- The inspect-app synthesis drawer renders all new sections — no data is hidden in an unexposed raw field.

---

## 6. Non-Goals

- Changing the pipeline stages that *feed* the synthesizer (researcher, forum, cross-pollination). This spec changes only what the synthesizer receives and emits.
- Interactive next-pass triggering. Proposals are plain text read-only suggestions; wiring them into `msv run` is handled by the existing investigation resumption flow and is out of scope here.
- Backward-compatibility rendering for v4 investigations. v4 syntheses stay as-is; the new rendering branch is gated on schema version.
- Changing the synthesizer model choice. This spec is format-only.

---

## 7. Technical Dependencies

| Dependency | Role |
|---|---|
| `react-markdown` + `rehype-sanitize` | Already in use in `Markdown.tsx`; renders inline markdown links in finding content. |
| `@mantine/core` | Existing UI kit used throughout the inspect-app. |
| Anthropic SDK (existing) | `runStructuredCall` is unchanged; only the tool schema and prompt change. |

No new npm packages required.

---

## 8. Detailed Design

### 8.1 New `SynthesisView` type

```typescript
// types.d.ts

export type SynthesisSection = {
  area_title: string;
  area_summary: string;          // 2–3 sentences framing the area
  key_findings: SynthesisFinding[];
};

export type SynthesisFinding = {
  content: string;               // one finding; may contain inline markdown links [title](url)
  confidence: 'high' | 'medium' | 'low';
};

export type SynthesisTensionPoint = {
  title: string;
  description: string;           // what the crux is
  sides: SynthesisSide[];        // ≥2 sides; each names a claim or WG
  resolution: string | null;     // null = genuinely unresolved
};

export type SynthesisSide = {
  label: string;                 // e.g. persona name or "WG-T3"
  position: string;              // their claim in one sentence
};

export type SynthesisReference = {
  url: string;
  title: string;
  summary: string;               // 1–2 sentences
  key_observations: string[];    // 1–3 bullets on why this source matters
};

export type SynthesisNextPassProposal = {
  topic: string;
  rationale: string;             // why this is worth exploring
  territory_hint?: string;       // which territory it relates to, if any
};

export type SynthesisView = {
  // New structured format (v5+ with this feature)
  sections?: SynthesisSection[];
  tension_points?: SynthesisTensionPoint[];
  key_references?: SynthesisReference[];
  next_pass_proposals?: SynthesisNextPassProposal[];
  dead_end_summary?: string;
  // Legacy / always-present fields (kept for backward compat and raw view)
  report: string;
  headline_findings: string[];
  open_tensions: string[];
  question_landscape?: QuestionLandscapeEntry[];
} | null;
```

The `report` and `headline_findings` fields remain so existing v4/v5 consumers don't break. The new fields are additive. When all new fields are present, the inspect-app renders the rich view; when absent, it falls back to the current prose rendering.

### 8.2 Augmenting the synthesizer input — `renderFindings`

The synthesizer needs to know which findings have usable source URLs so it can cite them. A new helper in `synthesizer.js`:

```javascript
function renderFindings(pairDebates) {
  const seen = new Set();
  const refs = [];
  for (const pd of (pairDebates || [])) {
    for (const rr of (pd.researcher_reports || [])) {
      for (const f of (rr.findings || [])) {
        if (!f.source_url || seen.has(f.source_url)) continue;
        seen.add(f.source_url);
        refs.push({
          url: f.source_url,
          title: f.source_title || f.source_url,
          content: f.content,
          quality: f.quality || 'secondary',
        });
      }
    }
  }
  return refs;
}

function renderFindingsText(refs) {
  if (refs.length === 0) return '(no source URLs in this run)';
  return refs
    .map(r => `- ${r.title} — ${r.url} (quality: ${r.quality})\n  ${r.content}`)
    .join('\n');
}
```

The text rendering is injected into the prompt. The model is instructed to use inline markdown links when citing a source (`[title](url)`) rather than a separate footnote numbering scheme. This keeps finding content self-contained and avoids the complexity of correlating `[N]` markers across two output fields.

The `renderFindings` de-duplicates by `source_url` — if two findings share a URL, only the first is included. Maximum 30 refs are included, sorted by quality (primary > secondary > indirect); excess are silently dropped to keep prompt size bounded.

### 8.3 Updated `emit_synthesis` tool schema

The `EMIT_SYNTHESIS_TOOL` input schema gains new top-level properties while keeping existing ones:

```javascript
const EMIT_SYNTHESIS_TOOL = {
  name: 'emit_synthesis',
  description:
    'Emit the structured report: sections with findings, tension points, key references, and next-pass proposals.',
  input_schema: {
    type: 'object',
    required: ['headline_findings', 'open_tensions', 'report', 'sections'],
    additionalProperties: false,
    properties: {
      // --- existing ---
      headline_findings: { /* unchanged */ },
      open_tensions:     { /* unchanged */ },
      report:            { /* unchanged — kept as full prose fallback */ },
      question_landscape:{ /* unchanged */ },
      dead_end_summary:  { /* unchanged */ },

      // --- new ---
      sections: {
        type: 'array',
        description: 'Broad thematic areas, each with key findings. List broad areas first, then the most specific/surprising findings within each.',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['area_title', 'area_summary', 'key_findings'],
          additionalProperties: false,
          properties: {
            area_title:   { type: 'string' },
            area_summary: { type: 'string', description: '2–3 sentences framing the area.' },
            key_findings: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: {
                type: 'object',
                required: ['content', 'confidence'],
                additionalProperties: false,
                properties: {
                  content:    { type: 'string', description: 'One finding. Use inline markdown links [title](url) to cite sources from the provided reference list.' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
          },
        },
      },
      tension_points: {
        type: 'array',
        description: 'The sharpest disagreements between agents or working groups in this investigation.',
        maxItems: 4,
        items: {
          type: 'object',
          required: ['title', 'description', 'sides'],
          additionalProperties: false,
          properties: {
            title:       { type: 'string' },
            description: { type: 'string', description: 'What the crux of the disagreement is, in 1–3 sentences.' },
            sides: {
              type: 'array',
              minItems: 2,
              items: {
                type: 'object',
                required: ['label', 'position'],
                additionalProperties: false,
                properties: {
                  label:    { type: 'string', description: 'Persona name, working group id, or short descriptor.' },
                  position: { type: 'string', description: 'Their position in one sentence.' },
                },
              },
            },
            resolution: { type: ['string', 'null'], description: 'How the tension resolved, or null if genuinely unresolved.' },
          },
        },
      },
      key_references: {
        type: 'array',
        description: 'The most relevant sources cited in the investigation. Only include sources that materially shaped the findings.',
        maxItems: 8,
        items: {
          type: 'object',
          required: ['url', 'title', 'summary', 'key_observations'],
          additionalProperties: false,
          properties: {
            url:              { type: 'string' },
            title:            { type: 'string' },
            summary:          { type: 'string', description: '1–2 sentences on what this source says.' },
            key_observations: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string' },
            },
          },
        },
      },
      next_pass_proposals: {
        type: 'array',
        description: 'Specific topics worth investigating in a follow-up pass. Order by relevance, most promising first.',
        minItems: 3,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['topic', 'rationale'],
          additionalProperties: false,
          properties: {
            topic:          { type: 'string' },
            rationale:      { type: 'string', description: '1–2 sentences on why this is worth the next pass.' },
            territory_hint: { type: 'string', description: 'Which territory this relates to, if applicable.' },
          },
        },
      },
    },
  },
};
```

`sections` is added to `required`. `tension_points`, `key_references`, and `next_pass_proposals` are optional to keep the schema lenient toward models that may omit them on weaker inputs.

### 8.4 Updated `SYNTHESIZER` prompt

The prompt gains three instruction blocks appended to the existing rules:

```
7. Structure your output by topic. Group findings into 2–6 thematic `sections`. Each section has:
   - A short `area_title` (broad framing first, narrow specifics in later sections).
   - An `area_summary` (2–3 sentences) naming the main insight and its source.
   - `key_findings` (1–5 per section), ordered from highest-confidence to most-surprising. When a finding is supported by a source in the provided reference list, embed it as an inline markdown link: `[source title](url)`. Example: "Studies show X ([Author 2023](https://example.com)).".

8. Name the sharpest disagreements in `tension_points`. For each, identify:
   - The two or more parties in conflict (persona name, working group id, or short description).
   - The crux of the disagreement in 1–3 sentences.
   - How it resolved, or null if still open. Prefer naming a tension unresolved over papering over it.

9. Surface the most important sources in `key_references`. Select from the provided reference list those that materially shaped the findings. For each, write a 1–2 sentence summary and 1–3 key observations on why this source mattered.

10. Propose 3–6 specific next-pass topics in `next_pass_proposals`. These should be gaps the investigation found but could not fill, contradictions that need more evidence, or promising directions that were only touched on. Order by how much they would change the current synthesis if investigated.
```

### 8.5 Updated `runSynthesizer` call

```javascript
async function runSynthesizer({ client, idea, model, budget, forum, personas, pairDebates = [], bus }) {
  const forumDump = renderForum(forum);
  const personaDump = renderPersonas(personas);
  const questionLandscape = renderQuestionLandscape(pairDebates);
  const deadEnds = renderDeadEnds(forum);
  const findingRefs = renderFindings(pairDebates);          // new
  const findingsDump = renderFindingsText(findingRefs);     // new

  // ...

  const messages = [
    {
      role: 'user',
      content: [
        `Original topic:\n${idea.raw_capture}`,
        `\nPersona roster (for attribution):\n${personaDump}`,
        `\nForum (ranked nodes):\n${forumDump}`,
        `\nQuestion landscape:\n${questionLandscape}`,
        `\nDead-end questions:\n${deadEnds}`,
        `\nSource reference list (cite as inline markdown links in findings):\n${findingsDump}`,  // new
        `\nProduce the final report. Invoke emit_synthesis.`,
      ].join('\n'),
    },
  ];

  // ...

  return {
    produced_at: new Date().toISOString(),
    report: payload.report,
    headline_findings: payload.headline_findings,
    open_tensions: payload.open_tensions,
    question_landscape: payload.question_landscape || null,
    dead_end_summary: payload.dead_end_summary || null,
    // New fields
    sections: payload.sections || null,
    tension_points: payload.tension_points || null,
    key_references: payload.key_references || null,
    next_pass_proposals: payload.next_pass_proposals || null,
    usage,
  };
}
```

### 8.6 Inspect-app: synthesis leaf renderer

The `case 'synthesis'` block in `leafRenderers.tsx` is replaced with a structured renderer. The existing `report` + `headline_findings` + `question_landscape` + `dead_end_summary` rendering becomes the fallback when `sections` is absent.

Add `Anchor` to the existing `@mantine/core` import on line 2:

```typescript
import { Anchor, Badge, Group, Skeleton, Stack, Text } from '@mantine/core';
```

```tsx
case 'synthesis': {
  const s = view.synthesis;
  if (!s) return null;

  const hasStructured = !!(s.sections?.length);

  const body = hasStructured ? (
    <Stack gap="xl">
      {/* Broad areas → detailed findings */}
      {s.sections!.map((section, i) => (
        <Stack key={i} gap="xs">
          <Text fw={700} size="lg">{section.area_title}</Text>
          <Text c="dimmed" size="sm">{section.area_summary}</Text>
          <Stack gap={4}>
            {section.key_findings.map((f, j) => (
              <Group key={j} gap="xs" align="flex-start">
                <Badge
                  size="xs"
                  color={f.confidence === 'high' ? 'green' : f.confidence === 'medium' ? 'yellow' : 'gray'}
                  variant="light"
                >
                  {f.confidence}
                </Badge>
                <Text size="sm" style={{ flex: 1 }}>
                  <Markdown>{f.content}</Markdown>
                </Text>
              </Group>
            ))}
          </Stack>
        </Stack>
      ))}

      {/* Tension points */}
      {s.tension_points && s.tension_points.length > 0 && (
        <Stack gap="xs">
          <Text fw={700} size="md">Tension points</Text>
          {s.tension_points.map((tp, i) => (
            <Stack key={i} gap={4} p="sm" style={{ borderLeft: '3px solid var(--mantine-color-orange-5)' }}>
              <Text fw={600} size="sm">{tp.title}</Text>
              <Text size="sm">{tp.description}</Text>
              {tp.sides.map((side, j) => (
                <Text key={j} size="xs" c="dimmed">
                  <strong>{side.label}:</strong> {side.position}
                </Text>
              ))}
              {tp.resolution && (
                <Text size="xs" c="teal">Resolved: {tp.resolution}</Text>
              )}
            </Stack>
          ))}
        </Stack>
      )}

      {/* Most relevant references */}
      {s.key_references && s.key_references.length > 0 && (
        <Stack gap="xs">
          <Text fw={700} size="md">Most relevant references</Text>
          {s.key_references.map((ref, i) => (
            <Stack key={i} gap={2} p="sm" style={{ background: 'var(--mantine-color-dark-6)', borderRadius: 4 }}>
              <Anchor href={ref.url} target="_blank" rel="noopener noreferrer" size="sm" fw={600}>
                {i + 1}. {ref.title}
              </Anchor>
              <Text size="sm">{ref.summary}</Text>
              <Stack gap={2} mt={4}>
                {ref.key_observations.map((obs, j) => (
                  <Text key={j} size="xs" c="dimmed">· {obs}</Text>
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}

      {/* Next pass proposals */}
      {s.next_pass_proposals && s.next_pass_proposals.length > 0 && (
        <Stack gap="xs">
          <Text fw={700} size="md">Dig deeper — next pass proposals</Text>
          <Text size="xs" c="dimmed">Topics worth exploring in a follow-up investigation.</Text>
          <Stack gap={4}>
            {s.next_pass_proposals.map((p, i) => (
              <Stack key={i} gap={2}>
                <Text size="sm"><strong>{i + 1}. {p.topic}</strong></Text>
                <Text size="xs" c="dimmed">{p.rationale}</Text>
              </Stack>
            ))}
          </Stack>
        </Stack>
      )}

      {/* Dead ends and fallback fields */}
      {s.dead_end_summary && (
        <Stack gap={2}>
          <Text fw={600} size="sm">Dead ends</Text>
          <Text size="sm" c="dimmed">{s.dead_end_summary}</Text>
        </Stack>
      )}
    </Stack>
  ) : (
    // Legacy rendering — unchanged from current implementation
    <Stack gap="sm">
      <Markdown>{s.report}</Markdown>
      {s.headline_findings.length > 0 && (
        <Stack gap={2}>
          <Text fw={600}>Headline findings</Text>
          {s.headline_findings.map((f, i) => (
            <Text key={i}>· {f}</Text>
          ))}
        </Stack>
      )}
      {s.question_landscape && (
        <Stack gap={2}>
          <Text fw={600}>Question landscape</Text>
          {s.question_landscape.map((q, i) => (
            <Text key={i} size="sm">
              {q.territory_name}: {q.questions.length} questions
            </Text>
          ))}
        </Stack>
      )}
      {s.dead_end_summary && (
        <Stack gap={2}>
          <Text fw={600}>Dead-end summary</Text>
          <Text size="sm">{s.dead_end_summary}</Text>
        </Stack>
      )}
    </Stack>
  );

  return { title: 'Synthesis', body, raw: s.report };
}
```

The `Markdown` component already allows `http(s)` links via `rehype-sanitize`, so inline links in `finding.content` render correctly without any additional configuration.

### 8.7 `run.js` — persisting new fields to `inv.synthesis`

`run.js:495–502` constructs `inv.synthesis` from the `runSynthesizer` return value. It currently whitelists only the legacy fields. Update it to include the four new fields:

```javascript
inv.synthesis = {
  produced_at: synthesis.produced_at,
  report: synthesis.report,
  headline_findings: synthesis.headline_findings,
  open_tensions: synthesis.open_tensions,
  question_landscape: synthesis.question_landscape || null,
  dead_end_summary: synthesis.dead_end_summary || null,
  // New fields
  sections: synthesis.sections || null,
  tension_points: synthesis.tension_points || null,
  key_references: synthesis.key_references || null,
  next_pass_proposals: synthesis.next_pass_proposals || null,
};
```

Without this change, the new fields are returned by `runSynthesizer` and immediately discarded — they never reach storage or the inspect-app.

### 8.8 `build.js` — passing new fields through `buildSynthesis`

`src/inspect/view/build.js:buildSynthesis()` reads `inv.synthesis` from disk and constructs the `SynthesisView` for the SPA. It currently whitelists only legacy fields. Update it to pass the new fields through:

```javascript
function buildSynthesis(loaderInput) {
  const synth = loaderInput.index?.investigation?.synthesis;
  if (!synth) return null;
  return {
    report: synth.report ?? '',
    headline_findings: synth.headline_findings ?? [],
    open_tensions: synth.open_tensions ?? [],
    question_landscape: synth.question_landscape ?? undefined,
    dead_end_summary: synth.dead_end_summary ?? undefined,
    // New fields
    sections: synth.sections ?? undefined,
    tension_points: synth.tension_points ?? undefined,
    key_references: synth.key_references ?? undefined,
    next_pass_proposals: synth.next_pass_proposals ?? undefined,
  };
}
```

Without this change, `view.synthesis.sections` is always `undefined` in the SPA even when the data was successfully written to disk.

### 8.9 Data flow summary

```
pairDebates[].researcher_reports[].findings[]  ──renderFindings()──► findingsDump (title + url + content per source)
                                                                          │
                                                      ┌──────────────────┘
                                                      ▼
runSynthesizer receives: forum + personas + questionLandscape + deadEnds + findingsDump
                                                      │
                                              emit_synthesis tool
                                                      │
                         ┌────────────────────────────┼──────────────────────────────┐
                         ▼                            ▼                              ▼
                    sections[]               tension_points[]         key_references[]
                    (areas → findings        (persona/WG cruxes       (url + title +
                     with inline md links)    with sides + resolution) summary + observations)
                         │                                             next_pass_proposals[]
                         │
                         ▼
                  run.js: inv.synthesis ← all new fields persisted
                         │
                  build.js: buildSynthesis() ← passes new fields through
                         │
                         ▼
              leafRenderers.tsx → structured drawer UI
```

---

## 9. User Experience

The synthesis drawer opens from the pipeline graph's `SynthesisNode`. With this change:

1. **Immediate orientation** — the first thing visible is 2–6 named thematic areas with short summaries. The user knows what the investigation found without reading prose.

2. **Drill-down** — each area expands into specific findings with confidence badges. High-confidence findings are visually distinct from speculative ones.

3. **Links in context** — findings contain inline markdown links directly in the text. The user can click through to the original source without scrolling to a separate footnote section.

4. **Tension map** — the tension-points section reads like a structured debate: "Person A held X; Person B held Y; unresolved because neither provided evidence of Z." This replaces opaque `open_tensions` strings with named parties and crux statements.

5. **References panel** — a compact list of the top 8 sources with summaries. No more need to manually re-search to verify a claim.

6. **Next pass** — a numbered plain-text list of topics, clearly separated from findings. These are gaps and follow-up angles, not conclusions. The user reads this as "what should I ask msv next?" and copies a topic into a new `msv run`.

---

## 10. Testing Strategy

### Unit tests — `synthesizer.js`

**`renderFindings` deduplications and limits:**
```javascript
it('deduplicates source_url across findings', () => {
  // Purpose: same URL from two separate findings should appear once in the reference list
  const refs = renderFindings([{
    researcher_reports: [
      { findings: [{ finding_id: 'f1', source_url: 'https://x.com', content: 'A' }] },
      { findings: [{ finding_id: 'f2', source_url: 'https://x.com', content: 'B' }] },
    ]
  }]);
  expect(refs).toHaveLength(1);
  expect(refs[0].url).toBe('https://x.com');
});

it('caps at 30 refs, prioritising primary quality', () => {
  // Purpose: a run with 50 findings should not blow up the prompt
  // ...
});

it('skips findings with no source_url', () => {
  // Purpose: internal-only findings must not appear in the reference list
});
```

**`runSynthesizer` output shape:**
```javascript
it('returns sections, tension_points, key_references, next_pass_proposals when model emits them', async () => {
  // Purpose: the return statement maps all new tool fields through
  // Use a mock runStructuredCall that returns a fixture with all new fields
});

it('returns null for new fields when model omits them', async () => {
  // Purpose: optional fields should not throw when absent
});
```

### Integration test — synthesizer prompt injection

```javascript
it('injects source reference list into the synthesizer prompt', async () => {
  // Purpose: verify findingsDump reaches the messages array so the model can
  // cite it; catch any future regression where renderFindings is called but
  // its output is not threaded into the message content
  let capturedMessages;
  const mockRunStructuredCall = jest.fn().mockImplementation(({ messages }) => {
    capturedMessages = messages;
    return { response: {}, toolUse: { input: fixtureOutput }, usage: {} };
  });
  await runSynthesizer({ ..., pairDebates: [pairDebateWithFindings] });
  expect(capturedMessages[0].content.join('')).toContain('Source reference list');
});
```

### Inspect-app tests — `leafRenderers.tsx`

**Structured rendering path:**
```typescript
it('renders section titles and findings when synthesis.sections is present', () => {
  // Purpose: the new structured path executes; catch if sections are silently dropped
  const view = buildViewFixture({ synthesis: structuredSynthesisFixture });
  const result = renderLeaf({ kind: 'synthesis' }, view, null, null);
  render(result!.body as ReactElement);
  expect(screen.getByText(structuredSynthesisFixture.sections[0].area_title)).toBeInTheDocument();
});

it('renders clickable anchor for each key_reference URL', () => {
  // Purpose: references must be links, not plain text — regression guard for
  // the Anchor component being replaced by Text accidentally
});

it('renders tension_points with side labels', () => {
  // Purpose: tension-point sides must show persona/WG attribution
});

it('renders next_pass_proposals list', () => {
  // Purpose: proposals must all be visible, not just the first
});

it('falls back to legacy prose rendering when sections is absent', () => {
  // Purpose: v4 and pre-feature v5 investigations must not break
  const view = buildViewFixture({ synthesis: legacySynthesisFixture });
  const result = renderLeaf({ kind: 'synthesis' }, view, null, null);
  render(result!.body as ReactElement);
  expect(screen.getByText('Headline findings')).toBeInTheDocument();
});
```

**Existing `DetailDrawer` test update:**
The current test at `DetailDrawer.test.tsx:15` asserts `screen.getByText('Synthesis')`. That remains valid. Add a second assertion that verifies at least one section title renders when the fixture has the new fields.

---

## 11. Performance Considerations

**Prompt size increase.** Adding the findings dump to the synthesizer input grows the message. Mitigation:
- Cap at 30 findings.
- Truncate `content` per finding to 200 characters.
- Only include findings with a `source_url` (URL-less findings carry no linking value).
- In practice, a typical run produces 10–20 researcher reports with 2–5 findings each, yielding ≤100 candidate findings before deduplication and quality filtering. After the cap and URL filter, expected growth is ~1,500–3,000 tokens, which fits comfortably within the 5,000-token output budget.

**Output size increase.** The `emit_synthesis` response grows because `sections`, `tension_points`, `key_references`, and `next_pass_proposals` are new arrays. Expected additional output: ~600–1,200 tokens. The `maxTokens: 5000` cap may need to be raised to 6,500 to prevent truncation. The existing 180-second timeout remains adequate.

**Double-output cost.** Both `report` (800–1500 words prose) and `sections` are required in the tool schema. The model must produce both, roughly doubling structured output. This is a deliberate trade-off during the rollout period: `report` serves as the raw-view fallback and keeps legacy consumers working. Once `sections` is proven stable, `report` can be moved to optional (tracked in §15.2).

---

## 12. Security Considerations

**URL injection in references.** The `renderFindings` function feeds researcher-sourced URLs into the synthesizer prompt. A hostile source could embed prompt-injection text in a page title that gets included in `source_title`. Mitigations:
- Truncate `source_title` to 120 characters in `renderFindings`.
- Truncate `content` to 200 characters per finding.
- `Markdown.tsx` already sanitizes rendered output with `rehype-sanitize` to `http(s)` only; this prevents link-injection in rendered output.
- The synthesizer's `key_references[].url` field passes through from the LLM's output, not from the source directly. If the LLM halluminates a URL, it renders as a broken link — not a security issue.

**No new trust boundary.** The inspect-app already renders LLM-generated prose via `react-markdown`. The new sections and finding content go through the same `Markdown` component with the same sanitization policy. No new rendering paths are introduced.

---

## 13. Documentation

No user-facing docs exist for `msv` today. Internal notes:
- `prompts.js` SYNTHESIZER constant gains three new numbered rules; the comment block above it should note the v5 structured-report change.
- `types.d.ts` JSDoc on `SynthesisView` should note which fields were added and in which schema version.

---

## 14. Implementation Phases

### Phase 1 — Core structured output

1. Add `SynthesisSection`, `SynthesisTensionPoint`, `SynthesisReference`, `SynthesisNextPassProposal`, `SynthesisFinding` types to `types.d.ts`.
2. Update `SynthesisView` with new optional fields.
3. Implement `renderFindings` and `renderFindingsText` in `synthesizer.js`.
4. Update `EMIT_SYNTHESIS_TOOL` schema with `sections`, `tension_points`, `key_references`, `next_pass_proposals`.
5. Update `SYNTHESIZER` prompt with rules 7–10.
6. Update `runSynthesizer` to pass findings dump and map new return fields.
7. Update `run.js:495–502` to persist new fields to `inv.synthesis`.
8. Update `build.js:buildSynthesis()` to pass new fields through to the SPA.
9. Update `leafRenderers.tsx` with structured rendering path and legacy fallback (add `Anchor` to `@mantine/core` import).

### Phase 2 — Testing and validation

1. Unit tests for `renderFindings` (dedup, cap, URL filter).
2. Unit tests for `runSynthesizer` new-field pass-through.
3. Inspect-app tests for structured renderer, legacy fallback, link rendering, and tension-point attribution.
4. Run a real investigation and verify section structure is coherent and references resolve correctly.

---

## 15. Open Questions

1. **Cap and selection logic for `renderFindings`.** The spec proposes quality-ordering (primary > secondary > indirect), then URL presence. Should WG-territory alignment (i.e., prefer findings from working groups whose nodes have higher `aggregate_confidence`) be a factor? That would require joining findings back through `evidence_refs` to forum nodes — possible but more complex.

2. **`report` field deprecation path.** With `sections` now providing the structured narrative, `report` becomes a fallback for rendering and the raw-view. Should `report` still be required in the tool schema, or should we move it to optional once `sections` is stable? Keeping it required for one release cycle gives a safe fallback; deprecation can follow in a subsequent spec.

3. **Model suitability for structured output.** The current synthesizer uses a smaller/cheaper model because its input is already distilled. The new schema is more complex. If the model consistently fails to populate `sections` or produces malformed `tension_points`, upgrading the model for this stage may be necessary. This should be evaluated empirically on a sample of real runs.

4. **`next_pass_proposals` and investigation resumption integration.** This spec surfaces proposals as a plain numbered list. Wiring a selected proposal into `msv run` (pre-populating the topic, carrying forward investigation context) is deferred to a follow-up spec that coordinates with `feat-investigation-resumption.md` and `question-machine.md`. The output shape here — `topic` + `rationale` strings — is intentionally minimal so it can be consumed by whatever interaction model that spec defines.

5. **Token budget.** The `maxTokens: 5000` cap is in `runSynthesizer`. Raising it to 6,500 increases cost per synthesis call. The trade-off should be measured against a sample of investigations before hardcoding the new cap.

---

## 16. References

- [`src/agents/synthesizer.js`](../src/agents/synthesizer.js) — current synthesizer implementation.
- [`src/agents/prompts.js`](../src/agents/prompts.js) — `SYNTHESIZER` prompt constant.
- [`src/inspect/types.d.ts`](../src/inspect/types.d.ts) — `SynthesisView` and all pipeline types.
- [`src/inspect-app/inspector/leafRenderers.tsx`](../src/inspect-app/inspector/leafRenderers.tsx) — `case 'synthesis'` rendering block.
- [`src/inspect-app/components/Synthesis/Markdown.tsx`](../src/inspect-app/components/Synthesis/Markdown.tsx) — markdown renderer with `rehype-sanitize`.
- [`src/forum.js`](../src/forum.js) — forum aggregation; line 68 propagates `evidence_refs` to forum nodes.
- [`specs/architecture.md`](architecture.md) — full pipeline stage reference.
- [`specs/question-machine.md`](question-machine.md) — investigation resumption flow that receives next-pass proposals.
