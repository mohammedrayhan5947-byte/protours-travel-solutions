import crypto from 'node:crypto'
import { q, one, tryLease, releaseLease } from './db.js'
import { call } from './tbo.js'
import * as pay from './razorpay.js'
import { inrFare, quoteTotal, paxFare, priceIncrease, rupees } from './pricing.js'
import { checkSearch, checkTravellers, normName } from './validate.js'
import { UserError, card, tripsOf, isDomesticResult } from './flights.js'

/* ============================================================
   Booking state machine.

   Booking status                         Leg status (one leg = one PNR)
   DRAFT → AWAITING_PAYMENT → PAID         PENDING → HELD (non-LCC PNR) → TICKETED
   PAID → TICKETING → CONFIRMED            … or FAILED / PRICE (needs staff) / UNKNOWN
   TICKETING → ATTENTION (held for staff)
   CONFIRMED → CANCELLING → CANCELLED (or back to CONFIRMED after a partial cancel)
   AWAITING_PAYMENT → EXPIRED;  ATTENTION → RESOLVED (staff)

   RACE CONDITIONS — every one is settled by a single atomic SQL statement:
   1. Pay clicked twice / two tabs / Razorpay webhook + browser callback
      → markPaid only moves AWAITING_PAYMENT → PAID once, and rzp_payment_id
        is UNIQUE; then exactly one caller wins PAID → TICKETING (the claim).
   2. Only the claim holder may write ticketing results (patchLeg checks
      claimed_by), so a slow worker that lost its claim can't overwrite.
   3. Ticket/Book timeouts never trigger a second Ticket: the attempt time is
      saved BEFORE calling TBO, and any leg with an attempt is only ever
      checked with GetBookingDetails afterwards.
   4. A worker that died mid-ticketing is taken over after 330 s (longer than
      TBO's slowest Ticket) by the reconciler, which resumes safely.
   5. Cancel clicked twice → only one CONFIRMED → CANCELLING transition.
   6. Refunds: one row per idem_key (UNIQUE); approving moves pending →
      processing atomically, so a refund is sent to Razorpay once.
   7. Editing travellers in two tabs → optimistic `version` check.
   8. TBO token refresh → single lease (tbo.js).
   ============================================================ */

const TRACE_TTL_MS = 15 * 60_000
const MIN_LEFT_MS = 4 * 60_000 // time the customer needs to pay and us to ticket
const TAKEOVER_SECONDS = 330
const POLL_MS = Number(process.env.TBO_POLL_MS || 12_000) // GetBookingDetails re-check interval (TBO: 10–15 s)

const J = JSON.stringify
const paise = (r) => Math.round(Number(r || 0) * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url')
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const nowIso = () => new Date().toISOString()
const dt = (d) => (d ? `${d}T00:00:00` : undefined)

const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const newRef = () => 'PT' + [...crypto.randomBytes(6)].map((x) => REF_CHARS[x % REF_CHARS.length]).join('')

export async function event(bookingId, type, data) {
  await q(`insert into booking_events (booking_id, type, data) values ($1, $2, $3::jsonb)`, [bookingId, type, J(data ?? null)])
}

const traceLeftMs = (b) => new Date(b.trace_started_at).getTime() + TRACE_TTL_MS - Date.now()

/* ---------------------------------------------------------------- views */

function flagsOf(legs, isDomestic) {
  const any = (...keys) => legs.some((l) => keys.some((k) => l.quote?.[k]))
  return {
    isDomestic,
    passport: any('IsPassportRequiredAtBook', 'IsPassportRequiredAtTicket'),
    passportFull: any('IsPassportFullDetailRequiredAtBook'),
    pan: any('IsPanRequiredAtBook', 'IsPanRequiredAtTicket'),
    gstMandatory: any('IsGSTMandatory'),
    gstAllowed: any('GSTAllowed', 'IsGSTMandatory'),
    seatMandatory: any('IsSeatMandatory', 'isseatmandatory'),
    mealMandatory: any('IsMealMandatory', 'ismealmandatory'),
  }
}

function travelDates(legs) {
  const segs = legs.flatMap((l) => tripsOf(l.quote).flat())
  const first = String(segs[0]?.Origin?.DepTime || '').slice(0, 10)
  const last = String(segs[segs.length - 1]?.Destination?.ArrTime || segs[segs.length - 1]?.Origin?.DepTime || '').slice(0, 10)
  return { first, last: last || first }
}

/** What the booking pages see while the customer is still booking. */
export function draftView(b) {
  let price = null
  try { price = quoteTotal(b.legs) } catch { /* non-INR — blocked at quote time */ }
  return {
    id: b.id,
    ref: b.ref,
    status: b.status,
    version: b.version,
    search: b.search,
    isDomestic: b.is_domestic,
    expiresAt: new Date(new Date(b.trace_started_at).getTime() + TRACE_TTL_MS).toISOString(),
    flags: flagsOf(b.legs, b.is_domestic),
    dates: travelDates(b.legs),
    legs: b.legs.map((l) => ({
      key: l.key,
      card: card(l.quote),
      lcc: l.isLCC,
      priceChanged: Boolean(l.priceChanged),
      changeInfo: l.changeInfo || null,
      rules: l.rules || [],
      holdOnly: Boolean(l.quote?.IsHoldMandatoryWithSSR),
    })),
    price,
    pax: b.pax || null,
    contact: b.contact ? { ...b.contact, ip: undefined } : null,
    gst: b.gst || null,
    payment: paymentView(b),
  }
}

function paymentView(b) {
  if (b.status !== 'AWAITING_PAYMENT' || !b.rzp_order_id) return null
  const fake = b.rzp_order_id.startsWith('fake_')
  return {
    mode: fake ? 'test' : 'razorpay',
    keyId: fake ? null : pay.keyId(),
    orderId: b.rzp_order_id,
    amount: b.amount_paise,
    name: `${b.pax?.[0]?.firstName || ''} ${b.pax?.[0]?.lastName || ''}`.trim(),
    email: b.contact?.email,
    phone: b.contact?.phone,
  }
}

const PUBLIC_STATUS = {
  DRAFT: 'Not booked yet',
  AWAITING_PAYMENT: 'Waiting for payment',
  EXPIRED: 'Fare expired — not booked',
  PAID: 'Payment received — issuing your ticket',
  TICKETING: 'Payment received — issuing your ticket',
  CONFIRMED: 'Confirmed',
  ATTENTION: 'Payment received — our team is completing your booking',
  CANCELLING: 'Cancellation in progress',
  CHANGING: 'Confirmed — your change is being made',
  CANCELLED: 'Cancelled',
  RESOLVED: 'Closed by our team',
}

/** The customer's booking page (no TBO internals, no passport numbers). */
const CHANGE_TEXT = {
  AWAITING_PAYMENT: 'Waiting for payment', PAID: 'Paid — being made', PROCESSING: 'Paid — being made',
  DONE: 'Done', ATTENTION: 'Paid — our team is completing it', EXPIRED: 'Not paid — expired', RESOLVED: 'Closed by our team',
}

export async function customerView(b, { canManage }) {
  const [refunds, changes] = await Promise.all([
    q(`select amount_paise, status, reason, updated_at from refunds where booking_id = $1 order by id`, [b.id]),
    q(`select id, kind, leg, status, amount_paise, price, summary, created_at from changes where booking_id = $1 and status <> 'QUOTED' order by created_at`, [b.id]),
  ])
  const firstDep = travelDates(b.legs).first
  const future = firstDep > new Date().toISOString().slice(0, 10)
  const changeable = (l) => l.status === 'TICKETED' && l.bookingId && (l.tickets || []).length && (l.tickets || []).every((t) => t.ticketId && !t.cancelled)
  return {
    ref: b.ref,
    status: b.status,
    statusText: PUBLIC_STATUS[b.status] || b.status,
    working: ['PAID', 'TICKETING', 'CANCELLING', 'CHANGING'].includes(b.status) || changes.some((c) => ['PAID', 'PROCESSING'].includes(c.status)),
    search: b.search,
    amount: b.amount_paise,
    price: b.price,
    legs: b.legs.map((l) => ({
      key: l.key,
      card: card(l.quote),
      status: l.status,
      pnr: l.pnr || null,
      tickets: (l.tickets || []).map((t) => ({ name: t.name, number: t.number, cancelled: Boolean(t.cancelled) })),
      cancellations: (l.changeRequests || []).map((c) => ({ status: crText(c.status), refunded: c.refunded ?? null, charge: c.charge ?? null })),
      addons: (l.addons || []).map((a) => ({ pax: a.pax, label: a.label })),
    })),
    travellers: (b.pax || []).map((p) => ({ name: `${p.title} ${p.firstName} ${p.lastName}`, type: p.type })),
    contact: canManage ? { email: b.contact?.email, phone: b.contact?.phone } : null,
    refunds: refunds.map((r) => ({ amount: r.amount_paise, status: r.status === 'done' ? 'Refunded' : 'Refund being processed', at: r.updated_at })),
    canCancel: canManage && b.status === 'CONFIRMED' && future
      && b.legs.some((l) => (l.tickets || []).some((t) => t.ticketId && !t.cancelled)),
    // Date change / add-ons: whole ticketed legs only (TBO re-issues full tickets only).
    changeableLegs: canManage && b.status === 'CONFIRMED' && future && b.journey_type !== 5
      ? b.legs.map((l, i) => (changeable(l) ? i : null)).filter((i) => i != null) : [],
    changes: changes.map((c) => ({
      id: c.id, kind: c.kind, leg: c.leg, status: c.status, statusText: CHANGE_TEXT[c.status] || c.status,
      amount: c.amount_paise, price: c.price, summary: c.summary, at: c.created_at,
    })),
  }
}

const CR_TEXT = { 1: 'Received', 2: 'Being processed', 3: 'Acknowledged', 4: 'Completed', 5: 'Rejected', 6: 'Closed', 7: 'Pending', 8: 'Other' }
const crText = (s) => CR_TEXT[s] || 'Requested'

/* ---------------------------------------------------------------- loading */

export async function load(id) {
  const b = await one(`select * from bookings where id = $1`, [id])
  if (!b) throw new UserError('Booking not found.', 404)
  return b
}

export async function loadForCustomer(ref, token) {
  const b = await one(`select * from bookings where ref = $1`, [String(ref || '').toUpperCase()])
  if (!b || !b.manage_token_hash || !token) throw new UserError('Booking not found.', 404)
  const a = Buffer.from(sha(token))
  const e = Buffer.from(b.manage_token_hash)
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) throw new UserError('Booking not found.', 404)
  return b
}

