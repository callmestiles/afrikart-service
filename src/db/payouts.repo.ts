import { getDb } from "./index";
import { newId, nowIso } from "./helpers";

export type PayoutStatus = "pending" | "processing" | "successful" | "failed";

export interface Payout {
  id: string;
  orderId: string;
  customerReference: string;
  fincraReference: string | null;
  fincraPayoutId: string | null;
  recipientName: string;
  recipientAccount: string;
  recipientBankCode: string;
  amount: number;
  sourceCurrency: string;
  destinationCurrency: string;
  status: PayoutStatus;
  failureReason: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

interface PayoutRow {
  id: string;
  order_id: string;
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
}

function rowToPayout(row: PayoutRow): Payout {
  return {
    id: row.id,
    orderId: row.order_id,
    customerReference: row.customer_reference,
    fincraReference: row.fincra_reference,
    fincraPayoutId: row.fincra_payout_id,
    recipientName: row.recipient_name,
    recipientAccount: row.recipient_account,
    recipientBankCode: row.recipient_bank_code,
    amount: row.amount,
    sourceCurrency: row.source_currency,
    destinationCurrency: row.destination_currency,
    status: row.status as PayoutStatus,
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPayout(params: {
  orderId: string;
  customerReference: string;
  recipientName: string;
  recipientAccount: string;
  recipientBankCode: string;
  amount: number;
  sourceCurrency: string;
  destinationCurrency: string;
  idempotencyKey: string;
}): Payout {
  const db = getDb();
  const id = newId();
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO payouts (
      id, order_id, customer_reference,
      recipient_name, recipient_account, recipient_bank_code,
      amount, source_currency, destination_currency,
      status, idempotency_key, created_at, updated_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      'pending', ?, ?, ?
    )
  `,
  ).run(
    id,
    params.orderId,
    params.customerReference,
    params.recipientName,
    params.recipientAccount,
    params.recipientBankCode,
    params.amount,
    params.sourceCurrency,
    params.destinationCurrency,
    params.idempotencyKey,
    now,
    now,
  );

  return getPayoutById(id)!;
}

export function getPayoutById(id: string): Payout | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM payouts WHERE id = ?").get(id) as
    | PayoutRow
    | undefined;
  return row ? rowToPayout(row) : null;
}

export function getPayoutByCustomerReference(ref: string): Payout | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM payouts WHERE customer_reference = ?")
    .get(ref) as PayoutRow | undefined;
  return row ? rowToPayout(row) : null;
}

export function updatePayoutWithFincraDetails(
  id: string,
  params: {
    fincraReference: string;
    fincraPayoutId: string;
    status: PayoutStatus;
  },
): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE payouts SET
      fincra_reference = ?,
      fincra_payout_id = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
  `,
  ).run(
    params.fincraReference,
    params.fincraPayoutId,
    params.status,
    nowIso(),
    id,
  );
}

export function updatePayoutStatus(
  id: string,
  status: PayoutStatus,
  failureReason?: string,
): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE payouts SET
      status = ?,
      failure_reason = COALESCE(?, failure_reason),
      updated_at = ?
    WHERE id = ?
  `,
  ).run(status, failureReason ?? null, nowIso(), id);
}

export function getStuckPayouts(): Payout[] {
  const db = getDb();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `
    SELECT * FROM payouts
    WHERE status = 'processing'
    AND updated_at < ?
  `,
    )
    .all(fiveMinutesAgo) as PayoutRow[];

  return rows.map(rowToPayout);
}
