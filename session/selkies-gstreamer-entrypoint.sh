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
    # selkies' web server (python websockets) rejects HTTP/1.0, which is
    # nginx's default proxy version — always speak 1.1 to it.
    location /health { proxy_http_version 1.1; proxy_buffering off; proxy_pass http://localhost:8081; }
    location /turn   { proxy_http_version 1.1; proxy_buffering off; proxy_pass http://localhost:8081; }
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
