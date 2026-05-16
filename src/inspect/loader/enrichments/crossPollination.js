const { bracketTimings } = require('./timings');

function enrichCrossPollination(logs) {
  const records = logs['cross-pollination'];
  return { timings: bracketTimings(records) };
}

module.exports = { enrichCrossPollination };
