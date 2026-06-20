import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  FINCRA_BASE_URL: z.string().url("FINCRA_BASE_URL must be a valid URL"),
  FINCRA_SECRET_KEY: z.string().min(1, "FINCRA_SECRET_KEY is required"),
  FINCRA_PUBLIC_KEY: z.string().min(1, "FINCRA_PUBLIC_KEY is required"),
  FINCRA_WEBHOOK_SECRET: z.string().min(1, "FINCRA_WEBHOOK_SECRET is required"),
  PORT: z.string().default("3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DB_PATH: z.string().default("./afrikart.db"),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  parsed.error.issues.forEach((err) => {
    console.error(`   ${err.path.join(".")}: ${err.message}`);
  });
  console.error(
    "\nHint: Copy .env.example to .env and fill in your credentials\n",
  );
  process.exit(1);
}

export const config = {
  fincra: {
    baseUrl: parsed.data.FINCRA_BASE_URL,
    secretKey: parsed.data.FINCRA_SECRET_KEY,
    publicKey: parsed.data.FINCRA_PUBLIC_KEY,
    webhookSecret: parsed.data.FINCRA_WEBHOOK_SECRET,
  },
  port: parseInt(parsed.data.PORT, 10),
  nodeEnv: parsed.data.NODE_ENV,
  dbPath: parsed.data.DB_PATH,
};
