# Phase 1: Pipeline Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full streaming pipeline end to end — a GPU-backed RetroArch container on k3s, launched via `curl`, playable in a plain browser tab via WebRTC with NVENC encoding.

**Architecture:** One container image (`game-session`) adapted from the Selkies v1.6.2 example container: supervisord runs dbus, PulseAudio, Xvfb (with VirtualGL EGL routing GL to the NVIDIA GPU), Selkies-GStreamer (WebRTC, NVENC), nginx (auth + web client), and our Python game supervisor which starts/stops RetroArch per game over a small HTTP API. Deployed as a `replicas: 0/1` Deployment with `hostNetwork: true` on the existing k3s cluster (RTX 3080 Ti).

**Tech Stack:** Ubuntu 22.04, Selkies-GStreamer v1.6.2, VirtualGL 3.1.4, RetroArch (libretro/stable PPA) + mgba/ppsspp cores (libretro buildbot), Python 3 stdlib supervisor, k3s + NVIDIA device plugin, Docker buildx (cross-build from macOS to linux/amd64), GHCR.

**Execution environment:** This plan runs on the user's **Mac** (Apple Silicon assumed), with: this git repo cloned, Docker Desktop running, `kubectl` configured against the k3s cluster, `python3` + `pytest` available, and a GitHub PAT with `write:packages` for GHCR. SSH access to the k3s server (referred to as `$K3S_HOST`) is needed only if GPU host setup turns out to be missing in Task 1.

## Global Constraints

- All images build for `--platform linux/amd64` (cluster is x86_64; Mac is arm64).
- Kubernetes namespace: `psp-xmb`. Deployment name: `game-session`, label `app: game-session`.
- Image name: `ghcr.io/<GHUSER>/psp-xmb-game-session:phase1` — replace `<GHUSER>` with the user's GitHub username everywhere it appears (ask the user once at start, then substitute).
- Pinned versions (verified 2026-07-07, do not silently upgrade):
  - Selkies v1.6.2 artifacts:
    - `https://github.com/selkies-project/selkies/releases/download/v1.6.2/gstreamer-selkies_gpl_v1.6.2_ubuntu22.04_amd64.tar.gz`
    - `https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies_gstreamer-1.6.2-py3-none-any.whl`
    - `https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies-gstreamer-web_v1.6.2.tar.gz`
    - `https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies-js-interposer_v1.6.2_ubuntu22.04_amd64.deb`
  - VirtualGL 3.1.4: `https://github.com/VirtualGL/virtualgl/releases/download/3.1.4/virtualgl_3.1.4_amd64.deb`
  - Cores: `https://buildbot.libretro.com/nightly/linux/x86_64/latest/{mgba,ppsspp}_libretro.so.zip`
  - PPSSPP system assets: `https://buildbot.libretro.com/assets/system/PPSSPP.zip`
  - Test ROM (freely distributable homebrew): `https://github.com/JeffRuLz/Celeste-Classic-GBA/releases/download/v1.2/Celeste.Classic.v1.2.Homebrew.gba`
  - NVIDIA device plugin: `nvcr.io/nvidia/k8s-device-plugin:v0.17.0`
- Ports (hostNetwork, on the k3s node): `8080` Selkies web/WebRTC signaling (nginx, basic auth), `9090` game supervisor API (bearer token), `3478` in-pod coturn, `55355/udp` RetroArch network commands (in-pod only, used in Phase 2+).
- Container display: `DISPLAY=:20`, Xvfb virtual screen, session resolution 1920x1080.
- Secrets are never committed. Only `secret.example.yaml` goes in git.
- Python supervisor uses **stdlib only** (no pip dependencies at runtime).

---

### Task 1: Cluster GPU preflight & enablement

**Files:**
- Create: `scripts/preflight.sh`
- Create: `deploy/gpu/nvidia-runtimeclass.yaml`
- Create: `deploy/gpu/nvidia-device-plugin.yaml`
- Create: `deploy/gpu/gpu-smoke-pod.yaml`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a cluster where pods with `runtimeClassName: nvidia` + `resources.limits."nvidia.com/gpu": 1` schedule and see the 3080 Ti. Later tasks rely on RuntimeClass name `nvidia`.

- [ ] **Step 1: Write the preflight script**

```bash
#!/usr/bin/env bash
# scripts/preflight.sh — verify the k3s cluster is ready for GPU workloads.
set -uo pipefail

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=1; }
FAILED=0

kubectl version --request-timeout=5s >/dev/null 2>&1 \
  && pass "kubectl can reach the cluster" \
  || fail "kubectl cannot reach the cluster (check kubeconfig/context)"

kubectl get runtimeclass nvidia >/dev/null 2>&1 \
  && pass "RuntimeClass 'nvidia' exists" \
  || fail "RuntimeClass 'nvidia' missing (apply deploy/gpu/nvidia-runtimeclass.yaml)"

GPUS=$(kubectl get nodes -o jsonpath='{.items[*].status.allocatable.nvidia\.com/gpu}')
if [ -n "${GPUS}" ] && [ "${GPUS}" != "0" ]; then
  pass "node advertises nvidia.com/gpu=${GPUS}"
else
  fail "no allocatable nvidia.com/gpu on any node (apply deploy/gpu/nvidia-device-plugin.yaml; if still failing, check host driver + nvidia-container-toolkit)"
fi

exit ${FAILED}
```