/** Reference + traveller surname → read-only view (like an airline's "find booking"). */
export async function lookup({ ref, lastName }) {
  const b = await one(`select * from bookings where ref = $1 and status <> 'DRAFT'`, [String(ref || '').trim().toUpperCase()])
  const ln = normName(lastName).toLowerCase()
  if (!b || !ln || !(b.pax || []).some((p) => normName(p.lastName).toLowerCase() === ln)) {
    throw new UserError('No booking matches that reference and surname.', 404)
  }
  return customerView(b, { canManage: false })
}

/* ---------------------------------------------------------------- draft: quote */

/**
 * Customer picked a flight: FareRule + FareQuote per leg (TBO's pathway),
 * then a DRAFT booking holds the authoritative prices server-side.
 * resultIndexes: [one] normally; [OB, IB] for a domestic or special return.
 */
export async function createDraft({ traceId, resultIndexes, search }, ctx) {
  const trace = await one(`select created_at from traces where trace_id = $1`, [String(traceId || '')])
  if (!trace) throw new UserError('This search has expired. Please search again.', 410)
  if (Date.now() - new Date(trace.created_at).getTime() > TRACE_TTL_MS - MIN_LEFT_MS) {
    throw new UserError('These fares are more than 10 minutes old. Please search again for live prices.', 410)
  }
  const { search: s, errors } = checkSearch(search || {})
  if (errors) throw new UserError(errors[0])
  const idx = (Array.isArray(resultIndexes) ? resultIndexes : []).map(String).filter(Boolean)
  if (idx.length < 1 || idx.length > 2) throw new UserError('Choose your flight.')

  // Special return: both indexes in ONE FareQuote ("OB4,IB4"), one PNR.
  // Domestic normal return: each side quoted and booked separately, two PNRs.
  const legInputs = s.journeyType === 5 ? [idx.join(',')] : idx
  const legs = []
  for (const [k, index] of legInputs.entries()) {
    const c = { ...ctx, traceId }
    const rule = await call('FareRule', { TraceId: traceId, ResultIndex: index.split(',')[0] }, c)
    const fq = await call('FareQuote', { TraceId: traceId, ResultIndex: index }, c)
    if (!fq.ok) {
      throw new UserError(fq.unknown ? 'The airline did not confirm the fare in time. Please try again.' : `This fare is no longer available: ${fq.error.message}`, 409)
    }
    const quote = fq.data.Results
    if (!inrFare(quote)) throw new UserError('This fare cannot be booked online. Please contact us and we will book it for you.', 422)
    legs.push({
      key: legInputs.length === 2 ? (k === 0 ? 'OB' : 'IB') : 'MAIN',
      resultIndex: quote.ResultIndex,
      isLCC: Boolean(quote.IsLCC),
      source: quote.Source,
      quote,
      priceChanged: Boolean(fq.data.IsPriceChanged),
      changeInfo: fq.data.FlightDetailChangeInfo || null,
      rules: rule.ok ? (rule.data.FareRules || []).map((r) => ({ from: r.Origin, to: r.Destination, airline: r.Airline, basis: r.FareBasisCode, text: r.FareRuleDetail || '' })) : [],
      status: 'PENDING',
      attempts: {},
      ssr: [],
    })
  }

  const isDomestic = legs.every((l) => isDomesticResult(l.quote))
  const { last } = travelDates(legs)
  const id = rid(18)
  for (let tries = 0; ; tries++) {
    try {
      const b = await one(
        `insert into bookings (id, ref, status, journey_type, is_domestic, search, legs, trace_id, trace_started_at, travel_end)
         values ($1, $2, 'DRAFT', $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9) returning *`,
        [id, newRef(), s.journeyType, isDomestic, J(s), J(legs), traceId, trace.created_at, last || null],
      )
      await event(id, 'quoted', { legs: legs.map((l) => ({ index: l.resultIndex, published: inrFare(l.quote).PublishedFare, priceChanged: l.priceChanged })) })
      return draftView(b)
    } catch (e) {
      if (tries < 4 && /bookings_ref_key|unique|duplicate/i.test(e.message)) continue
      throw e
    }
  }
}

export async function getDraft(id) {
  return draftView(await load(id))
}

/* ---------------------------------------------------------------- draft: SSR */

export function pickSsr(data, isLCC) {
  return isLCC
    ? { Baggage: data.Baggage || [], MealDynamic: data.MealDynamic || [], SeatDynamic: data.SeatDynamic || [], SpecialServices: data.SpecialServices || [] }
    : { Meal: data.Meal || [], SeatPreference: data.SeatPreference || [] }
}

export const seatKey = (s) => `${s.Origin}-${s.Destination}-${s.FlightNumber}`
export const svcKey = (s) => `${s.Origin}-${s.Destination}-${s.Code}`
export const allSeats = (raw) => (raw.SeatDynamic || []).flatMap((d) => d.SegmentSeat || []).flatMap((g) => g.RowSeats || []).flatMap((r) => r.Seats || [])
export const allServices = (raw) => (raw.SpecialServices || []).flatMap((x) => x.SegmentSpecialService || []).flatMap((x) => x.SSRService || [])

/** SSR options shaped for the add-ons step (prices in paise, at cost). */
export function ssrView(raw, isLCC) {
  if (!raw) return null
  if (!isLCC) {
    return {
      lcc: false,
      meals: raw.Meal.map((m) => ({ code: m.Code, label: m.Description })),
      seatPrefs: raw.SeatPreference.map((m) => ({ code: m.Code, label: m.Description })),
    }
  }
  const group = (groups, label) => groups.map((g, i) => ({
    group: i,
    label: g[0] ? `${g[0].Origin} → ${g[0].Destination}` : `Part ${i + 1}`,
    options: g.map((o) => ({ code: o.Code, label: label(o), price: paise(o.Price), none: /^No(Baggage|Meal)$/i.test(o.Code) })),
  }))
  const segs = new Map()
  for (const s of allSeats(raw)) {
    const k = seatKey(s)
    if (!segs.has(k)) segs.set(k, { key: k, label: `${s.Origin} → ${s.Destination}`, flight: `${s.AirlineCode}-${s.FlightNumber}`, craft: s.CraftType, rows: new Map() })
    if (s.Code === 'NoSeat' || !s.SeatNo) continue
    const seg = segs.get(k)
    if (!seg.rows.has(s.RowNo)) seg.rows.set(s.RowNo, [])
    seg.rows.get(s.RowNo).push({ code: s.Code, col: s.SeatNo, open: Number(s.AvailablityType) === 1, price: paise(s.Price), type: s.SeatType, deck: s.Deck })
  }
  return {
    lcc: true,
    baggage: group(raw.Baggage, (o) => (o.Code === 'NoBaggage' ? 'No extra baggage' : `${o.Weight} kg${o.Text ? ` · ${o.Text}` : ''}`)),
    meals: group(raw.MealDynamic, (o) => (o.Code === 'NoMeal' ? 'No meal' : o.AirlineDescription || o.Code)),
    seats: [...segs.values()].map((s) => ({ ...s, rows: [...s.rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([row, seats]) => ({ row, seats: seats.sort((a, b) => a.col.localeCompare(b.col)) })) })),
    services: allServices(raw).map((s) => ({ key: svcKey(s), label: `${s.Text || s.Code} (${s.Origin} → ${s.Destination})`, price: paise(s.Price) })),
  }
}

/** Add-ons step: SSR per leg. Raw options are kept server-side to price the selection. */
export async function draftSsr(id, ctx) {
  const b = await load(id)
  if (!['DRAFT', 'AWAITING_PAYMENT'].includes(b.status)) throw new UserError('This booking can no longer be changed.', 409)
  if (traceLeftMs(b) < MIN_LEFT_MS) throw new UserError('The fare has expired. Please search again.', 410)
  const legs = b.legs
  const views = []
  for (const leg of legs) {
    const r = await call('SSR', { TraceId: b.trace_id, ResultIndex: leg.resultIndex }, { ...ctx, bookingId: b.id })
    leg.ssrRaw = r.ok ? pickSsr(r.data, leg.isLCC) : null
    views.push(ssrView(leg.ssrRaw, leg.isLCC))
  }
  const row = await one(
    `update bookings set legs = $3::jsonb, version = version + 1, updated_at = now()
     where id = $1 and version = $2 and status = any('{DRAFT,AWAITING_PAYMENT}'::text[]) returning version`,
    [id, b.version, J(legs)],
  )
  if (!row) throw new UserError('This booking changed in another tab. Please reload the page.', 409)
  return { version: row.version, legs: views }
}

