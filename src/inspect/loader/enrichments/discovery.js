const { bracketTimings } = require('./timings');

function normalizeWebSearch(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  return {
    query: payload.query || '',
    results,
    result_count: typeof payload.result_count === 'number' ? payload.result_count : results.length,
    error: payload.error ?? null,
  };
}

function enrichDiscovery(logs) {
  const records = logs['discovery'];
  if (!records) {
    return { timings: { started_at: null, completed_at: null }, web_search_results: [] };
  }
  const timings = bracketTimings(records);
  const web_search_results = records
    .filter((r) => r.kind === 'web_search' && r.payload)
    .map((r) => normalizeWebSearch(r.payload));
  return { timings, web_search_results };
}

module.exports = { enrichDiscovery };
