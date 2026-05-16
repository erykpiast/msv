const { readIndex } = require('./readIndex');
const { readLogs } = require('./readLogs');
const { enrichDiscovery } = require('./enrichments/discovery');
const { enrichCoordinator } = require('./enrichments/coordinator');
const { enrichDebates } = require('./enrichments/debates');
const { enrichCrossPollination } = require('./enrichments/crossPollination');
const { enrichForum } = require('./enrichments/forum');
const { enrichSynthesis } = require('./enrichments/synthesis');
const { enrichParseErrors } = require('./enrichments/parseErrors');

async function buildLoaderInput(ideaDir) {
  const [index, logs] = await Promise.all([readIndex(ideaDir), readLogs(ideaDir)]);

  const enrichments = {
    discovery: enrichDiscovery(logs),
    coordinator: enrichCoordinator(logs, index),
    debates: enrichDebates(logs, index),
    crossPollination: enrichCrossPollination(logs),
    forum: enrichForum(logs),
    synthesis: enrichSynthesis(logs),
    parseErrors: enrichParseErrors(logs),
  };

  return { index, logs, enrichments };
}

module.exports = { buildLoaderInput };