/**
 * Turns the browser's add-on choices into TBO SSR objects taken from OUR
 * stored SSR response (so prices can't be tampered with), applying TBO's rules:
 * no seat/baggage for infants; free bags must be claimed on international
 * LCC; special fares (Super 6E, SpiceMax) need a free seat + meal; and if
 * one direction has a pick, the other direction gets the "No…" item.
 */
export function resolveSsr(leg, pax, sel, { isDomestic, seatMandatory, mealMandatory }) {
  const raw = leg.ssrRaw
  if (!raw) return pax.map((_, i) => ({ pax: i, items: [] }))
  const bad = () => new UserError('One of your add-ons is no longer available. Please choose again.', 409)

  return pax.map((p, i) => {
    const s = sel?.[i] || {}
    const infant = Number(p.type) === 3
    const items = []

    if (!leg.isLCC) {
      const meal = s.meal ? raw.Meal.find((m) => m.Code === s.meal) : null
      const seat = s.seat && !infant ? raw.SeatPreference.find((m) => m.Code === s.seat) : null
      if ((s.meal && !meal) || (s.seat && !infant && !seat)) throw bad()
      if (meal) items.push({ kind: 'meal', Code: meal.Code, Description: meal.Description })
      if (seat) items.push({ kind: 'seat', Code: seat.Code, Description: seat.Description })
      return { pax: i, items }
    }

    const groups = (kind, list, chosen, { autoFree, mandatory }) => {
      const picked = []
      list.forEach((grp, g) => {
        let o = null
        if (chosen?.[g] != null && chosen[g] !== '') {
          o = grp.find((x) => x.Code === chosen[g])
          if (!o) throw bad()
        }
        const free = grp.find((x) => Number(x.Price) === 0 && !/^No/i.test(x.Code))
        if (!o && (autoFree || mandatory) && free) o = free
        picked.push(o)
      })
      if (picked.some(Boolean)) {
        picked.forEach((o, g) => {
          const pad = o || list[g].find((x) => /^No/i.test(x.Code))
          if (pad) items.push({ kind, ...pad })
        })
      }
    }

    if (!infant) groups('baggage', raw.Baggage, s.baggage, { autoFree: !isDomestic, mandatory: false })
    groups('meal', raw.MealDynamic, s.meal, { autoFree: false, mandatory: mealMandatory })

    if (!infant) {
      const seats = allSeats(raw)
      const segKeys = [...new Set(seats.map(seatKey))]
      const chosen = segKeys.map((k) => {
        const code = s.seat?.[k]
        if (!code) {
          if (!seatMandatory) return null
          return seats.find((x) => seatKey(x) === k && Number(x.AvailablityType) === 1 && Number(x.Price) === 0 && x.SeatNo) || null
        }
        const o = seats.find((x) => seatKey(x) === k && x.Code === code)
        if (!o || Number(o.AvailablityType) !== 1) throw new UserError(`Seat ${code} has just been taken. Please pick another.`, 409)
        return o
      })
      if (chosen.some(Boolean)) {
        chosen.forEach((o, n) => {
          const pad = o || seats.find((x) => seatKey(x) === segKeys[n] && x.Code === 'NoSeat')
          if (pad) items.push({ kind: 'seat', ...pad })
        })
      }
    }

    for (const key of s.services || []) {
      const o = allServices(raw).find((x) => svcKey(x) === key)
      if (!o) throw bad()
      items.push({ kind: 'service', ...o })
    }
    return { pax: i, items }
  })
}

// Two passengers can't sit in the same seat.
function checkSeatClash(legs) {
  for (const leg of legs) {
    const taken = new Set()
    for (const s of leg.ssr) {
      for (const it of s.items) {
        if (it.kind !== 'seat' || it.Code === 'NoSeat' || !it.SeatNo) continue
        const k = `${seatKey(it)}:${it.Code}`
        if (taken.has(k)) throw new UserError(`Seat ${it.Code} is picked for two travellers.`)
        taken.add(k)
      }
    }
  }
}

/* ---------------------------------------------------------------- draft: travellers + payment */

function cleanPax(list) {
  const order = { 1: 0, 2: 1, 3: 2 }
  return (Array.isArray(list) ? list : [])
    .map((p) => ({
      type: Number(p.type),
      title: String(p.title || ''),
      gender: Number(p.gender),
      firstName: normName(p.firstName),
      lastName: normName(p.lastName),
      dob: p.dob || null,
      nationality: normName(p.nationality || 'IN').toUpperCase(),
      passportNo: normName(p.passportNo).toUpperCase() || null,
      passportExpiry: p.passportExpiry || null,
      passportIssueDate: p.passportIssueDate || null,
      passportIssueCountry: normName(p.passportIssueCountry).toUpperCase() || null,
      pan: normName(p.pan).toUpperCase() || null,
      guardian: p.guardian?.pan
        ? { title: String(p.guardian.title || 'Mr'), firstName: normName(p.guardian.firstName), lastName: normName(p.guardian.lastName), pan: normName(p.guardian.pan).toUpperCase() }
        : null,
      ff: p.ff?.number ? { airline: normName(p.ff.airline).toUpperCase(), number: normName(p.ff.number).toUpperCase() } : null,
    }))
    .sort((a, b) => order[a.type] - order[b.type]) // lead passenger = first adult
}

/** Travellers + add-ons → final server-side price → Razorpay order. */
export async function submitTravellers(id, body, ctx) {
  const b = await load(id)
  if (!['DRAFT', 'AWAITING_PAYMENT'].includes(b.status)) throw new UserError('This booking can no longer be changed.', 409)
  if (Number(body.version) !== b.version) throw new UserError('This booking changed in another tab. Please reload the page.', 409)
  if (traceLeftMs(b) < MIN_LEFT_MS) throw new UserError('The fare has expired. Please search again for live prices.', 410)

  // Editing after a payment attempt started could orphan that payment.
  if (b.status === 'AWAITING_PAYMENT' && b.rzp_order_id && !b.rzp_order_id.startsWith('fake_') && pay.configured()) {
    const order = await pay.fetchOrder(b.rzp_order_id).catch(() => null)
    if (order && order.status !== 'created') throw new UserError('A payment for this booking has already started.', 409)
  }

  const pax = cleanPax(body.pax)
  const contact = {
    email: normName(body.contact?.email).toLowerCase(),
    phone: normName(body.contact?.phone).replace(/\D/g, '').slice(-10),
    address: normName(body.contact?.address),
    city: normName(body.contact?.city),
    ip: ctx.ip || null,
  }
  const gst = body.gst?.number ? {
    number: normName(body.gst.number).toUpperCase(), company: normName(body.gst.company), email: normName(body.gst.email).toLowerCase(),
    phone: normName(body.gst.phone).replace(/\D/g, '').slice(-10), address: normName(body.gst.address),
  } : null

  const flags = flagsOf(b.legs, b.is_domestic)
  const errors = checkTravellers({ pax, contact, gst }, b.search, flags, travelDates(b.legs))
  if (errors.length) throw new UserError(errors[0].message, 400, { errors })

  const legs = b.legs.map((leg, li) => ({ ...leg, ssr: resolveSsr(leg, pax, body.ssr?.[li], flags) }))
  checkSeatClash(legs)
  const price = quoteTotal(legs)

  let orderId
  if (pay.configured()) orderId = (await pay.createOrder(price.total, b.ref, { booking: b.id, ref: b.ref })).id
  else if (pay.fakePayments()) orderId = `fake_${rid(9)}`
  else throw new UserError('Online payment is not switched on yet. Please call or WhatsApp us to book this fare.', 503)

  const token = rid(24)
  const row = await one(
    `update bookings set status = 'AWAITING_PAYMENT', version = version + 1, updated_at = now(),
       legs = $3::jsonb, pax = $4::jsonb, contact = $5::jsonb, gst = $6::jsonb, price = $7::jsonb,
       amount_paise = $8, rzp_order_id = $9, manage_token_hash = $10
     where id = $1 and version = $2 and status = any('{DRAFT,AWAITING_PAYMENT}'::text[]) and rzp_payment_id is null
     returning *`,
    [id, b.version, J(legs), J(pax), J(contact), J(gst), J(price), price.total, orderId, sha(token)],
  )
  if (!row) throw new UserError('This booking changed in another tab. Please reload the page.', 409)
  await event(id, 'awaiting_payment', { amount: price.total, order: orderId })
  return { ...draftView(row), manageToken: token }
}

/* ---------------------------------------------------------------- payment */

/**
 * Records a captured payment exactly once. Safe to call from the browser
 * callback, the webhook and the reconciler at the same time.
 */
