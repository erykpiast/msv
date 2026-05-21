#!/usr/bin/env node
// tools/check-synthesis-grounding.js — verify that every URL cited in an
// investigation's synthesis is (a) part of the trusted research findings,
// (b) reachable, and (c) returns a page whose title and body roughly match
// the citation.
//
// Usage:
//   node tools/check-synthesis-grounding.js [<id>] [--no-http] [--live] [--json]
//
// Without args: validates the most recent investigation with a synthesis.
// With <id>:    validates that specific investigation.
// --no-http:    skip network/cache; only run the structural (URL ∈ findings) check.
// --live:       ignore the on-disk source cache and refetch every URL.
// --json:       machine-readable JSON instead of a table.
//
// By default, when the per-investigation source cache exists (written by the
// researcher's grounding pass — see src/agents/researcher.js → applyGroundingFilter),
// this script reads page bodies and titles from the cache. That makes the run
// offline-capable and reproducible. Pass --live to refetch.
//
// Exit code is non-zero if any citation fails the structural check OR (when
// HTTP/cache checks are enabled) if any URL is unreachable. Title / content
// mismatches are reported but do not fail the run — see the no-fail policy
// rationale in src/grounding.js.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  normaliseUrl,
  compareTitles,
  compareContent,
  quotePresent,
  fetchWithTimeout,
  loadSourceArtifact,
  saveSourceArtifact,
  truncate,
} = require('../src/grounding');

const ROOT_DIR = process.env.MSV_ROOT
  ? path.resolve(process.env.MSV_ROOT)
  : path.join(os.homedir(), '.msv');
const IDEAS_DIR = path.join(ROOT_DIR, 'ideas');

const FETCH_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Investigation loading
// ---------------------------------------------------------------------------

async function findInvestigation(idArg) {
  if (idArg) {
    const filePath = path.join(IDEAS_DIR, idArg, 'index.json');
    return { id: idArg, filePath };
  }
  let entries;
  try {
    entries = await fs.readdir(IDEAS_DIR, { withFileTypes: true });
  } catch {
    throw new Error(`Could not read ${IDEAS_DIR}.`);
  }
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const filePath = path.join(IDEAS_DIR, ent.name, 'index.json');
    try {
      const stat = await fs.stat(filePath);
      candidates.push({ id: ent.name, filePath, mtime: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const cand of candidates) {
    const text = await fs.readFile(cand.filePath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (parsed?.investigation?.synthesis) return cand;
  }
  throw new Error('No investigation with a synthesis was found.');
}

async function loadInvestigation(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(text);
  if (!data.investigation) throw new Error('Missing `investigation` block.');
  if (!data.investigation.synthesis) throw new Error('Investigation has no synthesis.');
  return data;
}

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /(?<!\]\()https?:\/\/[^\s)<>\]]+/g;

function extractMarkdownCitations(text, sourcePath, citations) {
  if (typeof text !== 'string') return;
  let m;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    citations.push({
      url: normaliseUrl(m[2]),
      raw_url: m[2],
      title: m[1].trim(),
      source: sourcePath,
      kind: 'markdown-link',
    });
  }
  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    if (before.endsWith('](')) continue;
    citations.push({
      url: normaliseUrl(m[0]),
      raw_url: m[0],
      title: null,
      source: sourcePath,
      kind: 'bare-url',
    });
  }
}

function walkSynthesisCitations(synthesis) {
  const citations = [];

  extractMarkdownCitations(synthesis.report, 'report', citations);
  extractMarkdownCitations(synthesis.dead_end_summary, 'dead_end_summary', citations);

  for (const [i, h] of (synthesis.headline_findings || []).entries()) {
    extractMarkdownCitations(h, `headline_findings[${i}]`, citations);
  }
  for (const [i, t] of (synthesis.open_tensions || []).entries()) {
    extractMarkdownCitations(t, `open_tensions[${i}]`, citations);
  }
  for (const [i, sec] of (synthesis.sections || []).entries()) {
    extractMarkdownCitations(sec.area_title, `sections[${i}].area_title`, citations);
    extractMarkdownCitations(sec.area_summary, `sections[${i}].area_summary`, citations);
    for (const [j, kf] of (sec.key_findings || []).entries()) {
      extractMarkdownCitations(kf.content, `sections[${i}].key_findings[${j}].content`, citations);
    }
  }
  for (const [i, tp] of (synthesis.tension_points || []).entries()) {
    extractMarkdownCitations(tp.description, `tension_points[${i}].description`, citations);
    extractMarkdownCitations(tp.resolution, `tension_points[${i}].resolution`, citations);
    for (const [j, side] of (tp.sides || []).entries()) {
      extractMarkdownCitations(side.position, `tension_points[${i}].sides[${j}].position`, citations);
    }
  }
  for (const [i, np] of (synthesis.next_pass_proposals || []).entries()) {
    extractMarkdownCitations(np.topic, `next_pass_proposals[${i}].topic`, citations);
    extractMarkdownCitations(np.rationale, `next_pass_proposals[${i}].rationale`, citations);
  }
  for (const [i, kr] of (synthesis.key_references || []).entries()) {
    if (kr.url) {
      citations.push({
        url: normaliseUrl(kr.url),
        raw_url: kr.url,
        title: (kr.title || '').trim() || null,
        source: `key_references[${i}].url`,
        kind: 'key_reference',
        summary: kr.summary || null,
        key_observations: kr.key_observations || null,
      });
    }
    extractMarkdownCitations(kr.summary, `key_references[${i}].summary`, citations);
    for (const [j, ko] of (kr.key_observations || []).entries()) {
      extractMarkdownCitations(ko, `key_references[${i}].key_observations[${j}]`, citations);
    }
  }
  return citations;
}

