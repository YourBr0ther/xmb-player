import * as k8s from "@kubernetes/client-node";
import type { ClusterPort, PodStatus } from "../session/ports.js";

export function derivePodStatus(pods: k8s.V1Pod[]): PodStatus {
  if (pods.length === 0) return { phase: "None", ready: false, hostIP: null };
  const p = pods[0];
  const phase = (p.status?.phase as PodStatus["phase"]) ?? "Pending";
  const ready = (p.status?.containerStatuses ?? []).every(c => c.ready);
  const hostIP = p.status?.hostIP ?? null;
  const ph: PodStatus["phase"] = phase === "Running" ? "Running" : "Pending";
  return { phase: ph, ready: ready && ph === "Running", hostIP: ready ? hostIP : (ph === "Running" ? hostIP : null) };
}

export class K8sCluster implements ClusterPort {
  private apps: k8s.AppsV1Api;
  private core: k8s.CoreV1Api;
  constructor(
    private ns = process.env.POD_NAMESPACE ?? "psp-xmb",
    private deployment = process.env.GAME_DEPLOYMENT ?? "game-session",
    private labelSelector = process.env.GAME_LABEL ?? "app=game-session",
  ) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.core = kc.makeApiClient(k8s.CoreV1Api);
  }
  async scale(replicas: 0 | 1): Promise<void> {
    await this.apps.patchNamespacedDeploymentScale(
      this.deployment, this.ns,
      { spec: { replicas } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } },
    );
  }
  async podStatus(): Promise<PodStatus> {
    const res = await this.core.listNamespacedPod(
      this.ns, undefined, undefined, undefined, undefined, this.labelSelector);
    return derivePodStatus(res.body.items);
  }
}
