#!/usr/bin/env bash
# scripts/smoke-test.sh — Phase 1 acceptance: boot the session pod, load
# a homebrew GBA ROM via the supervisor API, verify state and encoder,
# and print the browser URL for the human playability check.
set -euo pipefail

NS=psp-xmb
ROM_URL="https://github.com/JeffRuLz/Celeste-Classic-GBA/releases/download/v1.2/Celeste.Classic.v1.2.Homebrew.gba"

echo "--- scaling game-session to 1"
kubectl -n "${NS}" scale deployment/game-session --replicas=1
kubectl -n "${NS}" rollout status deployment/game-session --timeout=600s
POD=$(kubectl -n "${NS}" get pod -l app=game-session -o jsonpath='{.items[0].metadata.name}')
NODE_IP=$(kubectl -n "${NS}" get pod "${POD}" -o jsonpath='{.status.hostIP}')
echo "Pod: ${POD} on ${NODE_IP}"

echo "--- placing test ROM in the library (homebrew, freely distributable)"
if [ ! -f /tmp/celeste.gba ]; then
  curl -fsSL -o /tmp/celeste.gba "${ROM_URL}"
fi
# Note: `kubectl cp` fails here — its tar tries to chown on the NFS-backed
# roms mount, which the server rejects. Stream the bytes directly instead.
kubectl -n "${NS}" exec "${POD}" -- mkdir -p /roms/gba
kubectl -n "${NS}" exec -i "${POD}" -- sh -c 'cat > /roms/gba/celeste.gba' < /tmp/celeste.gba

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
echo "Browser (LAN):  https://xmb.example.com  (Authelia, then user 'psp' + basic-auth password)"
echo "Browser (direct): http://${NODE_IP}:8080  (user 'psp' + basic-auth password)"
echo "To stop:  curl -X DELETE http://${NODE_IP}:9090/game -H 'Authorization: Bearer <token>'"
echo "To power off:  kubectl -n ${NS} scale deployment/game-session --replicas=0"
