import { Router, Request, Response } from "express";
import { z } from "zod";
import { getDb } from "../db";
import { fincraClient } from "../fincra/client";
import { FincraError, FincraNetworkError } from "../fincra/errors";
import { getOrderByReference, updateOrderStatus } from "../db/orders.repo";
import { appendOrderEvent } from "../db/events.repo";
import {
  createPayout,
  updatePayoutWithFincraDetails,
  updatePayoutStatus,
} from "../db/payouts.repo";
import { generatePayoutReference, generateIdempotencyKey } from "../db/helpers";
import { matchAccountName } from "../services/name-matching";
import { withRetry } from "../services/retry";

export const payoutsRouter = Router();

// 60 second safety buffer on quote expiry
// Prevents TOCTOU race where quote expires between our check and Fincra's check
const QUOTE_EXPIRY_BUFFER_MS = 60 * 1000;

const initiatePayoutSchema = z.object({
  orderReference: z.string().min(1, "orderReference is required"),
  recipient: z.object({
    name: z.string().min(1, "recipient.name is required"),
    accountNumber: z.string().min(1, "recipient.accountNumber is required"),
    bankCode: z.string().min(1, "recipient.bankCode is required"),
    email: z.string().email().optional(),
  }),
  sourceCurrency: z.string().default("NGN"),
  destinationCurrency: z.string().default("NGN"),
  narration: z.string().optional(),
});

