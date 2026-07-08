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

# A stale socket from a crashed X server would satisfy the wait below.
rm -f "/tmp/.X11-unix/X${DISPLAY#*:}"

# Virtual X server with a large virtual screen; actual mode set below.
su psp -c "/usr/bin/Xvfb ${DISPLAY} -screen 0 8192x4096x24 \
  +extension COMPOSITE +extension DAMAGE +extension GLX +extension RANDR \
  +extension RENDER +extension MIT-SHM +extension XFIXES +extension XTEST \
  +iglx +render -nolisten tcp -ac -noreset -shmem" >/tmp/Xvfb.log 2>&1 &
XVFB_PID=$!

echo 'Waiting for X socket'
until [ -S "/tmp/.X11-unix/X${DISPLAY#*:}" ]; do sleep 0.5; done
echo 'X server is ready'

su psp -c "export DISPLAY=${DISPLAY}; selkies-gstreamer-resize 1920x1080"

# Exit when Xvfb dies so supervisord restarts this program (and X with it),
# instead of leaving dependents crash-looping against a dead display.
wait "${XVFB_PID}"
