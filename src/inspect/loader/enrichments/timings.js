function bracketTimings(records) {
  if (!records || records.length === 0) {
    return { started_at: null, completed_at: null };
  }
  let earliest = null;
  let latest = null;
  for (const record of records) {
    if (!record.ts) continue;
    if (earliest === null || record.ts < earliest) earliest = record.ts;
    if (latest === null || record.ts > latest) latest = record.ts;
  }
  return { started_at: earliest, completed_at: latest };
}

module.exports = { bracketTimings };
