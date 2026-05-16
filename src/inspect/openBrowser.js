const { spawn } = require('node:child_process');

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `start` is a cmd.exe builtin, not a binary — must go through `cmd /c`.
    // The empty "" is `start`'s window-title slot so the URL is treated as the target.
    // Args go through argv (no shell: true), so shell metacharacters in `url` are inert.
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Swallow: caller has already printed the URL; missing binary is best-effort failure.
    });
    child.unref();
  } catch (_err) {
    // Same rationale — never throw.
  }
}

module.exports = { openBrowser };