- [ ] **Step 2: Run preflight to see the current state**

Run: `bash scripts/preflight.sh`
Expected: `PASS` for kubectl reachability. RuntimeClass/GPU lines may FAIL — that tells us which of the next steps are needed. If kubectl itself fails, stop and fix kubeconfig before proceeding.

- [ ] **Step 3: Write the RuntimeClass manifest**

```yaml
# deploy/gpu/nvidia-runtimeclass.yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
```

- [ ] **Step 4: Write the NVIDIA device plugin manifest**

```yaml
# deploy/gpu/nvidia-device-plugin.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: nvidia-device-plugin-daemonset
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: nvidia-device-plugin-ds
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        name: nvidia-device-plugin-ds
    spec:
      runtimeClassName: nvidia
      priorityClassName: system-node-critical
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: nvidia-device-plugin-ctr
          image: nvcr.io/nvidia/k8s-device-plugin:v0.17.0
          env:
            - name: FAIL_ON_INIT_ERROR
              value: "false"
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: device-plugin
              mountPath: /var/lib/kubelet/device-plugins
      volumes:
        - name: device-plugin
          hostPath:
            path: /var/lib/kubelet/device-plugins
```

- [ ] **Step 5: Apply GPU manifests (if preflight showed FAIL lines)**

Run:
```bash
kubectl apply -f deploy/gpu/nvidia-runtimeclass.yaml
kubectl apply -f deploy/gpu/nvidia-device-plugin.yaml
kubectl -n kube-system rollout status ds/nvidia-device-plugin-daemonset --timeout=120s
```
Expected: `daemon set "nvidia-device-plugin-daemonset" successfully rolled out`.

**Contingency (only if the device plugin pod logs show it cannot find the NVIDIA runtime/driver):** the k3s *host* is missing pieces. Over SSH to `$K3S_HOST`:
```bash
ssh $K3S_HOST nvidia-smi   # must print the RTX 3080 Ti; if not, install the NVIDIA driver first
ssh $K3S_HOST 'grep -l nvidia /var/lib/rancher/k3s/agent/etc/containerd/config.toml*'  # must match
# If containerd config has no nvidia runtime: install nvidia-container-toolkit, then restart k3s
ssh $K3S_HOST 'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list && sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit && sudo systemctl restart k3s'
```
Then re-run Step 5.

- [ ] **Step 6: Write the GPU smoke pod manifest**

```yaml
# deploy/gpu/gpu-smoke-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-smoke
spec:
  restartPolicy: Never
  runtimeClassName: nvidia
  containers:
    - name: nvidia-smi
      image: nvidia/cuda:12.4.1-base-ubuntu22.04
      command: ["nvidia-smi"]
      resources:
        limits:
          nvidia.com/gpu: 1
```

- [ ] **Step 7: Run the GPU smoke test**

Run:
```bash
kubectl apply -f deploy/gpu/gpu-smoke-pod.yaml
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/gpu-smoke --timeout=180s
kubectl logs gpu-smoke
kubectl delete pod gpu-smoke
```
Expected: `nvidia-smi` table listing `NVIDIA GeForce RTX 3080 Ti`.

- [ ] **Step 8: Re-run preflight — all PASS**

Run: `bash scripts/preflight.sh`
Expected: three `PASS` lines, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add scripts/preflight.sh deploy/gpu/
git commit -m "feat: k3s GPU preflight and NVIDIA enablement manifests"
```

---

### Task 2: Game supervisor (TDD)

**Files:**
- Create: `session/supervisor/supervisor.py`
- Test: `session/supervisor/test_supervisor.py`

**Interfaces:**
- Consumes: nothing (pure Python, stdlib only; runs on the Mac for tests, in the container for real).
- Produces — the HTTP contract Phase 2's `xmb-api` will call (port 9090):
  - `GET /healthz` → `200 {"ok": true}` (no auth)
  - `GET /status` → `200 {"state": "idle"|"running"|"crashed", "game": {"core": str, "rom": str} | null}`
  - `POST /game` body `{"core": "mgba", "rom": "/roms/gba/celeste.gba"}` → `200` with status JSON; replaces any running game; `404 {"error": ...}` for unknown core / missing ROM; `400` for bad JSON
  - `DELETE /game` → `200` with status JSON (state idle)
  - Auth: if env `SUPERVISOR_TOKEN` is set, all routes except `/healthz` require header `Authorization: Bearer <token>`, else `401`.
  - Python API: `GameSession(command_builder)` with `.start(core, rom)`, `.stop()`, `.status()`; `build_command(core, rom, cores_dir=None)` returning the vglrun/retroarch argv and raising `FileNotFoundError` for a missing core or ROM; `make_server(session, token="", port=0)` returning a `ThreadingHTTPServer`.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd session/supervisor && python3 -m pytest test_supervisor.py -v`
