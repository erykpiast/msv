const { bracketTimings } = require('./timings');

function enrichCoordinator(logs, index) {
  const initialRecords = logs['coordinator-initial'];
  const spawnRecords = logs['coordinator-spawn'];

  const timings = {
    initial: bracketTimings(initialRecords),
    spawn: bracketTimings(spawnRecords),
  };

  // The `declined` record's reason field is recorded when spawn decided not to run.
  let spawn_reason = null;
  let spawn_declined = false;
  if (spawnRecords) {
    for (const record of spawnRecords) {
      if (record.kind === 'declined' && record.payload) {
        spawn_declined = true;
        spawn_reason = record.payload.reason || null;
      }
    }
  }
  // Cross-check with index — when spawn produced no sub-questions, the spawn step declined.
  const spawnIndex = index?.investigation?.coordinator_decisions?.spawn;
  if (spawnIndex && Array.isArray(spawnIndex.sub_questions) && spawnIndex.sub_questions.length === 0) {
    spawn_declined = true;
  }

  return { timings, spawn_reason, spawn_declined };
}

module.exports = { enrichCoordinator };
