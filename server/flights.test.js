/* Booking engine checks against a simulated TBO + in-memory Postgres.
   Run: npm run test:flights
   Covers the money paths: pricing, validation, the full LCC flow with seats
   and meals, and every race condition the state machine is meant to stop. */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

Object.assign(process.env, {
  PGLITE_DIR: 'memory://',
  TBO_USERNAME: 'test', TBO_PASSWORD: 'test',
  ALLOW_FAKE_PAYMENTS: 'true', TBO_ENV: 'staging',
  FLIGHT_MARKUP_PERCENT: '5', TBO_POLL_MS: '5',
})
delete process.env.RAZORPAY_KEY_ID
delete process.env.DATABASE_URL

const { q } = await import('./db.js')
const B = await import('./bookings.js')
const C = await import('./changes.js')
const F = await import('./flights.js')
const { quoteTotal, paxFare } = await import('./pricing.js')
const { checkTravellers } = await import('./validate.js')

/* ---------------- fake TBO ---------------- */
const seg = (from, to, dep, arr, no) => ({
  Baggage: '15 KG', CabinBaggage: '7 KG', TripIndicator: 1, SegmentIndicator: 1,
  Airline: { AirlineCode: '6E', AirlineName: 'IndiGo', FlightNumber: no, FareClass: 'R', OperatingCarrier: '' },
  NoOfSeatAvailable: 9,
  Origin: { Airport: { AirportCode: from, CityName: from, CountryCode: 'IN', Terminal: '1' }, DepTime: dep },
  Destination: { Airport: { AirportCode: to, CityName: to, CountryCode: 'IN', Terminal: '1' }, ArrTime: arr },
  Duration: 150, GroundTime: 0, StopOver: false, Craft: '320',
})
const day = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10)
const result = (published = 10000) => ({
  ResultIndex: 'OB1', Source: 6, IsLCC: true, IsRefundable: true,
  Fare: { Currency: 'INR', BaseFare: published - 2000, Tax: 2000, YQTax: 0, OtherCharges: 0, PublishedFare: published, OfferedFare: published - 100, AdditionalTxnFeePub: 0, AdditionalTxnFeeOfrd: 0 },
  FareBreakdown: [
    { PassengerType: 1, PassengerCount: 2, BaseFare: (published - 2000) * 0.8, Tax: 1800, YQTax: 0 },
    { PassengerType: 3, PassengerCount: 1, BaseFare: (published - 2000) * 0.2, Tax: 200, YQTax: 0 },
  ],
  Segments: [[seg('BLR', 'DEL', `${day}T06:00:00`, `${day}T08:50:00`, '501')]],
  ValidatingAirline: '6E',
})
const ssrData = {
  ResponseStatus: 1, Error: { ErrorCode: 0 },
  Baggage: [[
    { AirlineCode: '6E', FlightNumber: '501', WayType: 2, Code: 'NoBaggage', Description: 2, Weight: 0, Currency: 'INR', Price: 0, Origin: 'BLR', Destination: 'DEL' },
    { AirlineCode: '6E', FlightNumber: '501', WayType: 2, Code: 'XBPA', Description: 2, Weight: 5, Currency: 'INR', Price: 2500, Origin: 'BLR', Destination: 'DEL' },
  ]],
  MealDynamic: [[
    { AirlineCode: '6E', FlightNumber: '501', WayType: 2, Code: 'NoMeal', Description: 2, Quantity: 0, Currency: 'INR', Price: 0, Origin: 'BLR', Destination: 'DEL' },
    { AirlineCode: '6E', FlightNumber: '501', WayType: 2, Code: 'PTSW', Description: 2, AirlineDescription: 'Paneer sandwich', Quantity: 1, Currency: 'INR', Price: 400, Origin: 'BLR', Destination: 'DEL' },
  ]],
  SeatDynamic: [{ SegmentSeat: [{ RowSeats: [
    { Seats: [{ AirlineCode: '6E', FlightNumber: '501', CraftType: 'A320', Origin: 'BLR', Destination: 'DEL', AvailablityType: 0, Description: 2, Code: 'NoSeat', RowNo: '0', SeatNo: null, Price: 0 }] },
    { Seats: [
      { AirlineCode: '6E', FlightNumber: '501', CraftType: 'A320', Origin: 'BLR', Destination: 'DEL', AvailablityType: 1, Description: 2, Code: '1A', RowNo: '1', SeatNo: 'A', SeatType: 1, Price: 500 },
      { AirlineCode: '6E', FlightNumber: '501', CraftType: 'A320', Origin: 'BLR', Destination: 'DEL', AvailablityType: 1, Description: 2, Code: '1B', RowNo: '1', SeatNo: 'B', SeatType: 3, Price: 300 },
      { AirlineCode: '6E', FlightNumber: '501', CraftType: 'A320', Origin: 'BLR', Destination: 'DEL', AvailablityType: 3, Description: 2, Code: '1C', RowNo: '1', SeatNo: 'C', SeatType: 2, Price: 300 },
    ] },
  ] }] }],
}

