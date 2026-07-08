# session/supervisor/supervisor.py
"""Game session supervisor.

Runs inside the game-session container. Manages the RetroArch process
(one game at a time) and exposes a small HTTP control API used by the
smoke test today and by xmb-api in Phase 2.
"""
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CORES_DIR = os.environ.get("CORES_DIR", "/opt/cores")
RETROARCH_CONFIG = os.environ.get("RETROARCH_CONFIG", "/opt/retroarch/retroarch.cfg")
VGL_DISPLAY = os.environ.get("VGL_DISPLAY", "egl")


def build_command(core, rom, cores_dir=None):
    """Build the RetroArch launch argv. Raises FileNotFoundError if the
    core or ROM does not exist."""
    core_path = os.path.join(cores_dir or CORES_DIR, f"{core}_libretro.so")
    if not os.path.isfile(core_path):
        raise FileNotFoundError(f"unknown core: {core}")
    if not os.path.isfile(rom):
        raise FileNotFoundError(f"ROM not found: {rom}")
    return [
        "vglrun", "-d", VGL_DISPLAY,
        "retroarch", "-L", core_path, rom,
        "--config", RETROARCH_CONFIG, "--verbose",
    ]


class GameSession:
    """Owns at most one running RetroArch process."""

    def __init__(self, command_builder=build_command):
        self._build = command_builder
        self._proc = None
        self._game = None
        self._crashed = False
        self._lock = threading.Lock()

    def start(self, core, rom):
        cmd = self._build(core, rom)  # may raise FileNotFoundError
        with self._lock:
            self._terminate_locked()
            self._proc = subprocess.Popen(cmd)
            self._game = {"core": core, "rom": rom}
            self._crashed = False

    def stop(self):
        with self._lock:
            self._terminate_locked()
            self._game = None
            self._crashed = False

    def status(self):
        with self._lock:
            if self._proc is not None and self._proc.poll() is not None:
                # Process exited on its own since we last looked.
                self._crashed = self._proc.returncode != 0
                self._proc = None
                if not self._crashed:
                    self._game = None
            if self._proc is not None:
                return {"state": "running", "game": dict(self._game)}
            if self._crashed:
                return {"state": "crashed", "game": dict(self._game)}
            return {"state": "idle", "game": None}

    def _terminate_locked(self):
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
        self._proc = None


def make_server(session, token="", port=9090):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self):
            if not token:
                return True
            return self.headers.get("Authorization") == f"Bearer {token}"

        def do_GET(self):
            if self.path == "/healthz":
                return self._send(200, {"ok": True})
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            if self.path == "/status":
                return self._send(200, session.status())
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            if self.path != "/game":
                return self._send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                core, rom = body["core"], body["rom"]
            except (ValueError, KeyError, json.JSONDecodeError):
                return self._send(400, {"error": "expected JSON {core, rom}"})
            try:
                session.start(core, rom)
            except FileNotFoundError as e:
                return self._send(404, {"error": str(e)})
            return self._send(200, session.status())

        def do_DELETE(self):
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            if self.path != "/game":
                return self._send(404, {"error": "not found"})
            session.stop()
            return self._send(200, session.status())

        def log_message(self, fmt, *args):
            print("[supervisor]", fmt % args)

    return ThreadingHTTPServer(("0.0.0.0", port), Handler)


def main():
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    port = int(os.environ.get("SUPERVISOR_PORT", "9090"))
    server = make_server(GameSession(), token=token, port=port)
    print(f"[supervisor] listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
