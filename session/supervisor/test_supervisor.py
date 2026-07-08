# session/supervisor/test_supervisor.py
import json
import os
import time
import urllib.error
import urllib.request

import pytest

from supervisor import GameSession, build_command, make_server


# ---------- build_command ----------

def test_build_command_maps_core_and_rom(tmp_path):
    core = tmp_path / "mgba_libretro.so"
    core.write_bytes(b"")
    rom = tmp_path / "game.gba"
    rom.write_bytes(b"")
    cmd = build_command("mgba", str(rom), cores_dir=str(tmp_path))
    assert cmd[:3] == ["vglrun", "-d", "egl"]
    assert "retroarch" in cmd
    assert str(core) in cmd
    assert str(rom) in cmd


def test_build_command_missing_core_raises(tmp_path):
    rom = tmp_path / "game.gba"
    rom.write_bytes(b"")
    with pytest.raises(FileNotFoundError):
        build_command("nonexistent", str(rom), cores_dir=str(tmp_path))


def test_build_command_missing_rom_raises(tmp_path):
    core = tmp_path / "mgba_libretro.so"
    core.write_bytes(b"")
    with pytest.raises(FileNotFoundError):
        build_command("mgba", str(tmp_path / "missing.gba"), cores_dir=str(tmp_path))


# ---------- GameSession ----------

def sleeper(core, rom):
    return ["sleep", "30"]


def crasher(core, rom):
    return ["sh", "-c", "exit 7"]


def clean_exit(core, rom):
    return ["true"]


def wait_for_state(session, state, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if session.status()["state"] == state:
            return session.status()
        time.sleep(0.05)
    raise AssertionError(
        f"never reached {state}, stuck at {session.status()['state']}")


def test_start_sets_running():
    s = GameSession(command_builder=sleeper)
    s.start("mgba", "/tmp/x.gba")
    st = s.status()
    assert st["state"] == "running"
    assert st["game"] == {"core": "mgba", "rom": "/tmp/x.gba"}
    s.stop()


def test_stop_returns_idle():
    s = GameSession(command_builder=sleeper)
    s.start("mgba", "/tmp/x.gba")
    s.stop()
    assert s.status() == {"state": "idle", "game": None}


def test_crash_detected():
    s = GameSession(command_builder=crasher)
    s.start("mgba", "/tmp/x.gba")
    st = wait_for_state(s, "crashed")
    assert st["game"] == {"core": "mgba", "rom": "/tmp/x.gba"}


def test_clean_exit_returns_idle():
    s = GameSession(command_builder=clean_exit)
    s.start("mgba", "/tmp/x.gba")
    wait_for_state(s, "idle")


def test_replace_terminates_old_process(tmp_path):
    pidfile = tmp_path / "pid"

    def pid_writer(core, rom):
        return ["sh", "-c", f"echo $$ > {pidfile}; exec sleep 30"]

    s = GameSession(command_builder=pid_writer)
    s.start("mgba", "/tmp/a.gba")
    deadline = time.time() + 5
    while not pidfile.exists() and time.time() < deadline:
        time.sleep(0.05)
    first_pid = int(pidfile.read_text().strip())

    s.start("mgba", "/tmp/b.gba")
    # first process must be gone
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            os.kill(first_pid, 0)
            time.sleep(0.05)
        except OSError:
            break
    else:
        raise AssertionError("old process still alive after replace")
    assert s.status()["game"]["rom"] == "/tmp/b.gba"
    s.stop()


# ---------- HTTP server ----------

@pytest.fixture
def server():
    session = GameSession(command_builder=sleeper)
    srv = make_server(session, token="sekrit", port=0)
    import threading
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    session.stop()
    srv.shutdown()


def call(srv, method, path, body=None, token="sekrit"):
    url = f"http://127.0.0.1:{srv.server_address[1]}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_healthz_needs_no_token(server):
    status, body = call(server, "GET", "/healthz", token=None)
    assert status == 200
    assert body == {"ok": True}


def test_status_requires_token(server):
    status, _ = call(server, "GET", "/status", token=None)
    assert status == 401


def test_wrong_token_rejected(server):
    status, _ = call(server, "GET", "/status", token="wrong")
    assert status == 401


def test_game_lifecycle_over_http(server):
    status, body = call(server, "GET", "/status")
    assert (status, body["state"]) == (200, "idle")

    status, body = call(server, "POST", "/game",
                        {"core": "mgba", "rom": "/tmp/x.gba"})
    assert (status, body["state"]) == (200, "running")

    status, body = call(server, "DELETE", "/game")
    assert (status, body["state"]) == (200, "idle")


def test_post_game_bad_json_400(server):
    url = f"http://127.0.0.1:{server.server_address[1]}/game"
    req = urllib.request.Request(url, data=b"not json", method="POST")
    req.add_header("Authorization", "Bearer sekrit")
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=5)
    assert exc.value.code == 400


def test_post_game_non_object_json_400(server):
    status, body = call(server, "POST", "/game", [1, 2])
    assert status == 400
    assert "error" in body


def test_post_game_launch_failure_500():
    def bad_binary(core, rom):
        return ["definitely-not-a-real-binary-xyz"]

    session = GameSession(command_builder=bad_binary)
    srv = make_server(session, token="", port=0)
    import threading
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    status, body = call(srv, "POST", "/game",
                        {"core": "mgba", "rom": "/tmp/x.gba"}, token=None)
    assert status == 500
    assert "error" in body
    # a failed launch must not leave status claiming "running"
    status, body = call(srv, "GET", "/status", token=None)
    assert status == 200
    assert body["state"] != "running"
    srv.shutdown()


def test_post_game_missing_core_404():
    session = GameSession()  # real build_command -> validates paths
    srv = make_server(session, token="", port=0)
    import threading
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    status, body = call(srv, "POST", "/game",
                        {"core": "definitely_missing", "rom": "/tmp/nope.gba"},
                        token=None)
    assert status == 404
    assert "error" in body
    srv.shutdown()