async function recordPayment(b, p, via) {
  if (p.order_id !== b.rzp_order_id) {
    await event(b.id, 'payment_for_old_order', { payment: p.id, order: p.order_id, amount: p.amount, via })
    await flag(b.id, `Payment ${p.id} was made on an older order — refund or rebook it.`)
    return null
  }
  let status = p.status
  if (status === 'authorized' && !String(p.id).startsWith('fake_')) {
    try { status = (await pay.capturePayment(p.id, p.amount)).status } catch { status = (await pay.fetchPayment(p.id)).status }
  }
  if (status !== 'captured') return null

  if (Number(p.amount) !== Number(b.amount_paise)) {
    await event(b.id, 'amount_mismatch', { payment: p.id, amount: p.amount, expected: b.amount_paise })
    await flag(b.id, `Payment ${p.id} amount ${rupees(p.amount)} does not match ${rupees(b.amount_paise)}.`)
    return null
  }

  const row = await one(
    `update bookings set status = 'PAID', rzp_payment_id = $2, version = version + 1, updated_at = now()
     where id = $1 and status = any('{AWAITING_PAYMENT,EXPIRED}'::text[]) and rzp_payment_id is null returning *`,
    [b.id, p.id],
  )
  if (row) {
    await event(b.id, 'paid', { payment: p.id, amount: p.amount, via })
    return row
  }
  const cur = await load(b.id)
  if (cur.rzp_payment_id !== p.id && cur.rzp_payment_id) {
    // The same order was paid twice (rare, but Razorpay allows retries).
    await event(b.id, 'duplicate_payment', { payment: p.id, amount: p.amount, via })
    await flag(b.id, `A second payment ${p.id} (${rupees(p.amount)}) was received — refund it.`)
  }
  return cur
}

export async function flag(id, note) {
  await q(`update bookings set attention = case when attention is null then $2 else attention || ' | ' || $2 end, updated_at = now() where id = $1`, [id, note])
}

/** Browser callback after Razorpay Checkout. Waits for ticketing (up to ~5 min). */
export async function verifyPayment(id, { orderId, paymentId, signature }) {
  const b = await load(id)
  if (!orderId || orderId !== b.rzp_order_id) throw new UserError('This payment does not belong to this booking.', 400)
  if (!pay.checkoutSignatureValid(orderId, paymentId, signature)) throw new UserError('We could not verify this payment.', 400)
  const p = await pay.fetchPayment(paymentId)
  const paid = await recordPayment(b, p, 'checkout')
  if (!paid) throw new UserError('Your payment has not completed yet. If money was taken, we will refund it automatically or contact you.', 402)
  await fulfil(id)
  return statusOf(id)
}

/** Certification / testing only: pay without a card (see razorpay.fakePayments). */
export async function fakePay(id) {
  if (!pay.fakePayments()) throw new UserError('Not available.', 403)
  const b = await load(id)
  if (!b.rzp_order_id?.startsWith('fake_')) throw new UserError('Not available.', 403)
  const paid = await recordPayment(b, { id: `fake_pay_${rid(8)}`, order_id: b.rzp_order_id, amount: b.amount_paise, status: 'captured' }, 'test')
  if (!paid) throw new UserError('Already paid.', 409)
  await fulfil(id)
  return statusOf(id)
}

/** Razorpay webhook (order.paid / payment.captured). Answers fast; ticketing continues in waitUntil. */
export async function webhook(raw, signature, waitUntil, onOtherOrder) {
  if (!pay.webhookSignatureValid(raw, signature)) throw new UserError('Bad signature.', 401)
  const evt = JSON.parse(raw)
  const p = evt.payload?.payment?.entity
  if (!p?.order_id || !['order.paid', 'payment.captured', 'payment.authorized'].includes(evt.event)) return { ignored: true }
  const b = await one(`select * from bookings where rzp_order_id = $1`, [p.order_id])
  // Not a booking's order: maybe a date change / add-on payment (server/changes.js).
  if (!b) return onOtherOrder ? onOtherOrder(p, `webhook:${evt.event}`) : { ignored: true }
  const paid = await recordPayment(b, p, `webhook:${evt.event}`)
  if (paid) waitUntil(fulfil(b.id).catch((e) => console.error('fulfil from webhook', e)))
  return { ok: true }
}

export async function statusOf(id) {
  const b = await load(id)
  return { status: b.status, ref: b.ref, statusText: PUBLIC_STATUS[b.status] }
}

/* ---------------------------------------------------------------- ticketing */

/** Writes into one leg — only while we still hold the claim. */
async function patchLeg(b, i, patch) {
  const row = await one(
    `update bookings set legs = jsonb_set(legs, $2::text[], (legs -> $3::int) || $4::jsonb), version = version + 1, updated_at = now()
     where id = $1 and claimed_by = $5 returning legs, version`,
    [b.id, [String(i)], i, J(patch), b.claimed_by],
  )
  if (!row) throw new LostClaim()
  b.legs = row.legs
  b.version = row.version
}

class LostClaim extends Error {
  constructor() { super('Another worker took over this booking.') }
}

async function fail(b, i, message, status = 'FAILED') {
  await patchLeg(b, i, { status, error: message })
  await event(b.id, 'leg_failed', { leg: i, status, message })
  return status
}

const tboDate = (d) => (d ? dt(d) : undefined)

/** Passenger objects for Book / LCC Ticket, per TBO's rules. */
// SpiceJet's Navitaire system takes MR/MS for children and MSTR/MR/MS for infants (TBO validation list).
const SG_TITLES = { 2: { Mstr: 'Mr', Miss: 'Ms' }, 3: { Miss: 'Ms' } }
const airlineOf = (leg) => leg.quote?.AirlineCode || leg.quote?.ValidatingAirline || tripsOf(leg.quote)[0]?.[0]?.Airline?.AirlineCode

function tboPassengers(b, leg, { lccSsr, paxFares } = {}) {
  const pax = b.pax
  const c = b.contact
  const sg = airlineOf(leg) === 'SG'
  const ssrFor = (i) => leg.ssr?.find((s) => s.pax === i)?.items || []
  const strip = ({ kind, ...rest }) => rest

  return pax.map((p, i) => {
    const items = ssrFor(i)
    const lead = i === 0
    const out = {
      Title: (sg && SG_TITLES[p.type]?.[p.title]) || p.title,
      FirstName: p.firstName,
      LastName: p.lastName,
      PaxType: p.type,
      DateOfBirth: tboDate(p.dob),
      Gender: p.gender,
      PassportNo: p.passportNo || undefined,
      PassportExpiry: tboDate(p.passportExpiry),
      PassportIssueDate: tboDate(p.passportIssueDate),
      PassportIssueCountryCode: p.passportIssueCountry || undefined,
      PAN: p.pan || undefined,
      AddressLine1: c.address,
      AddressLine2: '',
      City: c.city,
      CountryCode: 'IN',
      CountryName: 'India',
      Nationality: p.nationality || 'IN',
      CellCountryCode: '+91-',
      ContactNo: c.phone,
      Email: c.email,
      IsLeadPax: lead,
      FFAirlineCode: p.ff?.airline || null,
      FFNumber: p.ff?.number || '',
      Fare: paxFares?.[i] || paxFare(leg.quote, p.type, pax.length),
      GSTCompanyAddress: lead && b.gst ? b.gst.address : '',
      GSTCompanyContactNumber: lead && b.gst ? b.gst.phone : '',
      GSTCompanyName: lead && b.gst ? b.gst.company : '',
      GSTNumber: lead && b.gst ? b.gst.number : '',
      GSTCompanyEmail: lead && b.gst ? b.gst.email : '',
    }
    if (p.guardian && !p.pan) out.GuardianDetails = { Title: p.guardian.title, FirstName: p.guardian.firstName, LastName: p.guardian.lastName, PAN: p.guardian.pan }

    if (lccSsr) {
      // LCC: arrays; only send the kinds the traveller actually has.
      const of = (k) => items.filter((x) => x.kind === k).map(strip)
      if (of('baggage').length) out.Baggage = of('baggage')
      if (of('meal').length) out.MealDynamic = of('meal')
      if (of('seat').length) out.SeatDynamic = of('seat')
      if (of('service').length) out.SpecialServices = of('service')
    } else {
      // Non-LCC: single objects (meal / seat preference), passed in Book.
      const meal = items.find((x) => x.kind === 'meal')
      const seat = items.find((x) => x.kind === 'seat')
      if (meal) out.Meal = strip(meal)
      if (seat) out.Seat = strip(seat)
    }
    return out
  })
}

/** TBO: when SSR is used, SSR must be the last call before Book/Ticket. Also re-checks prices. */
async function refreshSsr(b, i, ctx) {
  const leg = b.legs[i]
  if (!leg.ssr?.some((s) => s.items.some((it) => !/^No/i.test(it.Code)))) return null
  const r = await call('SSR', { TraceId: b.trace_id, ResultIndex: leg.resultIndex }, ctx)
  if (!r.ok) return `Add-ons could not be confirmed (${r.error?.message}).`
  const fresh = pickSsr(r.data, leg.isLCC)
  if (!leg.isLCC) return null
  const pool = [...fresh.Baggage.flat(), ...fresh.MealDynamic.flat(), ...allSeats(fresh), ...allServices(fresh)]
  for (const s of leg.ssr) {
    for (const it of s.items) {
      if (/^No/i.test(it.Code)) continue
      const now = pool.find((x) => x.Code === it.Code && x.Origin === it.Origin && x.Destination === it.Destination)
      if (!now) return `Add-on ${it.Code} is no longer available.`
      if (paise(now.Price) > paise(it.Price)) return `Add-on ${it.Code} now costs more (${rupees(paise(now.Price))}).`
      if (it.kind === 'seat' && Number(now.AvailablityType) !== 1) return `Seat ${it.Code} was taken by someone else.`
    }
  }
  return null
}

