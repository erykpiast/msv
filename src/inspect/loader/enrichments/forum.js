const { contradictionKey } = require('../../../forum');
const { bracketTimings } = require('./timings');

function enrichForum(logs) {
  const records = logs['forum-contradictions'];
  const result = {
    timings: bracketTimings(records),
    contradiction_verdicts: {},
  };
  if (!records) return result;

  for (const record of records) {
    if (record.kind !== 'response') continue;
    const key = record.payload?.key;
    const verdict = record.payload?.result;
    if (!key || !verdict) continue;
    result.contradiction_verdicts[key] = {
      contradicts: !!verdict.contradicts,
      reason: verdict.reason || '',
      usage: verdict.usage || null,
    };
  }

  return result;
}

module.exports = { enrichForum, contradictionKey };