payoutsRouter.post("/vendor", async (req: Request, res: Response) => {
  // Validate request
  const parsed = initiatePayoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const {
    orderReference,
    recipient,
    sourceCurrency,
    destinationCurrency,
    narration,
  } = parsed.data;

  // Find the order
  const order = getOrderByReference(orderReference);
  if (!order) {
    return res.status(404).json({
      success: false,
      error: `Order not found: ${orderReference}`,
    });
  }

  // Verify order is in collected state
  if (order.status !== "collected") {
    return res.status(409).json({
      success: false,
      error: `Order is not ready for payout. Current status: ${order.status}`,
      currentStatus: order.status,
    });
  }

  // Atomically claim the order for payout
  // This is the double-submit prevention mechanism
  // Update status to payout_initiated inside a transaction
  // If two requests arrive simultaneously, only one wins the update
  // The other will see status !== 'collected' in step 3 and return 409
  const db = getDb();

  const claimed = db.transaction(() => {
    // Re-read inside transaction to get the latest status
    const fresh = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(order.id) as { status: string } | undefined;

    if (!fresh || fresh.status !== "collected") {
      return false; // Another request already claimed it
    }

    db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(
      "payout_initiated",
      new Date().toISOString(),
      order.id,
    );

    return true;
  })();

  if (!claimed) {
    return res.status(409).json({
      success: false,
      error: "Payout already initiated for this order",
      currentStatus: order.status,
    });
  }

  appendOrderEvent({
    orderId: order.id,
    event: "payout_claim_acquired",
    detail: `Order claimed for payout to ${recipient.name} at bank ${recipient.bankCode}`,
  });

  // Verify destination account with Fincra
  let verificationResult: Awaited<
    ReturnType<typeof fincraClient.verifyAccountNumber>
  >;

  try {
    verificationResult = await withRetry(
      () =>
        fincraClient.verifyAccountNumber({
          accountNumber: recipient.accountNumber,
          bankCode: recipient.bankCode,
        }),
      { maxAttempts: 3, baseDelayMs: 1000 },
    );
  } catch (err) {
    // Verification failed — release the order back to collected
    // so the operator can retry with correct account details
    updateOrderStatus(order.id, "collected");

    appendOrderEvent({
      orderId: order.id,
      event: "account_verification_failed",
      detail: `Account verification failed for ${recipient.accountNumber} at bank ${recipient.bankCode}: ${err instanceof Error ? err.message : "Unknown error"}`,
    });

    if (err instanceof FincraError && err.status === 404) {
      return res.status(422).json({
        success: false,
        error: `Account not found: ${recipient.accountNumber} at bank ${recipient.bankCode}`,
        errorType: "ACCOUNT_NOT_FOUND",
      });
    }

    return res.status(503).json({
      success: false,
      error: "Could not verify account. Please try again.",
      errorType: "VERIFICATION_UNAVAILABLE",
    });
  }

  // Name match check
  const nameMatch = matchAccountName(
    recipient.name,
    verificationResult.accountName,
  );

  appendOrderEvent({
    orderId: order.id,
    event: "account_verified",
    detail: `Account verified: ${verificationResult.accountName} at ${verificationResult.bankName} — ${nameMatch.detail}`,
    metadata: {
      confidence: nameMatch.confidence,
      expectedName: nameMatch.expectedName,
      verifiedName: nameMatch.verifiedName,
    },
  });

  if (!nameMatch.matched) {
    // Name mismatch catch, Release order back to collected so operator can review
    updateOrderStatus(order.id, "collected");

    appendOrderEvent({
      orderId: order.id,
      event: "payout_blocked_name_mismatch",
      detail: `Payout blocked: ${nameMatch.detail}. Order returned to collected state for operator review.`,
    });

    return res.status(422).json({
      success: false,
      error: "Account name does not match intended recipient",
      errorType: "NAME_MISMATCH",
      detail: nameMatch.detail,
      expectedName: nameMatch.expectedName,
      verifiedName: nameMatch.verifiedName,
    });
  }

  // Handle FX quote if cross-currency
  let quoteReference: string | undefined;

  const isCrossCurrency =
    sourceCurrency.toUpperCase() !== destinationCurrency.toUpperCase();

  if (isCrossCurrency) {
    try {
      const quote = await withRetry(
        () =>
          fincraClient.getQuote({
            sourceCurrency: sourceCurrency.toUpperCase(),
            destinationCurrency: destinationCurrency.toUpperCase(),
            amount: order.amount,
          }),
        { maxAttempts: 3, baseDelayMs: 1000 },
      );

      // Check expiry with 60-second safety buffer
      const expiresAt = new Date(quote.expireAt).getTime();
      const safeExpiry = expiresAt - QUOTE_EXPIRY_BUFFER_MS;

      if (Date.now() > safeExpiry) {
        // Quote is too close to expiry — fetch a fresh one
        const freshQuote = await fincraClient.getQuote({
          sourceCurrency: sourceCurrency.toUpperCase(),
          destinationCurrency: destinationCurrency.toUpperCase(),
          amount: order.amount,
        });
        quoteReference = freshQuote.reference;

        appendOrderEvent({
          orderId: order.id,
          event: "fx_quote_refreshed",
          detail: `FX quote refreshed (original was within 60s of expiry). Rate: ${freshQuote.rate} ${sourceCurrency}/${destinationCurrency}`,
          metadata: {
            quoteReference: freshQuote.reference,
            rate: freshQuote.rate,
          },
        });
      } else {
        quoteReference = quote.reference;

        appendOrderEvent({
          orderId: order.id,
          event: "fx_quote_obtained",
          detail: `FX quote obtained. Rate: ${quote.rate} ${sourceCurrency}/${destinationCurrency}. Valid until: ${new Date(quote.expireAt).toISOString()}`,
          metadata: { quoteReference: quote.reference, rate: quote.rate },
        });
      }
    } catch (err) {
      updateOrderStatus(order.id, "collected");

      appendOrderEvent({
        orderId: order.id,
        event: "fx_quote_failed",
        detail: `Failed to obtain FX quote for ${sourceCurrency} → ${destinationCurrency}: ${err instanceof Error ? err.message : "Unknown error"}`,
      });

      return res.status(503).json({
        success: false,
        error: "Could not obtain FX quote. Please try again.",
        errorType: "QUOTE_UNAVAILABLE",
      });
    }
  }

  // Generate references
  const customerReference = generatePayoutReference(order.orderId);
  const idempotencyKey = generateIdempotencyKey(customerReference);

  // Create payout record in the database before calling Fincra
  const payout = createPayout({
    orderId: order.id,
    customerReference,
    recipientName: recipient.name,
    recipientAccount: recipient.accountNumber,
    recipientBankCode: recipient.bankCode,
    amount: order.amount,
    sourceCurrency: sourceCurrency.toUpperCase(),
    destinationCurrency: destinationCurrency.toUpperCase(),
    idempotencyKey,
  });

  // Call Fincra with retry and idempotency key
  let fincraPayout: Awaited<ReturnType<typeof fincraClient.initiatePayout>>;

  try {
    fincraPayout = await withRetry(
      () =>
        fincraClient.initiatePayout(
          {
            amount: order.amount,
            sourceCurrency: sourceCurrency.toUpperCase(),
            destinationCurrency: destinationCurrency.toUpperCase(),
            customerReference,
            narration:
              narration ?? `AfriKart payout for order ${order.orderId}`,
            recipient: {
              name: verificationResult.accountName, // Use verified name, not user-supplied
              accountNumber: recipient.accountNumber,
              bankCode: recipient.bankCode,
              email: recipient.email,
            },
            quoteReference,
          },
          idempotencyKey,
        ),
      { maxAttempts: 3, baseDelayMs: 1000, idempotencyKey },
    );
  } catch (err) {
    // Payout call failed — update our records
    updatePayoutStatus(
      payout.id,
      "failed",
      err instanceof Error ? err.message : "Payout initiation failed",
    );
    updateOrderStatus(order.id, "payout_failed");

    appendOrderEvent({
      orderId: order.id,
      event: "payout_initiation_failed",
      detail: `Payout initiation failed: ${err instanceof Error ? err.message : "Unknown error"}. Order marked payout_failed.`,
    });

    if (err instanceof FincraError && err.errorType === "INSUFFICIENT_FUNDS") {
      return res.status(422).json({
        success: false,
        error: "Insufficient wallet balance to complete payout",
        errorType: "INSUFFICIENT_FUNDS",
      });
    }

    return res.status(503).json({
      success: false,
      error: "Payout initiation failed. Please contact support.",
      errorType: "PAYOUT_FAILED",
    });
  }

  //Update payout and order with Fincra's references
  updatePayoutWithFincraDetails(payout.id, {
    fincraReference: fincraPayout.reference,
    fincraPayoutId: fincraPayout.id,
    status: "processing",
  });

  updateOrderStatus(order.id, "payout_processing", {
    payoutReference: fincraPayout.reference,
    payoutId: fincraPayout.id,
  });

  appendOrderEvent({
    orderId: order.id,
    event: "payout_initiated",
    detail: `Payout of ${sourceCurrency.toUpperCase()} ${order.amount.toLocaleString()} initiated to ${verificationResult.accountName} at ${verificationResult.bankName}. Awaiting confirmation.`,
    metadata: {
      fincraReference: fincraPayout.reference,
      fincraPayoutId: fincraPayout.id,
      idempotencyKey,
      nameMatchConfidence: nameMatch.confidence,
    },
  });

  return res.status(202).json({
    success: true,
    data: {
      orderReference,
      payoutReference: fincraPayout.reference,
      customerReference,
      status: "processing",
      amount: order.amount,
      sourceCurrency: sourceCurrency.toUpperCase(),
      destinationCurrency: destinationCurrency.toUpperCase(),
      recipient: {
        name: verificationResult.accountName,
        accountNumber: recipient.accountNumber,
        bankCode: recipient.bankCode,
        bankName: verificationResult.bankName,
      },
      nameMatchConfidence: nameMatch.confidence,
      message:
        "Payout is being processed. You will receive a webhook notification when it completes.",
    },
  });
});
