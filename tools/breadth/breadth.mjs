#!/usr/bin/env node
// THROWAWAY prototype — wayfinder ticket #26.
// Measures "perspective diversity / breadth coverage" of an msv run from its
// persisted outputs under ~/.msv/ideas/<id>/. Reads-only. No deps.
//
// Breadth = how DIFFERENT the produced CONTENT is from itself (topical spread),
// measured at three levels and averaged:
//   - section_spread   — across synthesis section (title + summary)
//   - finding_spread   — across every key finding + headline finding
//   - question_spread  — across every research question in the question landscape
// "Spread" = mean pairwise lexical distance (1 - word-overlap). It's an AVERAGE,
// so producing more findings/questions doesn't inflate it — only producing
// genuinely-different ones does. That's what makes it robust to knobs that add
// volume without adding coverage (e.g. bumping territory count 5 -> 15).
//
// NOT in the score, reported alongside as context:
//   - source independence — distinct domains / evenness / #kinds-of-site. Measures
//     "how many independent places did it go", NOT topical breadth (40 near-identical
//     articles from 40 sites is not broad). A trust signal, not a breadth signal.
//   - inputs (knobs) — territory count T, candidate personas P, personas selected,
//     mean pair distinctness. These are what you TURN; breadth is what you read off.
//
// Usage:
//   node breadth.mjs                 # score every completed v5 run, table
//   node breadth.mjs <id> [<id>...]  # score specific ids, verbose JSON
//   node breadth.mjs --topic "foo"   # score + compare all runs whose topic starts with "foo"

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IDEAS = join(homedir(), ".msv", "ideas");

// ---------- text helpers ----------
const STOP = new Set(("the a an and or of to in on for is are be as by with that this " +
  "it its from at into over under about across whether what how does do we you they " +
  "not no yes but if then than more most less least can could will would may might").split(" "));
