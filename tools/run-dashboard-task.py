"""Fixed, viewer-only Task Scheduler entrypoint; never owns an existing server."""

import contextlib
import errno
import os
from pathlib import Path
import runpy
import socket
import sys


WORKSPACE = Path(__file__).resolve().parent.parent
ADDRESS = ("127.0.0.1", 5050)


def main(args=None):
    if (sys.argv[1:] if args is None else args):
        print("DASHBOARD_ARGUMENTS_REFUSED")
        return 2
    try:
        # Binding a short-lived exclusive probe avoids contacting/adopting any
        # unknown listener. Flask's own bind handles the remaining startup race.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(ADDRESS)
    except OSError as error:
        if error.errno == errno.EADDRINUSE or getattr(error, "winerror", None) == 10048:
            print("PORT_OCCUPIED")
            return 0  # deferred; the existing one-minute task trigger retries
        print("PORT_UNAVAILABLE")
        return 1

    print("DASHBOARD_STARTING", flush=True)
    try:
        os.chdir(WORKSPACE)
        # -E ignores PYTHON* environment overrides while retaining the current
        # account's installed user-site dependencies. Only this fixed checkout
        # is added here, never user arguments or another interpreter/shell.
        sys.path.insert(0, str(WORKSPACE))
        # Only fixed status codes leave this entrypoint. Do not expose server
        # tracebacks, request URLs or inherited environment values in task logs.
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                runpy.run_module("dashboard", run_name="__main__", alter_sys=True)
    except SystemExit as error:
        if error.code not in (None, 0):
            print("DASHBOARD_FAILED")
            return 1
    except KeyboardInterrupt:
        pass
    except Exception:
        print("DASHBOARD_FAILED")
        return 1
    print("DASHBOARD_STOPPED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
