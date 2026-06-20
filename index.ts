import { fincraClient } from "./src/fincra/client";
import { createApp } from "./src/app";
import { config } from "./src/config";

const app = createApp();

app.listen(config.port, () => {
  console.log(`✅ AfriKart service running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Fincra sandbox: ${config.fincra.baseUrl}`);
  console.log(`   Database: ${config.dbPath}`);
});

fincraClient
  .getWallets()
  .then((wallets) => {
    console.log(
      "✅ Fincra sandbox reachable. Wallets:",
      wallets.map((w) => `${w.currency}: ${w.balance}`).join(", "),
    );
  })
  .catch((err) => {
    console.warn("⚠️  Fincra sandbox not reachable:", err.message);
    console.warn(
      "   Make sure the sandbox is running: cd participant-repo && bun run start",
    );
  });
