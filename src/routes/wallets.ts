import { Router, Request, Response } from "express";
import { fincraClient } from "../fincra/client";

export const walletsRouter = Router();

walletsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const wallets = await fincraClient.getWallets();
    return res.json({
      success: true,
      data: wallets,
    });
  } catch (err) {
    return res.status(503).json({
      success: false,
      error: "Could not retrieve wallet balances",
    });
  }
});

walletsRouter.get("/logs", async (req: Request, res: Response) => {
  const currency = req.query.currency as string | undefined;
  const type = req.query.type as "credit" | "debit" | undefined;
  const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

  try {
    const logs = await fincraClient.getWalletLogs({
      currency,
      type,
      page,
      limit,
    });

    return res.json({
      success: true,
      data: logs,
    });
  } catch (err) {
    return res.status(503).json({
      success: false,
      error: "Could not retrieve wallet logs",
    });
  }
});
