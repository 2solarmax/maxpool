#!/usr/bin/env python3
"""Run a command on a real pseudo-terminal and let a test drive the terminal side.

Used by test/tui-terminal-pty.test.js (2026-11-12 terminal-freeze fix): a fake stdout
cannot prove what a real TTY does to a process that writes faster than the terminal
reads, so the test needs a real pty whose reader it controls.

    python3 pty-run.py <cols> <rows> -- <cmd> [args...]

Prints `PID <n>` once the child is running, then reads one command per stdin line:
    read                  start draining the terminal at full speed
    read-slow <n> <ms>    drain at most <n> bytes every <ms> ms (a terminal falling behind)
    pause                 stop reading (the terminal hangs again)
    keys <hex>            type bytes into the terminal (the child's stdin)
    wait <seconds>        wait for the child to exit -> `EXIT <code|TIMEOUT>`
    dump                  -> `OUT <base64 of every byte read so far>`
    kill                  SIGKILL the child
Until `read`/`read-slow`, NOTHING is read: the terminal looks hung to the child.
"""
import base64
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time


def main():
    sep = sys.argv.index('--')
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cmd = sys.argv[sep + 1:]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    child = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    out = bytearray()
    lock = threading.Lock()
    mode = {'chunk': None, 'every': 0.0, 'on': False}

    def reader():
        while True:
            if not mode['on']:
                time.sleep(0.01)
                continue
            r, _, _ = select.select([master], [], [], 0.05)
            if not r:
                continue
            try:
                data = os.read(master, mode['chunk'] or 65536)
            except OSError:
                return   # EIO: the child side closed (exited) and everything was read
            if not data:
                return
            with lock:
                out.extend(data)
            if mode['every']:
                time.sleep(mode['every'])

    threading.Thread(target=reader, daemon=True).start()

    def say(line):
        sys.stdout.write(line + '\n')
        sys.stdout.flush()

    say(f'PID {child.pid}')
    for raw in sys.stdin:
        parts = raw.split()
        if not parts:
            continue
        op = parts[0]
        if op == 'read':
            mode.update(chunk=None, every=0.0, on=True)
        elif op == 'read-slow':
            mode.update(chunk=int(parts[1]), every=int(parts[2]) / 1000.0, on=True)
        elif op == 'pause':
            mode['on'] = False
        elif op == 'keys':
            os.write(master, bytes.fromhex(parts[1]))
        elif op == 'wait':
            try:
                code = child.wait(timeout=float(parts[1]))
                time.sleep(0.3)   # let the reader collect the last bytes
                say(f'EXIT {code}')
            except subprocess.TimeoutExpired:
                say('EXIT TIMEOUT')
        elif op == 'dump':
            with lock:
                say('OUT ' + base64.b64encode(bytes(out)).decode())
        elif op == 'kill':
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass
            say('KILLED')
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass


if __name__ == '__main__':
    main()