export const ctxOf = (b) => ({ bookingId: b.id, traceId: b.trace_id, ip: b.contact?.ip || undefined })

/** First attempt for a leg: SSR refresh → Book (non-LCC / hold-mandatory) → Ticket. */
async function issueLeg(b, i, opts) {
  if (traceLeftMs(b) <= 0) return fail(b, i, 'The 15-minute fare session expired before ticketing. Rebook on the TBO portal or refund.')
  const ctx = ctxOf(b)
  const ssrProblem = await refreshSsr(b, i, ctx)
  if (ssrProblem && !opts.acceptIncrease) return fail(b, i, ssrProblem, 'PRICE')
  const leg = b.legs[i]
  const hasSsr = leg.ssr?.some((s) => s.items.length)
  if (!leg.isLCC || (leg.quote.IsHoldMandatoryWithSSR && hasSsr)) {
    const held = await bookLeg(b, i, opts, ctx)
    if (held !== 'HELD') return held
  }
  return ticketLeg(b, i, opts, ctx)
}

async function bookLeg(b, i, opts, ctx) {
  const leg = b.legs[i]
  await patchLeg(b, i, { attempts: { ...leg.attempts, book: nowIso() } })
  const r = await call('Book', {
    TraceId: b.trace_id,
    ResultIndex: leg.resultIndex,
    Passengers: tboPassengers(b, leg, { lccSsr: leg.isLCC }),
  }, ctx)
  if (r.unknown) {
    await patchLeg(b, i, { status: 'UNKNOWN', error: 'Book timed out' })
    return checkLeg(b, i, { polls: 3 })
  }
  const inner = r.data?.Response && typeof r.data.Response === 'object' ? r.data.Response : r.data
  if (!r.ok) return checkLeg(b, i, { polls: 1, definitive: true, failMessage: `Booking failed: ${r.error.message}` })

  const it = inner.FlightItinerary || {}
  const pnr = inner.PNR || it.PNR
  const bookingId = inner.BookingId || it.BookingId
  if (!pnr || !bookingId || ![1, 5].includes(Number(inner.Status ?? 1))) {
    return checkLeg(b, i, { polls: 1, definitive: true, failMessage: 'The airline did not confirm the booking.' })
  }
  // The PNR exists now, whatever else changed: record it first so staff can
  // always ticket or release it.
  await patchLeg(b, i, { status: 'HELD', pnr, bookingId, error: null })
  await event(b.id, 'held', { leg: i, pnr, bookingId, priceChanged: Boolean(inner.IsPriceChanged), timeChanged: Boolean(inner.IsTimeChanged) })

  // TBO: after a price/time change at Book, call Ticket on this PNR with
  // IsPriceChangeAccepted — never Book again.
  if (inner.IsTimeChanged || inner.IsPriceChanged) {
    const up = inner.IsPriceChanged
      ? (it.Fare ? paise(it.Fare.PublishedFare) - paise(inrFare(leg.quote).PublishedFare) : Infinity)
      : 0
    if (!opts.acceptIncrease && (inner.IsTimeChanged || up > 0)) {
      const why = inner.IsTimeChanged
        ? `The airline changed the flight timing on PNR ${pnr} — the customer must agree before we ticket.`
        : `The fare went up by ${Number.isFinite(up) ? rupees(up) : 'an unknown amount'} on PNR ${pnr}.`
      return fail(b, i, why, 'PRICE')
    }
    await patchLeg(b, i, { acceptChange: true })
  }
  return 'HELD'
}

async function ticketLeg(b, i, opts, ctx = ctxOf(b)) {
  const leg = b.legs[i]
  const held = leg.status === 'HELD'
  // Accepted: a lower/equal fare TBO re-priced, a change staff agreed with the
  // customer (retry), or a change already accepted at Book.
  const accept = opts.acceptPrice || leg.acceptChange || (held && opts.acceptIncrease) ? { IsPriceChangeAccepted: true } : {}
  const body = held
    ? { TraceId: b.trace_id, PNR: leg.pnr, BookingId: leg.bookingId, ...accept }
    : { TraceId: b.trace_id, ResultIndex: leg.resultIndex, AgentReferenceNo: b.ref, Passengers: tboPassengers(b, leg, { lccSsr: true, paxFares: opts.paxFares }), ...accept }

  // Saved BEFORE the call: from here on this leg is only ever re-checked, never re-ticketed.
  await patchLeg(b, i, { attempts: { ...leg.attempts, ticket: nowIso() } })
  const r = await call('Ticket', body, ctx)
  if (r.unknown) {
    await patchLeg(b, i, { status: 'UNKNOWN', error: 'Ticket timed out' })
    return checkLeg(b, i, { polls: 4 })
  }
  const inner = r.data?.Response && typeof r.data.Response === 'object' ? r.data.Response : (r.data || {})
  const ts = Number(inner.TicketStatus ?? inner.FlightItinerary?.TicketStatus ?? NaN)

  if (inner.IsPriceChanged || ts === 8) {
    const newFare = inner.FlightItinerary?.Fare
    const up = newFare ? paise(newFare.PublishedFare) - paise(inrFare(leg.quote).PublishedFare) : Infinity
    if (up > 0 && !opts.acceptIncrease) {
      await patchLeg(b, i, { status: held ? 'HELD' : 'PENDING', attempts: { ...b.legs[i].attempts, ticket: undefined } })
      return fail(b, i, `The fare went up by ${Number.isFinite(up) ? rupees(up) : 'an unknown amount'} at ticketing.`, 'PRICE')
    }
    if (opts.acceptPrice) return checkLeg(b, i, { polls: 2, failMessage: 'The fare kept changing at ticketing.' })
    // Price not higher: accept it and ticket again (TBO: IsPriceChangeAccepted = true).
    await patchLeg(b, i, { attempts: { ...b.legs[i].attempts, ticket: undefined } })
    const paxFares = held ? undefined : (inner.FlightItinerary?.Passenger || []).map((p) => p.Fare && {
      Currency: 'INR', BaseFare: p.Fare.BaseFare, Tax: p.Fare.Tax, YQTax: p.Fare.YQTax || 0,
      AdditionalTxnFeePub: p.Fare.AdditionalTxnFeePub || 0, AdditionalTxnFeeOfrd: p.Fare.AdditionalTxnFeeOfrd || 0, OtherCharges: p.Fare.OtherCharges || 0,
    })
    return ticketLeg(b, i, { ...opts, acceptPrice: true, paxFares: paxFares?.every(Boolean) ? paxFares : undefined }, ctx)
  }

  if (ts === 4) return fail(b, i, `The airline did not allow ticketing: ${r.error?.message || inner.Message || 'not allowed'}`)
  // Success, "already created", in-progress or an unclear failure: TBO says
  // GetBookingDetails is the truth — never guess, never re-ticket.
  return checkLeg(b, i, {
    polls: ts === 1 || ts === 6 ? 2 : 4,
    pnr: inner.PNR,
    bookingId: inner.BookingId,
    definitive: !r.ok && !inner.PNR && ts !== 5,
    failMessage: r.error?.message || inner.Message,
  })
}

/** GetBookingDetails is the source of truth for whether a leg was ticketed. */
async function checkLeg(b, i, hint = {}) {
  const leg = b.legs[i]
  const ctx = ctxOf(b)
  const bookingId = hint.bookingId || leg.bookingId
  const pnr = hint.pnr || leg.pnr
  const req = bookingId ? { BookingId: bookingId, ...(pnr ? { PNR: pnr } : {}) } : { TraceId: b.trace_id }
  // TBO reports a booking's Origin/Destination as its FIRST trip (DEL→BOM on a DEL⇄BOM return).
  const firstTrip = tripsOf(leg.quote)[0] || []
  const from = firstTrip[0]?.Origin?.Airport?.AirportCode
  const to = firstTrip[firstTrip.length - 1]?.Destination?.Airport?.AirportCode

  for (let n = 0; n < (hint.polls ?? 1); n++) {
    if (n > 0) await sleep(POLL_MS)
    const r = await call('GetBookingDetails', req, ctx)
    if (r.unknown || /under process/i.test(r.error?.message || '')) continue
    const it = r.data?.FlightItinerary
    // Looked up by TraceId, a domestic return's two PNRs share it: make sure this one is ours.
    // (A lookup by BookingId is already exact.)
    if (!it || !(it.BookingId || it.PNR)) break
    if (!bookingId && it.Origin && it.Destination && (it.Origin !== from || it.Destination !== to)) break

    const tickets = (it.Passenger || []).map((p) => ({
      paxId: p.PaxId,
      ticketId: p.Ticket?.TicketId ?? null,
      number: p.Ticket?.TicketNumber ?? null,
      name: `${p.Title || ''} ${p.FirstName || ''} ${p.LastName || ''}`.trim(),
      type: p.PaxType,
    }))
    if (tickets.length && tickets.every((t) => t.ticketId && t.number)) {
      await patchLeg(b, i, { status: 'TICKETED', pnr: it.PNR, bookingId: it.BookingId, tickets, invoiceNo: it.InvoiceNo || null, error: null })
      await event(b.id, 'ticketed', { leg: i, pnr: it.PNR, bookingId: it.BookingId })
      return 'TICKETED'
    }
    if (it.PNR) {
      await patchLeg(b, i, { status: 'HELD', pnr: it.PNR, bookingId: it.BookingId, error: b.legs[i].attempts?.ticket ? 'PNR exists but tickets are not issued yet' : null })
      if (!b.legs[i].attempts?.ticket) return 'HELD'
    }
  }

  const started = Date.parse(b.legs[i].attempts?.ticket || b.legs[i].attempts?.book || 0)
  if (hint.definitive || Date.now() - started > 10 * 60_000) {
    if (b.legs[i].status === 'HELD') return fail(b, i, hint.failMessage || 'The PNR is on hold but the ticket was not issued.', 'HELD_NOT_TICKETED')
    return fail(b, i, hint.failMessage || 'The ticket was not issued.')
  }
  if (b.legs[i].status !== 'UNKNOWN') await patchLeg(b, i, { status: 'UNKNOWN' })
  return 'UNKNOWN'
}

