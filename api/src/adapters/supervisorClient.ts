import { createSocket } from "node:dgram";
import type { SupervisorPort, SupervisorStatus } from "../session/ports.js";

const CMD: Record<string, string> = {
  pause: "PAUSE_TOGGLE", save_state: "SAVE_STATE", load_state: "LOAD_STATE",
};

export function retroArchCommand(cmd: "pause" | "save_state" | "load_state"): string {
  const v = CMD[cmd];
  if (!v) throw new Error(`unknown command: ${cmd}`);
  return v;
}

export class SupervisorClient implements SupervisorPort {
  constructor(
    private token = process.env.SUPERVISOR_TOKEN ?? "",
    private httpPort = 9090,
    private udpPort = 55355,
  ) {}

  private async http(hostIP: string, method: string, body?: unknown) {
    const res = await fetch(`http://${hostIP}:${this.httpPort}/game`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`supervisor ${method} /game -> ${res.status}`);
    return res.json();
  }

  async status(hostIP: string): Promise<SupervisorStatus> {
    const res = await fetch(`http://${hostIP}:${this.httpPort}/status`, {
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`supervisor /status -> ${res.status}`);
    return res.json() as Promise<SupervisorStatus>;
  }
  async startGame(hostIP: string, core: string, rom: string): Promise<void> {
    await this.http(hostIP, "POST", { core, rom });
  }
  async stopGame(hostIP: string): Promise<void> {
    await this.http(hostIP, "DELETE");
  }
  async command(hostIP: string, cmd: string): Promise<void> {
    const msg = Buffer.from(retroArchCommand(cmd as any));
    await new Promise<void>((resolve, reject) => {
      const sock = createSocket("udp4");
      sock.send(msg, this.udpPort, hostIP, err => {
        sock.close();
        err ? reject(err) : resolve();
      });
    });
  }
}
