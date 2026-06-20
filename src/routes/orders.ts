import { Router, Request, Response } from "express";
import { z } from "zod";
import { fincraClient } from "../fincra/client";
import { FincraError, FincraNetworkError } from "../fincra/errors";
import {
  createOrder,
  getOrderByReference,
  getOrdersByOrderId,
  updateOrderStatus,
} from "../db/orders.repo";
import { appendOrderEvent } from "../db/events.repo";
import { generateOrderReference } from "../db/helpers";

export const ordersRouter = Router();

// ─── Request Validation Schema ────────────────────────────────────────────────

const createOrderSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  amount: z.number().positive("amount must be greater than 0"),
  currency: z.string().default("NGN"),
  customer: z.object({
    name: z.string().min(1, "customer.name is required"),
    email: z.string().email("customer.email must be a valid email"),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ─── POST /orders ─────────────────────────────────────────────────────────────
ordersRouter.post("/", async (req: Request, res: Response) => {
  //validate
  const parsed = createOrderSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { orderId, amount, currency, customer, metadata } = parsed.data;

  //generate a unique checkout reference for this attempt
  const reference = generateOrderReference(orderId);

  //create order in draft state before calling Fincra
  const order = createOrder({
    reference,
    orderId,
    amount,
    currency: currency.toUpperCase(),
    customerName: customer.name,
    customerEmail: customer.email,
    metadata,
    status: "draft",
  });

  appendOrderEvent({
    orderId: order.id,
    event: "checkout_draft",
    detail: "Order draft created, initiating checkout with payment provider",
  });

  //call fincra
  let fincraResponse: Awaited<ReturnType<typeof fincraClient.initiateCheckout>>;
  try {
    fincraResponse = await fincraClient.initiateCheckout({
      amount,
      currency: currency.toUpperCase(),
      reference,
      customer,
      metadata,
    });
  } catch (err) {
    updateOrderStatus(order.id, "collection_failed");
    appendOrderEvent({
      orderId: order.id,
      event: "checkout_initiation_failed",
      detail:
        err instanceof FincraError
          ? `Checkout initiation failed: ${err.message}`
          : "Checkout initiation failed: provider unreachable",
    });

    if (err instanceof FincraError) {
      return res
        .status(err.status)
        .json({ success: false, error: err.message });
    }

    return res.status(503).json({
      success: false,
      error: "Payment provider temporarily unavailable. Please try again.",
      errorType: "PROVIDER_UNAVAILABLE",
    });
  }

  //fincra confirmed, update to pending
  updateOrderStatus(order.id, "pending", {
    paymentId: fincraResponse.payment.id,
  });

  appendOrderEvent({
    orderId: order.id,
    event: "checkout_initiated",
    detail: `${currency.toUpperCase()} ${amount.toLocaleString()} checkout initiated for ${customer.name}`,
    metadata: {
      fincraPaymentId: fincraResponse.payment.id,
      checkoutReference: reference,
      virtualAccount: fincraResponse.payment.virtualAccount,
    },
  });

  //return result
  return res.status(201).json({
    success: true,
    data: {
      orderId,
      reference,
      status: "pending",
      amount,
      currency: currency.toUpperCase(),
      customer,
      virtualAccount: fincraResponse.payment.virtualAccount,
      message: `Transfer ${currency.toUpperCase()} ${amount.toLocaleString()} to the virtual account below to complete your payment`,
    },
  });
});

// ─── GET /orders/:orderId ─────────────────────────────────────────────────────

ordersRouter.get("/:orderId", async (req: Request, res: Response) => {
  const orderId = Array.isArray(req.params.orderId)
    ? req.params.orderId[0]
    : req.params.orderId;
  const orders = getOrdersByOrderId(orderId);

  if (orders.length === 0) {
    return res.status(404).json({
      success: false,
      error: `No orders found for orderId: ${orderId}`,
    });
  }

  // Return all attempts, most recent first
  return res.json({
    success: true,
    data: {
      orderId,
      attempts: orders.map((o) => ({
        reference: o.reference,
        status: o.status,
        amount: o.amount,
        currency: o.currency,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })),
      latestStatus: orders[0].status,
    },
  });
});
