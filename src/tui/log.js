'use strict';

// Events deliberately not formatted here (dashboard-only):
// - wg.<substage>.start (ideation/adversarial/alignment/observation/debate) — log shows only the .done summary
// - wg.move — fires per move; too noisy for the log stream
// - cross_pollination.reaction — fires per reaction; the .done aggregate is shown
// - forum.contradiction.judged — fires per judgement; the .done aggregate is shown
const FORMATTERS = {
  'pipeline.start': (e) =>
    `[info] [pipeline] starting ${e.idea_id} · ${e.raw_capture}`,
  'pipeline.stage.start': (e) =>
    `[info] [${e.stage}] stage ${e.stage_index}/${e.total_stages} — ${e.stage}…`,
  'pipeline.stage.progress': (e) =>
    `[info] [${e.stage}] ${e.message}`,
  'pipeline.stage.heartbeat': (e) =>
    `[info] [pipeline] heartbeat · ${e.stage} · ${e.seconds}s`,
  'pipeline.stage.end': (e) =>
    `[info] [${e.stage}] stage done · ${JSON.stringify(e.summary)}`,
  'pipeline.complete': (e) =>
    `[info] [pipeline] complete · ${e.used_executor_calls} calls · ${e.used_total_tokens} tokens`,
  'pipeline.failed': (e) =>
    `[error] [pipeline] failed at ${e.stage}: ${e.error_message}`,

  'discovery.web_search.start': (e) =>
    `[info] [discovery] web_search: ${e.query}`,
  'discovery.web_search.result': (e) =>
    `[info] [discovery] web_search returned ${e.count} results`,
  'discovery.emit_personas': (e) =>
    `[info] [discovery] emit_personas (${e.count} candidates)`,

  'coordinator.territories.emitted': (e) =>
    `[info] [coordinator] done · ${e.count} territories: ${e.names.join(', ')}`,

  'wg.start': (e) =>
    `[info] [${e.territory_id}] wg.start · ${e.territory_name}`,
  'wg.ideation.done': (e) =>
    `[info] [${e.territory_id}] wg.ideation.done · ${e.total_candidates} candidates`,
  'wg.adversarial.done': (e) =>
    `[info] [${e.territory_id}] wg.adversarial.done · ${e.mark_count} marks${e.partial ? ' (partial)' : ''}`,
  'wg.alignment.done': (e) =>
    `[info] [${e.territory_id}] wg.alignment.done · ${e.move_count} moves, ${e.aligned_count} aligned`,
  'wg.researcher.start': (e) =>
    `[info] [${e.territory_id}] wg.researcher.start · ${e.aligned_id}`,
  'wg.researcher.turn': (e) =>
    `[${e.forced ? 'warn' : 'info'}] [${e.territory_id}] wg.researcher.turn ${e.turn_index} stop_reason=${e.stop_reason}${e.forced ? ' forced=true' : ''}`,
  'wg.researcher.done': (e) =>
    `[info] [${e.territory_id}] wg.researcher.done · ${e.aligned_id} outcome=${e.outcome} findings=${e.finding_count}`,
  'wg.observation.done': (e) =>
    `[info] [${e.territory_id}] wg.observation.done · ${e.observation_count} observations`,
  'wg.debate.done': (e) =>
    `[info] [${e.territory_id}] wg.debate.done · ${e.move_count} moves, ${e.claim_count} claims · ${e.terminated_by}`,
  'wg.end': (e) =>
    `[info] [${e.territory_id}] wg.end · ${e.aligned_count} aligned, ${e.report_count} reports, ${e.observation_count} observations, ${e.claim_count} claims · ${e.terminated_by}`,
  'wg.failed': (e) =>
    `[error] [${e.territory_id}] wg.failed: ${e.reason}`,

  'cross_pollination.done': (e) =>
    `[info] [cross_pollination] done · ${e.reaction_count} reactions`,

  'forum.done': (e) =>
    `[info] [forum] done · ${e.node_count} nodes, ${e.contradiction_count} contradictions, ${e.dead_end_count} dead ends`,

  'synthesizer.done': (e) =>
    `[info] [synthesis] done · ${e.headline_count} headlines, ${e.tension_count} tensions`,

  'api.call.start': (e) =>
    `[info] [api] call ${e.call_id} start · model=${e.model}`,
  'api.call.retry': (e) =>
    `[warn] [api] call ${e.call_id} retry ${e.attempt} · ${e.reason} · wait=${e.wait_ms}ms`,
  'api.call.end': (e) =>
    e.outcome === 'ok'
      ? `[info] [api] call ${e.call_id} ok · ${e.ms}ms · ${e.input_tokens}in · ${e.output_tokens}out`
      : `[error] [api] call ${e.call_id} failed · ${e.error_message}`,
};

const { sanitizeEnvelope } = require('./sanitize');

function attach(bus, opts = {}) {
  const verboseApi = !!opts.verboseApi;
  const off = bus.onAny((env) => {
    if (!verboseApi && env.name && env.name.startsWith('api.')) return;
    const safeEnv = sanitizeEnvelope(env);
    const fmt = FORMATTERS[safeEnv.name];
    if (!fmt) return;
    process.stdout.write(`${fmt(safeEnv)}\n`);
  });
  return async () => off();
}

module.exports = { attach, FORMATTERS };
