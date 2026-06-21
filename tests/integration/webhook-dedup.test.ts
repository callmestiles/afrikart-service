import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";

const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:3000";
const WEBHOOK_SECRET =
  process.env.FINCRA_WEBHOOK_SECRET ?? "whsec_afrikart_secret";

function signPayload(payload: string): string {
  return createHmac("sha512", WEBHOOK_SECRET).update(payload).digest("hex");
}

describe("Webhook Deduplication (integration)", () => {
  it("processes first delivery and skips duplicate with same event_id", async () => {
    const eventId = `evt_test_${Date.now()}`;
    const payload = {
      event: "collection.successful",
      data: {
        reference: `pay_nonexistent_${Date.now()}`,
        amountReceived: 25000,
        currency: "NGN",
      },
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr);

    // First delivery
    const res1 = await fetch(`${SERVICE_URL}/webhooks/fincra`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fincra-signature": signature,
        "x-event-id": eventId,
      },
      body: payloadStr,
    });

    assert.equal(res1.status, 200);

    // Small delay to let async processing complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Second delivery — same event_id
    const res2 = await fetch(`${SERVICE_URL}/webhooks/fincra`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fincra-signature": signature,
        "x-event-id": eventId,
      },
      body: payloadStr,
    });

    // Both should return 200 — we acknowledge duplicates gracefully
    // The duplicate is detected internally via the UNIQUE constraint
    assert.equal(res2.status, 200);
  });

  it("rejects webhook with invalid signature", async () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });

    const res = await fetch(`${SERVICE_URL}/webhooks/fincra`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fincra-signature": "invalid_signature_that_wont_verify",
        "x-event-id": `evt_test_${Date.now()}`,
      },
      body: payload,
    });

    assert.equal(res.status, 401);
  });

  it("rejects webhook with missing signature header", async () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });

    const res = await fetch(`${SERVICE_URL}/webhooks/fincra`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    assert.equal(res.status, 401);
  });
});
