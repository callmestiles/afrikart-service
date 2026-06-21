import { getDb } from '../db'
import { markWebhookProcessed } from '../db/webhooks.repo'
import { getOrderByReference, updateOrderStatus } from '../db/orders.repo'
import { appendOrderEvent } from '../db/events.repo'
import type { OrderStatus } from '../db/orders.repo'

interface WebhookPayload {
  event: string
  data: Record<string, unknown>
}

export async function processWebhookEvent(
  eventId: string,
  payload: WebhookPayload,
): Promise<void> {
  const { event, data } = payload

  // Extract the order reference from the webhook payload
  // Different event types store it in different fields
  const orderReference = extractOrderReference(event, data)

  const db = getDb()

  // Wrap everything in a transaction
  // Either ALL of this happens or NONE of it happens
  // If the status update succeeds but the event write fails,
  // the transaction rolls back — including the processed_webhooks insert
  // So the webhook will be redelivered and processed correctly next time
  const processEvent = db.transaction(() => {
    // Try to mark as processed
    // If this returns false, we've already handled this event
    const isNew = markWebhookProcessed({
      eventId,
      eventType: event,
      orderReference: orderReference ?? undefined,
    })

    if (!isNew) {
      console.log(`[webhook] Duplicate delivery detected — skipping: ${eventId} (${event})`)
      return { skipped: true }
    }

    console.log(`[webhook] Processing: ${eventId} (${event})`)

    //Handle the specific event type
    handleEvent(event, data, orderReference)

    return { skipped: false }
  })

  const result = processEvent()

  if (result.skipped) {
    console.log(`[webhook] Skipped duplicate: ${event}`)
  }
}

function handleEvent(
  event: string,
  data: Record<string, unknown>,
  orderReference: string | null,
): void {
  switch (event) {
    case 'collection.successful':
      handleCollectionSuccessful(data, orderReference)
      break

    case 'collection.failed':
      handleCollectionFailed(data, orderReference)
      break

    case 'charge.successful':
      handleChargeSuccessful(data, orderReference)
      break

    case 'payout.successful':
      handlePayoutSuccessful(data)
      break

    case 'payout.failed':
      handlePayoutFailed(data)
      break

    case 'chargeback.created':
      handleChargebackCreated(data)
      break

    default:
      console.log(`[webhook] Unhandled event type: ${event}`)
  }
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

function handleCollectionSuccessful(
  data: Record<string, unknown>,
  orderReference: string | null,
): void {
  if (!orderReference) return

  const order = getOrderByReference(orderReference)
  if (!order) {
    console.warn(`[webhook] collection.successful — order not found: ${orderReference}`)
    return
  }

  // Guard: only transition from pending or draft
  // Protects against duplicate webhooks that slip past the event_id check
  if (order.status !== 'pending' && order.status !== 'draft') {
    console.log(`[webhook] collection.successful — order already in status: ${order.status}, skipping`)
    return
  }

  const amountReceived = data.amountReceived as number
  const channel = data.paymentSource as string ?? 'bank_transfer'
  const currency = data.currency as string ?? order.currency

  updateOrderStatus(order.id, 'collected')

  appendOrderEvent({
    orderId: order.id,
    event: 'collection_succeeded',
    detail: `${currency} ${amountReceived?.toLocaleString() ?? order.amount.toLocaleString()} received via ${channel}`,
    metadata: { webhookData: data },
  })

  console.log(`[webhook] Order ${order.orderId} collected — reference: ${orderReference}`)
}

function handleCollectionFailed(
  data: Record<string, unknown>,
  orderReference: string | null,
): void {
  if (!orderReference) return

  const order = getOrderByReference(orderReference)
  if (!order) return

  if (order.status !== 'pending' && order.status !== 'draft') return

  updateOrderStatus(order.id, 'collection_failed')

  appendOrderEvent({
    orderId: order.id,
    event: 'collection_failed',
    detail: `Payment collection failed. Customer may retry.`,
    metadata: { webhookData: data },
  })
}

function handleChargeSuccessful(
  data: Record<string, unknown>,
  orderReference: string | null,
): void {
  // charge.successful is the card/checkout completion event
  // Treat it the same as collection.successful
  handleCollectionSuccessful(data, orderReference)
}

function handlePayoutSuccessful(data: Record<string, unknown>): void {
  const fincraReference = data.reference as string
  if (!fincraReference) return

  // Look up the order by payout reference
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM orders WHERE payout_reference = ?'
  ).get(fincraReference) as { id: string; order_id: string } | undefined

  if (!row) {
    console.warn(`[webhook] payout.successful — no order found for payout ref: ${fincraReference}`)
    return
  }

  updateOrderStatus(row.id, 'payout_successful')

  const recipientName = (data.recipient as Record<string, unknown>)?.name as string
  const amount = data.amountReceived as number
  const currency = data.destinationCurrency as string

  appendOrderEvent({
    orderId: row.id,
    event: 'payout_succeeded',
    detail: `${currency} ${amount?.toLocaleString()} successfully paid to ${recipientName}`,
    metadata: { webhookData: data },
  })

  console.log(`[webhook] Payout successful for order ${row.order_id}`)
}

