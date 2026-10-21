/* ============================================================
   TBO Air API certification runner (staging only).

   Books TBO's certification test cases through the SAME booking engine the
   website uses (server/), with test-mode payment, then writes every TBO
   request/response for each case into its own folder — the "case-wise JSON
   logs" TBO asks for before giving live access.

   Usage:  node scripts/tbo-certify.mjs            (all cases)
           node scripts/tbo-certify.mjs 2 4         (only cases 2 and 4)
   Needs TBO_USERNAME / TBO_PASSWORD (staging API login) in .env.local.
   Output: certification/<date>/case-NN-…/  +  certification/<date>/SUMMARY.md
   ============================================================ */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
process.chdir(root)
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
if (process.env.TBO_ENV === 'live') { console.error('Refusing to run certification bookings against LIVE TBO.'); process.exit(1) }
if (!process.env.TBO_USERNAME || !process.env.TBO_PASSWORD) { console.error('Set TBO_USERNAME and TBO_PASSWORD (staging API login) in .env.local first.'); process.exit(1) }
// Test-mode payments, full search logs, and a separate local database for certification runs.
Object.assign(process.env, { ALLOW_FAKE_PAYMENTS: 'true', TBO_LOG_SEARCH: 'full', TBO_ENV: 'staging' })
delete process.env.RAZORPAY_KEY_ID
delete process.env.RAZORPAY_KEY_SECRET
// Each case runs in its own process with a fresh in-memory database: full search
// logs are several MB each, too much to pile up in one in-process Postgres.
process.env.PGLITE_DIR = 'memory://'
delete process.env.DATABASE_URL

const { q } = await import('../server/db.js')
const F = await import('../server/flights.js')
const B = await import('../server/bookings.js')
const { call } = await import('../server/tbo.js')

/* ---------------- test data ---------------- */
const day = (n) => new Date(Date.now() + 5.5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10)
const yearsBefore = (date, y, extraDays = 0) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCFullYear(d.getUTCFullYear() - y)
  d.setUTCDate(d.getUTCDate() - extraDays)
  return d.toISOString().slice(0, 10)
}
// Different names on every run: TBO blocks a repeat booking with the same
// sector, date, flight and passengers ("duplicate booking" rule).
const FIRST = { 1: [['Ravi', 1], ['Asha', 2], ['Imran', 1], ['Fatima', 2], ['Kiran', 1], ['Neha', 2]], 2: [['Arjun', 1], ['Sara', 2], ['Rehan', 1]], 3: [['Ayaan', 1], ['Zoya', 2]] }
const LAST = ['Sharma', 'Khan', 'Reddy', 'Iyer', 'Nair', 'Patel', 'Rao', 'Shetty', 'Menon', 'Gupta', 'Joshi', 'Pillai']
const runSeed = Math.floor(Date.now() / 1000)
const passportNo = (i) => `Z${String((runSeed * 7 + i * 7919) % 10_000_000).padStart(7, '0')}`

function travellers(counts, travelDate, caseNo, { passport }) {
  const last = LAST[(runSeed + caseNo) % LAST.length]
  const list = []
  let n = 0
  for (const [type, count] of [[1, counts.adults], [2, counts.children], [3, counts.infants]]) {
    for (let k = 0; k < count; k++, n++) {
      const [first, gender] = FIRST[type][k % FIRST[type].length]
      const title = type === 1 ? (gender === 1 ? 'Mr' : 'Mrs') : gender === 1 ? 'Mstr' : 'Miss'
      const dob = type === 1 ? yearsBefore(travelDate, 30 + k * 3, 40) : type === 2 ? yearsBefore(travelDate, 6 + k, 20) : yearsBefore(travelDate, 1, 10)
      list.push({
        type, title, gender, firstName: first, lastName: last, dob, nationality: 'IN',
        ...(passport ? {
          passportNo: passportNo(n), passportExpiry: yearsBefore(travelDate, -6), passportIssueCountry: 'IN',
          // issued after birth (a baby's passport is issued within weeks of birth)
          passportIssueDate: [yearsBefore(travelDate, 3), yearsBefore(dob, 0, -30)].sort().at(-1),
        } : {}),
      })
    }
  }
  return list
}
const contact = { email: 'protours@protours.co.in', phone: '9900517604', address: 'A.M. Plaza, Hospital Road, Shivaji Nagar', city: 'Bengaluru' }

/* ---------------- result picking ---------------- */
const isLcc = (c) => c.lcc
const isGds = (c) => !c.lcc
const pickOne = (list, test) => (list || []).find(test)
const sameAirline = (a) => (c) => c.airline === a.airline
// TBO marks NDC fares in FareClassification ("NDC-Light", "PublishNDC" …)
const isNdc = (c) => !c.lcc && /NDC/i.test(c.fareClass || '')

