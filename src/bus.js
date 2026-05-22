'use strict';

const { EventEmitter } = require('node:events');

const EVENTS = Object.freeze({
  PIPELINE_START: 'pipeline.start',
  PIPELINE_STAGE_START: 'pipeline.stage.start',
  PIPELINE_STAGE_PROGRESS: 'pipeline.stage.progress',
  PIPELINE_STAGE_END: 'pipeline.stage.end',
  PIPELINE_STAGE_HEARTBEAT: 'pipeline.stage.heartbeat',
  PIPELINE_COMPLETE: 'pipeline.complete',
  PIPELINE_FAILED: 'pipeline.failed',

  DISCOVERY_WEB_SEARCH_START: 'discovery.web_search.start',
  DISCOVERY_WEB_SEARCH_RESULT: 'discovery.web_search.result',
  DISCOVERY_EMIT_PERSONAS: 'discovery.emit_personas',

  COORDINATOR_TERRITORIES_EMITTED: 'coordinator.territories.emitted',

  WG_START: 'wg.start',
  WG_IDEATION_START: 'wg.ideation.start',
  WG_IDEATION_PERSONA_DONE: 'wg.ideation.persona.done',
  WG_IDEATION_DONE: 'wg.ideation.done',
  WG_ADVERSARIAL_START: 'wg.adversarial.start',
  WG_ADVERSARIAL_DONE: 'wg.adversarial.done',
  WG_ALIGNMENT_START: 'wg.alignment.start',
  WG_ALIGNMENT_DONE: 'wg.alignment.done',
  WG_RESEARCHER_START: 'wg.researcher.start',
  WG_RESEARCHER_TURN: 'wg.researcher.turn',
  WG_RESEARCHER_WEB_SEARCH: 'wg.researcher.web_search',
  WG_RESEARCHER_WEB_FETCH: 'wg.researcher.web_fetch',
  WG_RESEARCHER_DONE: 'wg.researcher.done',
  WG_RESEARCHER_GROUNDING_DROP: 'wg.researcher.grounding_drop',
  WG_RESEARCHER_GROUNDING_SUMMARY: 'wg.researcher.grounding_summary',
  WG_OBSERVATION_START: 'wg.observation.start',
  WG_OBSERVATION_DONE: 'wg.observation.done',
  WG_DEBATE_START: 'wg.debate.start',
  WG_DEBATE_DONE: 'wg.debate.done',
  WG_MOVE: 'wg.move',
  WG_NICKNAMES_DONE: 'wg.nicknames.done',
  WG_NICKNAMES_FAILED: 'wg.nicknames.failed',
  WG_END: 'wg.end',
  WG_FAILED: 'wg.failed',

  CROSS_POLLINATION_REACTION: 'cross_pollination.reaction',
  CROSS_POLLINATION_DONE: 'cross_pollination.done',

  FORUM_CONTRADICTION_JUDGED: 'forum.contradiction.judged',
  FORUM_NICKNAMES_DONE: 'forum.nicknames.done',
  FORUM_NICKNAMES_FAILED: 'forum.nicknames.failed',
  FORUM_DONE: 'forum.done',

  SYNTHESIZER_DONE: 'synthesizer.done',

  API_CALL_START: 'api.call.start',
  API_CALL_RETRY: 'api.call.retry',
  API_CALL_END: 'api.call.end',
});

function createBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(40);
  let ideaId = null;

  function setIdea(id) {
    ideaId = id;
  }

  function safeDispatch(name, envelope) {
    const listeners = emitter.listeners(name);
    for (const fn of listeners) {
      try {
        fn(envelope);
      } catch (err) {
        process.stderr.write(
          `[msv:bus] listener for ${name} threw: ${err?.message || err}\n`
        );
      }
    }
  }

  function emit(name, payload = {}) {
    const envelope = { name, ts: Date.now(), idea_id: ideaId, ...payload };
    safeDispatch(name, envelope);
    safeDispatch('*', envelope);
  }

  function on(name, handler) {
    emitter.on(name, handler);
    return () => emitter.off(name, handler);
  }

  function onAny(handler) {
    return on('*', handler);
  }

  return { emit, on, onAny, setIdea, _emitter: emitter, EVENTS };
}

module.exports = { createBus, EVENTS };