/**
 * Drives every leg as far as it can safely go. Used by the first ticketing
 * attempt AND by the reconciler, so a crash halfway resumes correctly:
 * - a leg with a ticket attempt is only re-checked (GetBookingDetails)
 * - a held PNR with no ticket attempt is ticketed
 * - an untouched leg is booked/ticketed from scratch.
 */
async function run(b, opts = {}) {
  for (let i = 0; i < b.legs.length; i++) {
    const leg = b.legs[i]
    let st = leg.status
    if (st === 'TICKETED') continue
    if (['FAILED', 'PRICE', 'HELD_NOT_TICKETED'].includes(st)) break
    if (leg.attempts?.ticket) st = await checkLeg(b, i, { polls: 1 })
    else if (st === 'PENDING' && !leg.attempts?.book) st = await issueLeg(b, i, opts)
    else if (st !== 'HELD') st = await checkLeg(b, i, { polls: 1 })
    if (st === 'HELD' && !b.legs[i].attempts?.ticket) st = await ticketLeg(b, i, opts)
    if (st !== 'TICKETED') break
  }
  return settle(b)
}

async function settle(b) {
  const states = b.legs.map((l) => l.status)
  if (states.every((s) => s === 'TICKETED')) {
    const row = await one(
      `update bookings set status = 'CONFIRMED', claimed_by = null, version = version + 1, updated_at = now()
       where id = $1 and claimed_by = $2 and status = 'TICKETING' returning *`, [b.id, b.claimed_by])
    if (row) await event(b.id, 'confirmed', { pnrs: b.legs.map((l) => l.pnr) })
    return 'CONFIRMED'
  }
  if (states.includes('UNKNOWN')) {
    // Leave it in TICKETING; the reconciler keeps checking GetBookingDetails.
    await q(`update bookings set claimed_at = now() - make_interval(secs => $3), updated_at = now() where id = $1 and claimed_by = $2`,
      [b.id, b.claimed_by, TAKEOVER_SECONDS - 60])
    return 'TICKETING'
  }
  const why = b.legs.map((l, i) => (l.status === 'TICKETED' ? null : `${l.key === 'MAIN' ? 'Flight' : l.key} ${i + 1}: ${l.error || l.status}`)).filter(Boolean).join(' · ')
  return needsStaff(b, why)
}

async function needsStaff(b, reason) {
  const row = await one(
    `update bookings set status = 'ATTENTION', claimed_by = null, version = version + 1, updated_at = now(),
       attention = case when attention is null then $3 else attention || ' | ' || $3 end
     where id = $1 and claimed_by = $2 and status = 'TICKETING' returning id`, [b.id, b.claimed_by, reason])
  if (row) await event(b.id, 'attention', { reason })
  return 'ATTENTION'
}

/** PAID → TICKETING exactly once, then ticket. Anyone else just gets the status. */
export async function fulfil(id, opts = {}) {
  const claim = rid(9)
  const b = await one(
    `update bookings set status = 'TICKETING', claimed_by = $2, claimed_at = now(), version = version + 1, updated_at = now()
     where id = $1 and status = 'PAID' returning *`, [id, claim])
  if (!b) return null
  await event(id, 'ticketing', { claim })
  try {
    return await run(b, opts)
  } catch (e) {
    if (e instanceof LostClaim) return null
    console.error('ticketing error', id, e)
    return needsStaff(b, `Unexpected error while ticketing: ${e.message}`)
  }
}

/* ---------------------------------------------------------------- cancellation */

function ticketShare(leg, pax, ticketIds) {
  // Share of the leg's published fare that belongs to these tickets.
  const total = inrFare(leg.quote)
  const per = (type) => {
    const row = (leg.quote.FareBreakdown || []).find((x) => Number(x.PassengerType) === Number(type))
    const n = Number(row?.PassengerCount) || 1
    return row ? (Number(row.BaseFare) + Number(row.Tax)) / n + Number(total.OtherCharges || 0) / pax.length : 0
  }
  const sum = (leg.tickets || []).filter((t) => ticketIds.includes(t.ticketId)).reduce((a, t) => a + per(t.type), 0)
  return paise(sum)
}

/** Estimated charges before the customer confirms (TBO GetCancellationCharges). */
export async function cancelQuote(b, { legs }) {
  const out = []
  for (const i of legs || b.legs.map((_, n) => n)) {
    const leg = b.legs[i]
    if (!leg || leg.status !== 'TICKETED') continue
    const r = await call('GetCancellationCharges', { BookingId: leg.bookingId, RequestType: 1, BookingMode: 5 }, ctxOf(b))
    const charge = r.ok ? paise(r.data.CancellationCharge) : null
    const share = ticketShare(leg, b.pax, (leg.tickets || []).filter((t) => !t.cancelled).map((t) => t.ticketId))
    out.push({
      leg: i,
      pnr: leg.pnr,
      charge,
      estimate: charge == null ? null : Math.max(0, share - charge),
      remarks: r.ok ? r.data.Remarks || null : 'Charges will be confirmed by the airline after cancellation.',
    })
  }
  return { legs: out, note: 'Our service fee and paid add-ons (seats, meals, baggage) are not refundable. The airline confirms the final amount.' }
}

/**
 * Cancel whole legs or some travellers. pax: indexes into b.pax, or omitted
 * for everyone. Only one cancellation can run at a time (CONFIRMED → CANCELLING).
 */
export async function cancel(b, { legs, pax, reason }) {
  const claim = rid(9)
  const c = await one(
    `update bookings set status = 'CANCELLING', claimed_by = $2, claimed_at = now(), version = version + 1, updated_at = now()
     where id = $1 and status = 'CONFIRMED' returning *`, [b.id, claim])
  if (!c) throw new UserError('A change is already in progress for this booking.', 409)

  const chosenLegs = (Array.isArray(legs) && legs.length ? legs : c.legs.map((_, n) => n)).filter((i) => c.legs[i]?.status === 'TICKETED')
  const wantPax = Array.isArray(pax) && pax.length ? new Set(pax.map(Number)) : null
  const nameOf = (p) => `${p.firstName} ${p.lastName}`.toLowerCase()
  let sent = 0
  try {
    for (const i of chosenLegs) {
      const leg = c.legs[i]
      const live = (leg.tickets || []).filter((t) => !t.cancelled && t.ticketId)
      const pick = wantPax
        ? live.filter((t) => c.pax.some((p, pi) => wantPax.has(pi) && t.name.toLowerCase().endsWith(nameOf(p))))
        : live
      if (!pick.length) continue
      const full = pick.length === live.length
      const trips = tripsOf(leg.quote)
      const ctx = ctxOf(c)
      // TBO: charges must be fetched before cancelling GDS/NDC tickets.
      await call('GetCancellationCharges', { BookingId: leg.bookingId, RequestType: 1, BookingMode: 5 }, ctx)
      await patchLeg(c, i, { attempts: { ...leg.attempts, cancel: nowIso() } })
      const r = await call('SendChangeRequest', {
        BookingId: leg.bookingId,
        RequestType: full ? 1 : 2,
        CancellationType: 3,
        ...(full ? {} : { Sectors: trips.map((t) => ({ Origin: t[0].Origin.Airport.AirportCode, Destination: t[t.length - 1].Destination.Airport.AirportCode })) }),
        TicketId: pick.map((t) => t.ticketId),
        Remarks: normName(reason) || 'Cancelled by customer online',
      }, ctx)
      if (r.unknown) {
        await flag(c.id, `Cancellation for PNR ${leg.pnr} was sent but TBO did not reply — check the TBO portal.`)
        continue
      }
      if (!r.ok) {
        await event(c.id, 'cancel_failed', { leg: i, message: r.error.message })
        await flag(c.id, `Cancellation for PNR ${leg.pnr} failed: ${r.error.message}`)
        continue
      }
      const crs = (r.data.TicketCRInfo || []).map((x) => ({
        id: x.ChangeRequestId,
        ticketId: x.TicketId ?? null,
        ticketIds: x.TicketId ? [x.TicketId] : pick.map((t) => t.ticketId),
        status: Number(x.ChangeRequestStatus ?? 1),
        refunded: x.RefundedAmount != null ? paise(x.RefundedAmount) : null,
        charge: x.CancellationCharge != null ? paise(x.CancellationCharge) + paise(x.ServiceTaxOnRAF) : null,
        at: nowIso(),
      }))
      await patchLeg(c, i, { changeRequests: [...(c.legs[i].changeRequests || []), ...crs] })
      await event(c.id, 'cancel_requested', { leg: i, pnr: leg.pnr, full, tickets: pick.map((t) => t.ticketId), crs: crs.map((x) => x.id) })
      sent++
    }
  } finally {
    await q(`update bookings set claimed_by = null, updated_at = now() where id = $1 and claimed_by = $2`, [c.id, claim])
  }
  if (!sent) {
    await one(`update bookings set status = 'CONFIRMED', version = version + 1 where id = $1 and status = 'CANCELLING' returning id`, [c.id])
    throw new UserError('The cancellation could not be sent. Our team has been alerted and will contact you.', 502)
  }
  await refreshCancellation(c.id)
  return { ok: true }
}

