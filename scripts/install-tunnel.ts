import { installTunnelClient } from "../src/runtime/install-tunnel.js";

installTunnelClient((message) => console.log(message)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
