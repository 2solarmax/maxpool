// Is the terminal running maxpool still open? A SIGHUP has two very different
// senders: the kernel, when the window closes (→ shut down, or we orphan onto a
// dead terminal), and another program running `kill -HUP` to "reload" (→ shutting
// down kills every session using the pool; happened 2026-11-07). When the window
// really closed, the controlling terminal is revoked: opening /dev/tty fails and
// writes to it fail. When it is still open, both succeed.
import { openSync, closeSync, writeSync } from 'node:fs';

export function controllingTerminalAlive({
  isTTY = Boolean(process.stdout.isTTY),
  fd = process.stdout.fd,
  open = openSync, close = closeSync, write = writeSync,
} = {}) {
  // Not a real terminal (a pipe, or the test suite's forced-terminal mode): no way
  // to tell, so keep the long-standing answer — treat the SIGHUP as a hangup.
  if (!isTTY) return false;
  try {
    close(open('/dev/tty', 'r+'));
    write(fd, '');
    return true;
  } catch {
    return false;
  }
}