/** Polls TBO for open change requests; completes the cancellation and proposes refunds. */
async function refreshCancellation(id) {
  for (let round = 0; round < 3; round++) {
    const b = await load(id)
    if (b.status !== 'CANCELLING') return
    const legs = structuredClone(b.legs)
    const proposals = []
    for (const leg of legs) {
      for (const cr of leg.changeRequests || []) {
        if (cr.applied) continue
        // TBO may already report a request as completed in SendChangeRequest's own reply.
        if (![4, 5, 6].includes(cr.status) || cr.refunded == null) {
          const r = await call('GetChangeRequestStatus', { ChangeRequestId: cr.id }, ctxOf(b))
          if (!r.ok) continue
          cr.status = Number(r.data.ChangeRequestStatus)
          cr.refunded = r.data.RefundedAmount != null ? paise(r.data.RefundedAmount) : cr.refunded
          cr.charge = r.data.CancellationCharge != null ? paise(r.data.CancellationCharge) + paise(r.data.ServiceTaxOnRAF) : cr.charge
        }
        if (cr.status === 4 || (cr.status === 6 && cr.refunded != null)) {
          cr.applied = true
          for (const t of leg.tickets || []) if (cr.ticketIds.includes(t.ticketId)) t.cancelled = true
          const share = ticketShare(leg, b.pax, cr.ticketIds)
          const amount = Math.max(0, share - (cr.charge || 0))
          if (amount > 0) proposals.push({ key: `cr:${cr.id}`, amount, note: `PNR ${leg.pnr} cancelled (change request ${cr.id})` })
        }
      }
      const tickets = leg.tickets || []
      if (tickets.length && tickets.every((t) => t.cancelled)) leg.status = 'CANCELLED'
    }

    const open = legs.some((l) => (l.changeRequests || []).some((cr) => ![4, 5, 6].includes(cr.status)))
    const newlyRejected = legs.flatMap((l) => (l.changeRequests || []).filter((cr) => cr.status === 5 && !cr.flagged))
    newlyRejected.forEach((cr) => { cr.flagged = true })
    const rejected = newlyRejected.length > 0
    const allCancelled = legs.every((l) => l.status === 'CANCELLED')
    const next = open ? 'CANCELLING' : allCancelled ? 'CANCELLED' : 'CONFIRMED'

    const row = await one(
      `update bookings set legs = $3::jsonb, status = $4, version = version + 1, updated_at = now()
       where id = $1 and version = $2 and status = 'CANCELLING' returning id`, [id, b.version, J(legs), next])
    if (!row) continue // someone else updated it — re-read and try again
    for (const p of proposals) await proposeRefund(b, p.key, p.amount, p.note)
    if (rejected) await flag(id, 'The airline rejected a cancellation request — contact the customer.')
    if (next !== 'CANCELLING') await event(id, next === 'CANCELLED' ? 'cancelled' : 'partly_cancelled', null)
    return
  }
}

/* ---------------------------------------------------------------- refunds (staff-approved) */

/** paymentId: null = the booking's own payment; otherwise a change's Razorpay payment. */
export async function proposeRefund(b, idemKey, amount, reason, paymentId = null) {
  const cap = await refundable(b, paymentId)
  const amt = Math.min(amount, cap)
  if (amt <= 0) return
  const row = await one(
    `insert into refunds (booking_id, idem_key, reason, amount_paise, status, payment_id) values ($1, $2, $3, $4, 'pending', $5)
     on conflict (idem_key) do nothing returning id`, [b.id, idemKey, reason, amt, paymentId])
  if (row) await event(b.id, 'refund_proposed', { refund: row.id, amount: amt, reason, payment: paymentId })
}

/** What is left to refund on one payment (each payment is capped separately). */
async function refundable(b, paymentId = null) {
  let paid = Number(b.amount_paise || 0)
  if (paymentId) {
    const c = await one(`select amount_paise from changes where booking_id = $1 and rzp_payment_id = $2`, [b.id, paymentId])
    paid = Number(c?.amount_paise || 0)
  }
  const r = await one(
    `select coalesce(sum(amount_paise), 0)::int as used from refunds
     where booking_id = $1 and status in ('processing', 'done') and payment_id is not distinct from $2`, [b.id, paymentId])
  return Math.max(0, paid - Number(r.used))
}

/** Staff: approve a proposed refund (optionally changing the amount) — sent to Razorpay once. */
export async function approveRefund(refundId, { amount }, staff) {
  const cur = await one(`select r.*, b.rzp_payment_id, b.amount_paise as paid from refunds r join bookings b on b.id = r.booking_id where r.id = $1`, [refundId])
  if (!cur) throw new UserError('Refund not found.', 404)
  const b = await load(cur.booking_id)
  const amt = amount != null ? Math.round(Number(amount)) : cur.amount_paise
  if (!(amt > 0) || amt > (await refundable(b, cur.payment_id))) throw new UserError('That amount is more than what is left to refund.')

  const r = await one(
    `update refunds set status = 'processing', amount_paise = $2, created_by = $3, updated_at = now()
     where id = $1 and status in ('pending', 'failed') returning *`, [refundId, amt, staff])
  if (!r) throw new UserError('This refund is already being processed.', 409)
  try {
    const paymentId = r.payment_id || b.rzp_payment_id
    const fake = !paymentId || paymentId.startsWith('fake_')
    const res = fake ? { id: `fake_rfnd_${rid(6)}` } : await pay.refundPayment(paymentId, amt, `rf_${r.id}`, { booking: b.ref, reason: r.reason })
    await q(`update refunds set status = 'done', rzp_refund_id = $2, error = null, updated_at = now() where id = $1`, [r.id, res.id])
    await event(b.id, 'refunded', { refund: r.id, amount: amt, rzp: res.id, by: staff })
    return { ok: true }
  } catch (e) {
    await q(`update refunds set status = 'failed', error = $2, updated_at = now() where id = $1`, [r.id, e.message])
    throw new UserError(`Razorpay refused the refund: ${e.message}`, 502)
  }
}

/** Staff: a new refund (e.g. ticketing failed and the customer wants their money back). */
export async function createRefund(bookingId, { amount, reason, idemKey }, staff) {
  const b = await load(bookingId)
  if (!b.rzp_payment_id) throw new UserError('This booking has no payment to refund.')
  const amt = Math.round(Number(amount))
  if (!(amt > 0)) throw new UserError('Enter an amount.')
  const row = await one(
    `insert into refunds (booking_id, idem_key, reason, amount_paise, status, created_by) values ($1, $2, $3, $4, 'pending', $5)
     on conflict (idem_key) do nothing returning id`,
    [b.id, `staff:${b.id}:${String(idemKey || '').slice(0, 64)}`, normName(reason) || 'Refund by staff', amt, staff])
  if (!row) throw new UserError('This refund was already created.', 409)
  return approveRefund(row.id, { amount: amt }, staff)
}

/* ---------------------------------------------------------------- staff actions */

/** Retry ticketing for a booking on hold (e.g. after the customer agreed to a higher fare). */
export async function staffRetry(id, { acceptIncrease }, staff) {
  const b = await load(id)
  if (b.status !== 'ATTENTION' || !b.rzp_payment_id) throw new UserError('Only paid bookings that need attention can be retried.', 409)
  // Before resetting a failed leg, make sure TBO really has no ticket for it.
  const claim = rid(9)
  const c = await one(`update bookings set status = 'TICKETING', claimed_by = $2, claimed_at = now(), version = version + 1 where id = $1 and status = 'ATTENTION' returning *`, [id, claim])
  if (!c) throw new UserError('Someone else is already working on this booking.', 409)
  try {
    for (let i = 0; i < c.legs.length; i++) {
      const leg = c.legs[i]
      if (!['FAILED', 'PRICE'].includes(leg.status)) continue
      const seen = await checkLeg(c, i, { polls: 1 })
      if (seen === 'TICKETED') continue
      if (['FAILED', 'PRICE'].includes(c.legs[i].status)) {
        await patchLeg(c, i, { status: c.legs[i].pnr ? 'HELD' : 'PENDING', attempts: c.legs[i].pnr ? { book: c.legs[i].attempts?.book } : {}, error: null })
      }
    }
    for (let i = 0; i < c.legs.length; i++) {
      if (c.legs[i].status === 'HELD_NOT_TICKETED') await patchLeg(c, i, { status: 'HELD', attempts: { book: c.legs[i].attempts?.book } })
    }
    await event(id, 'staff_retry', { by: staff, acceptIncrease: Boolean(acceptIncrease) })
    await q(`update bookings set attention = null where id = $1`, [id])
    return await run(c, { acceptIncrease: Boolean(acceptIncrease) })
  } catch (e) {
    if (e instanceof LostClaim) return null
    return needsStaff(c, `Retry failed: ${e.message}`)
  }
}

