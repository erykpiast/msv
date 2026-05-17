'use strict';

const React = require('react');
const { getInk } = require('../inkExports');
const { COLORS } = require('../style');

const EVENT_FORMATTERS = {
  'pipeline.start': (e) => `idea ${e.idea_id} · ${e.raw_capture}`,
  'pipeline.stage.start': (e) => `stage ${e.stage_index}/${e.total_stages} — ${e.stage}`,
  'pipeline.stage.end': (e) => `stage done — ${e.stage}`,
  'pipeline.stage.heartbeat': (e) => `heartbeat · ${e.stage} · ${e.seconds}s`,
  'pipeline.complete': (e) => `complete · ${e.used_executor_calls || '?'} calls`,
  'pipeline.failed': (e) => `FAILED at ${e.stage}: ${e.error_message}`,
  'wg.start': (e) => `[${e.territory_id}] wg.start · ${e.territory_name}`,
  'wg.ideation.done': (e) => `[${e.territory_id}] ideation done · ${e.total_candidates} candidates`,
  'wg.adversarial.done': (e) => `[${e.territory_id}] adversarial done`,
  'wg.alignment.done': (e) => `[${e.territory_id}] alignment done · ${e.move_count} moves`,
  'wg.researcher.start': (e) => `[${e.territory_id}] researcher start · ${e.aligned_id || ''}`,
  'wg.researcher.done': (e) => `[${e.territory_id}] researcher done · ${e.outcome || ''}`,
  'wg.observation.done': (e) => `[${e.territory_id}] observation done · ${e.observation_count} obs`,
  'wg.debate.done': (e) => `[${e.territory_id}] debate done · ${e.claim_count} claims`,
  'wg.end': (e) => `[${e.territory_id}] wg done · ${e.aligned_count} aligned`,
  'api.call.start': (e) => `api call ${e.call_id} · ${e.model || ''}`,
  'api.call.end': (e) =>
    e.outcome === 'ok'
      ? `api ok ${e.call_id} · ${e.ms}ms`
      : `api failed ${e.call_id} · ${e.error_message}`,
};

function formatEvent(event) {
  const fmt = EVENT_FORMATTERS[event.name];
  if (fmt) {
    try {
      return fmt(event);
    } catch (_) {
      return '';
    }
  }
  // Fallback: show name + first non-name key
  const keys = Object.keys(event).filter((k) => k !== 'name').slice(0, 2);
  return keys.map((k) => `${k}=${JSON.stringify(event[k])}`).join(' ');
}

function eventColor(name) {
  if (!name) return COLORS.muted;
  if (name.startsWith('pipeline.failed') || name === 'wg.failed') return COLORS.failed;
  if (name.startsWith('api.call.retry')) return COLORS.warn;
  return COLORS.muted;
}

function RecentEvents({ recent }) {
  const { Box, Text } = getInk();

  const events = (recent || []).slice().reverse(); // newest first

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { color: COLORS.header, bold: true, underline: true }, 'Recent Events'),
    events.length === 0
      ? React.createElement(Text, { color: COLORS.muted }, '(none)')
      : events.map((event, i) =>
          React.createElement(
            Box,
            { key: i, flexDirection: 'row', gap: 1 },
            React.createElement(Text, { color: COLORS.muted }, event.name || '?'),
            React.createElement(
              Text,
              { color: eventColor(event.name) },
              formatEvent(event)
            )
          )
        )
  );
}

module.exports = RecentEvents;
