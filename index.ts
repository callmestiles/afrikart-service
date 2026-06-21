import { createApp } from "./src/app";
import { config } from "./src/config";
import { runStartupReconciliation } from "./src/services/reconciliation";

const app = createApp();

app.listen(config.port, () => {
  console.log(`✅ AfriKart service running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Fincra sandbox: ${config.fincra.baseUrl}`);
  console.log(`   Database: ${config.dbPath}`);

  // Run reconciliation after server is listening
  // We run it here rather than before listen() so the server
  // is already accepting requests while reconciliation runs
  // Reconciliation is best-effort — a failure here must never
  // prevent the server from starting
  runStartupReconciliation().catch((err) => {
    console.error("[reconciliation] Startup reconciliation failed:", err);
  });
});
