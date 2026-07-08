# GPU manifests

These manifests are for **verification and documentation only** — GPU enablement on
the cluster is managed elsewhere.

## Where the device plugin actually lives

The NVIDIA device plugin (v0.17.1) and its **time-slicing** configuration are managed
in the `k3s_setup` repo, not here:

- Manifest: `k3s_setup/manifests/292-nvidia-device-plugin.yaml`
- ConfigMap: `nvidia-device-plugin` in the `kube-system` namespace

The GPU node (`k3s-node4`, RTX 3080 Ti) advertises `nvidia.com/gpu: 3` because the
single physical GPU is shared via NVIDIA time-slicing into 3 virtual slots.

**Never apply a plain (non-time-sliced) device-plugin DaemonSet from this repo.**
Doing so would clobber the cluster's time-slicing config and drop the advertised GPU
count, breaking other GPU workloads already running on the cluster.

## What is in this directory

- `nvidia-runtimeclass.yaml` — documents the `nvidia` RuntimeClass this project
  depends on. It already exists on the cluster; the manifest is kept here as a record
  of the dependency (and for bootstrapping a fresh cluster).
- `gpu-smoke-pod.yaml` — a one-shot pod that runs `nvidia-smi` on the GPU node to
  verify scheduling, the RuntimeClass, and driver access.

## Verifying GPU readiness

```bash
export KUBECONFIG=~/.kube/k3s-config
bash scripts/preflight.sh

# GPU smoke test
kubectl apply -f deploy/gpu/gpu-smoke-pod.yaml
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/gpu-smoke --timeout=180s
kubectl logs gpu-smoke        # expect an nvidia-smi table showing the RTX 3080 Ti
kubectl delete pod gpu-smoke  # always clean up, even on failure
```