// Date-change option: same route five days later, ₹2,000 dearer, ₹500 airline re-issue charge.
const day2 = new Date(Date.now() + 25 * 86400_000).toISOString().slice(0, 10)
const reissueResult = () => {
  const r = result(12000)
  r.ResultIndex = 'RI1'
  r.Segments = [[seg('BLR', 'DEL', `${day2}T09:00:00`, `${day2}T11:50:00`, '777')]]
  r.FareBreakdown[0].SupplierReissueCharges = 500
  r.FareBreakdown[1].SupplierReissueCharges = 0
  return r
}

let tbo
function resetTbo() {
  tbo = {
    calls: [], ticketMode: 'ok', ticketed: false, ticketPrice: 10000, cancelStatus: 4,
    delayTicketMs: 0, crSeq: 100,
    reissueMode: 'ok', reissued: false, hideReissue: false, delayReissueMs: 0, riSeq: 0,
  }
}
const reissuedItinerary = () => ({
  BookingId: 9555, PNR: 'ABC123', Origin: 'BLR', Destination: 'DEL', InvoiceNo: 'INV2',
  Passenger: [
    { PaxId: 21, Title: 'Mr', FirstName: 'Ravi', LastName: 'Kumar', PaxType: 1, Ticket: { TicketId: 31, TicketNumber: '312-9' } },
    { PaxId: 22, Title: 'Mrs', FirstName: 'Asha', LastName: 'Kumar', PaxType: 1, Ticket: { TicketId: 32, TicketNumber: '312-10' } },
    { PaxId: 23, Title: 'Mstr', FirstName: 'Arun', LastName: 'Kumar', PaxType: 3, Ticket: { TicketId: 33, TicketNumber: '312-11' } },
  ],
})
const itinerary = () => ({
  BookingId: 9001, PNR: 'ABC123', Origin: 'BLR', Destination: 'DEL', InvoiceNo: 'INV1',
  Passenger: [
    { PaxId: 1, Title: 'Mr', FirstName: 'Ravi', LastName: 'Kumar', PaxType: 1, Ticket: tbo.ticketed ? { TicketId: 11, TicketNumber: '312-1' } : null },
    { PaxId: 2, Title: 'Mrs', FirstName: 'Asha', LastName: 'Kumar', PaxType: 1, Ticket: tbo.ticketed ? { TicketId: 12, TicketNumber: '312-2' } : null },
    { PaxId: 3, Title: 'Mstr', FirstName: 'Arun', LastName: 'Kumar', PaxType: 3, Ticket: tbo.ticketed ? { TicketId: 13, TicketNumber: '312-3' } : null },
  ],
})
const ok = (o) => ({ Response: { ResponseStatus: 1, Error: { ErrorCode: 0, ErrorMessage: '' }, ...o } })

globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop()
  const body = JSON.parse(init.body)
  tbo.calls.push({ method, body })
  const reply = (o) => new Response(JSON.stringify(o), { status: 200 })
  switch (method) {
    case 'Authenticate': return reply({ Status: 1, TokenId: 'tok', Error: { ErrorCode: 0 }, Member: { AgencyId: 1, MemberId: 2 } })
    case 'Search':
      if (body.SearchType === 1) return reply(ok({ TraceId: `trace-ri-${++tbo.riSeq}`, Results: [[reissueResult()]] }))
      return reply(ok({ TraceId: 'trace-1', Results: [[result()]] }))
    case 'FareRule': return reply({ Response: { Error: { ErrorCode: 0 }, FareRules: [{ Origin: 'BLR', Destination: 'DEL', Airline: '6E', FareBasisCode: 'R0', FareRuleDetail: 'Cancel fee 3000' }] } })
    case 'FareQuote': {
      if (String(body.ResultIndex).startsWith('RI')) return reply(ok({ TraceId: body.TraceId, IsPriceChanged: false, Results: reissueResult() }))
      const r = result()
      // one PNR covering both directions (special / international return)
      if (tbo.roundTrip) r.Segments = [r.Segments[0], [seg('DEL', 'BLR', `${day}T18:00:00`, `${day}T20:50:00`, '502')]]
      if (tbo.gds) r.IsLCC = false
      return reply(ok({ TraceId: body.TraceId, IsPriceChanged: false, Results: r }))
    }
    case 'Book':
      return reply(ok({ Response: { PNR: 'ABC123', BookingId: 9001, Status: 1, IsPriceChanged: false, IsTimeChanged: Boolean(tbo.bookTimeChange), FlightItinerary: { Passenger: [] } } }))
    case 'SSR': return reply({ Response: body.BookingId ? { ...ssrData, TraceId: 'trace-amend' } : ssrData })
    case 'TicketReissue': {
      if (tbo.delayReissueMs) await new Promise((r) => setTimeout(r, tbo.delayReissueMs))
      if (tbo.reissueMode === 'fail') return reply(ok({ ResponseStatus: 2, Error: { ErrorCode: 3, ErrorMessage: 'Amendment not allowed' } }))
      if (body.ResultIndex) tbo.reissued = true
      if (tbo.reissueMode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return reply(ok({ Response: body.ResultIndex ? { BookingId: 9555, PNR: 'ABC123', TicketStatus: 1 } : { BookingId: body.BookingId, PNR: 'ABC123' } }))
    }
    case 'Ticket': {
      if (tbo.delayTicketMs) await new Promise((r) => setTimeout(r, tbo.delayTicketMs))
      if (tbo.ticketMode === 'timeout') { tbo.ticketed = true; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
      if (tbo.ticketMode === 'price-up' && !body.IsPriceChangeAccepted) {
        return reply(ok({ Response: { IsPriceChanged: true, TicketStatus: 8, FlightItinerary: { Fare: { PublishedFare: 10900 }, Passenger: [] } } }))
      }
      tbo.ticketed = true
      return reply(ok({ Response: { PNR: 'ABC123', BookingId: 9001, TicketStatus: 1, IsPriceChanged: false, FlightItinerary: itinerary() } }))
    }
    case 'GetBookingDetails':
      if (body.BookingId === 9555 || (String(body.TraceId).startsWith('trace-ri') && tbo.reissued && !tbo.hideReissue)) {
        return reply({ Response: { Error: { ErrorCode: 0 }, FlightItinerary: reissuedItinerary() } })
      }
      if (String(body.TraceId).startsWith('trace-ri')) return reply({ Response: { Error: { ErrorCode: 2, ErrorMessage: 'No booking found' } } })
      return tbo.ticketed || body.BookingId ? reply({ Response: { Error: { ErrorCode: 0 }, FlightItinerary: itinerary() } })
        : reply({ Response: { Error: { ErrorCode: 2, ErrorMessage: 'No booking found' } } })
    case 'GetCancellationCharges': return reply(ok({ RefundAmount: 5000, CancellationCharge: 3000, Remarks: '' }))
    case 'SendChangeRequest':
      return reply(ok({ TicketCRInfo: body.TicketId.map((t) => (tbo.instantCancel
        ? { ChangeRequestId: tbo.crSeq++, TicketId: t, Status: 1, ChangeRequestStatus: 4, RefundedAmount: 2000, CancellationCharge: 1000, ServiceTaxOnRAF: 0 }
        : { ChangeRequestId: tbo.crSeq++, TicketId: t, Status: 1, ChangeRequestStatus: 1 })) }))
    case 'GetChangeRequestStatus':
      return reply({ ResponseStatus: 1, Error: null, ChangeRequestId: body.ChangeRequestId, RefundedAmount: 2000, CancellationCharge: 1000, ServiceTaxOnRAF: 0, ChangeRequestStatus: tbo.cancelStatus })
    default: return reply({ Response: { Error: { ErrorCode: 99, ErrorMessage: `unexpected ${method}` } } })
  }
}
const count = (m) => tbo.calls.filter((c) => c.method === m).length

/* ---------------- helpers ---------------- */
const searchInput = { journeyType: 1, adults: 2, children: 0, infants: 1, cabin: 2, segments: [{ from: 'BLR', to: 'DEL', date: day }] }
const pax = [
  { type: 1, title: 'Mr', gender: 1, firstName: 'Ravi', lastName: 'Kumar', dob: '1985-04-10' },
  { type: 1, title: 'Mrs', gender: 2, firstName: 'Asha', lastName: 'Kumar', dob: '1988-01-02' },
  { type: 3, title: 'Mstr', gender: 1, firstName: 'Arun', lastName: 'Kumar', dob: new Date(Date.now() - 300 * 86400_000).toISOString().slice(0, 10) },
]
const contact = { email: 'ravi@example.com', phone: '9876543210', address: '12 MG Road', city: 'Bengaluru' }

async function paidDraft({ seat = true } = {}) {
  const s = await F.search(searchInput, {})
  const d = await B.createDraft({ traceId: s.traceId, resultIndexes: [s.groups[0][0].id], search: s.search }, {})
  const ssr = await B.draftSsr(d.id, {})
  const segKey = ssr.legs[0].seats?.[0]?.key
  const sel = [[seat ? { seat: { [segKey]: '1A' }, meal: { 0: 'PTSW' } } : {}, {}, {}]]
  const t = await B.submitTravellers(d.id, { version: ssr.version, pax, contact, ssr: sel }, {})
  return { d, t }
}

beforeEach(async () => {
  resetTbo()
  await q('delete from changes')
  await q('delete from refunds'); await q('delete from booking_events'); await q('delete from bookings'); await q('delete from traces')
})

/* ---------------- tests ---------------- */
test('pricing: per-passenger fare and 5% markup rounded up to a rupee', () => {
  const r = result(10000)
  assert.deepEqual(paxFare(r, 1, 3).BaseFare, 3200) // 6400 / 2 adults
  const p = quoteTotal([{ quote: r, ssr: [{ items: [{ Price: 400 }] }] }], 5)
  assert.equal(p.fare, 1_000_000)
  assert.equal(p.ssr, 40_000)
  assert.equal(p.total % 100, 0)
  assert.equal(p.fare + p.ssr + p.markup, p.total)
  assert.equal(p.markup, 50_000)
})

test('validation: titles, infant age, passport only when needed', () => {
  const flags = { isDomestic: true }
  const dates = { first: day, last: day }
  const counts = { adults: 2, children: 0, infants: 1 }
  assert.deepEqual(checkTravellers({ pax, contact }, counts, flags, dates), [])
  const wrongTitle = pax.map((p, i) => (i === 0 ? { ...p, title: 'Mrs' } : p))
  assert.ok(checkTravellers({ pax: wrongTitle, contact }, counts, flags, dates).some((e) => e.field === 'pax.0.title'))
  const dotted = pax.map((p, i) => (i === 1 ? { ...p, lastName: 'K.' } : p))
  assert.ok(checkTravellers({ pax: dotted, contact }, counts, flags, dates).some((e) => e.field === 'pax.1.lastName'))
  const intl = checkTravellers({ pax, contact }, counts, { isDomestic: false }, dates)
  assert.ok(intl.some((e) => e.field === 'pax.0.passportNo'))
})

test('full LCC flow: seat + meal priced on the server, ticketed once, confirmed', async () => {
  const { t } = await paidDraft()
  // 10000 fare + 500 seat + 400 meal (+ NoBaggage pads at 0) + 5% of fare → rounded up
  assert.equal(t.price.ssr, 90_000)
  assert.equal(t.price.total, 1_000_000 + 90_000 + 50_000)
  assert.equal(t.status, 'AWAITING_PAYMENT')

  const done = await B.fakePay(t.id)
  assert.equal(done.status, 'CONFIRMED')
  assert.equal(count('Ticket'), 1)
  const ticketReq = tbo.calls.find((c) => c.method === 'Ticket').body
  assert.equal(ticketReq.Passengers[0].SeatDynamic[0].Code, '1A')
  assert.equal(ticketReq.Passengers[0].MealDynamic[0].Code, 'PTSW')
  assert.equal(ticketReq.Passengers[2].SeatDynamic, undefined, 'no seat for the infant')
  assert.equal(ticketReq.Passengers[0].Fare.BaseFare, 3200)
  assert.equal(ticketReq.Passengers.filter((p) => p.IsLeadPax).length, 1)
  // TBO rule: SSR is the last call before Ticket.
  const methods = tbo.calls.map((c) => c.method)
  assert.equal(methods[methods.indexOf('Ticket') - 1], 'SSR')
})

test('race: tampered seat price from the browser is ignored', async () => {
  const s = await F.search(searchInput, {})
  const d = await B.createDraft({ traceId: s.traceId, resultIndexes: [s.groups[0][0].id], search: s.search }, {})
  const ssr = await B.draftSsr(d.id, {})
  await assert.rejects(
    B.submitTravellers(d.id, { version: ssr.version, pax, contact, ssr: [[{ seat: { [ssr.legs[0].seats[0].key]: '1C' } }, {}, {}]] }, {}),
    /taken/, 'an occupied seat is refused')
})

test('race: browser callback + webhook + reconciler all at once ticket exactly once', async () => {
  const { t } = await paidDraft()
  await q(`update bookings set status = 'PAID', rzp_payment_id = 'fake_pay_1' where id = $1`, [t.id])
  tbo.delayTicketMs = 50
  await Promise.allSettled(Array.from({ length: 10 }, () => B.fulfil(t.id)))
  assert.equal(count('Ticket'), 1)
  const row = (await q('select status from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
})

test('race: a second, different payment for the same booking is flagged, not ticketed again', async () => {
  const { t } = await paidDraft({ seat: false })
  await B.fakePay(t.id)
  await B.fakePay(t.id)
  assert.equal(count('Ticket'), 1)
  const row = (await q('select status, attention from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
  assert.match(row.attention, /second payment/i)
})

test('race: two travellers-form submits from two tabs — the stale one is refused', async () => {
  const s = await F.search(searchInput, {})
  const d = await B.createDraft({ traceId: s.traceId, resultIndexes: [s.groups[0][0].id], search: s.search }, {})
  const ssr = await B.draftSsr(d.id, {})
  const body = { version: ssr.version, pax, contact, ssr: [[{}, {}, {}]] }
  const [a, b] = await Promise.allSettled([B.submitTravellers(d.id, body, {}), B.submitTravellers(d.id, body, {})])
  assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1)
  assert.match([a, b].find((r) => r.status === 'rejected').reason.message, /another tab/)
})

test('Ticket timeout is never retried: reconciler finds the ticket via GetBookingDetails', async () => {
  const { t } = await paidDraft()
  tbo.ticketMode = 'timeout'
  await B.fakePay(t.id)
  assert.equal(count('Ticket'), 1)
  // checkLeg already polled and found it (TBO did ticket before the timeout)
  let row = (await q('select status, legs from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
  assert.equal(row.legs[0].tickets.length, 3)

  // Same again, but TBO's booking only appears later: the worker "dies", the reconciler takes over.
  await q('delete from refunds'); await q('delete from booking_events'); await q('delete from bookings')
  resetTbo()
  const second = await paidDraft()
  tbo.ticketMode = 'timeout'
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('GetBookingDetails')) tbo.ticketed = false
    return realFetch(url, init)
  }
  await B.fakePay(second.t.id)
  globalThis.fetch = realFetch
  row = (await q('select status from bookings where id = $1', [second.t.id]))[0]
  assert.equal(row.status, 'TICKETING', 'outcome unknown → stays in TICKETING, not failed, not retried')
  tbo.ticketed = true
  await q(`update bookings set claimed_at = now() - interval '10 minutes' where id = $1`, [second.t.id])
  await B.reconcileOne(second.t.id)
  row = (await q('select status from bookings where id = $1', [second.t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
  assert.equal(count('Ticket'), 1, 'still only one Ticket call')
})

test('fare goes up at ticketing → held for staff; staff accepts → ticketed', async () => {
  const { t } = await paidDraft({ seat: false })
  tbo.ticketMode = 'price-up'
  await B.fakePay(t.id)
  let row = (await q('select status, attention from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'ATTENTION')
  assert.match(row.attention, /went up/)
  await B.staffRetry(t.id, { acceptIncrease: true }, 'staff')
  row = (await q('select status from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
  assert.ok(tbo.calls.some((c) => c.method === 'Ticket' && c.body.IsPriceChangeAccepted === true))
})

test('race: cancel clicked twice sends one change request; refund approved twice pays once', async () => {
  const { t } = await paidDraft({ seat: false })
  await B.fakePay(t.id)
  const b = (await q('select * from bookings where id = $1', [t.id]))[0]
  tbo.cancelStatus = 1
  const r = await Promise.allSettled([B.cancel(b, {}), B.cancel(b, {})])
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1)
  assert.equal(count('SendChangeRequest'), 1)

  tbo.cancelStatus = 4
  await B.reconcileOne(t.id)
  const after = (await q('select status from bookings where id = $1', [t.id]))[0]
  assert.equal(after.status, 'CANCELLED')
  const proposals = await q(`select * from refunds where booking_id = $1`, [t.id])
  assert.equal(proposals.length, 3, 'one proposed refund per cancelled ticket')
  assert.ok(proposals.every((p) => p.status === 'pending'), 'held for staff approval')

  const id = proposals[0].id
  const twice = await Promise.allSettled([B.approveRefund(id, {}, 'staff'), B.approveRefund(id, {}, 'staff')])
  assert.equal(twice.filter((x) => x.status === 'fulfilled').length, 1)
  const done = await q(`select status from refunds where id = $1`, [id])
  assert.equal(done[0].status, 'done')

  // Re-running the reconciler can't create duplicate refunds.
  await B.reconcileOne(t.id)
  assert.equal((await q(`select count(*)::int as n from refunds where booking_id = $1`, [t.id]))[0].n, 3)
})

test('online cancellation completed instantly by TBO is applied straight away', async () => {
  const { t } = await paidDraft({ seat: false })
  await B.fakePay(t.id)
  tbo.instantCancel = true
  const b = (await q('select * from bookings where id = $1', [t.id]))[0]
  await B.cancel(b, {})
  const row = (await q('select status, legs from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CANCELLED')
  assert.ok(row.legs[0].tickets.every((x) => x.cancelled))
  assert.equal(count('GetChangeRequestStatus'), 0, 'no polling needed')
  assert.equal((await q(`select count(*)::int as n from refunds where booking_id = $1`, [t.id]))[0].n, 3)
})

test('return on one PNR: GetBookingDetails reports the first trip only and is still recognised', async () => {
  tbo.roundTrip = true
  const { t } = await paidDraft({ seat: false })
  const done = await B.fakePay(t.id)
  assert.equal(done.status, 'CONFIRMED')
  assert.equal(count('Ticket'), 1)
})

test('full-service: time change at Book keeps the PNR, waits for staff, then tickets that PNR (no second Book)', async () => {
  tbo.gds = true
  tbo.bookTimeChange = true
  const { t } = await paidDraft({ seat: false })
  await B.fakePay(t.id)
  let row = (await q('select status, legs, attention from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'ATTENTION')
  assert.equal(row.legs[0].pnr, 'ABC123', 'PNR saved so staff can ticket or release it')
  assert.match(row.attention, /timing/)
  assert.equal(count('Ticket'), 0)

  await B.staffRetry(t.id, { acceptIncrease: true }, 'staff')
  row = (await q('select status from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
  assert.equal(count('Book'), 1, 'never booked twice')
  const ticket = tbo.calls.find((c) => c.method === 'Ticket').body
  assert.equal(ticket.PNR, 'ABC123')
  assert.equal(ticket.IsPriceChangeAccepted, true)
})

test('customer view hides internals; manage token required', async () => {
  const { t } = await paidDraft({ seat: false })
  await B.fakePay(t.id)
  await assert.rejects(B.loadForCustomer(t.ref, 'wrong'), /not found/i)
  const b = await B.loadForCustomer(t.ref, t.manageToken)
  const v = await B.customerView(b, { canManage: true })
  assert.equal(v.statusText, 'Confirmed')
  assert.equal(v.legs[0].pnr, 'ABC123')
  assert.equal(JSON.stringify(v).includes('passport'), false)
  const found = await B.lookup({ ref: t.ref, lastName: 'kumar' })
  assert.equal(found.contact, null)
})

/* ---------------- changes after ticketing: date change + add-ons ---------------- */

async function ticketed() {
  const { t } = await paidDraft({ seat: false })
  await B.fakePay(t.id)
  const fresh = () => B.loadForCustomer(t.ref, t.manageToken)
  return { t, fresh }
}

async function quotedReissue(fresh) {
  const s = await C.reissueSearch(await fresh(), { leg: 0, dates: [day2] }, {})
  return C.reissueQuote(await fresh(), { leg: 0, traceId: s.traceId, resultIndex: s.options[0].id }, {})
}

test('date change: priced on the server, paid, re-issued once, leg points at the new booking', async () => {
  const { t, fresh } = await ticketed()
  const s = await C.reissueSearch(await fresh(), { leg: 0, dates: [day2] }, {})
  // ₹2,000 fare difference + ₹500 re-issue charge + 5% of the difference
  assert.equal(s.options[0].price, 200_000 + 50_000 + 10_000)
  const searchReq = tbo.calls.filter((c) => c.method === 'Search').pop().body
  assert.equal(searchReq.SearchType, 1)
  assert.equal(searchReq.Pnr, 'ABC123')

  const ch = await C.reissueQuote(await fresh(), { leg: 0, traceId: s.traceId, resultIndex: s.options[0].id }, {})
  assert.equal(ch.status, 'AWAITING_PAYMENT')
  assert.equal(ch.amount, 260_000)

  const done = await C.fakeChangePay(await fresh(), ch.id)
  assert.equal(done.status, 'DONE')
  assert.equal(count('TicketReissue'), 1)
  const req = tbo.calls.find((c) => c.method === 'TicketReissue').body
  assert.equal(req.ResultIndex, 'RI1')
  assert.equal(req.BookingId, 9001)
  assert.ok(req.TicketData && 'TourCode' in req.TicketData)

  const row = (await q('select status, legs from bookings where id = $1', [t.id]))[0]
  assert.equal(row.status, 'CONFIRMED')
  assert.equal(row.legs[0].bookingId, 9555)
  assert.equal(row.legs[0].reissuedFrom[0].bookingId, 9001)
  assert.equal(row.legs[0].quote.ResultIndex, 'RI1')
  assert.equal(row.legs[0].tickets[0].number, '312-9')
})

test('race: many workers + a cancel click at once — the ticket is changed OR cancelled, never both', async () => {
  const { t, fresh } = await ticketed()
  const ch = await quotedReissue(fresh)
  await q(`update changes set status = 'PAID', rzp_payment_id = 'fake_pay_chg' where id = $1`, [ch.id])
  tbo.delayReissueMs = 30
  const b = await fresh()
  const out = await Promise.allSettled([...Array.from({ length: 8 }, () => C.processChange(ch.id)), B.cancel(b, {})])
  assert.ok(count('TicketReissue') <= 1)
  assert.equal(count('TicketReissue') + count('SendChangeRequest'), 1, 'exactly one of the two reached TBO')
  const c = (await q('select status from changes where id = $1', [ch.id]))[0]
  if (count('SendChangeRequest')) {
    assert.equal(c.status, 'ATTENTION', 'change held for staff because the booking was being cancelled')
    const r = await q(`select payment_id, status from refunds where idem_key = $1`, [`change:${ch.id}`])
    assert.equal(r[0].payment_id, 'fake_pay_chg', 'refund proposed against the change payment')
  } else {
    assert.equal(c.status, 'DONE')
    assert.match(out.at(-1).reason.message, /in progress/)
  }
})

test('race: cancel while a date change is being made is refused', async () => {
  const { fresh } = await ticketed()
  const ch = await quotedReissue(fresh)
  await q(`update changes set status = 'PAID', rzp_payment_id = 'fake_pay_chg' where id = $1`, [ch.id])
  tbo.delayReissueMs = 80
  const running = C.processChange(ch.id)
  await new Promise((r) => setTimeout(r, 25))
  await assert.rejects(B.cancel(await fresh(), {}), /in progress/)
  assert.equal(await running, 'DONE')
  assert.equal(count('SendChangeRequest'), 0)
})

test('race: only one open change per booking (two tabs paying for two date changes)', async () => {
  const { fresh } = await ticketed()
  const first = await quotedReissue(fresh)
  await q(`update changes set status = 'PAID', rzp_payment_id = 'fake_pay_1' where id = $1`, [first.id])
  await assert.rejects(quotedReissue(fresh), /already being paid for or made/)
  // An unpaid order left open in another tab is simply replaced.
  await q(`update changes set status = 'AWAITING_PAYMENT', rzp_payment_id = null where id = $1`, [first.id])
  const second = await quotedReissue(fresh)
  assert.equal(second.status, 'AWAITING_PAYMENT')
  assert.equal((await q('select status from changes where id = $1', [first.id]))[0].status, 'EXPIRED')
})

test('date change timeout is never re-sent: GetBookingDetails (now or via the reconciler) decides', async () => {
  const { t, fresh } = await ticketed()
  const ch = await quotedReissue(fresh)
  tbo.reissueMode = 'timeout'
  tbo.hideReissue = true // TBO's booking shows up only later
  const r = await C.fakeChangePay(await fresh(), ch.id)
  assert.equal(r.status, 'PROCESSING')
  assert.equal((await q('select status from bookings where id = $1', [t.id]))[0].status, 'CHANGING', 'locked while unsure')
  await assert.rejects(B.cancel(await fresh(), {}), /in progress/)

  tbo.hideReissue = false
  await q(`update changes set claimed_at = now() - interval '10 minutes' where id = $1`, [ch.id])
  await C.reconcileChanges(t.id)
  assert.equal((await q('select status from changes where id = $1', [ch.id]))[0].status, 'DONE')
  assert.equal((await q('select status, legs from bookings where id = $1', [t.id]))[0].legs[0].bookingId, 9555)
  assert.equal(count('TicketReissue'), 1, 'sent exactly once')
})

test('add-ons after ticketing: priced from our SSR copy, infant/tamper rules, one TicketReissue per PaxId', async () => {
  const { t, fresh } = await ticketed()
  const o = await C.addonOptions(await fresh(), { leg: 0 }, {})
  const seatKey = o.options.seats[0].key
  await assert.rejects(C.addonSelect(await fresh(), o.changeId, { ssr: [{}, {}, { seat: { [seatKey]: '1A' } }] }), /lap/)
  await assert.rejects(C.addonSelect(await fresh(), o.changeId, { ssr: [{ baggage: { 0: 'XBPZ' } }, {}, {}] }), /no longer available/)
  const ch = await C.addonSelect(await fresh(), o.changeId, { ssr: [{ seat: { [seatKey]: '1A' } }, { baggage: { 0: 'XBPA' } }, {}] })
  assert.equal(ch.amount, 50_000 + 250_000)

  const done = await C.fakeChangePay(await fresh(), ch.id)
  assert.equal(done.status, 'DONE')
  const req = tbo.calls.find((c) => c.method === 'TicketReissue').body
  assert.equal(req.BookingId, 9001)
  assert.equal(req.TraceId, 'trace-amend')
  assert.deepEqual(req.SSR.map((x) => x.PaxId), [1, 2])
  assert.equal(req.SSR[0].SeatDynamic[0].Code, '1A')
  assert.equal(req.SSR[1].Baggage[0].Code, 'XBPA')
  const legs = (await q('select legs from bookings where id = $1', [t.id]))[0].legs
  assert.equal(legs[0].addons.length, 2)

  // TBO: baggage already bought can't be topped up online.
  const again = await C.addonOptions(await fresh(), { leg: 0 }, {})
  assert.equal(again.travellers[1].hasBaggage, true)
  await assert.rejects(C.addonSelect(await fresh(), again.changeId, { ssr: [{}, { baggage: { 0: 'XBPA' } }, {}] }), /already has extra baggage/)
})

test('add-on refused by the airline → held for staff with a refund of that payment only', async () => {
  const { t, fresh } = await ticketed()
  const o = await C.addonOptions(await fresh(), { leg: 0 }, {})
  const ch = await C.addonSelect(await fresh(), o.changeId, { ssr: [{ meal: { 0: 'PTSW' } }, {}, {}] })
  tbo.reissueMode = 'fail'
  const r = await C.fakeChangePay(await fresh(), ch.id)
  assert.equal(r.status, 'ATTENTION')
  assert.equal((await q('select status from bookings where id = $1', [t.id]))[0].status, 'CONFIRMED', 'booking unlocked')
  const chg = (await q('select rzp_payment_id from changes where id = $1', [ch.id]))[0]
  const [refund] = await q(`select * from refunds where booking_id = $1`, [t.id])
  assert.equal(refund.payment_id, chg.rzp_payment_id)
  assert.equal(refund.amount_paise, 40_000)
  await B.approveRefund(refund.id, {}, 'staff')
  // Can't refund more than that payment, even though the booking itself was paid much more.
  await assert.rejects(B.approveRefund(refund.id, { amount: 1 }, 'staff'), /already being processed|more than/)
})
