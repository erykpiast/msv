'use strict';

// Deterministic post-pass that guarantees the synthesis document is
// self-contained (issue #42): the synthesizer prompt already asks the model
// not to leak internal ids (n_/f_/o_ ...) into prose, but that's enforced
// only by instruction-following. This module scans the emitted payload for
// bare occurrences of real internal ids and either resolves them to an
// inline `[title](url)` link (walking node -> evidence_refs ->
// finding/observation -> source_url, same as evidenceLayout.ts does for the
// inspect-app's evidence drawer) or reports them as unresolved so the caller
// can run a repair round-trip / redact them.

// Builds finding_id / observation_id / node_id -> object indices from the
// same inputs runSynthesizer already has in scope, so resolution needs no
// extra data beyond what was already used to build the prompt.
function buildEntityIndex({ forum, pairDebates }) {
  const findingsById = new Map();
  const observationsById = new Map();
  const nodesById = new Map();

  for (const pd of pairDebates || []) {
    for (const rr of pd.researcher_reports || []) {
      for (const f of rr.findings || []) {
        if (f.finding_id) findingsById.set(f.finding_id, f);
      }
    }
    for (const obs of pd.observations || []) {
      if (obs.observation_id) observationsById.set(obs.observation_id, obs);
    }
  }
  for (const node of (forum || {}).nodes || []) {
    if (node.node_id) nodesById.set(node.node_id, node);
  }

  return { findingsById, observationsById, nodesById };
}

function findingSource(finding) {
  if (!finding || !finding.source_url) return null;
  return { url: finding.source_url, title: (finding.source_title || finding.source_url).slice(0, 120) };
}