/** Picks paid add-ons from the SSR step the way a customer would (seat, meal, extra bag). */
function chooseSsr(ssrView, pax) {
  return ssrView.legs.map((opt) => pax.map((p, pi) => {
    if (!opt) return {}
    if (!opt.lcc) return { meal: opt.meals[0]?.code || '', seat: p.type === 3 ? '' : opt.seatPrefs[0]?.code || '' }
    const pick = {}
    const meals = opt.meals.map((g) => [g.group, g.options.find((o) => !o.none && o.price > 0) || g.options.find((o) => !o.none)])
    if (meals.some(([, o]) => o)) pick.meal = Object.fromEntries(meals.filter(([, o]) => o).map(([g, o]) => [g, o.code]))
    if (p.type !== 3) {
      const bags = opt.baggage.map((g) => [g.group, g.options.find((o) => !o.none && o.price > 0)])
      if (bags.some(([, o]) => o)) pick.baggage = Object.fromEntries(bags.filter(([, o]) => o).map(([g, o]) => [g, o.code]))
      pick.seat = {}
      for (const seg of opt.seats) {
        // a different open seat per traveller
        const open = seg.rows.flatMap((r) => r.seats).filter((s) => s.open)
        const s = open[pi * 2] || open[pi]
        if (s) pick.seat[seg.key] = s.code
      }
    }
    return pick
  }))
}

/* ---------------- the cases (TBO certification list) ---------------- */
const CASES = [
  { no: 1, tbo: 1, title: 'GDS Domestic Oneway – 1 Adult', search: { journeyType: 1, adults: 1, children: 0, infants: 0, sources: ['GDS'], segments: [['DEL', 'BOM', 30]] }, pick: (g) => [pickOne(g[0], isGds)] },
  { no: 2, tbo: 2, title: 'LCC Domestic Oneway – 1 Adult + 1 Child + 1 Infant (with SSR)', ssr: true, search: { journeyType: 1, adults: 1, children: 1, infants: 1, segments: [['DEL', 'BOM', 31]] }, pick: (g) => [pickOne(g[0], isLcc)] },
  { no: 3, tbo: 3, title: 'LCC Domestic Return – 2 Adults + 2 Children + 1 Infant', search: { journeyType: 2, adults: 2, children: 2, infants: 1, segments: [['BLR', 'BOM', 32], ['BOM', 'BLR', 36]] }, pick: (g) => [pickOne(g[0], isLcc), pickOne(g[1], isLcc)] },
  { no: 4, tbo: 4, title: 'LCC International Oneway – 1 Adult + 1 Child + 1 Infant (with SSR)', ssr: true, search: { journeyType: 1, adults: 1, children: 1, infants: 1, segments: [['DEL', 'DXB', 33]] }, pick: (g) => [pickOne(g[0], (c) => c.lcc && ['IX', 'SG', 'FZ'].includes(c.airline)) || pickOne(g[0], isLcc)] },
  { no: 5, tbo: 5, title: 'GDS International Return – 2 Adults + 2 Children + 1 Infant', search: { journeyType: 2, adults: 2, children: 2, infants: 1, sources: ['GDS'], segments: [['DEL', 'DXB', 34], ['DXB', 'DEL', 40]] }, pick: (g) => [pickOne(g[0], isGds)] },
  // TBO's optional case 6 (LCC domestic special return) returns no fares on staging for 6E/SG on any test sector, so its other optional NDC case is used instead.
  { no: 6, tbo: 12, title: 'NDC International Return – 2 Adults + 2 Children', ndc: true, search: { journeyType: 2, adults: 2, children: 2, infants: 0, segments: [['DEL', 'CDG', 102], ['CDG', 'DEL', 112]] }, candidates: (g) => g[0].filter(isNdc).sort((a, b) => (b.source === 211) - (a.source === 211)).map((c) => [c]) },
  { no: 7, tbo: 7, title: 'GDS Domestic Special Return (with SSR) – 2 Adults + 2 Children + 1 Infant', ssr: true, search: { journeyType: 5, adults: 2, children: 2, infants: 1, sources: ['GDS'], segments: [['DEL', 'BOM', 37], ['BOM', 'DEL', 41]] }, pick: (g) => { const ob = pickOne(g[0], isGds); return g[1] ? [ob, ob && pickOne(g[1], sameAirline(ob))] : [ob] } },
  { no: 8, tbo: 8, title: 'GDS Multiway – 2 Adults', search: { journeyType: 3, adults: 2, children: 0, infants: 0, sources: ['GDS'], segments: [['DEL', 'BOM', 39], ['BOM', 'BLR', 42], ['BLR', 'DEL', 45]] }, pick: (g) => [pickOne(g[0], isGds)] },
  { no: 9, tbo: 9, title: 'Domestic Oneway Air Fare Calendar – 2 Adults', calendar: true, search: { journeyType: 1, adults: 2, children: 0, infants: 0, segments: [['DEL', 'BOM', 43]] }, pick: (g) => [g[0][0]] },
  // TBO "Sample Verification": the one case sent and verified BEFORE the test cases.
  { no: 11, tbo: 'Sample', title: 'Sample Verification – Domestic Return 2 Adults + 1 Child + 1 Infant (LCC, with SSR)', ssr: true, search: { journeyType: 2, adults: 2, children: 1, infants: 1, segments: [['BLR', 'BOM', 26], ['BOM', 'BLR', 29]] }, pick: (g) => [pickOne(g[0], isLcc), pickOne(g[1], isLcc)] },
  { no: 10, tbo: 11, title: 'NDC International Oneway – 2 Adults + 2 Children (with SSR)', ssr: true, ndc: true, search: { journeyType: 1, adults: 2, children: 2, infants: 0, segments: [['DEL', 'LHR', 100]] }, candidates: (g) => g[0].filter(isNdc).map((c) => [c]) },
]

