const { bracketTimings } = require('./timings');

function enrichDiscovery(logs) {
  const records = logs['discovery'];
  if (!records) {
    return { timings: { started_at: null, completed_at: null }, web_search_results: [] };
  }
  const timings = bracketTimings(records);
  // Phase 2 will populate this from server_tool_use blocks; Phase 1 stays empty.
  const web_search_results = records
    .filter((r) => r.kind === 'web_search' && r.payload)
    .map((r) => r.payload);
  return { timings, web_search_results };
}

module.exports = { enrichDiscovery };
