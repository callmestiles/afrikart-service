import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../config'

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const expected = createHmac('sha512', config.fincra.webhookSecret)
    .update(rawBody)
    .digest('hex')

  // timingSafeEqual prevents timing attacks
  // A naive string comparison (expected === signature) leaks information
  // about how many characters match via response time differences
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    )
  } catch {
    // Buffer lengths differ, signature is malformed
    return false
  }
}