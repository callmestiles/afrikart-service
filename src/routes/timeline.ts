import { Router, Request, Response } from "express";
import { getDb } from "../db";
import { getOrderByReference, getOrdersByOrderId } from "../db/orders.repo";
import { getOrderEvents } from "../db/events.repo";

export const timelineRouter = Router();

// ─── GET /timeline/:reference ─────────────────────────────────────────────────
// Look up a single payment attempt by its checkout reference
// e.g. GET /timeline/pay_order_3001_1750000000000

timelineRouter.get("/:reference", (req: Request, res: Response) => {
  const { reference } = req.params;
  const ref = Array.isArray(reference) ? reference[0] : reference;
  const order = getOrderByReference(ref);

  if (!order) {
    return res.status(404).json({
      success: false,
      error: `No order found for reference: ${reference}`,
    });
  }

  return res.json({
    success: true,
    data: buildTimeline(order.id),
  });
});

// ─── GET /timeline/order/:orderId ─────────────────────────────────────────────
// Look up ALL payment attempts for a given orderId
// Useful when a customer has retried payment multiple times
// e.g. GET /timeline/order/order_3001

timelineRouter.get("/order/:orderId", (req: Request, res: Response) => {
  const { orderId } = req.params;
  const id = Array.isArray(orderId) ? orderId[0] : orderId;
  const orders = getOrdersByOrderId(id);

  if (orders.length === 0) {
    return res.status(404).json({
      success: false,
      error: `No orders found for orderId: ${orderId}`,
    });
  }

  return res.json({
    success: true,
    data: {
      orderId,
      totalAttempts: orders.length,
      attempts: orders.map((o) => buildTimeline(o.id)),
    },
  });
});

// ─── Builder ──────────────────────────────────────────────────────────────────

function buildTimeline(orderId: string) {
  const db = getDb();

  const orderRow = db
    .prepare("SELECT * FROM orders WHERE id = ?")
    .get(orderId) as
    | {
        id: string;
        reference: string;
        order_id: string;
        payment_id: string | null;
        status: string;
        amount: number;
        currency: string;
        customer_name: string;
        customer_email: string;
        attempt_count: number;
        payout_reference: string | null;
        payout_id: string | null;
        metadata: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!orderRow) return null;

  const events = getOrderEvents(orderId);

  const payoutRow =
    (db.prepare("SELECT * FROM payouts WHERE order_id = ?").get(orderId) as {
      id: string;
      customer_reference: string;
      fincra_reference: string | null;
      fincra_payout_id: string | null;
      recipient_name: string;
      recipient_account: string;
      recipient_bank_code: string;
      amount: number;
      source_currency: string;
      destination_currency: string;
      status: string;
      failure_reason: string | null;
      idempotency_key: string;
      created_at: string;
      updated_at: string;
    } | null) ?? null;

  // Maps every identifier involved in this transaction for cross-system debugging
  const identifierChain: Record<string, string | null> = {
    checkoutReference: orderRow.reference,
    fincraPaymentId: orderRow.payment_id,
    payoutCustomerReference: payoutRow?.customer_reference ?? null,
    fincraPayoutReference: orderRow.payout_reference,
    fincraPayoutId: orderRow.payout_id,
  };

  const payout = payoutRow
    ? {
        customerReference: payoutRow.customer_reference,
        fincraReference: payoutRow.fincra_reference,
        status: payoutRow.status,
        amount: payoutRow.amount,
        sourceCurrency: payoutRow.source_currency,
        destinationCurrency: payoutRow.destination_currency,
        failureReason: payoutRow.failure_reason,
        recipient: {
          name: payoutRow.recipient_name,
          account: payoutRow.recipient_account,
          bankCode: payoutRow.recipient_bank_code,
        },
        createdAt: payoutRow.created_at,
        updatedAt: payoutRow.updated_at,
      }
    : null;

  const statusDescription = describeStatus(orderRow.status);

  return {
    orderId: orderRow.order_id,
    reference: orderRow.reference,
    currentStatus: orderRow.status,
    statusDescription,
    amount: orderRow.amount,
    currency: orderRow.currency,
    customer: {
      name: orderRow.customer_name,
      email: orderRow.customer_email,
    },
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at,
    timeline: events.map((e) => ({
      event: e.event,
      detail: e.detail,
      timestamp: e.createdAt,
      metadata: Object.keys(e.metadata).length > 0 ? e.metadata : undefined,
    })),
    payout,
    identifierChain,
  };
}

function describeStatus(status: string): string {
  const descriptions: Record<string, string> = {
    draft: "Order created, checkout initiation in progress",
    pending: "Waiting for customer payment",
    collected: "Payment received, ready for vendor payout",
    collection_failed: "Customer payment failed or was not received",
    payout_initiated: "Payout claimed and being prepared",
    payout_processing: "Payout submitted to Fincra, awaiting bank confirmation",
    payout_successful: "Vendor has been paid successfully",
    payout_failed:
      "Payout was rejected by the destination bank. Funds restored.",
    chargebacked: "Customer has raised a chargeback. Wallet debited.",
  };

  return descriptions[status] ?? `Unknown status: ${status}`;
}
