import { getDb } from "./index";
import { newId, nowIso, stringifyMetadata, parseMetadata } from "./helpers";

export type OrderStatus =
  | "draft"
  | "pending"
  | "collected"
  | "collection_failed"
  | "payout_initiated"
  | "payout_processing"
  | "payout_successful"
  | "payout_failed"
  | "chargebacked";

export interface Order {
  id: string;
  reference: string;
  orderId: string;
  paymentId: string | null;
  status: OrderStatus;
  amount: number;
  currency: string;
  customerName: string;
  customerEmail: string;
  attemptCount: number;
  payoutReference: string | null;
  payoutId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Raw shape from SQLite
interface OrderRow {
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

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id,
    reference: row.reference,
    orderId: row.order_id,
    paymentId: row.payment_id,
    status: row.status as OrderStatus,
    amount: row.amount,
    currency: row.currency,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    attemptCount: row.attempt_count,
    payoutReference: row.payout_reference,
    payoutId: row.payout_id,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createOrder(params: {
  reference: string;
  orderId: string;
  amount: number;
  currency: string;
  customerName: string;
  customerEmail: string;
  metadata?: Record<string, unknown>;
  status?: OrderStatus;
}): Order {
  const db = getDb();
  const id = newId();
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO orders (
      id, reference, order_id, status, amount, currency,
      customer_name, customer_email, attempt_count, metadata,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, 1, ?,
      ?, ?
    )
  `,
  ).run(
    id,
    params.reference,
    params.orderId,
    params.status ?? "draft",
    params.amount,
    params.currency,
    params.customerName,
    params.customerEmail,
    stringifyMetadata(params.metadata ?? {}),
    now,
    now,
  );

  const order = getOrderById(id);
  if (!order) {
    throw new Error(`Failed to retrieve order after creation (id: ${id})`);
  }
  return order;
}

export function getOrderById(id: string): Order | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as
    | OrderRow
    | undefined;

  return row ? rowToOrder(row) : null;
}

export function getOrderByReference(reference: string): Order | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM orders WHERE reference = ?")
    .get(reference) as OrderRow | undefined;

  return row ? rowToOrder(row) : null;
}

export function getOrdersByOrderId(orderId: string): Order[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM orders WHERE order_id = ? ORDER BY created_at DESC")
    .all(orderId) as OrderRow[];

  return rows.map(rowToOrder);
}

export function updateOrderStatus(
  id: string,
  status: OrderStatus,
  extra: {
    paymentId?: string;
    payoutReference?: string;
    payoutId?: string;
  } = {},
): Order {
  const db = getDb();
  const now = nowIso();

  db.prepare(
    `
    UPDATE orders SET
      status = ?,
      payment_id = COALESCE(?, payment_id),
      payout_reference = COALESCE(?, payout_reference),
      payout_id = COALESCE(?, payout_id),
      updated_at = ?
    WHERE id = ?
  `,
  ).run(
    status,
    extra.paymentId ?? null,
    extra.payoutReference ?? null,
    extra.payoutId ?? null,
    now,
    id,
  );

  const order = getOrderById(id);
  if (!order) {
    throw new Error(`Failed to retrieve order after update (id: ${id})`);
  }
  return order;
}

// Atomically transitions an order from collected → payout_initiated.
// Returns false if another request already claimed it (race condition guard).
export function claimOrderForPayout(id: string): boolean {
  const db = getDb();

  return db.transaction(() => {
    const fresh = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(id) as { status: string } | undefined;

    if (!fresh || fresh.status !== "collected") {
      return false;
    }

    db.prepare(
      "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?",
    ).run("payout_initiated", nowIso(), id);

    return true;
  })();
}

export function getStuckOrders(): Order[] {
  // payout_initiated for more than 5 minutes — claimed but never confirmed
  const db = getDb();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `
    SELECT * FROM orders
    WHERE status = 'payout_initiated'
    AND updated_at < ?
  `,
    )
    .all(fiveMinutesAgo) as OrderRow[];

  return rows.map(rowToOrder);
}
