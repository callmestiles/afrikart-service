import { fincraClient } from "../fincra/client";
import { getStuckOrders, updateOrderStatus } from "../db/orders.repo";
import { getStuckPayouts, updatePayoutStatus } from "../db/payouts.repo";
import { appendOrderEvent } from "../db/events.repo";
import { getDb } from "../db";

export async function runStartupReconciliation(): Promise<void> {
  console.log("[reconciliation] Starting startup reconciliation...");

  await reconcileStuckOrders();
  await reconcileStuckPayouts();

  console.log("[reconciliation] Startup reconciliation complete");
}

// ─── Stuck Orders ─────────────────────────────────────────────────────────────
// Orders in payout_initiated that are older than 5 minutes
// These were claimed for payout but we may have crashed before
// calling Fincra or before receiving the webhook

async function reconcileStuckOrders(): Promise<void> {
  const stuckOrders = getStuckOrders();

  if (stuckOrders.length === 0) {
    console.log("[reconciliation] No stuck orders found");
    return;
  }

  console.log(
    `[reconciliation] Found ${stuckOrders.length} stuck order(s) — reconciling...`,
  );

  for (const order of stuckOrders) {
    try {
      if (!order.payoutReference) {
        // Order was claimed but Fincra was never called
        // Safe to release back to collected for retry
        updateOrderStatus(order.id, "collected");

        appendOrderEvent({
          orderId: order.id,
          event: "reconciliation_released",
          detail:
            "Order was stuck in payout_initiated with no payout reference. Released back to collected on startup — payout was never submitted to Fincra.",
        });

        console.log(
          `[reconciliation] Released order ${order.orderId} — no payout reference found`,
        );
        continue;
      }

      // Order has a payout reference — check Fincra for the actual status
      console.log(
        `[reconciliation] Checking Fincra for payout: ${order.payoutReference}`,
      );

      const fincraPayout = await fincraClient.getPayout(order.payoutReference);

      await applyFincraPayoutStatus(order.id, order.orderId, fincraPayout);
    } catch (err) {
      // Don't let one failure block the others
      console.error(
        `[reconciliation] Failed to reconcile order ${order.orderId}:`,
        err instanceof Error ? err.message : err,
      );

      appendOrderEvent({
        orderId: order.id,
        event: "reconciliation_failed",
        detail: `Startup reconciliation could not determine payout status: ${err instanceof Error ? err.message : "Unknown error"}. Manual review required.`,
      });
    }
  }
}

// ─── Stuck Payouts ────────────────────────────────────────────────────────────
// Payouts in processing state older than 5 minutes
// Cross-checks with Fincra to see if they resolved while we were down

async function reconcileStuckPayouts(): Promise<void> {
  const stuckPayouts = getStuckPayouts();

  if (stuckPayouts.length === 0) {
    console.log("[reconciliation] No stuck payouts found");
    return;
  }

  console.log(
    `[reconciliation] Found ${stuckPayouts.length} stuck payout(s) — reconciling...`,
  );

  for (const payout of stuckPayouts) {
    try {
      if (!payout.fincraReference) {
        // Payout record exists but Fincra reference was never stored
        // This means our DB write succeeded but Fincra call failed or response was lost
        console.log(
          `[reconciliation] Payout ${payout.id} has no Fincra reference — skipping`,
        );
        continue;
      }

      const fincraPayout = await fincraClient.getPayout(payout.fincraReference);

      // Find the order this payout belongs to
      const db = getDb();
      const orderRow = db
        .prepare("SELECT id, order_id FROM orders WHERE id = ?")
        .get(payout.orderId) as { id: string; order_id: string } | undefined;

      if (!orderRow) {
        console.warn(`[reconciliation] No order found for payout ${payout.id}`);
        continue;
      }

      await applyFincraPayoutStatus(
        orderRow.id,
        orderRow.order_id,
        fincraPayout,
      );
    } catch (err) {
      console.error(
        `[reconciliation] Failed to reconcile payout ${payout.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ─── Shared Status Applier ────────────────────────────────────────────────────

async function applyFincraPayoutStatus(
  orderId: string,
  orderDisplayId: string,
  fincraPayout: {
    reference: string;
    status: string;
    reason?: string;
    amountReceived?: number;
    recipient?: { name?: string };
    destinationCurrency?: string;
  },
): Promise<void> {
  const fincraStatus = fincraPayout.status;

  if (fincraStatus === "processing") {
    // Still in flight — leave status unchanged, will check again next restart
    appendOrderEvent({
      orderId,
      event: "reconciliation_still_processing",
      detail: `Payout ${fincraPayout.reference} is still processing at Fincra. Will check again on next restart.`,
    });

    console.log(
      `[reconciliation] Order ${orderDisplayId} payout still processing`,
    );
    return;
  }

  if (fincraStatus === "successful") {
    updateOrderStatus(orderId, "payout_successful", {
      payoutReference: fincraPayout.reference,
    });

    updatePayoutStatusByFincraRef(fincraPayout.reference, "successful");

    appendOrderEvent({
      orderId,
      event: "payout_succeeded",
      detail: `Payout resolved as successful during startup reconciliation. ${fincraPayout.destinationCurrency ?? ""} ${fincraPayout.amountReceived?.toLocaleString() ?? ""} paid to ${fincraPayout.recipient?.name ?? "recipient"}.`,
      metadata: { resolvedVia: "startup_reconciliation", fincraStatus },
    });

    console.log(
      `[reconciliation] Order ${orderDisplayId} payout resolved as successful`,
    );
    return;
  }

  if (fincraStatus === "failed") {
    const reason =
      fincraPayout.reason ?? "Destination bank rejected the payout";

    updateOrderStatus(orderId, "payout_failed");
    updatePayoutStatusByFincraRef(fincraPayout.reference, "failed", reason);

    appendOrderEvent({
      orderId,
      event: "payout_failed",
      detail: `Payout resolved as failed during startup reconciliation: ${reason}. Funds were restored by Fincra.`,
      metadata: { resolvedVia: "startup_reconciliation", fincraStatus, reason },
    });

    console.log(
      `[reconciliation] Order ${orderDisplayId} payout resolved as failed — ${reason}`,
    );
    return;
  }

  // Unknown status — log it for manual review
  appendOrderEvent({
    orderId,
    event: "reconciliation_unknown_status",
    detail: `Fincra returned unexpected payout status "${fincraStatus}" during reconciliation. Manual review required.`,
    metadata: { fincraStatus },
  });

  console.warn(
    `[reconciliation] Order ${orderDisplayId} has unexpected Fincra status: ${fincraStatus}`,
  );
}

// Reconciliation knows the Fincra reference, not the payout id
function updatePayoutStatusByFincraRef(
  fincraReference: string,
  status: "successful" | "failed",
  failureReason?: string,
): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE payouts SET
      status = ?,
      failure_reason = COALESCE(?, failure_reason),
      updated_at = ?
    WHERE fincra_reference = ?
  `,
  ).run(
    status,
    failureReason ?? null,
    new Date().toISOString(),
    fincraReference,
  );
}
