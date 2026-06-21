import { describe, it } from 'node:test'
import assert from 'node:assert/strict'


// A quote is considered safe if it expires more than BUFFER_MS from now
const QUOTE_EXPIRY_BUFFER_MS = 60 * 1000 // 60 seconds

function isQuoteSafe(expireAt: string, nowMs: number = Date.now()): boolean {
  const expiresAt = new Date(expireAt).getTime()
  const safeExpiry = expiresAt - QUOTE_EXPIRY_BUFFER_MS
  return nowMs < safeExpiry
}

describe('quote expiry safety buffer', () => {
  it('considers a quote safe when it expires in 5 minutes', () => {
    const expireAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    assert.equal(isQuoteSafe(expireAt), true)
  })

  it('considers a quote unsafe when it expires in 30 seconds', () => {
    const expireAt = new Date(Date.now() + 30 * 1000).toISOString()
    assert.equal(isQuoteSafe(expireAt), false)
  })

  it('considers a quote unsafe when it expires in exactly 60 seconds', () => {
    // At exactly the buffer boundary
    const nowMs = Date.now()
    const expireAt = new Date(nowMs + QUOTE_EXPIRY_BUFFER_MS).toISOString()
    assert.equal(isQuoteSafe(expireAt, nowMs), false)
  })

  it('considers a quote unsafe when it has already expired', () => {
    const expireAt = new Date(Date.now() - 1000).toISOString()
    assert.equal(isQuoteSafe(expireAt), false)
  })

  it('considers a quote safe when it expires in 61 seconds', () => {
    // Just outside the buffer
    const nowMs = Date.now()
    const expireAt = new Date(nowMs + QUOTE_EXPIRY_BUFFER_MS + 1000).toISOString()
    assert.equal(isQuoteSafe(expireAt, nowMs), true)
  })
})