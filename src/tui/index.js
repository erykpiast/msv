'use strict';

const log = require('./log');
const debug = require('./debug');

const NO_ATTACH = { attach: async () => ({ cleanup: async () => {} }) };

function loadDashboard() {
  return require('./dashboard');
}

function selectTui({ explicit, isStdoutTty, isStdinTty, env = process.env } = {}) {
  const dashboardCapable = !!isStdoutTty && !!isStdinTty;

  if (explicit === 'silent') return NO_ATTACH;
  if (explicit === 'debug') return debug;
  if (explicit === 'log') return log;
  if (explicit === 'dashboard') {
    if (dashboardCapable || env.FORCE_TTY === '1') return loadDashboard();
    process.stderr.write(
      'dashboard requires a TTY on stdin and stdout; falling back to log mode\n'
    );
    return log;
  }
  // Auto-select:
  if (env.CI || env.NO_TUI) return log;
  if (!dashboardCapable) return log;
  return loadDashboard();
}

module.exports = { selectTui };
