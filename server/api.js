import crypto from 'node:crypto'
import { UserError, search, calendar, fareOptions } from './flights.js'
import * as B from './bookings.js'
import * as C from './changes.js'
import { agencyBalance, configured as tboConfigured, isLive } from './tbo.js'
import { fakePayments, configured as payConfigured } from './razorpay.js'

/* One router for every /api/flights/* call, so the whole flight system is a
   single Vercel function (Hobby allows only a handful). Web-standard
   Request → Response, which Vercel runs natively and the Vite dev server
   adapts to (vite.config.js). */

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

function sameSecret(given, expected) {
  if (!expected || !given) return false
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')

function staffOnly(req) {
  if (!process.env.STAFF_PASSWORD) throw new UserError('Staff access is not configured (STAFF_PASSWORD).', 503)
  if (!sameSecret(bearer(req), process.env.STAFF_PASSWORD)) throw new UserError('Wrong staff password.', 401)
  return 'staff'
}

const clientIp = (req) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || undefined

/* [method, pattern, handler(ctx)] — first match wins. */
const ROUTES = [
  ['GET', /^config$/, () => ({
    enabled: tboConfigured(),
    live: isLive(),
    payments: payConfigured() ? 'razorpay' : fakePayments() ? 'test' : 'off',
  })],

  ['POST', /^search$/, ({ body, ctx }) => search(body, ctx)],
  ['POST', /^calendar$/, ({ body, ctx }) => calendar(body, ctx)],
  ['POST', /^fare-options$/, ({ body, ctx }) => fareOptions(body, ctx)],

  ['POST', /^drafts$/, ({ body, ctx }) => B.createDraft(body, ctx)],
  ['GET', /^drafts\/([\w-]+)$/, ({ m }) => B.getDraft(m[1])],
  ['POST', /^drafts\/([\w-]+)\/ssr$/, ({ m, ctx }) => B.draftSsr(m[1], ctx)],
  ['POST', /^drafts\/([\w-]+)\/travellers$/, ({ m, body, ctx }) => B.submitTravellers(m[1], body, ctx)],
  ['POST', /^drafts\/([\w-]+)\/pay\/verify$/, ({ m, body }) => B.verifyPayment(m[1], body)],
  ['POST', /^drafts\/([\w-]+)\/pay\/test$/, ({ m }) => B.fakePay(m[1])],
  ['GET', /^drafts\/([\w-]+)\/status$/, ({ m }) => B.statusOf(m[1])],

  // Orders that aren't a booking's are date-change / add-on payments (server/changes.js).
  ['POST', /^razorpay\/webhook$/, ({ raw, req, waitUntil }) => B.webhook(raw, req.headers.get('x-razorpay-signature'), waitUntil,
    (p, via) => C.changeWebhookPayment(p, via, waitUntil))],

  ['GET', /^bookings\/(PT\w+)$/, async ({ m, url, waitUntil }) => {
    const b = await B.loadForCustomer(m[1], url.searchParams.get('t'))
    // Opening the page nudges anything still in progress (ticketing, cancellation).
    if (['PAID', 'TICKETING', 'CANCELLING', 'AWAITING_PAYMENT'].includes(b.status)) waitUntil(B.reconcileOne(b.id).catch(() => {}))
    waitUntil(C.reconcileChanges(b.id).catch(() => {}))
    return B.customerView(b, { canManage: true })
  }],
  // Date change (TBO re-issue) and extras after ticketing (Air Amendment).
  ['POST', /^bookings\/(PT\w+)\/reissue\/search$/, async ({ m, body, ctx }) => C.reissueSearch(await B.loadForCustomer(m[1], body.t), body, ctx)],
  ['POST', /^bookings\/(PT\w+)\/reissue\/quote$/, async ({ m, body, ctx }) => C.reissueQuote(await B.loadForCustomer(m[1], body.t), body, ctx)],
  ['POST', /^bookings\/(PT\w+)\/addons\/options$/, async ({ m, body, ctx }) => C.addonOptions(await B.loadForCustomer(m[1], body.t), body, ctx)],
  ['POST', /^bookings\/(PT\w+)\/changes\/([\w-]+)\/addons$/, async ({ m, body }) => C.addonSelect(await B.loadForCustomer(m[1], body.t), m[2], body)],
  ['POST', /^bookings\/(PT\w+)\/changes\/([\w-]+)\/pay\/verify$/, async ({ m, body }) => C.verifyChangePayment(await B.loadForCustomer(m[1], body.t), m[2], body)],
  ['POST', /^bookings\/(PT\w+)\/changes\/([\w-]+)\/pay\/test$/, async ({ m, body }) => C.fakeChangePay(await B.loadForCustomer(m[1], body.t), m[2])],
  ['POST', /^bookings\/(PT\w+)\/cancel-quote$/, async ({ m, body }) => B.cancelQuote(await B.loadForCustomer(m[1], body.t), body)],
  ['POST', /^bookings\/(PT\w+)\/cancel$/, async ({ m, body }) => B.cancel(await B.loadForCustomer(m[1], body.t), body)],
  ['POST', /^lookup$/, ({ body }) => B.lookup(body)],

  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET"; external cron
  // services can use ?key=… instead.
  ['GET', /^cron$/, async ({ req, url }) => {
    if (!sameSecret(bearer(req) || url.searchParams.get('key'), process.env.CRON_SECRET)) throw new UserError('Forbidden.', 403)
    const bookings = await B.reconcileAll()
    return { ...bookings, ...(await C.reconcileChanges()) }
  }],

  ['GET', /^staff\/bookings$/, ({ req, url }) => (staffOnly(req), B.staffList({ status: url.searchParams.get('status') }))],
  ['GET', /^staff\/bookings\/([\w-]+)$/, ({ req, m }) => (staffOnly(req), B.staffDetail(m[1]))],
  ['GET', /^staff\/bookings\/([\w-]+)\/logs$/, ({ req, m }) => (staffOnly(req), B.staffLogs(m[1]))],
  ['POST', /^staff\/bookings\/([\w-]+)\/retry$/, ({ req, m, body }) => B.staffRetry(m[1], body, staffOnly(req))],
  ['POST', /^staff\/bookings\/([\w-]+)\/ticketed$/, ({ req, m, body }) => B.staffMarkTicketed(m[1], body, staffOnly(req))],
  ['POST', /^staff\/bookings\/([\w-]+)\/release$/, ({ req, m, body }) => B.staffRelease(m[1], body, staffOnly(req))],
  ['POST', /^staff\/bookings\/([\w-]+)\/resolve$/, ({ req, m, body }) => B.staffResolve(m[1], body, staffOnly(req))],
  ['POST', /^staff\/bookings\/([\w-]+)\/refund$/, ({ req, m, body }) => B.createRefund(m[1], body, staffOnly(req))],
  ['POST', /^staff\/bookings\/([\w-]+)\/reconcile$/, async ({ req, m }) => { staffOnly(req); await B.reconcileOne(m[1]); await C.reconcileChanges(m[1]); return { ok: true } }],
  ['POST', /^staff\/changes\/([\w-]+)\/resolve$/, ({ req, m, body }) => C.staffResolveChange(m[1], body, staffOnly(req))],
  ['POST', /^staff\/refunds\/(\d+)\/approve$/, ({ req, m, body }) => B.approveRefund(Number(m[1]), body, staffOnly(req))],
  ['GET', /^staff\/balance$/, async ({ req }) => {
    staffOnly(req)
    const r = await agencyBalance()
    return r.ok ? { cash: r.data.CashBalance, credit: r.data.CreditBalance, type: r.data.AgencyType } : { error: r.error?.message }
  }],
]

/**
 * @param {Request} req
 * @param {(p: Promise) => void} [waitUntil] keeps work running after the response (Vercel)
 */
export async function handle(req, waitUntil = (p) => p) {
  const url = new URL(req.url)
  // Vercel rewrites /api/flights/<path> → /api/flights?route=<path>; dev passes the path through.
  const path = (url.searchParams.get('route') || url.pathname.replace(/^\/api\/flights\/?/, '')).replace(/^\/+|\/+$/g, '')
  const route = ROUTES.find(([method, re]) => method === req.method && re.test(path))
  if (!route) return json(404, { error: 'Not found.' })

  try {
    const raw = req.method === 'POST' ? await req.text() : ''
    let body = {}
    if (raw && !path.startsWith('razorpay/')) {
      try { body = JSON.parse(raw) } catch { return json(400, { error: 'Invalid JSON.' }) }
    }
    const result = await route[2]({
      req, url, raw, body, waitUntil,
      m: path.match(route[1]),
      ctx: { ip: clientIp(req) },
    })
    return json(200, result ?? { ok: true })
  } catch (e) {
    if (e instanceof UserError) return json(e.status, { error: e.message, ...(e.extra || {}) })
    if (e.public) return json(e.status || 503, { error: e.message })
    console.error('flights api', path, e)
    return json(500, { error: 'Something went wrong on our side. Please try again, or call us.' })
  }
}
