import { createApp } from "./src/app";
import { config } from "./src/config";
import { runStartupReconciliation } from "./src/services/reconciliation";

const app = createApp();

app.listen(config.port, () => {
  console.log(`✅ AfriKart service running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Fincra sandbox: ${config.fincra.baseUrl}`);
  console.log(`   Database: ${config.dbPath}`);

  // Run after listen() so the server accepts requests while reconciliation runs
  runStartupReconciliation().catch((err) => {
    console.error("[reconciliation] Startup reconciliation failed:", err);
  });
});
