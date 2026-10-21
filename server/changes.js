import crypto from 'node:crypto'
import { q, one, tryLease, releaseLease } from './db.js'
import { call } from './tbo.js'
import * as pay from './razorpay.js'
import { inrFare, reissueTotal, rupees } from './pricing.js'
import { UserError, card, tripsOf } from './flights.js'
import { event, flag, load, pickSsr, ssrView, seatKey, svcKey, allSeats, allServices, ctxOf, proposeRefund } from './bookings.js'

/* ============================================================
   Changes to a ticketed booking, each paid with its own Razorpay order.

   reissue  Date change (TBO re-issuance, full ticket only):
            Search(SearchType=1, Pnr, Bookingid) → FareQuote → pay → TicketReissue.
            TBO issues a NEW BookingId (same PNR); the old one becomes "reissued".
   addons   Seat / meal / baggage after ticketing (TBO Air Amendment):
            SSR(BookingId) → pay → TicketReissue with an SSR array per PaxId.

   change status   QUOTED → AWAITING_PAYMENT → PAID → PROCESSING → DONE
                   … or ATTENTION (held for staff) / EXPIRED / RESOLVED.

   Same race rules as bookings.js, each settled by one atomic statement:
   - one payment marks a change PAID once (rzp_payment_id UNIQUE, status check);
   - exactly one worker wins PAID → PROCESSING (the claim);
   - the booking is locked CONFIRMED → CHANGING for the duration, so a
     cancellation (CONFIRMED → CANCELLING) and a change can never overlap;
   - at most one change per booking is open (partial unique index), so two
     tabs can't pay for two date changes of the same ticket;
   - attempted_at is saved BEFORE TicketReissue: a sent change is only ever
     checked afterwards (GetBookingDetails), never sent again.
   ============================================================ */

const TRACE_TTL_MS = 15 * 60_000
const MIN_LEFT_MS = 4 * 60_000
const TAKEOVER_SECONDS = 330
const POLL_MS = Number(process.env.TBO_POLL_MS || 12_000)

