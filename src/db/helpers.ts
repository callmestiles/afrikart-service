import { randomUUID } from "crypto";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateOrderReference(orderId: string): string {
  return `pay_${orderId}_${Date.now()}`;
}

export function generatePayoutReference(orderId: string): string {
  return `payout_${orderId}_${Date.now()}`;
}

export function generateIdempotencyKey(payoutReference: string): string {
  // Same payout reference always produces the same idempotency key
  // This means retries use the same key and which results in Fincra deduplicates on their end
  return `idem_${payoutReference}`;
}

export function parseMetadata(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    console.log("Failed to parse meta data.");
    return {};
  }
}

export function stringifyMetadata(data: unknown): string {
  try {
    return JSON.stringify(data ?? {});
  } catch {
    console.log("Failed to stringify meta data");
    return "{}";
  }
}
