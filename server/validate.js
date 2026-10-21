/* Passenger, contact and search validation — the rules from TBO's
   "Flight Validation" checklist and Sample Verification notes.
   Pure JS with no Node imports: the booking form imports this same file,
   so the browser and the server always apply identical rules. */

export const MAX_PAX = 9

/* Titles TBO accepts per passenger type and gender (1 = male, 2 = female). */
export const TITLES = {
  1: { 1: ['Mr'], 2: ['Mrs', 'Ms', 'Miss'] },
  2: { 1: ['Mstr'], 2: ['Miss'] },
  3: { 1: ['Mstr'], 2: ['Miss'] },
}

// Letters and single spaces only — TBO rejects dots, commas, slashes and
// brackets in names (e.g. "Mr Pushaan .. Grover..").
const NAME = /^[A-Za-z]+( [A-Za-z]+)*$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE = /^\d{10}$/
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PASSPORT = /^[A-Z0-9]{6,12}$/
const IATA = /^[A-Z]{3}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')

/** Whole years between two YYYY-MM-DD dates. */
export function ageOn(dob, on) {
  const [y1, m1, d1] = dob.split('-').map(Number)
  const [y2, m2, d2] = on.split('-').map(Number)
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0)
}

/**
 * Search request → normalised search, or { errors }.
 * journeyType: 1 one-way, 2 return, 3 multi-city, 5 special return.
 */
export function checkSearch(s, today) {
  const errors = []
  const journeyType = Number(s.journeyType)
  if (![1, 2, 3, 5].includes(journeyType)) errors.push('Choose one-way, return or multi-city.')
  const adults = Number(s.adults)
  const children = Number(s.children || 0)
  const infants = Number(s.infants || 0)
  if (!(adults >= 1)) errors.push('At least one adult must travel.')
  if (children < 0 || infants < 0) errors.push('Passenger counts cannot be negative.')
  if (adults + children + infants > MAX_PAX) errors.push(`A booking can have at most ${MAX_PAX} passengers, including infants.`)
  if (infants > adults) errors.push('Each infant must travel on an adult’s lap, so infants cannot outnumber adults.')
  const cabin = Number(s.cabin || 2)
  if (![1, 2, 3, 4, 5, 6].includes(cabin)) errors.push('Unknown cabin class.')

  const segs = (s.segments || []).map((g) => ({
    from: clean(g.from).toUpperCase(),
    to: clean(g.to).toUpperCase(),
    date: clean(g.date),
  }))
  const need = journeyType === 3 ? [2, 5] : journeyType === 1 ? [1, 1] : [2, 2]
  if (segs.length < need[0] || segs.length > need[1]) errors.push('Add the right number of flights for this trip type.')
  segs.forEach((g, i) => {
    const n = segs.length > 1 ? ` (flight ${i + 1})` : ''
    if (!IATA.test(g.from) || !IATA.test(g.to)) errors.push(`Pick departure and arrival airports${n}.`)
    if (g.from === g.to) errors.push(`Departure and arrival cannot be the same${n}.`)
    if (!DATE.test(g.date)) errors.push(`Pick a travel date${n}.`)
    else if (today && g.date < today) errors.push(`Travel date cannot be in the past${n}.`)
    if (i > 0 && DATE.test(g.date) && DATE.test(segs[i - 1].date) && g.date < segs[i - 1].date) {
      errors.push(`Flight ${i + 1} cannot be before flight ${i}.`)
    }
  })
  if (journeyType === 2 || journeyType === 5) {
    const [a, b] = segs
    if (a && b && (a.from !== b.to || a.to !== b.from)) errors.push('The return flight must go back the way you came.')
  }
  // Optional airline sources (TBO "Sources"): "GDS" or an LCC code such as 6E / SG.
  // TBO: multi-city searches GDS only, and special return takes one source at a time.
  const sources = Array.isArray(s.sources) ? [...new Set(s.sources.map((x) => clean(x).toUpperCase()))].filter((x) => /^(GDS|[A-Z0-9]{2})$/.test(x)).slice(0, 6) : []
  if (journeyType === 5 && sources.length > 1) errors.push('Special return fares can be searched for one airline at a time.')
  if (errors.length) return { errors }
  return {
    search: {
      journeyType, adults, children, infants, cabin,
      directOnly: Boolean(s.directOnly),
      segments: segs,
      ...(sources.length ? { sources } : {}),
    },
  }
}

/**
 * Validates passengers + contact for a booking.
 * flags: { isDomestic, passport, passportFull, pan, gstMandatory } (from FareQuote)
 * dates: { first, last } travel dates YYYY-MM-DD.
 * Returns a list of { field, message }; empty means valid.
 */
