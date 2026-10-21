/* Money maths. Everything the customer pays is computed here, on the server,
   from TBO's own FareQuote/SSR responses — never from numbers the browser sends.
   Amounts are paise (integers) unless a name says otherwise. */

export const PAX_TYPES = { 1: 'Adult', 2: 'Child', 3: 'Infant' }

const paise = (rupees) => Math.round(Number(rupees || 0) * 100)
const r2 = (n) => Math.round(n * 100) / 100

/** Agency markup, a percentage of the airline fare (FLIGHT_MARKUP_PERCENT, default 0). */
export function markupPercent() {
  const pct = Number(process.env.FLIGHT_MARKUP_PERCENT || 0)
  return Number.isFinite(pct) && pct >= 0 && pct <= 50 ? pct : 0
}

/**
 * The INR fare object of a TBO result. TBO can quote in another currency and
 * put the INR figures in BaseCurrencyFare; we only sell in rupees.
 */
export function inrFare(result) {
  if (result?.Fare?.Currency === 'INR') return result.Fare
  if (result?.BaseCurrencyFare?.Currency === 'INR') return result.BaseCurrencyFare
  return null
}

/** What the customer sees for a result before any add-ons (search list, fare cards). */
export function displayPrice(result, pct = markupPercent()) {
  const fare = inrFare(result)
  if (!fare) return null
  const base = paise(fare.PublishedFare)
  return roundUpRupee(base + Math.round((base * pct) / 100))
}

const roundUpRupee = (p) => Math.ceil(p / 100) * 100

/** Sum of the Price of every selected SSR item (seats, meals, baggage, services). */
export function ssrTotal(selections = []) {
  let total = 0
  for (const s of selections) for (const item of s.items || []) total += paise(item.Price)
  return total
}

/**
 * Final price for a booking: TBO published fare per leg + add-ons at cost +
 * markup on the fare. The total is rounded UP to a whole rupee; the markup
 * absorbs the rounding so the breakdown always adds up.
 */
export function quoteTotal(legs, pct = markupPercent()) {
  let fare = 0
  let ssr = 0
  for (const leg of legs) {
    const f = inrFare(leg.quote)
    if (!f) throw new Error('This fare is not priced in INR.')
    fare += paise(f.PublishedFare)
    ssr += ssrTotal(leg.ssr)
  }
  const raw = fare + ssr + Math.round((fare * pct) / 100)
  const total = roundUpRupee(raw)
  return { fare, ssr, markup: total - fare - ssr, markupPercent: pct, total }
}

/**
 * Per-passenger fare for the Book/Ticket request. TBO's rule: take the
 * FareBreakdown row for the passenger type and divide its BaseFare, Tax
 * (and the other per-type amounts) by that row's PassengerCount.
 * Booking-level OtherCharges are split evenly across all passengers.
 */
export function paxFare(result, paxType, totalPax) {
  const fare = inrFare(result)
  const row = (result.FareBreakdown || []).find((b) => Number(b.PassengerType) === Number(paxType))
  if (!fare || !row) throw new Error(`No fare breakdown for passenger type ${paxType}.`)
  const n = Number(row.PassengerCount) || 1
  return {
    Currency: 'INR',
    BaseFare: r2(row.BaseFare / n),
    Tax: r2(row.Tax / n),
    YQTax: r2((row.YQTax || 0) / n),
    AdditionalTxnFeePub: r2((row.AdditionalTxnFeePub || 0) / n),
    AdditionalTxnFeeOfrd: r2((row.AdditionalTxnFeeOfrd || 0) / n),
    OtherCharges: r2((fare.OtherCharges || 0) / Math.max(1, totalPax)),
  }
}

/**
 * Has the price moved against us? TBO's Book/Ticket can return a new fare.
 * We accept it automatically only if it is not higher than what we quoted
 * (the customer has already paid the quoted amount). Otherwise staff decide.
 */
export function priceIncrease(oldResult, newResult) {
  const a = inrFare(oldResult)
  const b = inrFare(newResult)
  if (!a || !b) return Infinity
  return paise(b.PublishedFare) - paise(a.PublishedFare)
}

/** Agency fee per date change, in rupees (FLIGHT_CHANGE_FEE, default 0). */
export function changeFee() {
  const fee = Number(process.env.FLIGHT_CHANGE_FEE || 0)
  return Number.isFinite(fee) && fee >= 0 ? paise(fee) : 0
}

/**
 * Date change: fare difference (never negative — airlines keep a cheaper
 * difference), the airline's re-issue charge from FareQuote, our markup on
 * the difference, and an optional fixed fee. Rounded up to a rupee.
 * TBO-confirm: SupplierReissueCharges is read at fare level, else summed
 * from FareBreakdown rows (TBO shows it per passenger-type row).
 */
export function reissueTotal(oldResult, newResult, pct = markupPercent(), fee = changeFee()) {
  const a = inrFare(oldResult)
  const b = inrFare(newResult)
  if (!a || !b) throw new Error('This fare is not priced in INR.')
  const difference = Math.max(0, paise(b.PublishedFare) - paise(a.PublishedFare))
  const fareLevel = b.SupplierReissueCharges
  const charges = paise(fareLevel != null
    ? fareLevel
    : (newResult.FareBreakdown || []).reduce((t, r) => t + Number(r.SupplierReissueCharges || 0), 0))
  const raw = difference + charges + Math.round((difference * pct) / 100) + fee
  const total = roundUpRupee(raw)
  return { difference, charges, fee, markup: total - difference - charges - fee, markupPercent: pct, total }
}

export const rupees = (p) => `₹${(Number(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