function handlePayoutFailed(data: Record<string, unknown>): void {
  const fincraReference = data.reference as string
  if (!fincraReference) return

  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM orders WHERE payout_reference = ?'
  ).get(fincraReference) as { id: string; order_id: string } | undefined

  if (!row) {
    console.warn(`[webhook] payout.failed — no order found for payout ref: ${fincraReference}`)
    return
  }

  const reason = data.reason as string ?? 'Destination bank rejected the payout'
  const amount = data.amountCharged as number
  const currency = data.sourceCurrency as string

  updateOrderStatus(row.id, 'payout_failed')

  appendOrderEvent({
    orderId: row.id,
    event: 'payout_failed',
    detail: `Payout of ${currency} ${amount?.toLocaleString()} failed: ${reason}. Funds restored to wallet.`,
    metadata: { webhookData: data, failureReason: reason },
  })

  console.log(`[webhook] Payout failed for order ${row.order_id} — reason: ${reason}`)
}

function handleChargebackCreated(data: Record<string, unknown>): void {
  const paymentReference = data.paymentReference as string
  if (!paymentReference) return

  const order = getOrderByReference(paymentReference)
  if (!order) {
    console.warn(`[webhook] chargeback.created — no order found for ref: ${paymentReference}`)
    return
  }

  const amount = data.amount as number
  const currency = data.currency as string
  const reason = data.reason as string ?? 'Unauthorized transaction'
  const deadline = data.deadline as string

  updateOrderStatus(order.id, 'chargebacked')

  appendOrderEvent({
    orderId: order.id,
    event: 'chargeback_created',
    detail: `Chargeback of ${currency} ${amount?.toLocaleString()} raised: "${reason}". Response deadline: ${deadline ? new Date(deadline).toLocaleDateString() : 'unknown'}. Wallet debited.`,
    metadata: { webhookData: data },
  })

  console.log(`[webhook] Chargeback on order ${order.orderId} — amount: ${currency} ${amount}`)
}

// ─── Reference Extraction ─────────────────────────────────────────────────────

function extractOrderReference(
  event: string,
  data: Record<string, unknown>,
): string | null {
  // Different event types embed the order reference in different fields
  switch (event) {
    case 'collection.successful':
    case 'collection.failed':
      return data.reference as string ?? null

    case 'charge.successful':
    case 'charge.failed':
      return data.reference as string ?? null

    case 'payout.successful':
    case 'payout.failed':
      // Payout events don't carry an order reference directly
      // We look up by payout reference in the handler itself
      return null

    case 'chargeback.created':
      return data.paymentReference as string ?? null

    default:
      return null
  }
}