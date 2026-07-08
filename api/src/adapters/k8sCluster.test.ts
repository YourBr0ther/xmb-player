import { describe, it, expect } from "vitest";
import { derivePodStatus } from "./k8sCluster.js";

it("returns None when no pods", () => {
  expect(derivePodStatus([])).toEqual({ phase: "None", ready: false, hostIP: null });
});

it("returns Pending for a scheduled-but-not-ready pod", () => {
  const pods = [{ status: { phase: "Pending", hostIP: undefined,
    containerStatuses: [{ ready: false }] } }];
  expect(derivePodStatus(pods as any)).toEqual({ phase: "Pending", ready: false, hostIP: null });
});

it("returns Running+ready+hostIP for a healthy pod", () => {
  const pods = [{ status: { phase: "Running", hostIP: "10.0.2.198",
    containerStatuses: [{ ready: true }] } }];
  expect(derivePodStatus(pods as any)).toEqual({ phase: "Running", ready: true, hostIP: "10.0.2.198" });
});
