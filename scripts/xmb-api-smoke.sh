#!/usr/bin/env bash
# scripts/xmb-api-smoke.sh — Phase 2a acceptance via port-forward to xmb-api.
set -euo pipefail
NS=psp-xmb
TOKEN=$(kubectl -n "$NS" get secret psp-xmb-auth -o jsonpath='{.data.xmb-api-token}' | base64 -d)

kubectl -n "$NS" port-forward deploy/xmb-api 18080:8080 >/tmp/xmb-pf.log 2>&1 &
PF=$!; trap 'kill $PF 2>/dev/null || true' EXIT
sleep 3
BASE=http://localhost:18080
auth=(-H "Authorization: Bearer ${TOKEN}")

echo "--- library (expect real systems w/ games)"
curl -fsS "${auth[@]}" "$BASE/api/library" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("systems:", [(g["system"], len(g["games"])) for g in d])'

echo "--- session before (expect off)"
curl -fsS "${auth[@]}" "$BASE/api/session"; echo

GID=$(curl -fsS "${auth[@]}" "$BASE/api/library" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin);
gs=[x for g in d for x in g["games"] if x["core"]=="mgba"]; print(gs[0]["id"] if gs else "")')
echo "--- starting game id=$GID (scales pod; first run pulls image)"
curl -fsS -X POST "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"gameId\":\"$GID\"}" "$BASE/api/session/start"; echo

echo "--- polling for in-game (up to 10 min)"
for i in $(seq 1 120); do
  ST=$(curl -fsS "${auth[@]}" "$BASE/api/session" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
  echo "  state=$ST"; [ "$ST" = "in-game" ] && break; sleep 5
done
[ "$ST" = "in-game" ] || { echo "FAILED: never reached in-game"; exit 1; }

echo "--- powering off"
curl -fsS -X DELETE "${auth[@]}" "$BASE/api/session"; echo
echo "SMOKE PASSED."
