import { q } from './db.js'
import { call } from './tbo.js'
import { inrFare, displayPrice, markupPercent } from './pricing.js'
import { checkSearch } from './validate.js'

/* Search-side TBO methods (no booking state) and the shapes the UI gets.
   The browser only ever sees compact cards with prices already including
   our markup; raw TBO objects stay on the server. */

export class UserError extends Error {
  constructor(message, status = 400, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
const at = (d) => `${d}T00:00:00`

/** TBO segments come as an array of arrays (one inner array per trip). */
export function tripsOf(result) {
  const s = result?.Segments || []
  return Array.isArray(s[0]) ? s : [s]
}

const segView = (s) => ({
  airline: s.Airline?.AirlineCode,
  airlineName: s.Airline?.AirlineName,
  flight: `${s.Airline?.AirlineCode}-${s.Airline?.FlightNumber}`,
  operatedBy: s.Airline?.OperatingCarrier && s.Airline.OperatingCarrier !== s.Airline.AirlineCode ? s.Airline.OperatingCarrier : null,
  from: s.Origin?.Airport?.AirportCode,
  fromCity: s.Origin?.Airport?.CityName,
  fromTerminal: s.Origin?.Airport?.Terminal || null,
  to: s.Destination?.Airport?.AirportCode,
  toCity: s.Destination?.Airport?.CityName,
  toTerminal: s.Destination?.Airport?.Terminal || null,
  dep: s.Origin?.DepTime,
  arr: s.Destination?.ArrTime,
  minutes: Number(s.Duration) || 0,
  layover: Number(s.GroundTime) || 0,
  craft: s.Craft || null,
  baggage: s.Baggage || null,
  cabinBaggage: s.CabinBaggage ? String(s.CabinBaggage).trim() : null,
  seatsLeft: s.NoOfSeatAvailable ?? null,
  stopOver: s.StopOver ? s.StopPoint || true : null,
})

export const isDomesticResult = (r) =>
  tripsOf(r).flat().every((s) => s.Origin?.Airport?.CountryCode === 'IN' && s.Destination?.Airport?.CountryCode === 'IN')

/** One flight option as the results list shows it. */
export function card(r, pct = markupPercent()) {
  const price = displayPrice(r, pct)
  if (price == null) return null
  const trips = tripsOf(r).map((segs) => {
    const v = segs.map(segView)
    const last = segs[segs.length - 1]
    const minutes = Number(last?.AccumulatedDuration) || v.reduce((t, s) => t + s.minutes + s.layover, 0)
    return {
      from: v[0]?.from, fromCity: v[0]?.fromCity, to: v[v.length - 1]?.to, toCity: v[v.length - 1]?.toCity,
      dep: v[0]?.dep, arr: v[v.length - 1]?.arr, minutes,
      stops: v.length - 1 + v.filter((s) => s.stopOver).length,
      segments: v,
    }
  })
  const seats = trips.flatMap((t) => t.segments.map((s) => s.seatsLeft)).filter((n) => n != null && n > 0)
  return {
    id: r.ResultIndex,
    lcc: Boolean(r.IsLCC),
    refundable: Boolean(r.IsRefundable),
    airline: r.ValidatingAirline || r.AirlineCode || trips[0]?.segments[0]?.airline,
    airlineName: trips[0]?.segments[0]?.airlineName,
    price,
    fareType: r.ResultFareType || null,
    // e.g. "Publish", "NDC-Light", "PublishNDC" — NDC fares say so here.
    fareClass: r.FareClassification?.Type || null,
    source: r.Source ?? null,
    remark: r.AirlineRemark || null,
    transitVisa: Boolean(r.IsTransitVisaRequired),
    seatsLeft: seats.length ? Math.min(...seats) : null,
    trips,
  }
}

const tboFail = (r, fallback) => {
  if (r.unknown) return new UserError('The airline system did not answer in time. Please try again.', 504)
  return new UserError(r.error?.message || fallback, 502)
}

/** Search → { traceId, groups } where groups[1] exists for split (domestic) returns. */
export async function search(input, ctx) {
  const { search: s, errors } = checkSearch(input, todayIST())
  if (errors) throw new UserError(errors[0], 400, { errors })

  const Segments = s.segments.map((g) => ({
    Origin: g.from,
    Destination: g.to,
    FlightCabinClass: s.cabin,
    PreferredDepartureTime: at(g.date),
    PreferredArrivalTime: at(g.date),
  }))
  const r = await call('Search', {
    AdultCount: s.adults,
    ChildCount: s.children,
    InfantCount: s.infants,
    DirectFlight: s.directOnly,
    OneStopFlight: false,
    JourneyType: s.journeyType,
    PreferredAirlines: null,
    Segments,
    // Multi-city is GDS-only at TBO; otherwise all sources unless the search names some.
    Sources: s.sources || (s.journeyType === 3 ? ['GDS'] : null),
  }, ctx)
  if (!r.ok) {
    if (/no result|not found/i.test(r.error?.message || '')) return { traceId: null, search: s, groups: [[]] }
    throw tboFail(r, 'Flight search failed.')
  }

  const traceId = r.data.TraceId
  // The server, not the browser, remembers when this TraceId was issued:
  // TBO kills it after 15 minutes, and booking must finish inside that.
  await q(`insert into traces (trace_id) values ($1) on conflict do nothing`, [traceId])

  const pct = markupPercent()
  const raw = Array.isArray(r.data.Results) ? r.data.Results : []
  const groups = (Array.isArray(raw[0]) ? raw : [raw]).map((list) => list.map((x) => card(x, pct)).filter(Boolean))
  return { traceId, search: s, groups, issuedAt: new Date().toISOString() }
}

/** Cheapest fare per day for a month (domestic one-way only, per TBO). */
export async function calendar({ from, to, month, cabin }, ctx) {
  if (!/^[A-Z]{3}$/.test(from || '') || !/^[A-Z]{3}$/.test(to || '') || !/^\d{4}-\d{2}$/.test(month || '')) {
    throw new UserError('Pick both airports and a month.')
  }
  const r = await call('GetCalendarFare', {
    JourneyType: 1,
    PreferredAirlines: null,
    Segments: [{ Origin: from, Destination: to, FlightCabinClass: Number(cabin) || 1, PreferredDepartureTime: at(`${month}-01`) }],
    Sources: null,
  }, ctx)
  if (!r.ok) throw tboFail(r, 'Fare calendar is not available for this route.')
  const pct = markupPercent()
  const days = (r.data.SearchResults || []).map((x) => {
    const when = String(x.DepartureDate || x.DepartureTime || '')
    const m = when.match(/^(\d{2})-(\d{2})-(\d{4})/)
    const date = m ? `${m[3]}-${m[2]}-${m[1]}` : when.slice(0, 10)
    const base = Math.round((Number(x.BaseFare || 0) + Number(x.Tax || 0) + Number(x.OtherCharges ?? x.OtherCharge ?? 0)) * 100)
    return {
      date,
      airline: x.AirlineName || x.AirlineCode,
      price: Math.ceil((base + Math.round((base * pct) / 100)) / 100) * 100,
      lowest: Boolean(x.IsLowestFareOfMonth ?? x.IsLowestFare),
    }
  }).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
  return { days }
}

/** Fare families (Saver / Flexi / Super 6E …) for one result. */
export async function fareOptions({ traceId, resultIndex }, ctx) {
  if (!traceId || !resultIndex) throw new UserError('Missing flight.')
  const r = await call('FareUpsell', { TraceId: traceId, ResultIndex: resultIndex }, ctx)
  if (!r.ok) return { options: [] }
  const pct = markupPercent()
  const list = Array.isArray(r.data.Results) ? r.data.Results : r.data.Results ? [r.data.Results] : []
  const options = list.map((x) => {
    const c = card(x, pct)
    if (!c) return null
    const ups = x.UpsellOptionsList?.UpsellList || []
    const services = [...new Set(ups.flatMap((u) => (u.ServicesList || [])
      .filter((sv) => sv.IsIncluded || sv.IsChargeable)
      .map((sv) => `${sv.UpsellDescription || sv.ServiceType}${sv.IsChargeable && !sv.IsIncluded ? ' (paid)' : ''}`)))]
    return { id: c.id, price: c.price, refundable: c.refundable, name: ups[0]?.FareFamilyName || c.fareType || 'Fare', services }
  }).filter(Boolean)
  return { options }
}

export { inrFare, isDomesticResult as domestic, segView }
