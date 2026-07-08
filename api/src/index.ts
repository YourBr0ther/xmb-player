// api/src/index.ts
import { createServer } from "node:http";
import { LibraryService } from "./library/libraryService.js";
import { SessionManager } from "./session/sessionManager.js";
import { K8sCluster } from "./adapters/k8sCluster.js";
import { SupervisorClient } from "./adapters/supervisorClient.js";
import { createApp } from "./http/server.js";
import { attachWs } from "./http/wsBroadcaster.js";
import { attachStreamProxy } from "./http/streamProxy.js";

async function main() {
  const token = process.env.XMB_API_TOKEN ?? "";
  const romsDir = process.env.ROMS_DIR ?? "/roms";
  const configDir = process.env.CONFIG_DIR ?? "/config";
  const port = Number(process.env.PORT ?? "8080");

  const library = new LibraryService(romsDir, configDir);
  await library.init();

  const session = new SessionManager(new K8sCluster(), new SupervisorClient());

  const app = createApp({ library, session, token });
  const server = createServer(app);
  attachWs(server, { session, token, path: "/api/ws" });
  // SPA -> game-session pod bridge: GET /turn + the /webrtc/signalling WS.
  // nodeIP comes from the SessionManager's current snapshot (null when idle).
  attachStreamProxy(server, app, { nodeIP: () => session.snapshot().node, token });

  server.listen(port, () => console.log(`[xmb-api] listening on :${port}`));
}

main().catch(e => { console.error(e); process.exit(1); });
