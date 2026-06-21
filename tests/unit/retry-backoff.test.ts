import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry } from '../../src/services/retry'
import { FincraError, FincraNetworkError } from '../../src/fincra/errors'

describe('withRetry', () => {
  it('returns result immediately on first success', async () => {
    let callCount = 0

    const result = await withRetry(async () => {
      callCount++
      return 'success'
    })

    assert.equal(result, 'success')
    assert.equal(callCount, 1)
  })

  it('retries on retryable error and succeeds on second attempt', async () => {
    let callCount = 0

    const result = await withRetry(
      async () => {
        callCount++
        if (callCount < 2) {
          throw new FincraError('Service unavailable', 503)
        }
        return 'success'
      },
      { maxAttempts: 3, baseDelayMs: 10 }, // Short delay for tests
    )

    assert.equal(result, 'success')
    assert.equal(callCount, 2)
  })

  it('throws immediately on non-retryable error without retrying', async () => {
    let callCount = 0

    await assert.rejects(
      async () => {
        await withRetry(
          async () => {
            callCount++
            throw new FincraError('Bad request', 400) // 400 is not retryable
          },
          { maxAttempts: 3, baseDelayMs: 10 },
        )
      },
      (err: unknown) => {
        assert.ok(err instanceof FincraError)
        assert.equal((err as FincraError).status, 400)
        return true
      },
    )

    // Should have only tried once — no retries for 400
    assert.equal(callCount, 1)
  })

  it('exhausts all attempts and throws the last error', async () => {
    let callCount = 0

    await assert.rejects(
      async () => {
        await withRetry(
          async () => {
            callCount++
            throw new FincraError('Service unavailable', 503)
          },
          { maxAttempts: 3, baseDelayMs: 10 },
        )
      },
      (err: unknown) => {
        assert.ok(err instanceof FincraError)
        return true
      },
    )

    assert.equal(callCount, 3) // All 3 attempts were made
  })

  it('retries on network errors', async () => {
    let callCount = 0

    const result = await withRetry(
      async () => {
        callCount++
        if (callCount < 3) {
          throw new FincraNetworkError('Connection refused')
        }
        return 'recovered'
      },
      { maxAttempts: 3, baseDelayMs: 10 },
    )

    assert.equal(result, 'recovered')
    assert.equal(callCount, 3)
  })
})