/** Staff booked it by hand on the TBO portal: record the PNR/tickets. */
export async function staffMarkTicketed(id, { leg, pnr, tickets }, staff) {
  const b = await load(id)
  if (!['ATTENTION', 'RESOLVED'].includes(b.status)) throw new UserError('Only bookings that need attention can be completed by hand.', 409)
  const i = Number(leg)
  if (!b.legs[i] || !/^[A-Z0-9]{5,8}$/i.test(String(pnr || ''))) throw new UserError('Enter the PNR.')
  const legs = structuredClone(b.legs)
  legs[i] = { ...legs[i], status: 'TICKETED', pnr: String(pnr).toUpperCase(), manual: true, error: null,
    tickets: (b.pax || []).map((p, n) => ({ name: `${p.title} ${p.firstName} ${p.lastName}`, number: tickets?.[n] || null, type: p.type, ticketId: null })) }
  const all = legs.every((l) => l.status === 'TICKETED')
  const row = await one(
    `update bookings set legs = $3::jsonb, status = $4, attention = case when $4 = 'CONFIRMED' then null else attention end, version = version + 1, updated_at = now()
     where id = $1 and version = $2 returning id`, [id, b.version, J(legs), all ? 'CONFIRMED' : b.status])
  if (!row) throw new UserError('The booking changed — reload and try again.', 409)
  await event(id, 'staff_ticketed', { leg: i, pnr, by: staff })
  return { ok: true }
}

/** Staff: release a held (non-LCC) PNR that won't be ticketed. */
export async function staffRelease(id, { leg }, staff) {
  const b = await load(id)
  const l = b.legs[Number(leg)]
  if (b.status !== 'ATTENTION' || !l?.bookingId || l.status === 'TICKETED') throw new UserError('Nothing to release.', 409)
  const r = await call('ReleasePNRRequest', { BookingId: l.bookingId, Source: l.source }, ctxOf(b))
  if (!r.ok) throw new UserError(`TBO could not release it: ${r.error?.message}`, 502)
  const legs = structuredClone(b.legs)
  legs[Number(leg)] = { ...l, status: 'RELEASED' }
  await q(`update bookings set legs = $2::jsonb, version = version + 1, updated_at = now() where id = $1`, [id, J(legs)])
  await event(id, 'released', { leg, pnr: l.pnr, by: staff })
  return { ok: true }
}

export async function staffResolve(id, { note }, staff) {
  const row = await one(`update bookings set status = 'RESOLVED', version = version + 1, updated_at = now() where id = $1 and status = 'ATTENTION' returning id`, [id])
  if (!row) throw new UserError('Only bookings that need attention can be closed.', 409)
  await event(id, 'resolved', { note: normName(note), by: staff })
  return { ok: true }
}

export async function staffList({ status }) {
  const rows = await q(
    `select id, ref, status, amount_paise, attention, search, created_at, updated_at, pax->0 as lead,
       (select count(*)::int from refunds r where r.booking_id = b.id and r.status in ('pending','failed')) as refunds_waiting,
       (select count(*)::int from changes c where c.booking_id = b.id and c.status in ('ATTENTION','PAID','PROCESSING')) as changes_waiting
     from bookings b where status <> 'DRAFT'
       and ($1::text is null or status = $1
            or ($1 = 'CHANGES' and exists (select 1 from changes c where c.booking_id = b.id and c.status in ('ATTENTION','PAID','PROCESSING'))))
     order by updated_at desc limit 200`,
    [status || null])
  return rows
}

export async function staffDetail(id) {
  const b = await load(id)
  const [events, refunds, changes] = await Promise.all([
    q(`select at, type, data from booking_events where booking_id = $1 order by id`, [id]),
    q(`select id, reason, amount_paise, status, error, rzp_refund_id, payment_id, created_by, updated_at from refunds where booking_id = $1 order by id`, [id]),
    q(`select id, kind, leg, status, amount_paise, price, summary, rzp_payment_id, attempted_at, attention, result, created_at, updated_at
       from changes where booking_id = $1 and status <> 'QUOTED' order by created_at`, [id]),
  ])
  return {
    id: b.id, ref: b.ref, status: b.status, attention: b.attention, amount: b.amount_paise, price: b.price,
    payment: b.rzp_payment_id, order: b.rzp_order_id, search: b.search, traceId: b.trace_id,
    pax: b.pax, contact: b.contact ? { ...b.contact, ip: undefined } : null, gst: b.gst,
    legs: b.legs.map((l) => ({ key: l.key, status: l.status, lcc: l.isLCC, pnr: l.pnr, bookingId: l.bookingId, error: l.error, attempts: l.attempts, tickets: l.tickets, changeRequests: l.changeRequests, card: card(l.quote), manual: l.manual, addons: l.addons, reissuedFrom: l.reissuedFrom })),
    events, refunds, changes, refundable: await refundable(b),
  }
}

/** Every TBO request/response for a booking — exactly what TBO asks for at certification. */
export async function staffLogs(id) {
  const b = await load(id)
  return q(`select at, method, request, response, http_status, ms, error from tbo_logs where booking_id = $1 or trace_id = $2 order by id`, [id, b.trace_id])
}

/* ---------------------------------------------------------------- reconciler */

/** One booking: finish anything left half-done. Safe to run as often as you like. */
export async function reconcileOne(id) {
  if (!(await tryLease(`rec:${id}`, 120))) return
  try {
    const b = await one(`select * from bookings where id = $1`, [id])
    if (!b) return
    const ageS = (t) => (Date.now() - new Date(t).getTime()) / 1000
    if (b.status === 'PAID' && ageS(b.updated_at) > 45) await fulfil(id)
    else if (b.status === 'TICKETING' && ageS(b.claimed_at) > TAKEOVER_SECONDS) {
      const c = await one(
        `update bookings set claimed_by = $2, claimed_at = now(), version = version + 1
         where id = $1 and status = 'TICKETING' and claimed_at < now() - make_interval(secs => $3) returning *`, [id, rid(9), TAKEOVER_SECONDS])
      if (c) {
        await event(id, 'takeover', null)
        try { await run(c) } catch (e) { if (!(e instanceof LostClaim)) await needsStaff(c, `Recovery failed: ${e.message}`) }
      }
    } else if (b.status === 'CANCELLING') await refreshCancellation(id)
    else if (b.status === 'AWAITING_PAYMENT' && traceLeftMs(b) < -30 * 60_000) {
      // A webhook may have been missed: ask Razorpay before giving up.
      if (pay.configured() && !b.rzp_order_id.startsWith('fake_')) {
        const payments = await pay.orderPayments(b.rzp_order_id).catch(() => null)
        const captured = payments?.items?.find((p) => ['captured', 'authorized'].includes(p.status))
        if (captured) {
          if (await recordPayment(b, captured, 'reconcile')) await fulfil(id)
          return
        }
      }
      const row = await one(`update bookings set status = 'EXPIRED', version = version + 1, updated_at = now() where id = $1 and status = 'AWAITING_PAYMENT' returning id`, [id])
      if (row) await event(id, 'expired', null)
    }
  } finally {
    await releaseLease(`rec:${id}`)
  }
}

/** Cron: everything that needs a nudge, plus housekeeping. */
export async function reconcileAll() {
  const due = await q(
    `select id from bookings where
       (status = 'PAID' and updated_at < now() - interval '45 seconds')
       or (status = 'TICKETING' and claimed_at < now() - make_interval(secs => $1))
       or status = 'CANCELLING'
       or (status = 'AWAITING_PAYMENT' and trace_started_at < now() - interval '45 minutes')
     order by updated_at limit 25`, [TAKEOVER_SECONDS])
  for (const { id } of due) {
    try { await reconcileOne(id) } catch (e) { console.error('reconcile', id, e) }
  }
  // Housekeeping: abandoned drafts, unpaid expired bookings, old traces.
  await q(`delete from bookings where status = 'DRAFT' and updated_at < now() - interval '1 day'`)
  await q(`delete from bookings where status = 'EXPIRED' and rzp_payment_id is null and updated_at < now() - interval '30 days'`)
  await q(`delete from traces where created_at < now() - interval '1 day'`)
  // Privacy policy: passport/PAN data removed 90 days after the trip; TBO logs after 180 days.
  await q(`update bookings set pax = (select jsonb_agg(p - 'passportNo' - 'passportExpiry' - 'passportIssueDate' - 'pan' - 'guardian') from jsonb_array_elements(pax) p),
             pii_purged_at = now() where pii_purged_at is null and pax is not null and travel_end < now() - interval '90 days'`)
  await q(`delete from tbo_logs where at < now() - interval '180 days'`)
  return { checked: due.length }
}
