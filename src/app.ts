import express from "express";
import { healthRouter } from "./routes/health";
import { ordersRouter } from "./routes/orders";
import { webhooksRouter } from "./routes/webhooks";
import { getDb } from "./db";

export function createApp() {
  getDb();

  const app = express();
  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use("/orders", ordersRouter);
  app.use("/webhooks", webhooksRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: "Route not found",
    });
  });

  // Global error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("Unhandled error:", err);
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    },
  );

  return app;
}
