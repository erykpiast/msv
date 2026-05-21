'use strict';

/**
 * Grounding utilities — URL fetch, title/quote/content comparison, and the
 * on-disk source-artifact cache used to make finding citations auditable.
 *
 * Used by:
 *   - src/agents/researcher.js: validates each finding's URL out-of-band before
 *     the report is persisted; failed findings are dropped.
 *   - tools/check-synthesis-grounding.js: validates the synthesis's citations
 *     against the per-investigation source cache (or live network, on demand).
 *
 * Cache layout, per investigation:
 *   ~/.msv/ideas/<id>/sources/
 *     <sha1-of-normalised-url>.bin       raw body, capped at SOURCE_BODY_CAP bytes
 *     <sha1-of-normalised-url>.meta.json metadata + decoded body_text (text/* only)
 *     index.json                          { [normalised_url]: sha1, ... }
 *
 * Cache discipline: writes are atomic-ish (tmp + rename for the body, append-then-
 * rename for the index). Concurrent writers to the same investigation rely on the
 * researcher running per-aligned-question; if two callers write the same URL,
 * last-write-wins, which is safe since the body for a given URL is overwritten
 * with the same content.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ideaDir } = require('./storage');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 msv-grounding-check';
const FETCH_TIMEOUT_MS = 15_000;
// Cap body bytes at 1 MB. The grounding check only needs shingles and titles;
// extremely large pages (e.g. JS-heavy SPAs with inline data URLs) would
// otherwise bloat the cache without improving the check.
const SOURCE_BODY_CAP = 1_000_000;
// Cap decoded body_text we keep in metadata.json after HTML stripping.
const SOURCE_BODY_TEXT_CAP = 200_000;
const TITLE_MATCH_THRESHOLD = 0.4;
const CONTENT_OVERLAP_THRESHOLD = 0.4;
const QUOTE_PRESENT_THRESHOLD = 0.5;
const QUOTE_PARTIAL_THRESHOLD = 0.2;
const QUOTE_SHINGLE_LEN = 6;

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have','how','in',
  'is','it','its','of','on','or','that','the','this','to','was','were','what',
  'when','where','which','who','whose','why','will','with','you','your','our',
  'their','they','them','these','those','than','then','if','but','not','can',
  'could','should','would','may','might','also','one','two','about','into',
  'over','under','between','within','without','during','any','all','some','no',
  'new','study','studies','research','paper','article','report','source','site',
  'pdf','en','de','fr','es','it','pt','ja','zh','www','com','org','net','io','co',
]);

// ---------------------------------------------------------------------------
// URL / text normalisation
// ---------------------------------------------------------------------------

function normaliseUrl(u) {
  if (!u) return '';
  let s = String(u).trim();
  s = s.replace(/[.,;:!?)\]}'"`]+$/, '');
  s = s.replace(/#.*$/, '');
  try {
    const url = new URL(s);
    url.hash = '';
    url.username = '';
    url.password = '';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return s;
  }
}

function normaliseText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s, { keepStopwords = false } = {}) {
  const tokens = normaliseText(s).split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (!keepStopwords && STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function stripPublisherSuffix(title) {
  return String(title || '').replace(/\s+[|—–-]\s+[^|—–-]+$/u, '').trim();
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

function compareTitles(citedTitle, fetchedTitle) {
  if (!citedTitle || !fetchedTitle) return { score: null, verdict: 'no-title' };
  const a = stripPublisherSuffix(normaliseText(citedTitle));
  const b = stripPublisherSuffix(normaliseText(fetchedTitle));
  if (!a || !b) return { score: null, verdict: 'no-title' };
  if (a === b) return { score: 1, verdict: 'exact' };
  if (a.includes(b) || b.includes(a)) return { score: 0.9, verdict: 'substring' };
  const score = jaccard(tokenSet(a), tokenSet(b));
  let verdict;
  if (score >= TITLE_MATCH_THRESHOLD) verdict = 'match';
  else if (score >= TITLE_MATCH_THRESHOLD / 2) verdict = 'weak';
  else verdict = 'mismatch';
  return { score: Number(score.toFixed(2)), verdict };
}

function compareContent(citedText, bodyText) {
  const cited = tokenSet(citedText);
  if (cited.size === 0) return { score: null, verdict: 'no-citation-text' };
  const body = tokenSet(bodyText);
  if (body.size === 0) return { score: null, verdict: 'empty-body' };
  let present = 0;
  for (const t of cited) if (body.has(t)) present++;
  const score = Number((present / cited.size).toFixed(2));
  let verdict;
  if (score >= CONTENT_OVERLAP_THRESHOLD) verdict = 'overlap';
  else if (score >= CONTENT_OVERLAP_THRESHOLD / 2) verdict = 'weak';
  else verdict = 'mismatch';
  return { score, verdict, cited_token_count: cited.size, present };
}

function quotePresent(quote, bodyText) {
  const q = normaliseText(quote).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const b = normaliseText(bodyText).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return { score: null, verdict: 'no-quote' };
  if (!b) return { score: null, verdict: 'empty-body' };
  const words = q.split(' ');
  if (words.length < QUOTE_SHINGLE_LEN) {
    const hit = b.includes(q);
    return { score: hit ? 1 : 0, verdict: hit ? 'present' : 'absent' };
  }
  let total = 0;
  let found = 0;
  for (let i = 0; i + QUOTE_SHINGLE_LEN <= words.length; i++) {
    total++;
    const shingle = words.slice(i, i + QUOTE_SHINGLE_LEN).join(' ');
    if (b.includes(shingle)) found++;
  }
  const score = total === 0 ? 0 : Number((found / total).toFixed(2));
  let verdict;
  if (score >= QUOTE_PRESENT_THRESHOLD) verdict = 'present';
  else if (score >= QUOTE_PARTIAL_THRESHOLD) verdict = 'partial';
  else verdict = 'absent';
  return { score, verdict, shingles_total: total, shingles_found: found };
}

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

function extractHtmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  if (!m) return null;
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim() || null;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    const finalUrl = res.url || url;
    // Read raw bytes once; decode for text/* content types only. We always keep
    // the raw bytes around because PDFs are useful debug artifacts even though
    // we can't text-search them.
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > SOURCE_BODY_CAP;
    const bodyBytes = truncated ? buf.subarray(0, SOURCE_BODY_CAP) : buf;
    let pageTitle = null;
    let bodyText = null;
    if (res.ok && /text\/html/i.test(contentType)) {
      const html = bodyBytes.toString('utf8');
      pageTitle = extractHtmlTitle(html);
      bodyText = stripHtml(html);
      if (bodyText.length > SOURCE_BODY_TEXT_CAP) {
        bodyText = bodyText.slice(0, SOURCE_BODY_TEXT_CAP);
      }
    } else if (res.ok && /^text\//i.test(contentType)) {
      bodyText = bodyBytes.toString('utf8').slice(0, SOURCE_BODY_TEXT_CAP);
    }
    return {
      ok: res.ok,
      status: res.status,
      final_url: finalUrl,
      content_type: contentType,
      page_title: pageTitle,
      body_text: bodyText,
      body_bytes: bodyBytes,
      byte_len: buf.length,
      truncated,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      final_url: null,
      content_type: null,
      page_title: null,
      body_text: null,
      body_bytes: null,
      byte_len: 0,
      truncated: false,
      error: err.name === 'AbortError' ? 'timeout' : (err.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Source-artifact cache
// ---------------------------------------------------------------------------

function sourcesDirFor(ideaId) {
  return path.join(ideaDir(ideaId), 'sources');
}

function sourcesIndexPathFor(ideaId) {
  return path.join(sourcesDirFor(ideaId), 'index.json');
}

function urlHash(normalisedUrl) {
  return crypto.createHash('sha1').update(normalisedUrl).digest('hex');
}

async function ensureSourcesDir(ideaId) {
  await fs.mkdir(sourcesDirFor(ideaId), { recursive: true });
}

async function readSourcesIndex(ideaId) {
  try {
    const text = await fs.readFile(sourcesIndexPathFor(ideaId), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSourcesIndex(ideaId, index) {
  const file = sourcesIndexPathFor(ideaId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await fs.rename(tmp, file);
}

async function saveSourceArtifact(ideaId, url, fetched) {
  await ensureSourcesDir(ideaId);
  const normalised = normaliseUrl(url);
  const hash = urlHash(normalised);
  const dir = sourcesDirFor(ideaId);
  const binPath = path.join(dir, `${hash}.bin`);
  const metaPath = path.join(dir, `${hash}.meta.json`);

  if (fetched.body_bytes && fetched.body_bytes.length > 0) {
    const tmpBin = `${binPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpBin, fetched.body_bytes, { flag: 'wx' });
    await fs.rename(tmpBin, binPath);
  }

  const meta = {
    url,
    normalised_url: normalised,
    sha1: hash,
    fetched_at: new Date().toISOString(),
    ok: fetched.ok,
    status: fetched.status,
    final_url: fetched.final_url,
    content_type: fetched.content_type,
    page_title: fetched.page_title,
    body_text: fetched.body_text,
    byte_len: fetched.byte_len,
    truncated: fetched.truncated,
    error: fetched.error,
  };
  const tmpMeta = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpMeta, JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await fs.rename(tmpMeta, metaPath);

  // Update index. This is racy across concurrent writers; the worst case is a
  // momentarily missing entry — the .meta.json still exists and can be located
  // by deterministic hash. Keep the index as an O(1) optimisation, not a
  // correctness gate.
  try {
    const index = await readSourcesIndex(ideaId);
    index[normalised] = hash;
    await writeSourcesIndex(ideaId, index);
  } catch {
    // Index write conflicts are non-fatal — sweep can rebuild from .meta.json.
  }

  return { hash, normalised_url: normalised, meta_path: metaPath, bin_path: binPath };
}

async function loadSourceArtifact(ideaId, url) {
  const normalised = normaliseUrl(url);
  const hash = urlHash(normalised);
  const metaPath = path.join(sourcesDirFor(ideaId), `${hash}.meta.json`);
  try {
    const text = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function loadSourceBytes(ideaId, url) {
  const normalised = normaliseUrl(url);
  const hash = urlHash(normalised);
  const binPath = path.join(sourcesDirFor(ideaId), `${hash}.bin`);
  try {
    return await fs.readFile(binPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Finding-level validation (researcher-side)
// ---------------------------------------------------------------------------

/**
 * Re-fetch a finding's URL out-of-band, persist the artifact, and verify that
 * (a) the URL is reachable, (b) the model-supplied source_quote is plausibly
 * present in the page body, and (c) the model-supplied source_title plausibly
 * matches the page title.
 *
 * Returns { ok, errors, warnings, meta, refetch } where:
 *   ok       — true iff no hard error. Title mismatch is a warning, not a hard
 *              error, because publisher title strings drift and many PDFs lack
 *              extractable titles. Quote-absent IS a hard error: the finding
 *              claims to quote the source, and the quote should be in the
 *              source.
 *   errors   — array of strings; non-empty means drop the finding.
 *   warnings — array of strings; advisory.
 *   meta     — { status, page_title, title_check, quote_check }
 *   refetch  — the raw fetchWithTimeout return (omitted if from cache)
 */
