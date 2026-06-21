import { getDb } from "./index";
import { newId, nowIso, stringifyMetadata, parseMetadata } from "./helpers";

export interface OrderEvent {
  id: string;
  orderId: string;
  event: string;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// Raw shape from SQLite
interface OrderEventRow {
  id: string;
  order_id: string;
  event: string;
  detail: string;
  metadata: string;
  created_at: string;
}

function rowToEvent(row: OrderEventRow): OrderEvent {
  return {
    id: row.id,
    orderId: row.order_id,
    event: row.event,
    detail: row.detail,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

export function appendOrderEvent(params: {
  orderId: string;
  event: string;
  detail: string;
  metadata?: Record<string, unknown>;
}): OrderEvent {
  const db = getDb();
  const id = newId();
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO order_events (id, order_id, event, detail, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    params.orderId,
    params.event,
    params.detail,
    stringifyMetadata(params.metadata ?? {}),
    now,
  );

  return {
    id,
    orderId: params.orderId,
    event: params.event,
    detail: params.detail,
    metadata: params.metadata ?? {},
    createdAt: now,
  };
}

export function getOrderEvents(orderId: string): OrderEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM order_events
    WHERE order_id = ?
    ORDER BY created_at ASC
  `,
    )
    .all(orderId) as OrderEventRow[];

  return rows.map(rowToEvent);
}