/* ---------------- run ---------------- */
const only = process.argv.slice(2).map(Number).filter(Boolean)
const outDir = path.join('certification', day(0))
mkdirSync(outDir, { recursive: true })

// No case numbers given: run every case, each in its own process, then summarise.
if (!only.length) {
  for (const c of CASES) spawnSync(process.execPath, [path.join('scripts', 'tbo-certify.mjs'), String(c.no)], { stdio: 'inherit' })
  writeSummary()
  process.exit(0)
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
const maxLogId = async () => Number((await q('select coalesce(max(id), 0)::int as id from tbo_logs'))[0].id)
const summary = []

for (const c of CASES.filter((x) => !only.length || only.includes(x.no))) {
  const startId = await maxLogId()
  const started = new Date()
  const result = { case: c.no, tboCase: c.tbo, title: c.title, status: 'NOT RUN', refs: [], pnrs: [], bookingIds: [], notes: [] }
  console.log(`\n=== Case ${c.no} (TBO case ${c.tbo}): ${c.title}`)
  try {
    const s = { ...c.search, cabin: 2, segments: c.search.segments.map(([from, to, d]) => ({ from, to, date: day(d) })) }

    if (c.calendar) {
      // Fare calendar → pick the cheapest day → refresh that day → search it.
      const cal = await F.calendar({ from: s.segments[0].from, to: s.segments[0].to, month: s.segments[0].date.slice(0, 7), cabin: 1 }, {})
      const cheapest = cal.days.filter((d) => d.date >= day(7)).sort((a, b) => a.price - b.price)[0]
      if (cheapest) {
        s.segments[0].date = cheapest.date
        await call('UpdateCalendarFareOfDay', { JourneyType: 1, PreferredAirlines: null, Segments: [{ Origin: s.segments[0].from, Destination: s.segments[0].to, FlightCabinClass: 1, PreferredDepartureTime: `${cheapest.date}T00:00:00` }], Sources: null }, {})
        result.notes.push(`Calendar: cheapest day ${cheapest.date}`)
      } else result.notes.push('Calendar returned no days; searched the planned date')
    }

    const res = await F.search(s, {})
    result.traceId = res.traceId
    // Candidates in order; if an airline declines at FareQuote ("failed from the Supplier end"), try the next.
    const options = res.traceId ? (c.candidates ? c.candidates(res.groups) : [c.pick(res.groups)]).filter((o) => o.length && o.every(Boolean)).slice(0, 5) : []
    if (!options.length) throw new Error(`No suitable result on staging for this case (results: ${res.groups.map((g) => g.length).join('/')})`)
    let draft, indexes
    for (const option of options) {
      indexes = option
      result.flights = indexes.map((x) => `${x.airlineName} ${x.trips.map((t) => t.segments.map((g) => g.flight).join('+')).join(' / ')} (${x.lcc ? 'LCC' : x.fareClass || 'GDS'}, source ${x.source})`)
      console.log('  picked:', result.flights.join(' | '))
      try {
        draft = await B.createDraft({ traceId: res.traceId, resultIndexes: indexes.map((x) => x.id), search: res.search }, {})
        break
      } catch (e) {
        if (e.status !== 409 || option === options.at(-1)) throw e
        result.notes.push(`${result.flights.join(' | ')}: ${e.message} — tried the next fare`)
      }
    }
    result.refs.push(draft.ref)
    const passport = !draft.flags.isDomestic || draft.flags.passport || draft.flags.passportFull || c.ndc
    const pax = travellers(s, draft.dates.last || s.segments.at(-1).date, c.no, { passport })
    const ssr = await B.draftSsr(draft.id, {})
    const selections = c.ssr ? chooseSsr(ssr, pax) : undefined
    const submitted = await B.submitTravellers(draft.id, { version: ssr.version, pax, contact, ssr: selections }, {})
    result.amount = submitted.price.total / 100
    const done = await B.fakePay(draft.id)
    // Wait for any reconciliation (Ticket can take minutes on staging).
    let status = done.status
    for (let i = 0; i < 20 && ['PAID', 'TICKETING'].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 15_000))
      await B.reconcileOne(draft.id)
      status = (await B.statusOf(draft.id)).status
    }
    let row = (await q('select status, legs, attention from bookings where id = $1', [draft.id]))[0]
    // Airline changed the time or fare at Book: staff would confirm with the customer, then
    // ticket the SAME PNR with IsPriceChangeAccepted (TBO guide) — do exactly that.
    if (row.status === 'ATTENTION' && /timing|went up/i.test(row.attention || '')) {
      result.notes.push(`Airline change at Book: ${row.attention}`)
      await B.staffRetry(draft.id, { acceptIncrease: true }, 'certification')
      row = (await q('select status, legs, attention from bookings where id = $1', [draft.id]))[0]
      result.notes.push('Change accepted and ticketed on the same PNR')
    }
    result.status = row.status
    result.pnrs = row.legs.map((l) => l.pnr || '—')
    result.bookingIds = row.legs.map((l) => l.bookingId || '—')
    result.tickets = row.legs.map((l) => (l.tickets || []).map((t) => `${t.name}: ${t.number}`))
    if (row.attention) result.notes.push(row.attention)
  } catch (e) {
    result.status = 'ERROR'
    result.notes.push(e.message)
  }

  // Case-wise logs: every TBO call made during this case, in order, plus the day's login.
  const logs = await q('select id, at, method, request, response, http_status, ms, error from tbo_logs where id > $1 order by id', [startId])
  const login = (await q(`select id, at, method, request, response, http_status, ms, error from tbo_logs where method = 'Authenticate' and id <= $1 order by id desc limit 1`, [startId]))[0]
  const dir = path.join(outDir, `case-${String(c.no).padStart(2, '0')}-${slug(c.title)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const all = [...(login ? [login] : []), ...logs]
  all.forEach((l, i) => {
    const base = `${String(i).padStart(2, '0')}-${l.method}`
    writeFileSync(path.join(dir, `${base}-request.json`), JSON.stringify(l.request, null, 2))
    writeFileSync(path.join(dir, `${base}-response.json`), JSON.stringify(l.response, null, 2))
  })
  result.methods = all.map((l) => `${l.method}${l.error ? ` (${l.error})` : ''}`)
  result.started = started.toISOString()
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result, null, 2))
  summary.push(result)
  console.log(`  → ${result.status}  PNR ${result.pnrs.join(', ') || '—'}  ${result.notes.join(' | ')}`)
}

writeSummary()
process.exit(0)

/* ---------------- summary (built from every case folder of the day) ---------------- */
function writeSummary() {
const results = readdirSync(outDir).filter((d) => d.startsWith('case-') && existsSync(path.join(outDir, d, 'summary.json')))
  .sort().map((d) => JSON.parse(readFileSync(path.join(outDir, d, 'summary.json'), 'utf8')))
const lines = [
  `# TBO certification run — ${day(0)}`,
  '',
  'Bookings made on TBO **staging** through the website’s booking engine with test-mode payment.',
  'Each case folder holds every TBO request/response in order (`NN-Method-request.json` / `-response.json`) and a `summary.json`.',
  '',
  '| # | TBO case | Test case | Result | PNR(s) | TBO BookingId(s) | Booking ref | Notes |',
  '|---|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.case} | ${r.tboCase} | ${r.title} | ${r.status} | ${r.pnrs.join(', ')} | ${r.bookingIds.join(', ')} | ${r.refs.join(', ')} | ${r.notes.join('; ').replace(/\|/g, '/')} |`),
  '',
]
writeFileSync(path.join(outDir, 'SUMMARY.md'), lines.join('\n'))
console.log(`\nWrote ${path.join(outDir, 'SUMMARY.md')}`)
}