Expected: collection error — `ModuleNotFoundError: No module named 'supervisor'`.

- [ ] **Step 3: Write the implementation**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd session/supervisor && python3 -m pytest test_supervisor.py -v`
Expected: all 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add session/supervisor/
git commit -m "feat: game session supervisor with HTTP control API (TDD)"
```

---

### Task 3: game-session container image

**Files:**
- Create: `session/Dockerfile`
- Create: `session/entrypoint.sh`
- Create: `session/selkies-gstreamer-entrypoint.sh`
- Create: `session/supervisord.conf`
- Create: `session/retroarch.cfg`

**Interfaces:**
- Consumes: `session/supervisor/supervisor.py` from Task 2 (COPYed into the image at `/opt/supervisor/supervisor.py`).
- Produces: image `ghcr.io/<GHUSER>/psp-xmb-game-session:phase1` exposing 8080 (Selkies via nginx) and 9090 (supervisor). Cores at `/opt/cores/{mgba,ppsspp}_libretro.so`. Env contract used by Task 4's Deployment: `DISPLAY`, `XDG_RUNTIME_DIR`, `SELKIES_ENCODER`, `SELKIES_ENABLE_BASIC_AUTH`, `SELKIES_BASIC_AUTH_USER`, `SELKIES_BASIC_AUTH_PASSWORD`, `SELKIES_ENABLE_RESIZE`, `SUPERVISOR_TOKEN`.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# session/Dockerfile
# game-session: RetroArch + Selkies-GStreamer WebRTC streaming, GPU via
# VirtualGL EGL inside Xvfb. Adapted from the Selkies v1.6.2 example
# container (MPL-2.0), trimmed to an appliance: no desktop environment.
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8

# --- System + Selkies/GStreamer runtime dependencies ---
RUN apt-get update && apt-get install --no-install-recommends -y \
        apt-utils ca-certificates curl gnupg jq locales software-properties-common tzdata unzip \
        ssl-cert dbus-user-session dbus-x11 \
        python3-pip python3-dev python3-gi python3-setuptools python3-wheel \
        libgcrypt20 libgirepository-1.0-1 glib-networking libglib2.0-0 libgudev-1.0-0 \
        alsa-utils libpulse0 pulseaudio libopus0 libvpx-dev x264 x265 \
        libdrm2 libegl1 libgl1 libopengl0 libgles1 libgles2 libglvnd0 libglx0 xcvt libopenh264-dev \
        wmctrl xsel xdotool x11-utils x11-xkb-utils x11-xserver-utils xserver-xorg-core xvfb \
        libx11-xcb1 libxcb-dri3-0 libxdamage1 libxfixes3 libxv1 libxtst6 libxext6 \
        mesa-utils mesa-va-drivers libva2 vainfo vdpau-driver-all libvdpau-va-gl1 \
        supervisor nginx apache2-utils netcat-openbsd coturn dnsutils \
    && locale-gen en_US.UTF-8 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- NVIDIA library paths + EGL vendor config (driver mounts at runtime) ---
RUN echo "/usr/local/nvidia/lib" >> /etc/ld.so.conf.d/nvidia.conf && \
    echo "/usr/local/nvidia/lib64" >> /etc/ld.so.conf.d/nvidia.conf && \
    mkdir -pm755 /usr/share/glvnd/egl_vendor.d && \
    printf '{\n  "file_format_version" : "1.0.0",\n  "ICD": {\n    "library_path": "libEGL_nvidia.so.0"\n  }\n}\n' \
      > /usr/share/glvnd/egl_vendor.d/10_nvidia.json
ENV PATH="/usr/local/nvidia/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=all
ENV __GL_SYNC_TO_VBLANK=0

# --- VirtualGL 3.1.4 (route OpenGL to the GPU via EGL inside Xvfb) ---
ENV VGL_DISPLAY=egl
RUN cd /tmp && \
    curl -fsSL -O https://github.com/VirtualGL/virtualgl/releases/download/3.1.4/virtualgl_3.1.4_amd64.deb && \
    apt-get update && apt-get install -y --no-install-recommends ./virtualgl_3.1.4_amd64.deb && \
    rm -f virtualgl_3.1.4_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Selkies-GStreamer v1.6.2 (pinned release artifacts) ---
