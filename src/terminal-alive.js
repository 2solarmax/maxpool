// Is the terminal running maxpool still open? A SIGHUP has two very different
// senders: the kernel, when the window closes (→ shut down, or we orphan onto a
// dead terminal), and another program running `kill -HUP` to "reload" (→ shutting
// down kills every session using the pool; happened 2026-11-07). When the window
// really closed, the controlling terminal is revoked: opening /dev/tty fails and
// writes to it fail. When it is still open, both succeed.
import { openSync, closeSync, writeSync, constants } from 'node:fs';

export function terminalOutputAlive(fd = process.stdout.fd, write = writeSync) {
  // A zero-byte write returns EIO on a revoked macOS pty even while opening
  // /dev/tty can still block. Probe the existing descriptor first.
  try { write(fd, ''); return true; } catch (err) {
    return !['EIO', 'ENXIO', 'ENODEV', 'EPIPE', 'EBADF'].includes(err?.code);
  }
}

export function controllingTerminalAlive({
  isTTY = Boolean(process.stdout.isTTY),
  fd = process.stdout.fd,
  open = openSync, close = closeSync, write = writeSync,
} = {}) {
  // Not a real terminal (a pipe, or the test suite's forced-terminal mode): no way
  // to tell, so keep the long-standing answer — treat the SIGHUP as a hangup.
  if (!isTTY || !terminalOutputAlive(fd, write)) return false;
  try {
    close(open('/dev/tty', constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOCTTY));
    return true;
  } catch {
    return false;
  }
}
