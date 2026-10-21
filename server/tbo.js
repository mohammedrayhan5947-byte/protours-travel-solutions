import { q, one, tryLease, releaseLease } from './db.js'

/* ============================================================
   TBO (Tek Travels) Universal Air API v10 client.
   Docs: https://apidoc.tektravels.com/flight/

   - One login token per day (valid until midnight); every request reuses it.
     ErrorCode 6 = invalid token → log in again once and retry.
   - Book/Ticket can take up to 300 s on TBO's side. A timeout there means
     "outcome unknown", never "failed": callers must check GetBookingDetails
     instead of retrying (see bookings.js).
   - Live access needs a whitelisted static IP. On Vercel, route TBO traffic
     through a static-IP proxy by setting NODE_USE_ENV_PROXY=1 and
     HTTPS_PROXY=<proxy url> — Node's fetch then uses it, no code change.
   ============================================================ */

const env = (k, d) => process.env[k] || d

const SHARED = () => env('TBO_SHARED_URL', 'https://Sharedapi.tektravels.com/SharedData.svc/rest')
const AIR = () => env('TBO_AIR_URL', 'https://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest')
// Staging serves every Air method from one path; live may split booking methods out.
const AIR_BOOK = () => env('TBO_AIR_BOOK_URL', AIR())

const BASE = {
  Authenticate: SHARED, Logout: SHARED, GetAgencyBalance: SHARED,
  Search: AIR, FareRule: AIR, FareQuote: AIR, SSR: AIR, FareUpsell: AIR,
  GetCalendarFare: AIR, UpdateCalendarFareOfDay: AIR,
  Book: AIR_BOOK, Ticket: AIR_BOOK, GetBookingDetails: AIR_BOOK, ReleasePNRRequest: AIR_BOOK,
  SendChangeRequest: AIR_BOOK, GetChangeRequestStatus: AIR_BOOK, GetCancellationCharges: AIR_BOOK,
  // Date change (re-issuance) and post-ticket add-ons (Air Amendment) share this method.
  TicketReissue: AIR_BOOK,
}

// TBO's own guidance: 300 s for Book/Ticket, 60 s for the rest. Ours stops a
// little under Vercel's 300 s ceiling so we can still record "unknown".
const TIMEOUT_MS = { Book: 280_000, Ticket: 280_000, TicketReissue: 280_000, Search: 120_000 }

// Search responses run to megabytes; keep them only while certifying.
const SUMMARISE = new Set(['Search', 'GetCalendarFare', 'UpdateCalendarFareOfDay', 'FareUpsell'])

export const configured = () => Boolean(process.env.TBO_USERNAME && process.env.TBO_PASSWORD)
export const isLive = () => env('TBO_ENV', 'staging') === 'live'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** India date (TBO tokens expire at local midnight). */
const istDay = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)

/** Responses are usually wrapped in { Response: … } — except when they aren't. */
function unwrap(body) {
  if (body && typeof body === 'object' && body.Response && typeof body.Response === 'object' && body.Error === undefined) {
    return body.Response
  }
  return body
}