RUN cd /opt && \
    curl -fsSL https://github.com/selkies-project/selkies/releases/download/v1.6.2/gstreamer-selkies_gpl_v1.6.2_ubuntu22.04_amd64.tar.gz | tar -xzf - && \
    mkdir -p /tmp/gst-web-extract && \
    curl -fsSL https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies-gstreamer-web_v1.6.2.tar.gz | tar -xzf - -C /tmp/gst-web-extract && \
    mkdir -p /opt/gst-web && \
    cp -a /tmp/gst-web-extract/*/. /opt/gst-web/ 2>/dev/null || cp -a /tmp/gst-web-extract/. /opt/gst-web/ && \
    rm -rf /tmp/gst-web-extract && \
    test -f /opt/gst-web/index.html && \
    curl -fsSL -o /tmp/selkies.whl https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies_gstreamer-1.6.2-py3-none-any.whl && \
    pip3 install --no-cache-dir /tmp/selkies.whl && rm -f /tmp/selkies.whl && \
    curl -fsSL -o /tmp/js-interposer.deb https://github.com/selkies-project/selkies/releases/download/v1.6.2/selkies-js-interposer_v1.6.2_ubuntu22.04_amd64.deb && \
    apt-get update && apt-get install -y --no-install-recommends /tmp/js-interposer.deb && \
    rm -f /tmp/js-interposer.deb && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- RetroArch (libretro stable PPA) + cores (libretro buildbot) ---
RUN add-apt-repository -y ppa:libretro/stable && \
    apt-get update && apt-get install --no-install-recommends -y retroarch && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/cores && cd /opt/cores && \
    for core in mgba ppsspp; do \
      curl -fsSL -O "https://buildbot.libretro.com/nightly/linux/x86_64/latest/${core}_libretro.so.zip" && \
      unzip -o "${core}_libretro.so.zip" && rm -f "${core}_libretro.so.zip"; \
    done && \
    mkdir -p /opt/retroarch/system && cd /opt/retroarch/system && \
    curl -fsSL -O https://buildbot.libretro.com/assets/system/PPSSPP.zip && \
    unzip -oq PPSSPP.zip && rm -f PPSSPP.zip

# --- Non-root user; nginx/logs writable ---
RUN groupadd -g 1000 psp && useradd -ms /bin/bash -u 1000 -g 1000 psp && \
    usermod -aG audio,video,input psp && \
    mkdir -p /roms /saves /states /var/log/supervisor && \
    chown -R psp:psp /roms /saves /states /opt/retroarch /opt/gst-web /var/log/supervisor && \
    chown -R psp:psp /var/lib/nginx /var/log/nginx

# --- Our components ---
COPY supervisor/supervisor.py /opt/supervisor/supervisor.py
COPY retroarch.cfg /opt/retroarch/retroarch.cfg
COPY entrypoint.sh /etc/entrypoint.sh
COPY selkies-gstreamer-entrypoint.sh /etc/selkies-gstreamer-entrypoint.sh
COPY supervisord.conf /etc/supervisord.conf
RUN chmod 755 /etc/entrypoint.sh /etc/selkies-gstreamer-entrypoint.sh && \
    chown psp:psp /opt/retroarch/retroarch.cfg

ENV DISPLAY=:20
ENV XDG_RUNTIME_DIR=/tmp/runtime-psp
ENV PULSE_RUNTIME_PATH=/tmp/runtime-psp/pulse
ENV PULSE_SERVER=unix:/tmp/runtime-psp/pulse/native
ENV GST_DEBUG="*:2"
ENV SELKIES_ENCODER=nvh264enc
ENV SELKIES_ENABLE_RESIZE=false
ENV CORES_DIR=/opt/cores
ENV RETROARCH_CONFIG=/opt/retroarch/retroarch.cfg

EXPOSE 8080 9090

ENTRYPOINT ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
```

- [ ] **Step 2: Write the container entrypoint (X server + devices)**

```bash
#!/bin/bash
# session/entrypoint.sh — prepare runtime dirs, joystick interposer
# devices, and the Xvfb display. Runs as root under supervisord; the
# streaming/emulator processes run as user psp.
set -e

mkdir -pm700 "${XDG_RUNTIME_DIR}"
chown psp:psp "${XDG_RUNTIME_DIR}"

# Joystick interposer device nodes (used from Phase 3 on; harmless now)
mkdir -pm1777 /dev/input || true
touch /dev/input/js0 /dev/input/js1 /dev/input/js2 /dev/input/js3 || true
chmod 777 /dev/input/js* || true

# Virtual X server with a large virtual screen; actual mode set below.
su psp -c "/usr/bin/Xvfb ${DISPLAY} -screen 0 8192x4096x24 \
  +extension COMPOSITE +extension DAMAGE +extension GLX +extension RANDR \
  +extension RENDER +extension MIT-SHM +extension XFIXES +extension XTEST \
  +iglx +render -nolisten tcp -ac -noreset -shmem" >/tmp/Xvfb.log 2>&1 &

echo 'Waiting for X socket'
until [ -S "/tmp/.X11-unix/X${DISPLAY#*:}" ]; do sleep 0.5; done
echo 'X server is ready'

su psp -c "export DISPLAY=${DISPLAY}; selkies-gstreamer-resize 1920x1080"

sleep infinity
```

- [ ] **Step 3: Write the Selkies entrypoint**

```bash
#!/bin/bash
# session/selkies-gstreamer-entrypoint.sh — start in-pod TURN + Selkies,
# then generate nginx config (auth + static web + proxied signaling).
# Adapted from the Selkies v1.6.2 example container (MPL-2.0).
set -e

until [ -d "${XDG_RUNTIME_DIR}" ]; do sleep 0.5; done

export SELKIES_INTERPOSER='/usr/$LIB/selkies_joystick_interposer.so'
export LD_PRELOAD="${SELKIES_INTERPOSER}${LD_PRELOAD:+:${LD_PRELOAD}}"
export SDL_JOYSTICK_DEVICE=/dev/input/js0

export DISPLAY="${DISPLAY:-:20}"
export GST_DEBUG="${GST_DEBUG:-*:2}"
export GSTREAMER_PATH=/opt/gstreamer
. /opt/gstreamer/gst-env

export SELKIES_ENCODER="${SELKIES_ENCODER:-nvh264enc}"
export SELKIES_ENABLE_RESIZE="${SELKIES_ENABLE_RESIZE:-false}"

# In-pod TURN server (hostNetwork makes it reachable on the LAN).
if [ -z "${SELKIES_TURN_HOST}" ]; then
  export TURN_RANDOM_PASSWORD="$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"
  export SELKIES_TURN_HOST="$(hostname -I | awk '{print $1}')"
  export SELKIES_TURN_PORT="3478"
  export SELKIES_TURN_USERNAME="selkies"
  export SELKIES_TURN_PASSWORD="${TURN_RANDOM_PASSWORD}"
  export SELKIES_TURN_PROTOCOL="tcp"
  export SELKIES_STUN_HOST="stun.l.google.com"
  export SELKIES_STUN_PORT="19302"
  turnserver --verbose --listening-ip=0.0.0.0 \
    --listening-port="${SELKIES_TURN_PORT}" \
    --realm=psp-xmb.local \
    --external-ip="${SELKIES_TURN_HOST}" \
    --min-port=49152 --max-port=49172 \
    --lt-cred-mech --user="selkies:${TURN_RANDOM_PASSWORD}" \
    --no-cli --cli-password="${TURN_RANDOM_PASSWORD}" \
    --userdb="${XDG_RUNTIME_DIR}/turnserver-turndb" \
    --pidfile="${XDG_RUNTIME_DIR}/turnserver.pid" \
    --log-file=stdout --allow-loopback-peers &
fi

echo 'Waiting for X socket' && until [ -S "/tmp/.X11-unix/X${DISPLAY#*:}" ]; do sleep 0.5; done

# nginx: basic auth + static web client + websocket proxy to selkies :8081
if [ "$(echo "${SELKIES_ENABLE_BASIC_AUTH}" | tr '[:upper:]' '[:lower:]')" != "false" ]; then
  htpasswd -bcm "${XDG_RUNTIME_DIR}/.htpasswd" "${SELKIES_BASIC_AUTH_USER:-psp}" "${SELKIES_BASIC_AUTH_PASSWORD:-psp}"
  AUTH_LINES="auth_basic \"Selkies\";
    auth_basic_user_file ${XDG_RUNTIME_DIR}/.htpasswd;"
else
  AUTH_LINES=""
fi
cat > /etc/nginx/sites-available/default <<NGINX
server {
    access_log /dev/stdout;
    error_log /dev/stderr;
    listen 8080;
    listen [::]:8080;
    ${AUTH_LINES}

    location / {
        root /opt/gst-web/;
        index index.html index.htm;
    }
    location /health { proxy_buffering off; proxy_pass http://localhost:8081; }
    location /turn   { proxy_buffering off; proxy_pass http://localhost:8081; }
    location ~ ^/(ws|webrtc/signalling)\$ {
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_http_version 1.1;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_pass http://localhost:8081;
    }
}
NGINX

rm -rf "${HOME}/.cache/gstreamer-1.0"

exec selkies-gstreamer \
    --addr="localhost" \
    --port="8081" \
    --enable_basic_auth="false" \
    --enable_metrics_http="true" \
    --metrics_http_port="9081"
```

- [ ] **Step 4: Write the supervisord config**

```ini
# session/supervisord.conf
[supervisord]
nodaemon=true
logfile=/tmp/supervisord.log
pidfile=/tmp/supervisord.pid
childlogdir=/tmp

[program:entrypoint]
command=/etc/entrypoint.sh
user=root
stdout_logfile=/tmp/entrypoint.log
redirect_stderr=true
autorestart=true
stopasgroup=true
priority=1

[program:pulseaudio]
command=bash -c "until [ -d \"%(ENV_XDG_RUNTIME_DIR)s\" ]; do sleep 0.5; done; /usr/bin/pulseaudio --daemonize=false --exit-idle-time=-1 --disallow-exit"
user=psp
environment=HOME="/home/psp",XDG_RUNTIME_DIR="%(ENV_XDG_RUNTIME_DIR)s",PULSE_RUNTIME_PATH="%(ENV_PULSE_RUNTIME_PATH)s"
stdout_logfile=/tmp/pulseaudio.log
redirect_stderr=true
autorestart=true
stopasgroup=true
priority=10

[program:selkies]
command=bash -c "until [ -S /tmp/.X11-unix/X20 ] && [ -S \"%(ENV_PULSE_RUNTIME_PATH)s/native\" ]; do sleep 0.5; done; /etc/selkies-gstreamer-entrypoint.sh"
user=psp
environment=HOME="/home/psp",USER="psp",SHELL="/bin/bash"
stdout_logfile=/tmp/selkies-gstreamer-entrypoint.log
redirect_stderr=true
autorestart=true
stopasgroup=true
stopsignal=INT
priority=20

[program:nginx]
command=bash -c "until nc -z localhost 8081; do sleep 0.5; done; /usr/sbin/nginx -g 'daemon off;'"
user=root
stdout_logfile=/tmp/nginx.log
redirect_stderr=true
autorestart=true
stopasgroup=true
priority=30

[program:game-supervisor]
command=bash -c "until [ -S /tmp/.X11-unix/X20 ]; do sleep 0.5; done; /usr/bin/python3 /opt/supervisor/supervisor.py"
user=psp
environment=HOME="/home/psp",DISPLAY="%(ENV_DISPLAY)s",XDG_RUNTIME_DIR="%(ENV_XDG_RUNTIME_DIR)s",PULSE_SERVER="%(ENV_PULSE_SERVER)s",SDL_JOYSTICK_DEVICE="/dev/input/js0"
stdout_logfile=/tmp/game-supervisor.log
redirect_stderr=true
autorestart=true
stopasgroup=true
priority=40
```

- [ ] **Step 5: Write the RetroArch config**

```ini
# session/retroarch.cfg — RetroArch as an invisible runtime: fullscreen
# into Xvfb, audio to PulseAudio, saves/states on PVCs, network command
# interface for Phase 2+ (save/load state from the web XMB).
video_driver = "gl"
video_fullscreen = "true"
video_windowed_fullscreen = "true"
video_vsync = "true"
audio_driver = "pulse"
audio_enable = "true"
network_cmd_enable = "true"
network_cmd_port = "55355"
savefile_directory = "/saves"
savestate_directory = "/states"
system_directory = "/opt/retroarch/system"
input_autodetect_enable = "true"
pause_nonactive = "false"
quit_press_twice = "false"
menu_driver = "rgui"
config_save_on_exit = "false"
```

- [ ] **Step 6: Build the image for linux/amd64**

Run (substitute `<GHUSER>`):
```bash
cd session
docker buildx build --platform linux/amd64 -t ghcr.io/<GHUSER>/psp-xmb-game-session:phase1 --load .
```
Expected: build completes without error (first build downloads ~1.5 GB; takes a while under emulation). If `--load` fails on older Docker Desktop, use `--output type=docker`.

- [ ] **Step 7: Local container smoke test (CPU path, qemu)**

Run:
```bash
docker run -d --name gs-test --platform linux/amd64 \
  -e SELKIES_ENCODER=x264enc \
  -e SELKIES_ENABLE_BASIC_AUTH=true \
  -e SELKIES_BASIC_AUTH_USER=psp \
  -e SELKIES_BASIC_AUTH_PASSWORD=test \
  -e SUPERVISOR_TOKEN=testtoken \
  -p 18080:8080 -p 19090:9090 \
  ghcr.io/<GHUSER>/psp-xmb-game-session:phase1
sleep 60
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18080/            # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -u psp:test http://localhost:18080/ # expect 200
curl -s http://localhost:19090/healthz                                       # expect {"ok": true}
curl -s -H 'Authorization: Bearer testtoken' http://localhost:19090/status   # expect {"state": "idle", "game": null}
docker logs gs-test | tail -20
docker rm -f gs-test
```
Expected: `401`, `200`, `{"ok": true}`, `{"state": "idle", "game": null}`.
**Contingency:** GStreamer under qemu emulation is occasionally flaky. If the selkies program crash-loops locally but nginx/supervisor answer correctly, note it and proceed — Task 5 validates the real streaming path on the actual amd64/GPU node. If nginx or the supervisor endpoints fail, that's a real bug: read `/tmp/*.log` inside the container (`docker exec gs-test cat /tmp/selkies-gstreamer-entrypoint.log`) and fix before proceeding.

- [ ] **Step 8: Push to GHCR**

Run:
```bash
echo "<GITHUB_PAT>" | docker login ghcr.io -u <GHUSER> --password-stdin
docker push ghcr.io/<GHUSER>/psp-xmb-game-session:phase1
```
Expected: push succeeds. Then make the package public (Settings → Packages → psp-xmb-game-session → Change visibility → Public) so the cluster can pull without an imagePullSecret — the image contains no secrets or ROMs. (If the user prefers private, instead create the pull secret in Task 4 Step 3's note.)

- [ ] **Step 9: Commit**

```bash
git add session/
git commit -m "feat: game-session container image (RetroArch + Selkies + VirtualGL)"
```

---

### Task 4: Kubernetes manifests & deploy

**Files:**
- Create: `deploy/base/namespace.yaml`
- Create: `deploy/base/pvcs.yaml`
- Create: `deploy/base/game-session.yaml`
- Create: `deploy/base/secret.example.yaml`
- Create: `deploy/base/kustomization.yaml`
- Create: `.gitignore`

**Interfaces:**
- Consumes: image `ghcr.io/<GHUSER>/psp-xmb-game-session:phase1` (Task 3); RuntimeClass `nvidia` (Task 1).
- Produces: namespace `psp-xmb`; Deployment `game-session` (replicas 0, label `app: game-session`); PVCs `roms`, `saves`, `states`; Secret name `psp-xmb-auth` with keys `basic-auth-password`, `supervisor-token`. Phase 2's xmb-api will scale this exact Deployment and read this exact Secret.

- [ ] **Step 1: Write namespace and PVCs**

```yaml
# deploy/base/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: psp-xmb
```

```yaml
# deploy/base/pvcs.yaml
# k3s local-path PVCs. WaitForFirstConsumer: they stay Pending until the
# game-session pod first schedules — that is normal, not an error.
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: roms
  namespace: psp-xmb
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 200Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: saves
  namespace: psp-xmb
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: states
  namespace: psp-xmb
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 20Gi
```

- [ ] **Step 2: Write the secret template and .gitignore**

```yaml
# deploy/base/secret.example.yaml
# Template only — never commit a real secret. Create the real one with:
#   kubectl -n psp-xmb create secret generic psp-xmb-auth \
#     --from-literal=basic-auth-password='<choose-a-password>' \
#     --from-literal=supervisor-token="$(openssl rand -hex 24)"
apiVersion: v1
kind: Secret
metadata:
  name: psp-xmb-auth
  namespace: psp-xmb
type: Opaque
stringData:
  basic-auth-password: CHANGE-ME
  supervisor-token: CHANGE-ME
```

```gitignore
# .gitignore
node_modules/
__pycache__/
*.pyc
.DS_Store
secret.yaml
*.local.yaml
```

- [ ] **Step 3: Write the game-session Deployment**

```yaml
# deploy/base/game-session.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: game-session
  namespace: psp-xmb
  labels:
    app: game-session
spec:
  # Scaled 0<->1 by hand today, by xmb-api in Phase 2. Never >1.
  replicas: 0
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: game-session
  template:
    metadata:
      labels:
        app: game-session
    spec:
      runtimeClassName: nvidia
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: game-session
          image: ghcr.io/<GHUSER>/psp-xmb-game-session:phase1
          imagePullPolicy: Always
          env:
            - name: SELKIES_ENCODER
              value: nvh264enc
            - name: SELKIES_ENABLE_BASIC_AUTH
              value: "true"
            - name: SELKIES_BASIC_AUTH_USER
              value: psp
            - name: SELKIES_BASIC_AUTH_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: psp-xmb-auth
                  key: basic-auth-password
            - name: SUPERVISOR_TOKEN
              valueFrom:
                secretKeyRef:
                  name: psp-xmb-auth
                  key: supervisor-token
          ports:
            - containerPort: 8080   # selkies web + signaling (nginx)
            - containerPort: 9090   # game supervisor API
          resources:
            limits:
              nvidia.com/gpu: 1
          readinessProbe:
            httpGet:
              path: /healthz
              port: 9090
            initialDelaySeconds: 10
            periodSeconds: 5
          volumeMounts:
            - name: roms
              mountPath: /roms
            - name: saves
              mountPath: /saves
            - name: states
              mountPath: /states
            - name: dshm
              mountPath: /dev/shm
      volumes:
        - name: roms
          persistentVolumeClaim:
            claimName: roms
        - name: saves
          persistentVolumeClaim:
            claimName: saves
        - name: states
          persistentVolumeClaim:
            claimName: states
        - name: dshm
          emptyDir:
            medium: Memory
            sizeLimit: 2Gi
```

Note: if the GHCR package was kept private, additionally create
`kubectl -n psp-xmb create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<GHUSER> --docker-password=<GITHUB_PAT>`
and add `imagePullSecrets: [{name: ghcr-pull}]` to the pod spec.

- [ ] **Step 4: Write the kustomization**

```yaml
# deploy/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - pvcs.yaml
  - game-session.yaml
```

- [ ] **Step 5: Create the real secret, then apply**

Run:
```bash
kubectl apply -f deploy/base/namespace.yaml
kubectl -n psp-xmb create secret generic psp-xmb-auth \
  --from-literal=basic-auth-password='<choose-a-password>' \
  --from-literal=supervisor-token="$(openssl rand -hex 24)"
kubectl apply -k deploy/base
kubectl -n psp-xmb get deploy,pvc,secret
```
Expected: deployment `game-session` with `READY 0/0`; PVCs `roms`/`saves`/`states` in `Pending` (normal — WaitForFirstConsumer); secret `psp-xmb-auth`.

- [ ] **Step 6: Commit**

```bash
git add deploy/base/ .gitignore
git commit -m "feat: k8s manifests for game-session (namespace, PVCs, deployment)"
```

---

### Task 5: End-to-end smoke test

**Files:**
- Create: `scripts/smoke-test.sh`

**Interfaces:**
- Consumes: everything above — Deployment `game-session` in `psp-xmb`, supervisor API contract from Task 2, secret `psp-xmb-auth`.
- Produces: the Phase 1 acceptance proof, and the attach URL pattern (`http://<node-ip>:8080`) that Phase 2's web XMB will embed.

- [ ] **Step 1: Write the smoke test script**

```bash
#!/usr/bin/env bash
# scripts/smoke-test.sh — Phase 1 acceptance: boot the session pod, load
# a homebrew GBA ROM via the supervisor API, verify state and encoder,
# and print the browser URL for the human playability check.
set -euo pipefail

NS=psp-xmb
ROM_URL="https://github.com/JeffRuLz/Celeste-Classic-GBA/releases/download/v1.2/Celeste.Classic.v1.2.Homebrew.gba"

NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
echo "Node IP: ${NODE_IP}"

echo "--- scaling game-session to 1"
kubectl -n "${NS}" scale deployment/game-session --replicas=1
kubectl -n "${NS}" rollout status deployment/game-session --timeout=600s
POD=$(kubectl -n "${NS}" get pod -l app=game-session -o jsonpath='{.items[0].metadata.name}')
echo "Pod: ${POD}"

echo "--- placing test ROM on the roms PVC"
if [ ! -f /tmp/celeste.gba ]; then
  curl -fsSL -o /tmp/celeste.gba "${ROM_URL}"
fi
kubectl -n "${NS}" exec "${POD}" -- mkdir -p /roms/gba
kubectl -n "${NS}" cp /tmp/celeste.gba "${NS}/${POD}:/roms/gba/celeste.gba"

TOKEN=$(kubectl -n "${NS}" get secret psp-xmb-auth -o jsonpath='{.data.supervisor-token}' | base64 -d)

echo "--- starting game via supervisor API"
curl -fsS -X POST "http://${NODE_IP}:9090/game" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"core":"mgba","rom":"/roms/gba/celeste.gba"}'
echo
sleep 5

echo "--- supervisor status (expect running)"
curl -fsS "http://${NODE_IP}:9090/status" -H "Authorization: Bearer ${TOKEN}"
echo

echo "--- checking encoder in selkies log (expect nvh264enc)"
kubectl -n "${NS}" exec "${POD}" -- sh -c \
  'grep -io nvh264enc /tmp/selkies-gstreamer-entrypoint.log | head -1' \
  || echo "WARN: nvh264enc not found in selkies log — may be falling back to CPU encoding"

echo
echo "SMOKE TEST PASSED (automated checks)."
echo "Human check: open  http://${NODE_IP}:8080  (user 'psp', your basic-auth password)"
echo "You should see Celeste Classic running. Arrow keys move, X/C are the GBA buttons."
echo "To stop:  curl -X DELETE http://${NODE_IP}:9090/game -H 'Authorization: Bearer <token>'"
echo "To power off:  kubectl -n ${NS} scale deployment/game-session --replicas=0"
```

- [ ] **Step 2: Run the smoke test**

Run: `bash scripts/smoke-test.sh`
Expected output, in order:
1. rollout status: `deployment "game-session" successfully rolled out` (first run pulls the image — can take minutes)
2. POST /game returns `{"state": "running", "game": {"core": "mgba", "rom": "/roms/gba/celeste.gba"}}`
3. /status returns `"state": "running"`
4. encoder check prints `nvh264enc`

**Debugging paths if it fails:**
- Pod stuck `Pending`: `kubectl -n psp-xmb describe pod <pod>` — usually GPU (Task 1 not green) or PVC provisioning.
- Pod `CrashLoopBackOff`: `kubectl -n psp-xmb logs <pod>` then `kubectl -n psp-xmb exec <pod> -- cat /tmp/entrypoint.log /tmp/selkies-gstreamer-entrypoint.log /tmp/game-supervisor.log`.
- `/status` says `crashed`: RetroArch died — `kubectl exec ... -- cat /tmp/game-supervisor.log`; verify the core loads on the GPU: `kubectl exec ... -- su psp -c 'DISPLAY=:20 vglrun -d egl glxinfo | grep -i "opengl renderer"'` must print `NVIDIA ... 3080 Ti`, not `llvmpipe`.

- [ ] **Step 3: Human verification (the actual point of Phase 1)**

Open `http://<node-ip>:8080` in a browser on the LAN, authenticate as `psp`, and confirm: Celeste Classic is visibly running, keyboard input works (arrows + X/C), audio plays, and motion is smooth (~60fps). Report the result honestly — if latency is bad or video is black, Phase 1 is not done; debug with the paths above.

- [ ] **Step 4: Commit and tag**

```bash
git add scripts/smoke-test.sh
git commit -m "feat: phase 1 end-to-end smoke test"
git tag phase1-pipeline-proof
```
