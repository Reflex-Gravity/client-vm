# SPDX-License-Identifier: Apache-2.0
"""Runs an interactive shell on a real pseudo-terminal and replays keystrokes.

Reference side of test/e2e/pty-differential.spec.ts. Reads JSON on stdin:
  {"shell": "bash", "args": ["--norc", "--noprofile", "-i"], "cwd": "...",
   "env": {...}, "cols": 80, "rows": 40, "steps": ["keys", ...]}
Each step is written once the output has been quiet for a moment, and the
raw output (base64) is printed when the last step has settled.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

QUIET_S = 0.3
MAX_WAIT_S = 5.0


def drain(fd, out, quiet=QUIET_S, limit=MAX_WAIT_S):
    """Reads until nothing arrives for `quiet` seconds (or `limit` passes)."""
    start = last = time.monotonic()
    while True:
        now = time.monotonic()
        if now - last >= quiet or now - start >= limit:
            return
        ready, _, _ = select.select([fd], [], [], quiet)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return
        if not data:
            return
        out.append(data)
        last = time.monotonic()


def main():
    spec = json.load(sys.stdin)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(spec["cwd"])
        os.execvpe(spec["shell"], [spec["shell"], *spec["args"]], spec["env"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0))
    out = []
    drain(fd, out)
    for step in spec["steps"]:
        os.write(fd, step.encode())
        drain(fd, out)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    sys.stdout.write(base64.b64encode(b"".join(out)).decode())


main()
