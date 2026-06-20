import { Router } from "express";
import { config } from "../config";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "afrikart-service",
    environment: config.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});
