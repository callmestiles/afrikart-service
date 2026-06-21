import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

// 1. Sandbox running at localhost:4000
// 2. Your service running at localhost:3000

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000'
const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:4000'
const SANDBOX_KEY = process.env.FINCRA_SECRET_KEY ?? 'sk_test_afrikart_secret'

describe('Collection Flow (integration)', () => {
  let orderReference: string

  it('POST /orders creates an order and returns virtual account', async () => {
    const res = await fetch(`${SERVICE_URL}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: `order_test_${Date.now()}`,
        amount: 25000,
        currency: 'NGN',
        customer: {
          name: 'Test Customer',
          email: 'test@example.com',
        },
      }),
    })

    assert.equal(res.status, 201)

    const body = await res.json() as {
      success: boolean
      data: {
        reference: string
        status: string
        virtualAccount: { accountNumber: string }
      }
    }

    assert.equal(body.success, true)
    assert.equal(body.data.status, 'pending')
    assert.ok(body.data.reference.startsWith('pay_'))
    assert.ok(body.data.virtualAccount.accountNumber)

    orderReference = body.data.reference
  })

  it('POST /orders returns 400 for missing customer email', async () => {
    const res = await fetch(`${SERVICE_URL}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: 'order_bad',
        amount: 25000,
        customer: { name: 'No Email' },
      }),
    })

    assert.equal(res.status, 400)
    const body = await res.json() as { success: boolean }
    assert.equal(body.success, false)
  })

  it('POST /orders returns 400 for negative amount', async () => {
    const res = await fetch(`${SERVICE_URL}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: 'order_bad_amount',
        amount: -100,
        customer: { name: 'Test', email: 'test@example.com' },
      }),
    })

    assert.equal(res.status, 400)
  })

  it('simulating settlement triggers webhook and updates order to collected', async () => {
    assert.ok(orderReference, 'Need orderReference from previous test')

    // Simulate settlement via the sandbox
    const settleRes = await fetch(`${SANDBOX_URL}/simulate/collections/settle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': SANDBOX_KEY,
      },
      body: JSON.stringify({
        reference: orderReference,
        status: 'successful',
        channel: 'bank_transfer',
      }),
    })

    assert.equal(settleRes.status, 200)

    // Wait for webhook to be processed
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Check timeline — order should now be collected
    const timelineRes = await fetch(`${SERVICE_URL}/timeline/${orderReference}`)
    const timeline = await timelineRes.json() as {
      data: { currentStatus: string }
    }

    assert.equal(timeline.data.currentStatus, 'collected')
  })

  it('GET /timeline/:reference returns full event history', async () => {
    assert.ok(orderReference, 'Need orderReference from previous test')

    const res = await fetch(`${SERVICE_URL}/timeline/${orderReference}`)
    assert.equal(res.status, 200)

    const body = await res.json() as {
      data: {
        timeline: Array<{ event: string }>
        identifierChain: Record<string, string | null>
      }
    }

    // Timeline should have at least checkout_draft and collection_succeeded
    const events = body.data.timeline.map(e => e.event)
    assert.ok(events.includes('checkout_draft'))
    assert.ok(events.includes('collection_succeeded'))

    // Identifier chain should be populated
    assert.ok(body.data.identifierChain.checkoutReference)
    assert.ok(body.data.identifierChain.fincraPaymentId)
  })
})