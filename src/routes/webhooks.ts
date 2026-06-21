import { Router, Request, Response } from 'express'
import { verifyWebhookSignature } from '../services/webhook-verification'
import { processWebhookEvent } from '../services/webhook-processor'

export const webhooksRouter = Router()

webhooksRouter.post('/fincra', (req: Request, res: Response) => {
  // We need the raw body string for signature verification
  const rawBody = JSON.stringify(req.body)
  const signature = req.headers['x-fincra-signature'] as string

  // Verify signature before doing anything else
  if (!signature) {
    return res.status(401).json({
      success: false,
      error: 'Missing x-fincra-signature header',
    })
  }

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] Invalid signature — rejecting request')
    return res.status(401).json({
      success: false,
      error: 'Invalid webhook signature',
    })
  }

  const payload = req.body as { event: string; data: Record<string, unknown> }
  const eventId = req.headers['x-event-id'] as string ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`

  // Respond immediately — Fincra retries on timeout, which creates duplicate deliveries
  res.status(200).json({ success: true, message: 'Webhook received' })

  setImmediate(() => {
    processWebhookEvent(eventId, payload).catch(err => {
      console.error('[webhook] Unhandled error during processing:', err)
    })
  })
})