const words = (s) => (s || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
const contentSet = (s) => new Set(words(s).filter((w) => !STOP.has(w)));
const jaccard = (a, b) => {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};
// mean pairwise lexical distance (1 - jaccard) over a list of strings
const lexicalSpread = (texts) => {
  const sets = texts.map(contentSet).filter((s) => s.size);
  if (sets.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) { sum += 1 - jaccard(sets[i], sets[j]); n++; }
  return n ? sum / n : 0;
};
// greedy clustering of strings by lexical overlap -> distinct-cluster count
const clusterCount = (texts, thresh = 0.25) => {
  const sets = texts.map(contentSet).filter((s) => s.size);
  const reps = [];
  for (const s of sets) {
    if (!reps.some((r) => jaccard(r, s) >= thresh)) reps.push(s);
  }
  return reps.length;
};
const shannon = (counts) => {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0;
  for (const c of counts) { if (!c) continue; const p = c / total; h -= p * Math.log2(p); }
  return h; // bits
};

// crude domain -> category heuristic
const categorise = (domain) => {
  if (/(^|\.)arxiv\.org$|(^|\.)springer|(^|\.)nature|(^|\.)acm\.org|(^|\.)ieee|openreview|semanticscholar|(^|\.)ssrn/.test(domain)) return "academic";
  if (/\.gov$|\.gov\.|europa\.eu$|\.int$/.test(domain)) return "gov";
  if (/(^|\.)nvidia|(^|\.)google|deepmind|(^|\.)openai|(^|\.)microsoft|(^|\.)meta|huggingface|(^|\.)ibm|(^|\.)aws/.test(domain)) return "vendor";
  if (/substack|medium\.com|blog\.|\.blog|wordpress|ghost\.io/.test(domain)) return "blog";
  if (/reuters|bloomberg|techcrunch|theverge|wired|nytimes|guardian|forbes|venturebeat|axios/.test(domain)) return "news";
  if (/wikipedia|wiktionary/.test(domain)) return "reference";
  return "other";
};
const domainOf = (url) => {
  const m = /^https?:\/\/([^/]+)/i.exec(url || "");
  return m ? m[1].replace(/^www\./, "").toLowerCase() : null;
};

// ---------- per-run extraction ----------
function loadRun(id) {
  const f = join(IDEAS, id, "index.json");
  if (!existsSync(f)) return null;
  const inv = JSON.parse(readFileSync(f, "utf8")).investigation || {};
  if (inv.schema_version !== "v5") return null;

  const territories = inv.coordinator_decisions?.initial?.territories || [];
  const cands = inv.perspective_discovery?.candidate_personas || [];
  const syn = inv.synthesis || {};
  const sections = syn.sections || [];

  // --- content levels for breadth ---
  const sectionTexts = sections.map((s) => `${s.area_title} ${s.area_summary}`);
  const findingTexts = [
    ...sections.flatMap((s) => (s.key_findings || []).map((k) => k.content || "")),
    ...(syn.headline_findings || []),
  ].filter(Boolean);
  const questionTexts = (syn.question_landscape || [])
    .flatMap((q) => (q.questions || []).map((x) => x.question || ""))
    .filter(Boolean);

  // sources: distinct domains + categories + entropy over fetched (ok) pages
  const srcDir = join(IDEAS, id, "sources");
  const domainCounts = {};
  if (existsSync(srcDir)) {
    for (const fn of readdirSync(srcDir)) {
      if (!fn.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(srcDir, fn), "utf8"));
        if (meta.ok === false) continue;
        const d = domainOf(meta.final_url || meta.url);
        if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
      } catch { /* skip */ }
    }
  }
  const domains = Object.keys(domainCounts);
  const cats = new Set(domains.map(categorise));

  // breadth = mean of the content-spread levels that have >=2 items
  const section_spread = lexicalSpread(sectionTexts);
  const finding_spread = lexicalSpread(findingTexts);
  const question_spread = lexicalSpread(questionTexts);
  const levels = [
    { k: "section", v: section_spread, n: sectionTexts.length },
    { k: "finding", v: finding_spread, n: findingTexts.length },
    { k: "question", v: question_spread, n: questionTexts.length },
  ].filter((l) => l.n >= 2);
  const breadth = levels.length ? levels.reduce((a, l) => a + l.v, 0) / levels.length : 0;

  return {
    id,
    topic: (JSON.parse(readFileSync(f, "utf8")).raw_capture || "").replace(/\s+/g, " ").slice(0, 60),
    complete: !!inv.synthesis,
    breadth,                       // the headline: content topical spread, 0..1
    content: {
      section_spread, section_n: sectionTexts.length,
      finding_spread, finding_n: findingTexts.length,
      question_spread, question_n: questionTexts.length,
    },
    source_independence: {         // reported, NOT in breadth
      distinct_domains: domains.length,
      domain_categories: cats.size,
      domain_entropy: shannon(Object.values(domainCounts)),
    },
    inputs: {                      // the knobs you turn
      T: territories.length,
      P: cands.length,
      selected: (inv.perspective_discovery?.selected_persona_ids || []).length,
      mean_pair_distinctness: territories.length
        ? territories.reduce((a, t) => a + (t.pair_distinctness_score || 0), 0) / territories.length : 0,
    },
    _texts: { sections: sectionTexts, findings: findingTexts, questions: questionTexts },
  };
}

// ---------- model-as-judge: count distinct areas the findings cover ----------
// Swaps blunt word-overlap for semantic grouping. Breadth = number of distinct
// areas the model clusters the findings into, plus how evenly sized those areas
// are (8 balanced areas is broader than 8 where one swallows everything).
// Returns the labeled groups too, so the count is auditable, not a black box.
const JUDGE_SYSTEM =
  "You measure the topical BREADTH of one research investigation. You are given a " +
  "numbered list of its findings. Cluster them into distinct AREAS OF INQUIRY: two " +
  "findings share an area if they'd sit under the same heading in a survey of the " +
  "topic. Judge by subject matter, not by wording. Every finding lands in exactly one " +
  "area. Prefer the coarsest grouping that still keeps genuinely different subjects " +
  "apart — do not split hairs, do not lump unrelated subjects. Return via the tool.";
const JUDGE_TOOL = {
  name: "report_areas",
  description: "Report the distinct areas of inquiry found in the findings.",
  input_schema: {
    type: "object",
    properties: {
      areas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "short name for the area" },
            finding_indices: { type: "array", items: { type: "integer" } },
          },
          required: ["label", "finding_indices"],
        },
      },
    },
    required: ["areas"],
  },
};

