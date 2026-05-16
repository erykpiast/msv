function enrichParseErrors(logs) {
  const records = logs['parse-errors'];
  if (!records) return { parse_errors: [] };

  const errors = [];
  for (const record of records) {
    const payload = record.payload || {};
    errors.push({
      kind: record.kind || null,
      stage: payload.stage || null,
      persona_id: payload.persona_id || null,
      errors: payload.errors || null,
      raw: payload.raw || null,
      ts: record.ts || null,
    });
  }
  return { parse_errors: errors };
}

module.exports = { enrichParseErrors };
