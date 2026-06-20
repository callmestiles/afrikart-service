import { createApp } from "./src/app";
import { config } from "./src/config";

const app = createApp();

app.listen(config.port, () => {
  console.log(`✅ AfriKart service running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Fincra sandbox: ${config.fincra.baseUrl}`);
  console.log(`   Database: ${config.dbPath}`);
});