export function checkTravellers({ pax, contact, gst }, counts, flags, dates) {
  const errors = []
  const err = (field, message) => errors.push({ field, message })
  const list = Array.isArray(pax) ? pax : []

  const want = { 1: counts.adults, 2: counts.children, 3: counts.infants }
  for (const t of [1, 2, 3]) {
    if (list.filter((p) => Number(p.type) === t).length !== want[t]) {
      err('pax', 'The number of travellers does not match your search.')
      break
    }
  }

  const passportNeeded = !flags.isDomestic || flags.passport || flags.passportFull
  const seen = new Set()

  list.forEach((p, i) => {
    const f = (k) => `pax.${i}.${k}`
    const type = Number(p.type)
    const gender = Number(p.gender)
    const first = clean(p.firstName)
    const last = clean(p.lastName)

    if (![1, 2].includes(gender)) err(f('gender'), 'Choose male or female, as on the ID.')
    if (!TITLES[type]?.[gender]?.includes(p.title)) err(f('title'), 'Choose a title that matches the passenger.')
    if (!NAME.test(first)) err(f('firstName'), 'Use letters only, exactly as on the ID.')
    if (!NAME.test(last)) err(f('lastName'), 'Use letters only. If you have one name, enter it in both boxes.')
    if (first.length + last.length > 50) err(f('lastName'), 'Name is too long for the airline system.')
    const full = `${first} ${last}`.toLowerCase()
    if (seen.has(full)) err(f('firstName'), 'Two travellers cannot have exactly the same name.')
    seen.add(full)

    const dobNeeded = type !== 1 || passportNeeded
    if (p.dob || dobNeeded) {
      if (!DATE.test(p.dob || '')) err(f('dob'), 'Enter the date of birth.')
      else {
        const a = ageOn(p.dob, dates.first)
        const aLast = ageOn(p.dob, dates.last)
        if (type === 1 && a < 12) err(f('dob'), 'Adults must be 12 or older on the travel date.')
        if (type === 2 && (a < 2 || a > 11)) err(f('dob'), 'Children must be 2–11 years old on the travel date.')
        if (type === 3 && (a < 0 || aLast >= 2)) err(f('dob'), 'Infants must be under 2 for the whole trip.')
      }
    }

    if (passportNeeded) {
      const no = clean(p.passportNo).toUpperCase()
      if (!PASSPORT.test(no)) err(f('passportNo'), 'Enter the passport number.')
      if (!DATE.test(p.passportExpiry || '')) err(f('passportExpiry'), 'Enter the passport expiry date.')
      else if (p.passportExpiry <= dates.last) err(f('passportExpiry'), 'The passport expires before the trip ends.')
      if (flags.passportFull) {
        if (!DATE.test(p.passportIssueDate || '')) err(f('passportIssueDate'), 'Enter the passport issue date.')
        else if ((p.dob && p.passportIssueDate < p.dob) || p.passportIssueDate > dates.first) err(f('passportIssueDate'), 'The issue date must be after the date of birth and before travel.')
        if (!/^[A-Z]{2}$/.test(clean(p.passportIssueCountry).toUpperCase())) err(f('passportIssueCountry'), 'Enter the issuing country.')
      }
    }
    if (!/^[A-Z]{2}$/.test(clean(p.nationality || 'IN').toUpperCase())) err(f('nationality'), 'Choose a nationality.')

    if (flags.pan) {
      if (type === 1 && ageOn(p.dob || dates.first, dates.first) >= 18) {
        if (!PAN.test(clean(p.pan).toUpperCase())) err(f('pan'), 'Enter a valid PAN (e.g. ABCDE1234F).')
      } else if (!PAN.test(clean(p.pan).toUpperCase())) {
        const g = p.guardian || {}
        if (!PAN.test(clean(g.pan).toUpperCase()) || !NAME.test(clean(g.firstName)) || !NAME.test(clean(g.lastName))) {
          err(f('guardian'), 'Enter a parent or guardian’s name and PAN, exactly as on the PAN card.')
        }
      }
    }
  })

  const c = contact || {}
  if (!EMAIL.test(clean(c.email))) err('contact.email', 'Enter an email address for the e-ticket.')
  if (!PHONE.test(clean(c.phone).replace(/^\+?91/, ''))) err('contact.phone', 'Enter a 10-digit mobile number.')
  if (clean(c.address).length < 3) err('contact.address', 'Enter an address (the airline requires one).')
  if (clean(c.city).length < 2) err('contact.city', 'Enter the city.')

  if (flags.gstMandatory || gst?.number) {
    const g = gst || {}
    if (!GSTIN.test(clean(g.number).toUpperCase())) err('gst.number', 'Enter a valid 15-character GSTIN.')
    if (clean(g.company).length < 2) err('gst.company', 'Enter the company name on the GST registration.')
    if (!EMAIL.test(clean(g.email))) err('gst.email', 'Enter the company email.')
    if (!PHONE.test(clean(g.phone).replace(/^\+?91/, ''))) err('gst.phone', 'Enter the company phone number.')
    if (clean(g.address).length < 3) err('gst.address', 'Enter the company address.')
  }
  return errors
}

export const normName = clean
