#!/usr/bin/env python3
"""pty_bridge.py — run a command inside a pseudo-terminal and relay it over stdio.

The studio embeds a real terminal for the agent, the way Orca does: the agent
CLI gets a tty, believes it is talking to a person, and draws its own UI. Node
has no pseudo-terminal of its own without a native module, and the lane's
promise is "no dependencies, no build step" — so the pty comes from Python's
standard library, which the gates already require.

    stdin   frames   <type:1 byte> <length:4 bytes big-endian> <payload>
              type 0  bytes the person typed        → written to the pty
              type 1  a resize, payload "cols rows" → TIOCSWINSZ + SIGWINCH
    stdout  the pty's output, raw, as it comes
    exit    the child's exit code, or 128 + the signal that killed it

When stdin closes (the studio has gone away) the child is sent SIGHUP, exactly
as a closed terminal window would, and the bridge drains what is left.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except BlockingIOError:
            select.select([], [fd], [])
            continue
        data = data[n:]


def main():
    args = sys.argv[1:]
    cols, rows = 120, 36
    while args and args[0].startswith("--"):
        if args[0] == "--":
            args = args[1:]
            break
        if len(args) < 2:
            break
        key, value = args[0], args[1]
        args = args[2:]
        if key == "--cols":
            cols = max(20, min(500, int(value)))
        elif key == "--rows":
            rows = max(5, min(200, int(value)))
    if not args:
        sys.stderr.write("usage: pty_bridge.py [--cols N --rows N] -- command [args...]\n")
        sys.exit(2)

    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ.pop("CI", None)
        try:
            os.execvp(args[0], args)
        except OSError as exc:
            sys.stderr.write("could not start %s: %s\r\n" % (args[0], exc.strerror or exc))
            sys.stderr.flush()
            os._exit(127)

    set_winsize(fd, rows, cols)
    stdin_fd = sys.stdin.fileno()
    out = sys.stdout.buffer
    inbuf = b""
    stdin_open = True

    while True:
        watch = [fd] + ([stdin_fd] if stdin_open else [])
        try:
            ready, _, _ = select.select(watch, [], [])
        except InterruptedError:
            continue

        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:      # Linux: the child hung up
                    data = b""
                else:
                    raise
            if not data:
                break
            out.write(data)
            out.flush()

        if stdin_fd in ready:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                stdin_open = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                continue
            inbuf += chunk
            while len(inbuf) >= 5:
                kind = inbuf[0]
                length = struct.unpack(">I", inbuf[1:5])[0]
                if len(inbuf) < 5 + length:
                    break
                payload = inbuf[5:5 + length]
                inbuf = inbuf[5 + length:]
                if kind == 0:
                    write_all(fd, payload)
                elif kind == 1:
                    try:
                        c, r = payload.decode("ascii").split()
                        set_winsize(fd, max(5, min(200, int(r))), max(20, min(500, int(c))))
                        os.kill(pid, signal.SIGWINCH)
                    except (ValueError, OSError):
                        pass

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    sys.exit(128 + os.WTERMSIG(status))


if __name__ == "__main__":
    main()