async function validateFindingGrounding({
  ideaId,
  url,
  sourceQuote,
  sourceTitle,
  useCache = true,
  saveArtifact = true,
}) {
  const errors = [];
  const warnings = [];

  let fetched = null;
  let fromCache = false;
  if (useCache) {
    const cached = await loadSourceArtifact(ideaId, url);
    if (cached) {
      fetched = cached;
      fromCache = true;
    }
  }
  if (!fetched) {
    fetched = await fetchWithTimeout(url);
    if (saveArtifact && fetched.byte_len > 0) {
      await saveSourceArtifact(ideaId, url, fetched);
    }
  }

  if (!fetched.ok) {
    errors.push(`unreachable: ${fetched.error || `HTTP ${fetched.status}`}`);
    return {
      ok: false,
      errors,
      warnings,
      meta: { status: fetched.status, page_title: fetched.page_title || null, from_cache: fromCache },
    };
  }

  const isHtml = /text\/html/i.test(fetched.content_type || '');
  const isText = /^text\//i.test(fetched.content_type || '');
  const bodyText = fetched.body_text;

  // Quote check. A finding whose quote is not on the page is the canonical
  // failure mode we are trying to catch — flag as hard error.
  let quoteCheck = null;
  if (sourceQuote) {
    if (bodyText) {
      quoteCheck = quotePresent(sourceQuote, bodyText);
      if (quoteCheck.verdict === 'absent') {
        errors.push('quote-absent: source_quote does not appear in the fetched body');
      } else if (quoteCheck.verdict === 'partial') {
        warnings.push(`quote-partial: ${quoteCheck.shingles_found}/${quoteCheck.shingles_total} shingles present`);
      }
    } else if (isText) {
      // Was text/* but stripping produced nothing — odd but not fatal.
      warnings.push('quote-skip: body text empty after stripping');
    } else {
      // Binary content (PDF, etc). We cannot verify the quote without a PDF
      // parser, so we record the inability rather than fail the finding.
      warnings.push('quote-skip: non-text content type, cannot verify quote');
    }
  }

  // Title check. Advisory only.
  let titleCheck = null;
  if (sourceTitle && fetched.page_title) {
    titleCheck = compareTitles(sourceTitle, fetched.page_title);
    if (titleCheck.verdict === 'mismatch') {
      warnings.push(`title-mismatch: cited "${truncate(sourceTitle, 80)}" vs page "${truncate(fetched.page_title, 80)}"`);
    }
  } else if (sourceTitle && isHtml && !fetched.page_title) {
    warnings.push('title-skip: HTML page has no <title>');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: {
      status: fetched.status,
      final_url: fetched.final_url,
      content_type: fetched.content_type,
      page_title: fetched.page_title || null,
      title_check: titleCheck,
      quote_check: quoteCheck,
      from_cache: fromCache,
    },
  };
}

function truncate(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // tunables
  USER_AGENT,
  FETCH_TIMEOUT_MS,
  SOURCE_BODY_CAP,
  TITLE_MATCH_THRESHOLD,
  CONTENT_OVERLAP_THRESHOLD,
  // normalisation
  normaliseUrl,
  normaliseText,
  tokenSet,
  jaccard,
  stripPublisherSuffix,
  // comparisons
  compareTitles,
  compareContent,
  quotePresent,
  // HTML
  extractHtmlTitle,
  stripHtml,
  // fetch
  fetchWithTimeout,
  // cache
  sourcesDirFor,
  sourcesIndexPathFor,
  urlHash,
  ensureSourcesDir,
  readSourcesIndex,
  saveSourceArtifact,
  loadSourceArtifact,
  loadSourceBytes,
  // finding-level
  validateFindingGrounding,
  // utility
  truncate,
};
