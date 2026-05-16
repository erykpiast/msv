const { bracketTimings } = require('./timings');

function enrichSynthesis(logs) {
  const records = logs['synthesizer'];
  return { timings: bracketTimings(records) };
}

module.exports = { enrichSynthesis };