// Resolves a single bare internal id to a citable source, or null if the id
// is a known entity but carries (or cites) no source_url anywhere. Callers
// should only invoke this for ids present in one of the index maps.
function resolveInternalId(id, index) {
  if (index.findingsById.has(id)) {
    return findingSource(index.findingsById.get(id));
  }
  if (index.observationsById.has(id)) {
    const obs = index.observationsById.get(id);
    for (const fid of obs.cited_finding_ids || []) {
      const resolved = findingSource(index.findingsById.get(fid));
      if (resolved) return resolved;
    }
    return null;
  }
  if (index.nodesById.has(id)) {
    const node = index.nodesById.get(id);
    for (const ref of node.evidence_refs || []) {
      const refId = ref.finding_id || ref.observation_id;
      if (!refId) continue;
      const resolved = resolveInternalId(refId, index);
      if (resolved) return resolved;
    }
    return null;
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches the *shape* of MSV's internal ids (see forum.js/working_group.js's
// generators), not just ids present in this run's index. A hallucinated or
// malformed id (e.g. `n_999` when only 3 nodes exist, or `f_missing`) is
// exactly the case issue #42's design calls out as needing a repair
// round-trip — it wouldn't be caught by matching only known ids. Each
// alternative requires the real numeric-suffix shape the generators produce
// (not just a bare prefix), which keeps ordinary domain terms a research
// topic might use (e.g. "p_value", "o_ring") from false-positiving.
const ID_SHAPE_RE = /\b(?:n_\d{3,}|p_\d{3,}|rr_\d{3,}|f_[\w-]+_\d{2,}|o_[\w-]+_\d{3,})\b/g;

// Walks every prose field the synthesizer can emit (per issue #42's scope:
// report, sections — including area_title — tension_points (explicitly
// sides[].position/description/resolution), key_references, next_pass_proposals
// (topic/rationale/territory_hint), and question_landscape's prose. The one
// deliberate omission is question_landscape[].territory_id, which the prompt
// exempts as structured metadata. Applies `mutate(str, fieldPath)` to each
// string leaf and returns a shallow-cloned payload; only touched branches are
// copied.
function walkPayloadStrings(payload, mutate) {
  const out = { ...payload };

  if (typeof out.report === 'string') out.report = mutate(out.report, 'report');
  if (typeof out.dead_end_summary === 'string') {
    out.dead_end_summary = mutate(out.dead_end_summary, 'dead_end_summary');
  }
  if (Array.isArray(out.headline_findings)) {
    out.headline_findings = out.headline_findings.map((s, i) =>
      typeof s === 'string' ? mutate(s, `headline_findings[${i}]`) : s
    );
  }
  if (Array.isArray(out.open_tensions)) {
    out.open_tensions = out.open_tensions.map((s, i) =>
      typeof s === 'string' ? mutate(s, `open_tensions[${i}]`) : s
    );
  }
  if (Array.isArray(out.sections)) {
    out.sections = out.sections.map((section, i) => ({
      ...section,
      area_title:
        typeof section.area_title === 'string'
          ? mutate(section.area_title, `sections[${i}].area_title`)
          : section.area_title,
      area_summary:
        typeof section.area_summary === 'string'
          ? mutate(section.area_summary, `sections[${i}].area_summary`)
          : section.area_summary,
      key_findings: Array.isArray(section.key_findings)
        ? section.key_findings.map((kf, j) => ({
            ...kf,
            content: typeof kf.content === 'string' ? mutate(kf.content, `sections[${i}].key_findings[${j}].content`) : kf.content,
          }))
        : section.key_findings,
    }));
  }
  if (Array.isArray(out.tension_points)) {
    out.tension_points = out.tension_points.map((tp, i) => ({
      ...tp,
      title: typeof tp.title === 'string' ? mutate(tp.title, `tension_points[${i}].title`) : tp.title,
      description: typeof tp.description === 'string' ? mutate(tp.description, `tension_points[${i}].description`) : tp.description,
      resolution: typeof tp.resolution === 'string' ? mutate(tp.resolution, `tension_points[${i}].resolution`) : tp.resolution,
      sides: Array.isArray(tp.sides)
        ? tp.sides.map((side, j) => ({
            ...side,
            label: typeof side.label === 'string' ? mutate(side.label, `tension_points[${i}].sides[${j}].label`) : side.label,
            position: typeof side.position === 'string' ? mutate(side.position, `tension_points[${i}].sides[${j}].position`) : side.position,
          }))
        : tp.sides,
    }));
  }
  if (Array.isArray(out.key_references)) {
    out.key_references = out.key_references.map((ref, i) => ({
      ...ref,
      title: typeof ref.title === 'string' ? mutate(ref.title, `key_references[${i}].title`) : ref.title,
      summary: typeof ref.summary === 'string' ? mutate(ref.summary, `key_references[${i}].summary`) : ref.summary,
      key_observations: Array.isArray(ref.key_observations)
        ? ref.key_observations.map((o, j) => (typeof o === 'string' ? mutate(o, `key_references[${i}].key_observations[${j}]`) : o))
        : ref.key_observations,
    }));
  }
  if (Array.isArray(out.next_pass_proposals)) {
    out.next_pass_proposals = out.next_pass_proposals.map((p, i) => ({
      ...p,
      topic: typeof p.topic === 'string' ? mutate(p.topic, `next_pass_proposals[${i}].topic`) : p.topic,
      rationale: typeof p.rationale === 'string' ? mutate(p.rationale, `next_pass_proposals[${i}].rationale`) : p.rationale,
      territory_hint: typeof p.territory_hint === 'string' ? mutate(p.territory_hint, `next_pass_proposals[${i}].territory_hint`) : p.territory_hint,
    }));
  }
  if (Array.isArray(out.question_landscape)) {
    // territory_id is the one field the synthesizer prompt explicitly exempts
    // from the no-leak rule (structured metadata, not user-facing prose), so
    // it is deliberately left unscanned; every other field here is prose.
    out.question_landscape = out.question_landscape.map((entry, i) => ({
      ...entry,
      territory_name:
        typeof entry.territory_name === 'string'
          ? mutate(entry.territory_name, `question_landscape[${i}].territory_name`)
          : entry.territory_name,
      questions: Array.isArray(entry.questions)
        ? entry.questions.map((q, j) => ({
            ...q,
            question: typeof q.question === 'string' ? mutate(q.question, `question_landscape[${i}].questions[${j}].question`) : q.question,
            origin: typeof q.origin === 'string' ? mutate(q.origin, `question_landscape[${i}].questions[${j}].origin`) : q.origin,
            provenance_note: typeof q.provenance_note === 'string' ? mutate(q.provenance_note, `question_landscape[${i}].questions[${j}].provenance_note`) : q.provenance_note,
          }))
        : entry.questions,
    }));
  }

  return out;
}

// Scans every prose field for bare internal ids: resolvable ones are rewritten
// in place as `[title](url)`; unresolvable ones are left untouched (so a
// follow-up repair prompt can quote them in context) and reported.
function scanAndResolve(payload, index) {
  const unresolved = [];
  const resolvedPayload = walkPayloadStrings(payload, (str, field) =>
    str.replace(ID_SHAPE_RE, (id) => {
      const resolved = resolveInternalId(id, index);
      if (resolved) return `[${resolved.title}](${resolved.url})`;
      unresolved.push({ id, field, context: str.slice(0, 300) });
      return id;
    })
  );
  return { payload: resolvedPayload, unresolved };
}

// Final pass after the repair loop is exhausted: any of the given ids still
// present get redacted (not just left bare) so no internal id survives into
// the persisted document, satisfying the issue's "resolve or strip" mandate.
function redactUnresolved(payload, unresolvedIds) {
  const uniqueIds = [...new Set(unresolvedIds)];
  if (uniqueIds.length === 0) return payload;
  const escaped = uniqueIds.sort((a, b) => b.length - a.length).map(escapeRegExp);
  const regex = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'g');
  return walkPayloadStrings(payload, (str) => str.replace(regex, '[unverified]'));
}

// Batches every broken reference from one repair round into a single prompt,
// per issue #42's design (§2): all broken refs in one round-trip, not one
// call per id.
function buildRepairPrompt(unresolved) {
  const list = unresolved
    .map((r) => `- "${r.id}" (in ${r.field}): "...${r.context}..."`)
    .join('\n');
  return [
    'Your previous emit_synthesis call left the following internal identifiers exposed in prose, with no resolvable source:',
    list,
    'Each of these either does not correspond to any finding/observation/forum-node in the material you were given, or was left as a bare internal id instead of a citation.',
    'Re-emit emit_synthesis now, addressing every one of them: either replace it with a proper inline markdown link `[title](url)` to a real source from the material provided, or remove the unsupported claim entirely if nothing backs it. Do not leave any bare internal identifier (ids like n_001, f_..., o_...) anywhere in the output.',
  ].join('\n\n');
}

module.exports = {
  buildEntityIndex,
  resolveInternalId,
  scanAndResolve,
  redactUnresolved,
  buildRepairPrompt,
};
