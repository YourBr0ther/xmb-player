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
  fail "no allocatable nvidia.com/gpu on any node (device plugin is managed in k3s_setup repo — see deploy/gpu/README.md)"
fi

exit ${FAILED}
