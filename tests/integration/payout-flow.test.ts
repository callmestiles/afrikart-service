import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:3000'
const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:4000'
const SANDBOX_KEY = process.env.FINCRA_SECRET_KEY ?? 'sk_test_afrikart_secret'

async function createAndCollectOrder(): Promise<string> {
  // Creates an order and simulates settlement
  // Returns the checkout reference

  const orderId = `order_payout_test_${Date.now()}`

  const createRes = await fetch(`${SERVICE_URL}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId,
      amount: 25000,
      currency: 'NGN',
      customer: { name: 'Test Customer', email: 'test@example.com' },
    }),
  })

  const createBody = await createRes.json() as { data: { reference: string } }
  const reference = createBody.data.reference

  // Settle
  await fetch(`${SANDBOX_URL}/simulate/collections/settle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': SANDBOX_KEY,
    },
    body: JSON.stringify({
      reference,
      status: 'successful',
      channel: 'bank_transfer',
    }),
  })

  // Wait for webhook
  await new Promise(resolve => setTimeout(resolve, 1000))

  return reference
}

describe('Payout Flow (integration)', () => {
  it('happy path — payout to valid account succeeds', async () => {
    const reference = await createAndCollectOrder()

    const res = await fetch(`${SERVICE_URL}/payouts/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderReference: reference,
        recipient: {
          name: 'Ada Lovelace',
          accountNumber: '0123456789',
          bankCode: '058',
        },
        sourceCurrency: 'NGN',
        destinationCurrency: 'NGN',
      }),
    })

    assert.equal(res.status, 202)

    const body = await res.json() as {
      success: boolean
      data: { status: string; payoutReference: string }
    }

    assert.equal(body.success, true)
    assert.equal(body.data.status, 'processing')
    assert.ok(body.data.payoutReference)
  })

  it('rejects payout for order not in collected state', async () => {
    // Use a reference that doesn't exist
    const res = await fetch(`${SERVICE_URL}/payouts/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderReference: 'pay_nonexistent_order',
        recipient: {
          name: 'Ada Lovelace',
          accountNumber: '0123456789',
          bankCode: '058',
        },
        sourceCurrency: 'NGN',
        destinationCurrency: 'NGN',
      }),
    })

    assert.equal(res.status, 404)
  })

  it('blocks payout on name mismatch', async () => {
    const reference = await createAndCollectOrder()

    const res = await fetch(`${SERVICE_URL}/payouts/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderReference: reference,
        recipient: {
          name: 'Wrong Name Entirely',
          accountNumber: '0123456789',
          bankCode: '058',
        },
        sourceCurrency: 'NGN',
        destinationCurrency: 'NGN',
      }),
    })

    assert.equal(res.status, 422)

    const body = await res.json() as { errorType: string }
    assert.equal(body.errorType, 'NAME_MISMATCH')
  })

  it('payout to account ending in 9 fails asynchronously', async () => {
    const reference = await createAndCollectOrder()

    // Initiate payout to failing account
    const res = await fetch(`${SERVICE_URL}/payouts/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderReference: reference,
        recipient: {
          name: 'Fatima Invalid',
          accountNumber: '0000000009',
          bankCode: '058',
        },
        sourceCurrency: 'NGN',
        destinationCurrency: 'NGN',
      }),
    })

    // Initially returns 202 — payout is processing
    assert.equal(res.status, 202)

    // Wait for async payout.failed webhook
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Check timeline — should now show payout_failed
    const timelineRes = await fetch(`${SERVICE_URL}/timeline/${reference}`)
    const timeline = await timelineRes.json() as {
      data: { currentStatus: string; timeline: Array<{ event: string }> }
    }

    assert.equal(timeline.data.currentStatus, 'payout_failed')

    const events = timeline.data.timeline.map(e => e.event)
    assert.ok(events.includes('payout_failed'))
  })

  it('prevents double payout on same collected order', async () => {
    const reference = await createAndCollectOrder()

    // First payout
    const res1 = await fetch(`${SERVICE_URL}/payouts/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderReference: reference,
        recipient: {
          name: 'Ada Lovelace',
          accountNumber: '0123456789',
          bankCode: '058',
        },
        sourceCurrency: 'NGN',
        destinationCurrency: 'NGN',
      }),
    })

    assert.equal(res1.status, 202)

    // Second payout attempt — same order
    const res2 = await fetch(`${SERVICE_URL}/payouts/vendor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orderReference: reference,
        recipient: {
          name: 'Ada Lovelace',
          accountNumber: '0123456789',
          bankCode: '058',
        },
        sourceCurrency: 'NGN',
        destinationCurrency: 'NGN',
      }),
    })

    // Must be rejected — order is no longer in collected state
    assert.equal(res2.status, 409)
  })
})