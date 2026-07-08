export interface PodStatus {
  phase: "None" | "Pending" | "Running";
  ready: boolean;
  hostIP: string | null;
}

export interface ClusterPort {
  scale(replicas: 0 | 1): Promise<void>;
  podStatus(): Promise<PodStatus>;
}

export interface SupervisorStatus {
  state: "idle" | "running" | "crashed";
  game: { core: string; rom: string } | null;
}

export interface SupervisorPort {
  status(hostIP: string): Promise<SupervisorStatus>;
  startGame(hostIP: string, core: string, rom: string): Promise<void>;
  stopGame(hostIP: string): Promise<void>;
  command(hostIP: string, cmd: string): Promise<void>;
}