function buildTrustedSet(pairDebates) {
  const byUrl = new Map();
  for (const pd of (pairDebates || [])) {
    for (const rr of (pd.researcher_reports || [])) {
      for (const f of (rr.findings || [])) {
        if (!f.source_url) continue;
        const key = normaliseUrl(f.source_url);
        const entry = byUrl.get(key) || {
          url: key,
          raw_url: f.source_url,
          source_quotes: [],
          summaries: [],
          titles: [],
        };
        if (f.source_quote) entry.source_quotes.push(f.source_quote);
        if (f.summary) entry.summaries.push(f.summary);
        if (f.source_title) entry.titles.push(f.source_title);
        byUrl.set(key, entry);
      }
    }
  }
  return byUrl;
}

// ---------------------------------------------------------------------------
// HTTP / cache resolution
// ---------------------------------------------------------------------------

async function withConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return out;
}

async function resolveUrl(ideaId, url, { live }) {
  if (!live) {
    const cached = await loadSourceArtifact(ideaId, url);
    if (cached) {
      // Re-shape the cached meta into the fetched-result shape used downstream.
      return {
        ok: cached.ok,
        status: cached.status,
        final_url: cached.final_url,
        content_type: cached.content_type,
        page_title: cached.page_title,
        body_text: cached.body_text,
        from_cache: true,
      };
    }
  }
  const fetched = await fetchWithTimeout(url);
  // Cache for future runs even when called from the validator — it's the
  // same artifact shape the researcher writes.
  if (fetched.byte_len > 0) {
    try { await saveSourceArtifact(ideaId, url, fetched); } catch {}
  }
  return {
    ok: fetched.ok,
    status: fetched.status,
    error: fetched.error,
    final_url: fetched.final_url,
    content_type: fetched.content_type,
    page_title: fetched.page_title,
    body_text: fetched.body_text,
    from_cache: false,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { id: null, http: true, live: false, json: false };
  for (const a of argv) {
    if (a === '--no-http') args.http = false;
    else if (a === '--live') args.live = true;
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (!a.startsWith('-')) args.id = a;
  }
  return args;
}

function fmtTable(rows, header) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))
  );
  const line = (cells) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  const out = [line(header), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function summarise(results, opts) {
  let total = results.length;
  let ungrounded = 0;
  let unreachable = 0;
  let titleMismatch = 0;
  let contentMismatch = 0;
  let quoteAbsent = 0;
  for (const r of results) {
    if (!r.in_trusted_set) ungrounded++;
    if (opts.http && r.http && !r.http.ok) unreachable++;
    if (opts.http && r.title_check && r.title_check.verdict === 'mismatch') titleMismatch++;
    if (opts.http && r.content_check && r.content_check.verdict === 'mismatch') contentMismatch++;
    if (opts.http && r.quote_check && r.quote_check.verdict === 'absent') quoteAbsent++;
  }
  return { total, ungrounded, unreachable, titleMismatch, contentMismatch, quoteAbsent };
}

function renderHuman(invId, results, summary, opts) {
  const lines = [];
  lines.push(`investigation: ${invId}`);
  lines.push(
    `citations: ${summary.total}  ungrounded: ${summary.ungrounded}` +
      (opts.http
        ? `  unreachable: ${summary.unreachable}  title-mismatch: ${summary.titleMismatch}  content-mismatch: ${summary.contentMismatch}  quote-absent: ${summary.quoteAbsent}`
        : '  (HTTP checks skipped)')
  );
  lines.push('');
  const header = opts.http
    ? ['url', 'trusted', 'status', 'title', 'content', 'quote', 'src']
    : ['url', 'trusted', 'sources'];
  const rows = results.map((r) => {
    const url = truncate(r.url, 70);
    const trusted = r.in_trusted_set ? 'yes' : 'NO';
    const sourcesField = truncate(r.cited_at.join(', '), 50);
    if (!opts.http) return [url, trusted, sourcesField];
    const cacheTag = r.http?.from_cache ? ' [cache]' : '';
    const status = r.http
      ? r.http.error
        ? r.http.error
        : `${r.http.status}${r.http.final_url && normaliseUrl(r.http.final_url) !== r.url ? ' (redir)' : ''}${cacheTag}`
      : '-';
    const title = r.title_check
      ? `${r.title_check.verdict}${r.title_check.score != null ? `(${r.title_check.score})` : ''}`
      : '-';
    const content = r.content_check
      ? `${r.content_check.verdict}${r.content_check.score != null ? `(${r.content_check.score})` : ''}`
      : '-';
    const quote = r.quote_check
      ? `${r.quote_check.verdict}${r.quote_check.score != null ? `(${r.quote_check.score})` : ''}`
      : '-';
    return [url, trusted, status, title, content, quote, sourcesField];
  });
  lines.push(fmtTable(rows, header));

  const failures = results.filter(
    (r) =>
      !r.in_trusted_set ||
      (opts.http && r.http && !r.http.ok) ||
      (opts.http && r.title_check && r.title_check.verdict === 'mismatch') ||
      (opts.http && r.content_check && r.content_check.verdict === 'mismatch') ||
      (opts.http && r.quote_check && r.quote_check.verdict === 'absent')
  );
  if (failures.length > 0) {
    lines.push('');
    lines.push('details:');
    for (const r of failures) {
      lines.push(`- ${r.url}`);
      lines.push(`    cited at: ${r.cited_at.join(', ')}`);
      if (!r.in_trusted_set) {
        lines.push('    ungrounded: not in researcher findings — possibly fabricated');
      }
      if (opts.http && r.http && !r.http.ok) {
        lines.push(`    unreachable: ${r.http.error || `HTTP ${r.http.status}`}`);
      }
      if (opts.http && r.http && r.http.final_url && normaliseUrl(r.http.final_url) !== r.url) {
        lines.push(`    redirected to: ${r.http.final_url}`);
      }
      if (opts.http && r.title_check && (r.title_check.verdict === 'mismatch' || r.title_check.verdict === 'weak')) {
        lines.push(`    cited title : ${truncate(r.cited_titles[0] || '(none)', 120)}`);
        lines.push(`    page title  : ${truncate(r.http?.page_title || '(none)', 120)}`);
      }
      if (opts.http && r.content_check && r.content_check.verdict === 'mismatch') {
        lines.push(`    content overlap: ${r.content_check.present}/${r.content_check.cited_token_count} cited tokens present`);
      }
      if (opts.http && r.quote_check && r.quote_check.verdict === 'absent') {
        lines.push('    stored quote absent from page (may be JS-rendered or behind a paywall)');
        if (r.stored_quote) lines.push(`    quote        : "${truncate(r.stored_quote, 140)}"`);
      }
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node tools/check-synthesis-grounding.js [<id>] [--no-http] [--live] [--json]'
    );
    return;
  }
  const { id, filePath } = await findInvestigation(args.id);
  const data = await loadInvestigation(filePath);
  const synthesis = data.investigation.synthesis;
  const trusted = buildTrustedSet(data.investigation.pair_debates);
  const allCitations = walkSynthesisCitations(synthesis);

  const byUrl = new Map();
  for (const c of allCitations) {
    if (!c.url) continue;
    const entry = byUrl.get(c.url) || {
      url: c.url,
      raw_urls: new Set(),
      cited_titles: [],
      cited_text_chunks: [],
      cited_at: [],
    };
    entry.raw_urls.add(c.raw_url);
    if (c.title) entry.cited_titles.push(c.title);
    if (c.summary) entry.cited_text_chunks.push(c.summary);
    if (c.key_observations) entry.cited_text_chunks.push(...c.key_observations);
    entry.cited_at.push(c.source);
    byUrl.set(c.url, entry);
  }

  const urls = Array.from(byUrl.values());
  const httpResults = args.http
    ? await withConcurrency(urls, FETCH_CONCURRENCY, async (entry) => {
        return resolveUrl(id, entry.url, { live: args.live });
      })
    : urls.map(() => null);

  const results = urls.map((entry, i) => {
    const trustedEntry = trusted.get(entry.url) || null;
    const http = httpResults[i];

    const citedTitle = entry.cited_titles[0] || null;
    const titleCheck =
      args.http && http?.ok ? compareTitles(citedTitle, http.page_title) : null;

    const citedTextBlob = [
      ...entry.cited_titles,
      ...entry.cited_text_chunks,
    ].join(' ');
    const contentCheck =
      args.http && http?.ok && http.body_text
        ? compareContent(citedTextBlob, http.body_text)
        : null;

    const storedQuote = trustedEntry?.source_quotes?.[0] || null;
    const quoteCheck =
      args.http && http?.ok && http.body_text && storedQuote
        ? quotePresent(storedQuote, http.body_text)
        : null;

    return {
      url: entry.url,
      raw_urls: Array.from(entry.raw_urls),
      cited_at: entry.cited_at,
      cited_titles: entry.cited_titles,
      in_trusted_set: !!trustedEntry,
      stored_quote: storedQuote,
      http,
      title_check: titleCheck,
      content_check: contentCheck,
      quote_check: quoteCheck,
    };
  });

  const summary = summarise(results, { http: args.http });

  if (args.json) {
    console.log(JSON.stringify({ investigation_id: id, summary, results }, null, 2));
  } else {
    console.log(renderHuman(id, results, summary, { http: args.http }));
  }

  const hardFail =
    summary.ungrounded > 0 || (args.http && summary.unreachable > 0);
  process.exitCode = hardFail ? 1 : 0;
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 2;
});
