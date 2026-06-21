import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "../../src/services/webhook-verification";
import { config } from "../../src/config";

describe("verifyWebhookSignature", () => {
  // Helper to generate a valid signature for a given payload
  function sign(payload: string): string {
    return createHmac("sha512", config.fincra.webhookSecret)
      .update(payload)
      .digest("hex");
  }

  it("returns true for a valid signature", () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });
    const signature = sign(payload);
    assert.equal(verifyWebhookSignature(payload, signature), true);
  });

  it("returns false for a tampered payload", () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });
    const signature = sign(payload);
    const tamperedPayload = JSON.stringify({
      event: "collection.successful",
      data: { amount: 999999 },
    });
    assert.equal(verifyWebhookSignature(tamperedPayload, signature), false);
  });

  it("returns false for a wrong secret", () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });
    const wrongSignature = createHmac("sha512", "wrong_secret")
      .update(payload)
      .digest("hex");
    assert.equal(verifyWebhookSignature(payload, wrongSignature), false);
  });

  it("returns false for an empty signature", () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });
    assert.equal(verifyWebhookSignature(payload, ""), false);
  });

  it("returns false for a malformed signature (wrong length)", () => {
    const payload = JSON.stringify({
      event: "collection.successful",
      data: {},
    });
    assert.equal(
      verifyWebhookSignature(payload, "not-a-valid-hex-signature"),
      false,
    );
  });

  it("is consistent — same input always produces same result", () => {
    const payload = JSON.stringify({
      event: "payout.successful",
      data: { reference: "ref_123" },
    });
    const signature = sign(payload);
    assert.equal(verifyWebhookSignature(payload, signature), true);
    assert.equal(verifyWebhookSignature(payload, signature), true);
    assert.equal(verifyWebhookSignature(payload, signature), true);
  });
});