const J = JSON.stringify
const paise = (r) => Math.round(Number(r || 0) * 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url')
const nowIso = () => new Date().toISOString()
const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
const DATE = /^\d{4}-\d{2}-\d{2}$/

/* ---------------------------------------------------------------- TBO request shapes */

/* TBO-confirm before go-live. TBO's public pages give the re-issue flow, the
   method name (TicketReissue) and the TicketData object (TourCode, Endorsement,
   CorporateCode, AgentDealCode, copied from the original ticket), but not the
   full request. These two builders are our reading of it — check both with
   TBO's API team (apiintegrationteam@tbo.com) and adjust only here. */
const reissueSearchFields = (leg) => ({ SearchType: 1, Pnr: leg.pnr, Bookingid: leg.bookingId })

export function reissueBody(leg, c) {
  return {
    TraceId: c.trace_id,
    ResultIndex: c.quote.result.ResultIndex,
    BookingId: leg.bookingId,
    PNR: leg.pnr,
    TicketData: c.quote.ticketData,
  }
}

/** From TBO's Air Amendment sample: one entry per PaxId, items exactly as SSR returned them. */
export function addonBody(leg, c) {
  return {
    ...(c.trace_id ? { TraceId: c.trace_id } : {}),
    BookingId: leg.bookingId,
    SSR: c.quote.selection.map((s) => {
      const of = (k) => s.items.filter((x) => x.kind === k).map(({ kind, ...x }) => x)
      const o = { PaxId: s.paxId }
      if (of('baggage').length) o.Baggage = of('baggage')
      if (of('meal').length) o.MealDynamic = of('meal')
      if (of('seat').length) o.SeatDynamic = of('seat')
      if (of('service').length) o.SpecialServices = of('service')
      return o
    }),
  }
}

/* ---------------------------------------------------------------- helpers */

function changeableLeg(b, i) {
  if (b.status !== 'CONFIRMED') throw new UserError('This booking can’t be changed right now. Please try again in a minute, or contact us.', 409)
  if (b.journey_type === 5) throw new UserError('Special return fares can only be changed by our team. Please WhatsApp or call us.', 422)
  const leg = b.legs[Number(i)]
  if (!leg || leg.status !== 'TICKETED' || !leg.bookingId) throw new UserError('Choose a ticketed flight.')
  const tickets = leg.tickets || []
  if (!tickets.length || tickets.some((t) => !t.ticketId || t.cancelled)) {
    throw new UserError('Part of this ticket is cancelled or was issued by hand, so it can only be changed by our team. Please contact us.', 422)
  }
  const dep = String(tripsOf(leg.quote)[0]?.[0]?.Origin?.DepTime || '').slice(0, 10)
  if (!dep || dep <= todayIST()) throw new UserError('Changes on the day of travel can’t be made online. Please call us.', 422)
  return leg
}

async function loadChange(b, cid) {
  const c = await one(`select * from changes where id = $1 and booking_id = $2`, [String(cid || ''), b.id])
  if (!c) throw new UserError('Change not found.', 404)
  return c
}

const itemLabel = (it) =>
  it.kind === 'baggage' ? `${it.Weight} kg extra check-in baggage (${it.Origin} → ${it.Destination})`
    : it.kind === 'meal' ? `${it.AirlineDescription || it.Code} (${it.Origin} → ${it.Destination})`
      : it.kind === 'seat' ? `Seat ${it.Code} (${it.Origin} → ${it.Destination})`
        : `${it.Text || it.Code} (${it.Origin} → ${it.Destination})`

const paxName = (p) => `${p.title} ${p.firstName} ${p.lastName}`

/** Which TBO PaxId belongs to each of our travellers (matched by name on the ticket). */
const paxIds = (b, leg) => b.pax.map((p) => (leg.tickets || [])
  .find((t) => String(t.name).toLowerCase().endsWith(`${p.firstName} ${p.lastName}`.toLowerCase()))?.paxId ?? null)

/** TBO: baggage bought at booking (or earlier) can't be topped up through Air Amendment. */
function hasBaggage(leg, i) {
  const atBooking = (leg.ssr || []).find((s) => s.pax === i)?.items || []
  return atBooking.some((x) => x.kind === 'baggage' && !/^No/i.test(x.Code)) || (leg.addons || []).some((a) => a.pax === i && a.kind === 'baggage')
}

export function changeView(c, b) {
  const fake = c.rzp_order_id?.startsWith('fake_')
  return {
    id: c.id,
    kind: c.kind,
    leg: c.leg,
    status: c.status,
    amount: c.amount_paise,
    price: c.price,
    summary: c.summary,
    attention: c.status === 'ATTENTION' ? 'Your payment is safe — our team will contact you to finish this change or refund it.' : null,
    expiresAt: c.trace_started_at ? new Date(new Date(c.trace_started_at).getTime() + TRACE_TTL_MS).toISOString() : null,
    payment: c.status === 'AWAITING_PAYMENT' && c.rzp_order_id ? {
      mode: fake ? 'test' : 'razorpay',
      keyId: fake ? null : pay.keyId(),
      orderId: c.rzp_order_id,
      amount: c.amount_paise,
      name: b ? `${b.pax?.[0]?.firstName || ''} ${b.pax?.[0]?.lastName || ''}`.trim() : '',
      email: b?.contact?.email,
      phone: b?.contact?.phone,
    } : null,
  }
}

/** Unpaid orders the customer walked away from are expired, so they can pick another option. */
async function clearUnpaid(b) {
  const open = await q(`select id, rzp_order_id from changes where booking_id = $1 and status = 'AWAITING_PAYMENT'`, [b.id])
  for (const c of open) {
    if (c.rzp_order_id && !c.rzp_order_id.startsWith('fake_') && pay.configured()) {
      const o = await pay.fetchOrder(c.rzp_order_id).catch(() => null)
      if (!o || o.status !== 'created') continue // a payment was started: keep it; the unique index blocks a second one
    }
    await q(`update changes set status = 'EXPIRED', updated_at = now() where id = $1 and status = 'AWAITING_PAYMENT' and rzp_payment_id is null`, [c.id])
  }
}

/** QUOTED → AWAITING_PAYMENT (or straight to PAID when there is nothing to pay). */
async function openPayment(b, c, total) {
  await clearUnpaid(b)
  let orderId = null
  if (total > 0) {
    if (pay.configured()) orderId = (await pay.createOrder(total, `${b.ref}-${c.kind}`, { booking: b.id, change: c.id, ref: b.ref })).id
    else if (pay.fakePayments()) orderId = `fake_${rid(9)}`
    else throw new UserError('Online payment is not switched on yet. Please call or WhatsApp us to make this change.', 503)
  }
  let row
  try {
    row = await one(
      `update changes set status = $2, rzp_order_id = $3, updated_at = now() where id = $1 and status = 'QUOTED' returning *`,
      [c.id, total > 0 ? 'AWAITING_PAYMENT' : 'PAID', orderId])
  } catch (e) {
    if (/changes_one_open|unique|duplicate/i.test(e.message)) {
      throw new UserError('Another change to this booking is already being paid for or made. Please wait for it to finish.', 409)
    }
    throw e
  }
  if (!row) throw new UserError('This change was already submitted.', 409)
  await event(b.id, 'change_awaiting_payment', { change: c.id, kind: c.kind, amount: total })
  return row
}

async function traceRow(traceId) {
  const t = await one(`select created_at from traces where trace_id = $1`, [String(traceId || '')])
  if (!t) throw new UserError('These options have expired. Please search again.', 410)
  if (Date.now() - new Date(t.created_at).getTime() > TRACE_TTL_MS - MIN_LEFT_MS) {
    throw new UserError('These prices are more than 10 minutes old. Please search again.', 410)
  }
  return t
}

/* ---------------------------------------------------------------- date change (re-issue) */

/** New dates for one ticketed leg → re-issue options, priced as "what you pay now". */
export async function reissueSearch(b, { leg: li, dates }, ctx) {
  const leg = changeableLeg(b, li)
  const trips = tripsOf(leg.quote)
  const ds = (Array.isArray(dates) ? dates : []).map(String)
  if (ds.length !== trips.length || ds.some((d) => !DATE.test(d) || d <= todayIST())) {
    throw new UserError(trips.length > 1 ? 'Pick a new date for each flight, from tomorrow onwards.' : 'Pick a new date, from tomorrow onwards.')
  }
  if (ds.some((d, i) => i > 0 && d < ds[i - 1])) throw new UserError('The return can’t be before the outbound flight.')

  const count = (t) => b.pax.filter((p) => Number(p.type) === t).length
  const r = await call('Search', {
    AdultCount: count(1),
    ChildCount: count(2),
    InfantCount: count(3),
    DirectFlight: false,
    OneStopFlight: false,
    JourneyType: trips.length === 1 ? 1 : b.journey_type === 3 ? 3 : 2,
    PreferredAirlines: null,
    Segments: trips.map((t, i) => ({
      Origin: t[0].Origin.Airport.AirportCode,
      Destination: t[t.length - 1].Destination.Airport.AirportCode,
      FlightCabinClass: b.search?.cabin || 2,
      PreferredDepartureTime: `${ds[i]}T00:00:00`,
      PreferredArrivalTime: `${ds[i]}T00:00:00`,
    })),
    Sources: null,
    ...reissueSearchFields(leg),
  }, { ...ctx, bookingId: b.id })
  if (!r.ok) {
    if (/no result|not found/i.test(r.error?.message || '')) return { traceId: null, options: [] }
    throw new UserError(r.unknown ? 'The airline did not answer in time. Please try again.' : `Date change search failed: ${r.error.message}`, 502)
  }
  await q(`insert into traces (trace_id) values ($1) on conflict do nothing`, [r.data.TraceId])
  const raw = Array.isArray(r.data.Results) ? r.data.Results : []
  const list = Array.isArray(raw[0]) ? raw[0] : raw
  const options = list.map((x) => {
    const c = card(x)
    if (!c) return null
    try {
      const price = reissueTotal(leg.quote, x)
      return { ...c, price: price.total, change: price }
    } catch { return null }
  }).filter(Boolean)
  return { traceId: r.data.TraceId, options }
}

/** Customer picked a new flight: FareQuote (re-issue charges), then a payment order. */
export async function reissueQuote(b, { leg: li, traceId, resultIndex }, ctx) {
  const leg = changeableLeg(b, li)
  const trace = await traceRow(traceId)
  const c0 = { ...ctx, bookingId: b.id, traceId }
  const fq = await call('FareQuote', { TraceId: traceId, ResultIndex: String(resultIndex || '') }, c0)
  if (!fq.ok) throw new UserError(fq.unknown ? 'The airline did not confirm the price in time. Please try again.' : `This option is no longer available: ${fq.error.message}`, 409)
  const result = fq.data.Results
  if (!inrFare(result)) throw new UserError('This option can’t be paid online. Please contact us.', 422)
  const price = reissueTotal(leg.quote, result)

  // TicketData must be copied from the original ticket (TBO re-issue notes).
  const gbd = await call('GetBookingDetails', { BookingId: leg.bookingId, PNR: leg.pnr }, c0)
  const it = gbd.data?.FlightItinerary || {}
  const src = it.TicketData || it.Passenger?.[0]?.Ticket || it
  const ticketData = {
    TourCode: src.TourCode || '', Endorsement: src.Endorsement || '',
    CorporateCode: src.CorporateCode || '', AgentDealCode: src.AgentDealCode || '',
  }

  const c = await one(
    `insert into changes (id, booking_id, kind, leg, status, trace_id, trace_started_at, quote, summary, price, amount_paise)
     values ($1, $2, 'reissue', $3, 'QUOTED', $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9) returning *`,
    [rid(), b.id, Number(li), traceId, trace.created_at,
      J({ result, ticketData, oldBookingId: leg.bookingId, oldPnr: leg.pnr }),
      J({ card: card(result), priceChanged: Boolean(fq.data.IsPriceChanged) }), J(price), price.total])
  await event(b.id, 'change_quoted', { change: c.id, kind: 'reissue', leg: Number(li), amount: price.total })
  const row = await openPayment(b, c, price.total)
  if (row.status === 'PAID') await processChange(row.id)
  return changeView(await one(`select * from changes where id = $1`, [row.id]), b)
}

/* ---------------------------------------------------------------- add-ons (Air Amendment) */

/** What can still be bought for this ticket (TBO SSR by BookingId). */
export async function addonOptions(b, { leg: li }, ctx) {
  const leg = changeableLeg(b, li)
  const r = await call('SSR', { BookingId: leg.bookingId }, { ...ctx, bookingId: b.id })
  if (!r.ok) throw new UserError('Extra seats, meals or baggage can’t be bought online for this flight. Please contact us.', 422)
  const raw = pickSsr(r.data, true)
  const traceId = r.data.TraceId || null
  if (traceId) await q(`insert into traces (trace_id) values ($1) on conflict do nothing`, [traceId])
  const c = await one(
    `insert into changes (id, booking_id, kind, leg, status, trace_id, trace_started_at, quote)
     values ($1, $2, 'addons', $3, 'QUOTED', $4, now(), $5::jsonb) returning id`,
    [rid(), b.id, Number(li), traceId, J({ ssrRaw: raw })])
  return {
    changeId: c.id,
    options: ssrView(raw, true),
    travellers: b.pax.map((p, i) => ({ name: paxName(p), type: p.type, hasBaggage: hasBaggage(leg, i) })),
  }
}

/** The customer's picks → priced from OUR copy of TBO's SSR response → payment order. */
export async function addonSelect(b, cid, { ssr }) {
  const c = await loadChange(b, cid)
  if (c.kind !== 'addons' || c.status !== 'QUOTED') throw new UserError('These options were already used. Please start again.', 409)
  const leg = changeableLeg(b, c.leg)
  if (Date.now() - new Date(c.trace_started_at).getTime() > TRACE_TTL_MS - MIN_LEFT_MS) throw new UserError('These options have expired. Please start again.', 410)

  const raw = c.quote.ssrRaw
  const ids = paxIds(b, leg)
  const seats = allSeats(raw)
  const bad = () => new UserError('One of the extras is no longer available. Please choose again.', 409)
  const selection = []
  const takenSeats = new Set()

  b.pax.forEach((p, i) => {
    const s = ssr?.[i] || {}
    const infant = Number(p.type) === 3
    const items = []
    const fromGroup = (groups, g, code, kind) => {
      const o = (groups?.[g] || []).find((x) => x.Code === code)
      if (!o || /^No/i.test(o.Code)) throw bad()
      items.push({ kind, ...o })
    }
    for (const [g, code] of Object.entries(s.baggage || {})) {
      if (!code) continue
      if (infant) throw new UserError('Infants can’t have their own baggage allowance.')
      if (hasBaggage(leg, i)) throw new UserError(`${p.firstName} already has extra baggage on this ticket — the airline doesn’t allow adding more online.`)
      fromGroup(raw.Baggage, g, code, 'baggage')
    }
    for (const [g, code] of Object.entries(s.meal || {})) if (code) fromGroup(raw.MealDynamic, g, code, 'meal')
    for (const [k, code] of Object.entries(s.seat || {})) {
      if (!code) continue
      if (infant) throw new UserError('Infants sit on a lap, so they don’t get a seat.')
      const o = seats.find((x) => seatKey(x) === k && x.Code === code)
      if (!o || Number(o.AvailablityType) !== 1) throw new UserError(`Seat ${code} has just been taken. Please pick another.`, 409)
      if (takenSeats.has(`${k}:${code}`)) throw new UserError(`Seat ${code} is picked for two travellers.`)
      takenSeats.add(`${k}:${code}`)
      items.push({ kind: 'seat', ...o })
    }
    for (const key of s.services || []) {
      const o = allServices(raw).find((x) => svcKey(x) === key)
      if (!o) throw bad()
      items.push({ kind: 'service', ...o })
    }
    if (!items.length) return
    if (ids[i] == null) throw new UserError('We couldn’t match a traveller to their ticket. Please contact us to add extras.', 422)
    selection.push({ pax: i, paxId: ids[i], items })
  })
  if (!selection.length) throw new UserError('Choose at least one extra.')

  const total = selection.reduce((t, s) => t + s.items.reduce((u, it) => u + paise(it.Price), 0), 0)
  const summary = { items: selection.flatMap((s) => s.items.map((it) => ({ pax: paxName(b.pax[s.pax]), label: itemLabel(it), price: paise(it.Price) }))) }
  const priced = await one(
    `update changes set quote = quote || $2::jsonb, summary = $3::jsonb, price = $4::jsonb, amount_paise = $5, updated_at = now()
     where id = $1 and status = 'QUOTED' returning *`,
    [c.id, J({ selection }), J(summary), J({ addons: total, total }), total])
  if (!priced) throw new UserError('These options were already used. Please start again.', 409)
  const row = await openPayment(b, priced, total)
  if (row.status === 'PAID') await processChange(row.id)
  return changeView(await one(`select * from changes where id = $1`, [row.id]), b)
}

/* ---------------------------------------------------------------- payment */

async function recordChangePayment(c, p, via) {
  if (p.order_id !== c.rzp_order_id) return null
  let status = p.status
  if (status === 'authorized' && !String(p.id).startsWith('fake_')) {
    try { status = (await pay.capturePayment(p.id, p.amount)).status } catch { status = (await pay.fetchPayment(p.id)).status }
  }
  if (status !== 'captured') return null
  if (Number(p.amount) !== Number(c.amount_paise)) {
    await flag(c.booking_id, `Change payment ${p.id} amount ${rupees(p.amount)} does not match ${rupees(c.amount_paise)} — check and refund.`)
    return null
  }
  let row
  try {
    row = await one(
      `update changes set status = 'PAID', rzp_payment_id = $2, updated_at = now()
       where id = $1 and status = any('{AWAITING_PAYMENT,EXPIRED}'::text[]) and rzp_payment_id is null returning *`, [c.id, p.id])
  } catch (e) {
    // Paid after expiry while another change had opened: keep the money visible to staff.
    if (!/changes_one_open|unique|duplicate/i.test(e.message)) throw e
    row = null
    const held = await one(
      `update changes set status = 'ATTENTION', rzp_payment_id = $2, attention = 'Paid after another change had started — refund it or redo it by hand.', updated_at = now()
       where id = $1 and rzp_payment_id is null returning *`, [c.id, p.id])
    if (held) {
      const b = await load(c.booking_id)
      await proposeRefund(b, `change:${c.id}`, held.amount_paise, 'Change paid after another change had started', p.id)
      await event(c.booking_id, 'change_attention', { change: c.id, reason: held.attention })
    }
    return null
  }
  if (row) {
    await event(c.booking_id, 'change_paid', { change: c.id, payment: p.id, amount: p.amount, via })
    return row
  }
  const cur = await one(`select * from changes where id = $1`, [c.id])
  if (cur.rzp_payment_id && cur.rzp_payment_id !== p.id) {
    await flag(c.booking_id, `A second payment ${p.id} (${rupees(p.amount)}) was received for change ${c.id} — refund it.`)
  }
  return null
}

export async function verifyChangePayment(b, cid, { orderId, paymentId, signature }) {
  const c = await loadChange(b, cid)
  if (!orderId || orderId !== c.rzp_order_id) throw new UserError('This payment does not belong to this change.', 400)
  if (!pay.checkoutSignatureValid(orderId, paymentId, signature)) throw new UserError('We could not verify this payment.', 400)
  await recordChangePayment(c, await pay.fetchPayment(paymentId), 'checkout')
  await processChange(cid)
  return changeView(await one(`select * from changes where id = $1`, [cid]), b)
}

/** Certification / testing only (see razorpay.fakePayments). */
export async function fakeChangePay(b, cid) {
  if (!pay.fakePayments()) throw new UserError('Not available.', 403)
  const c = await loadChange(b, cid)
  if (!c.rzp_order_id?.startsWith('fake_')) throw new UserError('Not available.', 403)
  await recordChangePayment(c, { id: `fake_pay_${rid(8)}`, order_id: c.rzp_order_id, amount: c.amount_paise, status: 'captured' }, 'test')
  await processChange(cid)
  return changeView(await one(`select * from changes where id = $1`, [cid]), b)
}

/** Razorpay webhook for an order that isn't a booking's (bookings.webhook hands it here). */
export async function changeWebhookPayment(p, via, waitUntil) {
  const c = await one(`select * from changes where rzp_order_id = $1`, [p.order_id])
  if (!c) return { ignored: true }
  if (await recordChangePayment(c, p, via)) waitUntil(processChange(c.id).catch((e) => console.error('change from webhook', e)))
  return { ok: true }
}

/* ---------------------------------------------------------------- applying a change */

async function unlockBooking(bookingId, claim) {
  await q(`update bookings set status = 'CONFIRMED', claimed_by = null, version = version + 1, updated_at = now()
           where id = $1 and claimed_by = $2 and status = 'CHANGING'`, [bookingId, claim])
}

/** TBO did nothing: hold the change for staff, propose a full refund of its payment, unlock the booking. */
async function changeFailed(c, bookingId, claim, reason) {
  const row = await one(
    `update changes set status = 'ATTENTION', attention = $3, claimed_by = null, updated_at = now()
     where id = $1 and claimed_by = $2 returning *`, [c.id, claim, reason])
  if (!row) return null
  await unlockBooking(bookingId, claim)
  if (row.rzp_payment_id && row.amount_paise > 0) {
    await proposeRefund(await load(bookingId), `change:${c.id}`, row.amount_paise, `Change not made: ${reason}`, row.rzp_payment_id)
  }
  await event(bookingId, 'change_attention', { change: c.id, reason })
  return 'ATTENTION'
}

/** Outcome unknown: hold for staff without proposing a refund. keepLocked = the ticket may have changed. */
async function changeUnsure(c, bookingId, claim, reason, keepLocked) {
  const row = await one(
    `update changes set status = 'ATTENTION', attention = $3, claimed_by = null, updated_at = now()
     where id = $1 and claimed_by = $2 returning id`, [c.id, claim, reason])
  if (!row) return null
  if (keepLocked) await q(`update bookings set claimed_by = null, updated_at = now() where id = $1 and claimed_by = $2`, [bookingId, claim])
  else await unlockBooking(bookingId, claim)
  await event(bookingId, 'change_attention', { change: c.id, reason })
  return 'ATTENTION'
}

/** Writes the result into the booking's leg and closes the change — only while we hold the claim. */
async function finish(c, b, claim, legPatch, result) {
  const row = await one(
    `update bookings set legs = jsonb_set(legs, $2::text[], (legs -> $3::int) || $4::jsonb),
       status = 'CONFIRMED', claimed_by = null, version = version + 1, updated_at = now()
     where id = $1 and claimed_by = $5 and status = 'CHANGING' returning id`,
    [b.id, [String(c.leg)], c.leg, J(legPatch), claim])
  if (!row) return null
  await q(`update changes set status = 'DONE', result = $3::jsonb, claimed_by = null, updated_at = now() where id = $1 and claimed_by = $2`, [c.id, claim, J(result)])
  await event(b.id, 'change_done', { change: c.id, kind: c.kind, ...result })
  return 'DONE'
}

function ticketsOf(it) {
  return (it.Passenger || []).map((p) => ({
    paxId: p.PaxId,
    ticketId: p.Ticket?.TicketId ?? null,
    number: p.Ticket?.TicketNumber ?? null,
    name: `${p.Title || ''} ${p.FirstName || ''} ${p.LastName || ''}`.trim(),
    type: p.PaxType,
  }))
}

/** Re-issue result, from the TicketReissue reply or GetBookingDetails. */
async function finishReissue(c, b, claim, it) {
  const leg = b.legs[c.leg]
  const tickets = ticketsOf(it)
  return finish(c, b, claim, {
    bookingId: it.BookingId,
    pnr: it.PNR || leg.pnr,
    quote: c.quote.result,
    tickets,
    invoiceNo: it.InvoiceNo || null,
    reissuedFrom: [...(leg.reissuedFrom || []), { bookingId: c.quote.oldBookingId, pnr: c.quote.oldPnr, at: nowIso() }],
  }, { bookingId: it.BookingId, pnr: it.PNR || leg.pnr })
}

/** After an unclear re-issue reply: GetBookingDetails decides — never send it again. */
async function checkReissue(c, b, claim, polls) {
  const { from, to } = (() => {
    const t = tripsOf(c.quote.result).flat()
    return { from: t[0]?.Origin?.Airport?.AirportCode, to: t[t.length - 1]?.Destination?.Airport?.AirportCode }
  })()
  for (let n = 0; n < polls; n++) {
    if (n > 0) await sleep(POLL_MS)
    const r = await call('GetBookingDetails', { TraceId: c.trace_id }, { ...ctxOf(b), traceId: c.trace_id })
    if (r.unknown || /under process/i.test(r.error?.message || '')) continue
    const it = r.data?.FlightItinerary
    if (!it?.BookingId || it.BookingId === c.quote.oldBookingId) break
    if (it.Origin && it.Destination && (it.Origin !== from || it.Destination !== to)) break
    const tickets = ticketsOf(it)
    if (tickets.length && tickets.every((t) => t.ticketId && t.number)) return finishReissue(c, b, claim, it)
  }
  const cur = await one(`select attempted_at from changes where id = $1`, [c.id])
  if (Date.now() - new Date(cur.attempted_at).getTime() > 10 * 60_000) {
    return changeUnsure(c, b.id, claim, 'The date change was sent but TBO never confirmed it — check the TBO portal before refunding or redoing it.', true)
  }
  // Still unclear: let the reconciler look again in about a minute.
  await q(`update changes set claimed_at = now() - make_interval(secs => $3) where id = $1 and claimed_by = $2`, [c.id, claim, TAKEOVER_SECONDS - 60])
  return 'PROCESSING'
}

async function applyReply(c, b, claim, data) {
  const leg = b.legs[c.leg]
  if (c.kind === 'addons') {
    const added = c.quote.selection.flatMap((s) => s.items.map((it) => ({ pax: s.pax, kind: it.kind, code: it.Code, label: itemLabel(it), at: nowIso() })))
    return finish(c, b, claim, { addons: [...(leg.addons || []), ...added] }, { items: added.length })
  }
  const inner = data?.Response && typeof data.Response === 'object' ? data.Response : (data || {})
  const it = inner.FlightItinerary || {}
  const bookingId = inner.BookingId || it.BookingId
  if (bookingId && bookingId !== c.quote.oldBookingId) {
    const g = await call('GetBookingDetails', { BookingId: bookingId }, ctxOf(b))
    const full = g.data?.FlightItinerary
    if (full?.BookingId && ticketsOf(full).every((t) => t.ticketId && t.number)) return finishReissue(c, b, claim, full)
  }
  return checkReissue(c, b, claim, 3)
}

/** PAID → PROCESSING exactly once; booking CONFIRMED → CHANGING; then TicketReissue once. */
export async function processChange(cid) {
  const claim = rid(9)
  const c = await one(
    `update changes set status = 'PROCESSING', claimed_by = $2, claimed_at = now(), updated_at = now()
     where id = $1 and status = 'PAID' returning *`, [cid, claim])
  if (!c) return null

  const b = await one(
    `update bookings set status = 'CHANGING', claimed_by = $2, claimed_at = now(), version = version + 1, updated_at = now()
     where id = $1 and status = 'CONFIRMED' returning *`, [c.booking_id, claim])
  if (!b) {
    const cur = await load(c.booking_id)
    if (cur.status === 'CHANGING') {
      // Another change is still being finished: try again later (reconciler).
      await q(`update changes set status = 'PAID', claimed_by = null, updated_at = now() where id = $1 and claimed_by = $2`, [cid, claim])
      return 'WAITING'
    }
    return changeFailed(c, c.booking_id, claim, `The booking was ${cur.status.toLowerCase()} when this change was paid, so it was not made.`)
  }
  await event(b.id, 'change_processing', { change: cid, kind: c.kind })
  return run(c, b, claim)
}

async function run(c, b, claim) {
  try {
    const leg = b.legs[c.leg]
    if (Date.now() - new Date(c.trace_started_at).getTime() > TRACE_TTL_MS) {
      return changeFailed(c, b.id, claim, 'The airline’s 15-minute quote expired before the change could be made.')
    }
    if (!leg || leg.status !== 'TICKETED' || (c.kind === 'reissue' && leg.bookingId !== c.quote.oldBookingId)) {
      return changeFailed(c, b.id, claim, 'The ticket changed after this was quoted, so it was not made.')
    }
    // Saved BEFORE calling TBO: from here on this change is only ever checked, never re-sent.
    const marked = await one(`update changes set attempted_at = now() where id = $1 and claimed_by = $2 returning id`, [c.id, claim])
    if (!marked) return null
    const r = await call('TicketReissue', c.kind === 'reissue' ? reissueBody(leg, c) : addonBody(leg, c), { ...ctxOf(b), traceId: c.trace_id })
    if (r.unknown) {
      return c.kind === 'reissue'
        ? checkReissue(c, b, claim, 3)
        : changeUnsure(c, b.id, claim, 'TBO did not reply to the add-on purchase — check the TBO portal before refunding or redoing it.', false)
    }
    if (!r.ok) return changeFailed(c, b.id, claim, `The airline refused the change: ${r.error.message}`)
    return applyReply(c, b, claim, r.data)
  } catch (e) {
    console.error('change error', c.id, e)
    const sent = await one(`select attempted_at from changes where id = $1`, [c.id])
    return sent?.attempted_at
      ? changeUnsure(c, b.id, claim, `Unexpected error after sending the change: ${e.message}`, c.kind === 'reissue')
      : changeFailed(c, b.id, claim, `Unexpected error: ${e.message}`)
  }
}

/* ---------------------------------------------------------------- staff + reconciler */

/** Staff closed a held change: done by hand on the TBO portal, or not made (optionally refund it). */
export async function staffResolveChange(cid, { note, done, refund }, staff) {
  const c = await one(
    `update changes set status = $2, attention = coalesce(attention || ' | ', '') || $3, updated_at = now()
     where id = $1 and status = 'ATTENTION' returning *`,
    [String(cid), done ? 'DONE' : 'RESOLVED', `Closed by staff: ${String(note || '').trim() || (done ? 'done by hand' : 'not made')}`])
  if (!c) throw new UserError('Only changes that need attention can be closed.', 409)
  await q(`update bookings set status = 'CONFIRMED', claimed_by = null, version = version + 1, updated_at = now()
           where id = $1 and status = 'CHANGING' and claimed_by is null`, [c.booking_id])
  if (refund && c.rzp_payment_id && c.amount_paise > 0) {
    await proposeRefund(await load(c.booking_id), `change:${c.id}`, c.amount_paise, 'Change not made — refunded by staff', c.rzp_payment_id)
  }
  await event(c.booking_id, 'change_resolved', { change: c.id, done: Boolean(done), by: staff, note })
  return { ok: true }
}

async function reconcileChange(id) {
  const c = await one(`select * from changes where id = $1`, [id])
  if (!c) return
  const ageS = (t) => (Date.now() - new Date(t).getTime()) / 1000
  if (c.status === 'PAID' && ageS(c.updated_at) > 45) return processChange(id)

  if (c.status === 'PROCESSING' && ageS(c.claimed_at) > TAKEOVER_SECONDS) {
    const claim = rid(9)
    const t = await one(
      `update changes set claimed_by = $2, claimed_at = now() where id = $1 and status = 'PROCESSING'
         and claimed_at < now() - make_interval(secs => $3) returning *`, [id, claim, TAKEOVER_SECONDS])
    if (!t) return
    await q(`update bookings set claimed_by = $2 where id = $1 and status = 'CHANGING'`, [t.booking_id, claim])
    await event(t.booking_id, 'change_takeover', { change: id })
    const b = await load(t.booking_id)
    if (!t.attempted_at) {
      // Never reached TBO: safe to start again.
      await unlockBooking(t.booking_id, claim)
      await q(`update changes set status = 'PAID', claimed_by = null, updated_at = now() where id = $1 and claimed_by = $2`, [id, claim])
      return processChange(id)
    }
    return t.kind === 'reissue'
      ? checkReissue(t, b, claim, 1)
      : changeUnsure(t, b.id, claim, 'The add-on purchase was interrupted — check the TBO portal before refunding or redoing it.', false)
  }

  if (c.status === 'AWAITING_PAYMENT' && ageS(c.trace_started_at || c.created_at) > 45 * 60) {
    if (pay.configured() && c.rzp_order_id && !c.rzp_order_id.startsWith('fake_')) {
      const payments = await pay.orderPayments(c.rzp_order_id).catch(() => null)
      const paid = payments?.items?.find((p) => ['captured', 'authorized'].includes(p.status))
      if (paid) {
        if (await recordChangePayment(c, paid, 'reconcile')) await processChange(id)
        return
      }
    }
    await q(`update changes set status = 'EXPIRED', updated_at = now() where id = $1 and status = 'AWAITING_PAYMENT' and rzp_payment_id is null`, [id])
  }
}

/** Cron + booking page: finish half-done changes (all bookings, or one). */
export async function reconcileChanges(bookingId = null) {
  const due = await q(
    `select id from changes where ($1::text is null or booking_id = $1) and (
       (status = 'PAID' and updated_at < now() - interval '45 seconds')
       or (status = 'PROCESSING' and claimed_at < now() - make_interval(secs => $2))
       or (status = 'AWAITING_PAYMENT' and coalesce(trace_started_at, created_at) < now() - interval '45 minutes'))
     order by updated_at limit 25`, [bookingId, TAKEOVER_SECONDS])
  for (const { id } of due) {
    if (!(await tryLease(`chg:${id}`, 120))) continue
    try { await reconcileChange(id) } catch (e) { console.error('reconcile change', id, e) } finally { await releaseLease(`chg:${id}`) }
  }
  if (!bookingId) await q(`delete from changes where status = 'QUOTED' and created_at < now() - interval '1 day'`)
  return { changes: due.length }
}