async function judgeRun(id, { model, samples = 2 } = {}) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const run = loadRun(id);
  const findings = run?._texts.findings || [];
  if (findings.length < 2) return { id, topic: run?.topic, findings: findings.length, runs: [] };
  const numbered = findings.map((t, i) => `[${i}] ${t}`).join("\n\n");

  // ride out 429/529/overloaded with exponential backoff (throwaway version of apiQueue)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (params) => {
    for (let attempt = 0; ; attempt++) {
      try { return await client.messages.create(params); }
      catch (e) {
        const s = e?.status;
        const retryable = s === 429 || s === 529 || (s >= 500 && s < 600) || e?.error?.error?.type === "overloaded_error";
        if (!retryable || attempt >= 6) throw e;
        const wait = Math.min(2000 * 2 ** attempt, 30000) * (0.75 + Math.random() * 0.5);
        console.error(`  (retry ${attempt + 1}/6 after ${s || e?.name}, waiting ${Math.round(wait)}ms)`);
        await sleep(wait);
      }
    }
  };

  const trials = [];
  for (let s = 0; s < samples; s++) {
    const resp = await call({
      model,
      max_tokens: 4000,
      system: JUDGE_SYSTEM,
      tools: [JUDGE_TOOL],
      tool_choice: { type: "tool", name: "report_areas" },
      messages: [{ role: "user", content: `Findings:\n\n${numbered}` }],
    });
    const block = resp.content.find((b) => b.type === "tool_use" && b.name === "report_areas");
    let input = block?.input;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* leave */ } }
    let areas = input?.areas;
    // model sometimes double-encodes: input.areas arrives as a JSON string
    // holding either [ ... ] or { "areas": [ ... ] }
    if (typeof areas === "string") {
      try { const p = JSON.parse(areas); areas = Array.isArray(p) ? p : p?.areas; } catch { /* leave */ }
    }
    if (!Array.isArray(areas)) {
      console.error(`  [debug] unexpected tool input shape (stop_reason=${resp.stop_reason}):`);
      console.error("  " + JSON.stringify(input)?.slice(0, 500));
      areas = Array.isArray(input) ? input : [];
    }
    const sizes = areas.map((a) => (a.finding_indices || []).length).filter((n) => n > 0);
    const evenness = sizes.length > 1 ? shannon(sizes) / Math.log2(sizes.length) : 0; // 0..1
    trials.push({ n_areas: areas.length, evenness: +evenness.toFixed(2), labels: areas.map((a) => a.label) });
  }
  const counts = trials.map((t) => t.n_areas);
  return {
    id, topic: run.topic, findings: findings.length,
    n_areas_mean: +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1),
    n_areas_range: [Math.min(...counts), Math.max(...counts)],
    evenness_mean: +(trials.reduce((a, t) => a + t.evenness, 0) / trials.length).toFixed(2),
    trials,
  };
}

// ---------- CLI ----------
const MODEL = "claude-sonnet-5"; // mirrors src/models.js
const args = process.argv.slice(2);

// --judge <id...>: model-as-judge distinct-area count (semantic, replaces lexical)
if (args[0] === "--judge") {
  const jids = args.slice(1);
  if (!jids.length) { console.error("usage: --judge <id> [<id>...]"); process.exit(1); }
  for (const id of jids) {
    const r = await judgeRun(id, { model: MODEL, samples: 2 });
    console.log(JSON.stringify(r, null, 2));
  }
  process.exit(0);
}

let ids, topicFilter = null;
const ti = args.indexOf("--topic");
if (ti >= 0) { topicFilter = (args[ti + 1] || "").toLowerCase(); ids = null; }
else if (args.length) ids = args;

let runs;
if (ids) runs = ids.map(loadRun).filter(Boolean);
else {
  runs = readdirSync(IDEAS).map(loadRun).filter(Boolean).filter((r) => r.complete);
  if (topicFilter) runs = runs.filter((r) => r.topic.toLowerCase().startsWith(topicFilter));
}

if (ids && ids.length) {
  for (const r of runs) console.log(JSON.stringify(r, null, 2));
} else {
  const rows = runs.sort((a, b) => b.breadth - a.breadth);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("id", 10) + pad("BREADTH", 9) +
    pad("sec", 7) + pad("find", 7) + pad("ques", 7) +
    pad("| src.doms", 11) + pad("srcEntr", 9) + "topic");
  for (const r of rows) {
    const c = r.content, s = r.source_independence;
    console.log(pad(r.id.slice(0, 8), 10) + pad(r.breadth.toFixed(3), 9) +
      pad(c.section_spread.toFixed(2), 7) + pad(c.finding_spread.toFixed(2), 7) +
      pad(c.question_spread.toFixed(2), 7) +
      pad("| " + s.distinct_domains, 11) + pad(s.domain_entropy.toFixed(2), 9) + r.topic);
  }
}
