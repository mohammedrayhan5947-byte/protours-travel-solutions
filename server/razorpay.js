import crypto from 'node:crypto'

/* Razorpay over its REST API (no SDK needed). Keys live only on the server:
   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET. */

const API = 'https://api.razorpay.com/v1'

export const configured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
export const keyId = () => process.env.RAZORPAY_KEY_ID

/**
 * Test-only shortcut so certification bookings can run on TBO staging
 * without a card: allowed only when explicitly switched on AND TBO is not live.
 */
export const fakePayments = () => process.env.ALLOW_FAKE_PAYMENTS === 'true' && process.env.TBO_ENV !== 'live'

async function rzp(path, { method = 'GET', body } = {}) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.description || `Razorpay HTTP ${res.status}`)
    e.status = res.status
    throw e
  }
  return data
}

export const createOrder = (amountPaise, receipt, notes) =>
  rzp('/orders', { method: 'POST', body: { amount: amountPaise, currency: 'INR', receipt, notes } })

export const fetchOrder = (id) => rzp(`/orders/${encodeURIComponent(id)}`)

/** Payments made against an order — used when a webhook may have been missed. */
export const orderPayments = (id) => rzp(`/orders/${encodeURIComponent(id)}/payments`)

export const fetchPayment = (id) => rzp(`/payments/${encodeURIComponent(id)}`)

export const capturePayment = (id, amountPaise) =>
  rzp(`/payments/${encodeURIComponent(id)}/capture`, { method: 'POST', body: { amount: amountPaise, currency: 'INR' } })

export const refundPayment = (id, amountPaise, receipt, notes) =>
  rzp(`/payments/${encodeURIComponent(id)}/refund`, { method: 'POST', body: { amount: amountPaise, speed: 'normal', receipt, notes } })

function safeEqualHex(expected, given) {
  if (typeof given !== 'string' || given.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))
}

/** Checkout's handler signature: HMAC(order_id|payment_id) with the key secret. */
export function checkoutSignatureValid(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
  return safeEqualHex(expected, signature)
}

/** Webhook signature: HMAC of the raw request body with the webhook secret. */
export function webhookSignatureValid(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return safeEqualHex(expected, signature)
}
