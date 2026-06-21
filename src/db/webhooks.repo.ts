import { getDb } from './index'
import { nowIso } from './helpers'

export interface ProcessedWebhook {
  eventId: string
  eventType: string
  orderReference: string | null
  processedAt: string
}

// Returns true if this is a new event we should process
// Returns false if we have already processed it (duplicate delivery)
export function markWebhookProcessed(params: {
  eventId: string
  eventType: string
  orderReference?: string
}): boolean {
  const db = getDb()

  try {
    db.prepare(`
      INSERT INTO processed_webhooks (event_id, event_type, order_reference, processed_at)
      VALUES (?, ?, ?, ?)
    `).run(
      params.eventId,
      params.eventType,
      params.orderReference ?? null,
      nowIso(),
    )

    return true 
  } catch (err: unknown) {
    // UNIQUE constraint violation meaning we have already processed this event
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed')
    ) {
      return false
    }

    // Any other error is unexpected, rethrow
    throw err
  }
}

export function hasProcessedWebhook(eventId: string): boolean {
  const db = getDb()
  const row = db.prepare(
    'SELECT event_id FROM processed_webhooks WHERE event_id = ?'
  ).get(eventId)

  return row !== undefined
}