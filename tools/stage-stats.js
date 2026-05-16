#!/usr/bin/env node
// tools/stage-stats.js — per-stage timing and token stats from historical runs.
// Usage: node tools/stage-stats.js [<id>] [--all] [--json]
//
// Without args: shows stats for the most recent run in ~/.msv/ideas/.
// With <id>:   shows stats for that specific run.
// With --all:  aggregates stats across all runs with events.jsonl files.
// With --json: outputs machine-readable JSON instead of a table.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const ROOT_DIR = process.env.MSV_ROOT
  ? path.resolve(process.env.MSV_ROOT)
  : path.join(os.homedir(), '.msv');

const STAGE_ORDER = [
  'discovery',
  'diversity',
  'coordinator',
  'working_groups',
  'cross_pollination',
  'forum',
  'synthesis',
];

async function readEventsJsonl(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const events = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

function computeStats(events) {
  const stages = {};
  let currentStage = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let pipelineStart = null;
  let pipelineEnd = null;
  let ideaId = null;
  let topic = null;

  for (const e of events) {
    switch (e.name) {
      case 'pipeline.start':
        pipelineStart = e.ts;
        ideaId = e.idea_id;
        topic = e.raw_capture;
        break;

      case 'pipeline.stage.start':
        currentStage = e.stage;
        stages[e.stage] = stages[e.stage] || {
          name: e.stage,
          startedAt: null,
          endedAt: null,
          durationMs: null,
          inputTokens: 0,
          outputTokens: 0,
          apiCalls: 0,
          retryCalls: 0,
        };
        stages[e.stage].startedAt = e.ts;
        break;

      case 'pipeline.stage.end':
        if (stages[e.stage]) {
          stages[e.stage].endedAt = e.ts;
          if (stages[e.stage].startedAt) {
            stages[e.stage].durationMs = e.ts - stages[e.stage].startedAt;
          }
        }
        currentStage = null;
        break;

      case 'pipeline.complete':
      case 'pipeline.failed':
        pipelineEnd = e.ts;
        break;

      case 'api.call.start':
        if (currentStage && stages[currentStage]) {
          stages[currentStage].apiCalls++;
        }
        break;

      case 'api.call.retry':
        if (currentStage && stages[currentStage]) {
          stages[currentStage].retryCalls++;
        }
        break;

      case 'api.call.end':
        if (e.outcome === 'ok') {
          const inp = e.input_tokens || 0;
          const out = e.output_tokens || 0;
          totalInputTokens += inp;
          totalOutputTokens += out;
          if (currentStage && stages[currentStage]) {
            stages[currentStage].inputTokens += inp;
            stages[currentStage].outputTokens += out;
          }
        }
        break;
    }
  }

  return {
    ideaId,
    topic,
    pipelineStart,
    pipelineEnd,
    totalDurationMs: pipelineStart && pipelineEnd ? pipelineEnd - pipelineStart : null,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    stages,
  };
}

function fmtMs(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtK(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function printTable(stats) {
  const pad = (s, n) => String(s).padStart(n);
  const padL = (s, n) => String(s).padEnd(n);

  console.log(`\nRun: ${stats.ideaId || '?'}`);
  if (stats.topic) console.log(`Topic: ${stats.topic}`);
  console.log(`Total duration: ${fmtMs(stats.totalDurationMs)}`);
  console.log(`Total tokens: ${fmtK(stats.totalTokens)} (${fmtK(stats.totalInputTokens)} in / ${fmtK(stats.totalOutputTokens)} out)`);
  console.log('');

  const header = `${'Stage'.padEnd(20)} ${'Duration'.padStart(10)} ${'API calls'.padStart(10)} ${'Retries'.padStart(8)} ${'Input tok'.padStart(12)} ${'Output tok'.padStart(12)} ${'Total tok'.padStart(12)}`;
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const name of STAGE_ORDER) {
    const s = stats.stages[name];
    if (!s) {
      console.log(`${name.padEnd(20)} ${'—'.padStart(10)}`);
      continue;
    }
    console.log(
      `${padL(name, 20)} ${pad(fmtMs(s.durationMs), 10)} ${pad(s.apiCalls, 10)} ${pad(s.retryCalls, 8)} ${pad(fmtK(s.inputTokens), 12)} ${pad(fmtK(s.outputTokens), 12)} ${pad(fmtK(s.inputTokens + s.outputTokens), 12)}`
    );
  }
  console.log('');
}

async function findAllIdeas() {
  const ideasDir = path.join(ROOT_DIR, 'ideas');
  let entries;
  try {
    entries = await fs.readdir(ideasDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(ideasDir, e.name, 'events.jsonl'));
}

async function findLatestIdea() {
  const ideasDir = path.join(ROOT_DIR, 'ideas');
  let entries;
  try {
    entries = await fs.readdir(ideasDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const withMtime = await Promise.all(
    entries.filter((e) => e.isDirectory()).map(async (e) => {
      const filePath = path.join(ideasDir, e.name, 'events.jsonl');
      try {
        const stat = await fs.stat(filePath);
        return { filePath, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  const valid = withMtime.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  return valid[0]?.filePath || null;
}

async function main() {
  const args = process.argv.slice(2);
  const flagJson = args.includes('--json');
  const flagAll = args.includes('--all');
  const id = args.find((a) => !a.startsWith('--'));

  let filePaths = [];

  if (flagAll) {
    filePaths = await findAllIdeas();
    if (filePaths.length === 0) {
      console.error('No ideas with events.jsonl found.');
      process.exit(1);
    }
  } else if (id) {
    filePaths = [
      path.join(ROOT_DIR, 'ideas', id, 'events.jsonl'),
      path.join(ROOT_DIR, 'archive', id, 'events.jsonl'),
    ];
  } else {
    const latest = await findLatestIdea();
    if (!latest) {
      console.error('No runs found. Run `msv run` first, or specify an idea id.');
      process.exit(1);
    }
    filePaths = [latest];
  }

  const allStats = [];
  for (const filePath of filePaths) {
    const events = await readEventsJsonl(filePath);
    if (!events || events.length === 0) continue;
    allStats.push(computeStats(events));
  }

  if (allStats.length === 0) {
    console.error('No events.jsonl data found.');
    process.exit(1);
  }

  if (flagJson) {
    console.log(JSON.stringify(allStats, null, 2));
    return;
  }

  if (flagAll && allStats.length > 1) {
    // Print summary table across runs
    console.log(`\n=== Stage stats across ${allStats.length} runs ===\n`);

    // Aggregate per stage
    const agg = {};
    for (const stats of allStats) {
      for (const [name, s] of Object.entries(stats.stages)) {
        agg[name] = agg[name] || { count: 0, totalMs: 0, totalTokens: 0, totalCalls: 0 };
        agg[name].count++;
        if (s.durationMs) agg[name].totalMs += s.durationMs;
        agg[name].totalTokens += s.inputTokens + s.outputTokens;
        agg[name].totalCalls += s.apiCalls;
      }
    }

    const pad = (s, n) => String(s).padStart(n);
    const padL = (s, n) => String(s).padEnd(n);
    const header = `${'Stage'.padEnd(20)} ${'Avg duration'.padStart(14)} ${'Avg tokens'.padStart(12)} ${'Avg calls'.padStart(10)} ${'Runs'.padStart(6)}`;
    console.log(header);
    console.log('─'.repeat(header.length));
    for (const name of STAGE_ORDER) {
      const a = agg[name];
      if (!a) continue;
      const avgMs = a.count > 0 ? a.totalMs / a.count : null;
      const avgTok = a.count > 0 ? Math.round(a.totalTokens / a.count) : 0;
      const avgCalls = a.count > 0 ? Math.round(a.totalCalls / a.count) : 0;
      console.log(`${padL(name, 20)} ${pad(fmtMs(avgMs), 14)} ${pad(fmtK(avgTok), 12)} ${pad(avgCalls, 10)} ${pad(a.count, 6)}`);
    }
    console.log('');

    // Also print individual run summaries
    for (const stats of allStats) printTable(stats);
  } else {
    for (const stats of allStats) printTable(stats);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