async function log(entry) {
  try {
    await q(
      `insert into tbo_logs (booking_id, trace_id, method, request, response, http_status, ms, error)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [entry.bookingId ?? null, entry.traceId ?? null, entry.method, JSON.stringify(entry.request ?? null), JSON.stringify(entry.response ?? null),
        entry.httpStatus ?? null, entry.ms ?? null, entry.error ?? null],
    )
  } catch (e) {
    console.error('tbo_logs insert failed', e.message)
  }
}

/**
 * Raw POST to one TBO method. Never throws for TBO-side problems:
 * returns { ok, data, error, unknown } where `unknown` means we could not
 * tell whether TBO acted on the request (timeout / network failure).
 */
async function send(method, payload, ctx = {}) {
  const started = Date.now()
  const url = `${BASE[method]()}/${method}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS[method] ?? 60_000)
  let httpStatus, body, text, error

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    httpStatus = res.status
    text = await res.text()
    try { body = JSON.parse(text) } catch { body = undefined }
  } catch (e) {
    error = e.name === 'AbortError' ? 'timeout' : `network: ${e.message}`
  } finally {
    clearTimeout(timer)
  }

  const data = body === undefined ? undefined : unwrap(body)
  const err = data?.Error
  const code = Number(err?.ErrorCode ?? 0)
  const status = Number(data?.ResponseStatus ?? data?.Status ?? 0)

  const request = method === 'Authenticate' ? { ...payload, Password: '***' } : payload
  const response = body === undefined
    ? (text ? { raw: text.slice(0, 2000) } : null)
    : SUMMARISE.has(method) && process.env.TBO_LOG_SEARCH !== 'full'
      ? { summary: true, TraceId: data?.TraceId, ResponseStatus: data?.ResponseStatus, Error: err, results: Array.isArray(data?.Results) ? data.Results.map((r) => (Array.isArray(r) ? r.length : 1)) : undefined }
      : body
  await log({ ...ctx, traceId: ctx.traceId ?? payload.TraceId ?? data?.TraceId, method, request, response, httpStatus, ms: Date.now() - started, error })

  if (error) return { ok: false, unknown: true, error: { code: -1, message: error } }
  if (body === undefined) {
    return { ok: false, unknown: httpStatus >= 500, error: { code: -2, message: `TBO returned HTTP ${httpStatus}: ${String(text).slice(0, 200)}` } }
  }
  // Some methods (FareRule, GetBookingDetails) carry no status field: then the error code decides.
  const hasStatus = data?.ResponseStatus !== undefined || data?.Status !== undefined
  const ok = code === 0 && (!hasStatus || status === 1 || method === 'GetBookingDetails' || method === 'GetAgencyBalance')
  return { ok, data, error: ok ? null : { code, message: err?.ErrorMessage || `TBO status ${status}` } }
}

async function authenticate() {
  const r = await send('Authenticate', {
    ClientId: env('TBO_CLIENT_ID', 'ApiIntegrationNew'),
    UserName: process.env.TBO_USERNAME,
    Password: process.env.TBO_PASSWORD,
    EndUserIp: env('TBO_END_USER_IP', '127.0.0.1'),
  })
  if (!r.ok || !r.data?.TokenId) throw new Error(`TBO login failed: ${r.error?.message || 'no token returned'}`)
  return {
    token: r.data.TokenId,
    agencyId: r.data.Member?.AgencyId,
    memberId: r.data.Member?.MemberId,
    day: istDay(),
  }
}

/**
 * Today's token. Only one request logs in at a time (lease); everyone else
 * waits for it. `stale` = a token TBO just rejected: it is dropped only if it
 * is still the stored one, so ten parallel failures cause one re-login.
 */
export async function getToken(stale) {
  if (!configured()) throw Object.assign(new Error('Online flight booking is not switched on yet. Please call or WhatsApp us.'), { status: 503, public: true })
  if (stale) await q(`delete from kv where key = 'tbo:token' and value->>'token' = $1`, [stale])

  const read = async () => {
    const row = await one(`select value from kv where key = 'tbo:token'`)
    return row?.value?.day === istDay() ? row.value : null
  }

  for (let i = 0; i < 40; i++) {
    const current = await read()
    if (current) return current
    if (await tryLease('tbo-auth', 45)) {
      try {
        const fresh = await authenticate()
        await q(
          `insert into kv (key, value) values ('tbo:token', $1::jsonb)
           on conflict (key) do update set value = excluded.value`,
          [JSON.stringify(fresh)],
        )
        return fresh
      } finally {
        await releaseLease('tbo-auth')
      }
    }
    await sleep(750)
  }
  throw new Error('Timed out waiting for the TBO login.')
}

/** Calls a TBO Air method with today's token, re-logging in once on ErrorCode 6. */
export async function call(method, payload, ctx = {}) {
  const auth = await getToken()
  const base = { EndUserIp: ctx.ip || env('TBO_END_USER_IP', '127.0.0.1'), TokenId: auth.token }
  let r = await send(method, { ...base, ...payload }, ctx)
  if (r.error?.code === 6) {
    const fresh = await getToken(auth.token)
    r = await send(method, { ...base, TokenId: fresh.token, ...payload }, ctx)
  }
  return r
}

/** Wallet balance — staff page shows it so failed tickets for "low balance" are obvious. */
export async function agencyBalance() {
  const auth = await getToken()
  return send('GetAgencyBalance', {
    ClientId: env('TBO_CLIENT_ID', 'ApiIntegrationNew'),
    TokenAgencyId: auth.agencyId,
    TokenMemberId: auth.memberId,
    EndUserIp: env('TBO_END_USER_IP', '127.0.0.1'),
    TokenId: auth.token,
  })
}
