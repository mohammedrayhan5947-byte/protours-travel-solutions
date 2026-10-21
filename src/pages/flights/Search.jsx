import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, Plus, Minus, Search as SearchIcon, X, MessageCircle, SlidersHorizontal } from 'lucide-react'
import { BIZ, waLink } from '../../data/site.js'
import { codeFromText, airportLabel, countryOf, cityOf } from '../../data/airports.js'
import { api, money, dayLabel, hhmm, CABINS, todayLocal, AirportInput, AirportList, Alert, Spinner, FlightCard } from './shared.jsx'

/* /flights — live fare search on TBO, then hand-off to /flights/book/:id.
   The form state lives in the URL, so a search can be shared or reloaded. */

const TRIPS = [['oneway', 'One-way'], ['return', 'Return'], ['multi', 'Multi-city']]
const TIMES = [['early', 'Before 6 am', 0, 6], ['morning', '6 am – noon', 6, 12], ['afternoon', 'Noon – 6 pm', 12, 18], ['night', 'After 6 pm', 18, 24]]
const RESULTS_TTL_MS = 12 * 60_000 // TBO's TraceId lives 15 min; we stop selling at 12.

const blankSeg = () => ({ from: '', to: '', date: '' })

function formFromParams(p) {
  const trip = TRIPS.some(([k]) => k === p.get('trip')) ? p.get('trip') : 'oneway'
  const segs = trip === 'multi'
    ? (p.get('seg') || '').split(',').filter(Boolean).map((s) => {
      const [from, to, ...d] = s.split('-')
      return { from: from ? airportLabel(from) : '', to: to ? airportLabel(to) : '', date: d.join('-') }
    })
    : [{ from: p.get('from') ? airportLabel(p.get('from')) : 'BLR · Bengaluru — Kempegowda International', to: p.get('to') ? airportLabel(p.get('to')) : '', date: p.get('date') || '' }]
  return {
    trip,
    segs: trip === 'multi' && segs.length < 2 ? [...segs, ...Array.from({ length: 2 - segs.length }, blankSeg)] : segs,
    ret: p.get('ret') || '',
    same: p.get('same') === '1',
    adults: Math.max(1, Number(p.get('ad')) || 1),
    children: Number(p.get('ch')) || 0,
    infants: Number(p.get('in')) || 0,
    cabin: Number(p.get('cabin')) || 2,
    direct: p.get('direct') === '1',
  }
}

/** Form → the API's search shape (or an error message). */
function toSearch(f) {
  const segs = f.segs.map((s) => ({ from: codeFromText(s.from), to: codeFromText(s.to), date: s.date }))
  if (segs.some((s) => !s.from || !s.to)) return { error: 'Choose airports from the list, or type a 3-letter airport code.' }
  if (segs.some((s) => !s.date)) return { error: 'Pick your travel date.' }
  let segments = segs
  let journeyType = f.trip === 'multi' ? 3 : 1
  if (f.trip === 'return') {
    if (!f.ret) return { error: 'Pick your return date.' }
    segments = [segs[0], { from: segs[0].to, to: segs[0].from, date: f.ret }]
    journeyType = f.same ? 5 : 2
  }
  return { search: { journeyType, adults: f.adults, children: f.children, infants: f.infants, cabin: f.cabin, directOnly: f.direct, segments } }
}

function paramsFrom(f, s) {
  const p = new URLSearchParams({ trip: f.trip, ad: f.adults, ch: f.children, in: f.infants, cabin: f.cabin })
  if (f.direct) p.set('direct', '1')
  if (f.trip === 'multi') p.set('seg', s.segments.map((g) => `${g.from}-${g.to}-${g.date}`).join(','))
  else {
    p.set('from', s.segments[0].from)
    p.set('to', s.segments[0].to)
    p.set('date', s.segments[0].date)
  }
  if (f.trip === 'return') {
    p.set('ret', f.ret)
    if (f.same) p.set('same', '1')
  }
  return p
}

function Counter({ label, hint, value, min, max, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="font-semibold text-ink">{label}</div>
        <div className="text-[0.85rem] text-slate-500">{hint}</div>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 disabled:opacity-40" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`}><Minus size={16} /></button>
        <span className="w-5 text-center font-display text-[1.1rem] font-bold tabular-nums" aria-live="polite">{value}</span>
        <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 disabled:opacity-40" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}><Plus size={16} /></button>
      </div>
    </div>
  )
}

function SearchForm({ initial, onSearch, busy }) {
  const [f, setF] = useState(initial)
  const [error, setError] = useState('')
  const [today, setToday] = useState('')
  const [paxOpen, setPaxOpen] = useState(false)
  useEffect(() => { setToday(todayLocal()) }, [])
  useEffect(() => { setF(initial) }, [initial])

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  const setSeg = (i, k, v) => setF((s) => ({ ...s, segs: s.segs.map((g, n) => (n === i ? { ...g, [k]: v } : g)) }))
  const total = f.adults + f.children + f.infants
  const label = 'mb-1.5 block font-display text-[0.8rem] font-bold tracking-[0.14em] text-slate-500 uppercase'

  const submit = (e) => {
    e.preventDefault()
    const r = toSearch(f)
    if (r.error) return setError(r.error)
    setError('')
    onSearch(f, r.search)
  }

  const setTrip = (trip) => setF((s) => ({
    ...s,
    trip,
    segs: trip === 'multi'
      ? [s.segs[0], s.segs[1] || { from: s.segs[0].to, to: '', date: '' }]
      : [s.segs[0]],
  }))

  return (
    <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[var(--shadow-lift)] sm:p-6" aria-label="Search flights">
      <AirportList />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Trip type" className="inline-flex rounded-xl bg-slate-50 p-1">
          {TRIPS.map(([k, t]) => (
            <button
              key={k} type="button" role="radio" aria-checked={f.trip === k} onClick={() => setTrip(k)}
              className={`rounded-lg px-4 py-2 font-display text-[0.95rem] font-bold transition-colors ${f.trip === k ? 'bg-navy-950 text-white' : 'text-slate-600 hover:text-ink'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[0.95rem] text-ink">
          <input type="checkbox" checked={f.direct} onChange={(e) => set('direct', e.target.checked)} className="h-4.5 w-4.5 accent-brand-500" />
          Non-stop flights only
        </label>
      </div>

      <div className="mt-5 grid gap-4">
        {f.segs.map((g, i) => (
          <div key={i} className="grid gap-3 md:grid-cols-[1fr_auto_1fr_11rem] md:items-end">
            <AirportInput id={`fs-from-${i}`} label={f.trip === 'multi' ? `Flight ${i + 1} · from` : 'From'} value={g.from} onChange={(v) => setSeg(i, 'from', v)} placeholder="City or airport" />
            <button
              type="button" aria-label="Swap airports"
              onClick={() => setF((s) => ({ ...s, segs: s.segs.map((x, n) => (n === i ? { ...x, from: x.to, to: x.from } : x)) }))}
              className="hidden h-[50px] w-11 place-items-center rounded-xl border border-slate-200 text-slate-600 hover:border-navy-950 hover:text-ink md:grid"
            >
              <ArrowLeftRight size={18} />
            </button>
            <AirportInput id={`fs-to-${i}`} label="To" value={g.to} onChange={(v) => setSeg(i, 'to', v)} placeholder="City or airport" />
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <label className={label} htmlFor={`fs-date-${i}`}>{f.trip === 'return' ? 'Depart' : 'Date'}</label>
                <input id={`fs-date-${i}`} type="date" className="field" min={(i > 0 && f.segs[i - 1].date) || today || undefined} value={g.date} onChange={(e) => setSeg(i, 'date', e.target.value)} />
              </div>
              {f.trip === 'multi' && f.segs.length > 2 && (
                <button type="button" aria-label={`Remove flight ${i + 1}`} onClick={() => setF((s) => ({ ...s, segs: s.segs.filter((_, n) => n !== i) }))} className="grid h-[50px] w-10 place-items-center rounded-xl text-slate-500 hover:text-clay"><X size={18} /></button>
              )}
            </div>
          </div>
        ))}
        {f.trip === 'multi' && f.segs.length < 5 && (
          <button type="button" onClick={() => setF((s) => ({ ...s, segs: [...s.segs, { from: s.segs[s.segs.length - 1].to, to: '', date: '' }] }))} className="inline-flex w-fit items-center gap-2 font-semibold text-brand-500 hover:underline">
            <Plus size={16} /> Add another flight
          </button>
        )}
      </div>

      <div className={`mt-4 grid gap-3 sm:grid-cols-2 md:items-end ${f.trip === 'return' ? 'md:grid-cols-[11rem_1fr_11rem_auto]' : 'md:grid-cols-[1fr_11rem_auto]'}`}>
        {f.trip === 'return' && (
          <div>
            <label className={label} htmlFor="fs-ret">Return</label>
            <input id="fs-ret" type="date" className="field" min={f.segs[0].date || today || undefined} value={f.ret} onChange={(e) => set('ret', e.target.value)} />
          </div>
        )}

        <div className="relative">
          <span className={label} id="fs-pax-label">Travellers</span>
          <button type="button" aria-expanded={paxOpen} aria-labelledby="fs-pax-label" onClick={() => setPaxOpen((o) => !o)} className="field text-left">
            {f.adults} adult{f.adults > 1 ? 's' : ''}{f.children ? `, ${f.children} child${f.children > 1 ? 'ren' : ''}` : ''}{f.infants ? `, ${f.infants} infant${f.infants > 1 ? 's' : ''}` : ''}
          </button>
          {paxOpen && (
            <div className="absolute z-20 mt-2 w-full min-w-[18rem] rounded-xl border border-slate-200 bg-white p-4 shadow-[var(--shadow-lift)]">
              <Counter label="Adults" hint="12 years and over" value={f.adults} min={1} max={9 - f.children - f.infants} onChange={(v) => set('adults', v)} />
              <Counter label="Children" hint="2–11 years" value={f.children} min={0} max={9 - f.adults - f.infants} onChange={(v) => set('children', v)} />
              <Counter label="Infants" hint="Under 2, on a lap" value={f.infants} min={0} max={Math.min(f.adults, 9 - f.adults - f.children)} onChange={(v) => set('infants', v)} />
              <p className="mt-2 text-[0.82rem] text-slate-500">Up to 9 travellers per booking. {total}/9</p>
              <button type="button" className="btn btn-ghost mt-3 w-full !py-2" onClick={() => setPaxOpen(false)}>Done</button>
            </div>
          )}
        </div>

        <div>
          <label className={label} htmlFor="fs-cabin">Cabin</label>
          <select id="fs-cabin" className="field" value={f.cabin} onChange={(e) => set('cabin', Number(e.target.value))}>
            {CABINS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>

        <button type="submit" className="btn btn-gold h-[52px] w-full sm:col-span-2 md:col-span-1 md:w-auto" disabled={busy}>
          <SearchIcon size={18} aria-hidden="true" /> {busy ? 'Searching…' : 'Search flights'}
        </button>
      </div>

      {f.trip === 'return' && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-[0.92rem] text-slate-600">
          <input type="checkbox" checked={f.same} onChange={(e) => set('same', e.target.checked)} className="mt-1 h-4 w-4 accent-brand-500" />
          <span>Same airline both ways (special return fares — sometimes cheaper, one booking for both flights)</span>
        </label>
      )}
      {error && <Alert tone="error" className="mt-4">{error}</Alert>}
    </form>
  )
}

/* ---------------- results ---------------- */

const stopsOf = (c) => Math.max(...c.trips.map((t) => t.stops))
const depHour = (c) => Number(hhmm(c.trips[0].dep).slice(0, 2))

function useFilters(list) {
  const [f, setF] = useState({ stops: new Set(), airlines: new Set(), times: new Set(), refundable: false, sort: 'price' })
  const airlines = useMemo(() => {
    const m = new Map()
    for (const c of list) {
      const k = c.airlineName || c.airline
      m.set(k, Math.min(m.get(k) ?? Infinity, c.price))
    }
    return [...m.entries()].sort((a, b) => a[1] - b[1])
  }, [list])
  const shown = useMemo(() => {
    let r = list.filter((c) =>
      (!f.stops.size || f.stops.has(Math.min(2, stopsOf(c)))) &&
      (!f.airlines.size || f.airlines.has(c.airlineName || c.airline)) &&
      (!f.times.size || TIMES.some(([k, , a, b]) => f.times.has(k) && depHour(c) >= a && depHour(c) < b)) &&
      (!f.refundable || c.refundable))
    const mins = (c) => c.trips.reduce((t, x) => t + x.minutes, 0)
    const by = { price: (a, b) => a.price - b.price, fastest: (a, b) => mins(a) - mins(b), early: (a, b) => a.trips[0].dep.localeCompare(b.trips[0].dep) }
    return [...r].sort(by[f.sort])
  }, [list, f])
  const toggle = (k, v) => setF((s) => {
    const n = new Set(s[k])
    n.has(v) ? n.delete(v) : n.add(v)
    return { ...s, [k]: n }
  })
  return { f, setF, toggle, airlines, shown }
}

function Filters({ ctl, count }) {
  const { f, setF, toggle, airlines } = ctl
  const box = 'flex cursor-pointer items-center gap-2.5 py-1 text-[0.95rem]'
  const head = 'mb-2 font-display text-[0.8rem] font-bold tracking-[0.14em] text-slate-500 uppercase'
  return (
    <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-5">
      <div>
        <label htmlFor="fs-sort" className={head}>Sort by</label>
        <select id="fs-sort" className="field !py-2.5" value={f.sort} onChange={(e) => setF((s) => ({ ...s, sort: e.target.value }))}>
          <option value="price">Cheapest first</option>
          <option value="fastest">Fastest first</option>
          <option value="early">Earliest departure</option>
        </select>
      </div>
      <fieldset>
        <legend className={head}>Stops</legend>
        {[[0, 'Non-stop'], [1, '1 stop'], [2, '2+ stops']].map(([v, t]) => (
          <label key={v} className={box}><input type="checkbox" className="h-4 w-4 accent-brand-500" checked={f.stops.has(v)} onChange={() => toggle('stops', v)} />{t}</label>
        ))}
      </fieldset>
      <fieldset>
        <legend className={head}>Departure time</legend>
        {TIMES.map(([k, t]) => (
          <label key={k} className={box}><input type="checkbox" className="h-4 w-4 accent-brand-500" checked={f.times.has(k)} onChange={() => toggle('times', k)} />{t}</label>
        ))}
      </fieldset>
      <fieldset>
        <legend className={head}>Airlines</legend>
        {airlines.map(([a, p]) => (
          <label key={a} className={`${box} justify-between`}>
            <span className="flex items-center gap-2.5"><input type="checkbox" className="h-4 w-4 accent-brand-500" checked={f.airlines.has(a)} onChange={() => toggle('airlines', a)} />{a}</span>
            <span className="text-[0.85rem] text-slate-500">{money(p)}</span>
          </label>
        ))}
      </fieldset>
      <label className={box}><input type="checkbox" className="h-4 w-4 accent-brand-500" checked={f.refundable} onChange={(e) => setF((s) => ({ ...s, refundable: e.target.checked }))} />Refundable fares only</label>
      <p className="text-[0.85rem] text-slate-500" aria-live="polite">{count} flight{count === 1 ? '' : 's'} shown</p>
    </div>
  )
}

/** "More fares" — fare families from TBO FareUpsell (e.g. Saver / Flexi / Super 6E). */
function FareOptions({ traceId, card, onPick, busy }) {
  const [state, setState] = useState(null)
  const load = async () => {
    setState({ loading: true })
    try { setState({ options: (await api('fare-options', { method: 'POST', body: { traceId, resultIndex: card.id } })).options }) } catch { setState({ options: [] }) }
  }
  if (!state) return <button type="button" onClick={load} className="mt-3 text-[0.9rem] font-semibold text-brand-500 hover:underline">More fare options</button>
  if (state.loading) return <div className="mt-3"><Spinner label="Checking fare options" /></div>
  if (!state.options.length) return <p className="mt-3 text-[0.88rem] text-slate-500">No other fares for this flight.</p>
  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {state.options.map((o) => (
        <li key={o.id} className="flex flex-col rounded-xl border border-slate-200 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-display font-bold text-ink">{o.name}</span>
            <span className="font-display font-extrabold text-ink">{money(o.price)}</span>
          </div>
          <ul className="mt-2 flex-1 space-y-1 text-[0.85rem] text-slate-600">
            {o.services.slice(0, 6).map((s) => <li key={s}>· {s}</li>)}
            {!o.services.length && <li>{o.refundable ? 'Refundable' : 'Non-refundable'}</li>}
          </ul>
          <button type="button" className="btn btn-ghost mt-3 !py-2 !text-[0.95rem]" disabled={busy} onClick={() => onPick(o.id)}>Choose this fare</button>
        </li>
      ))}
    </ul>
  )
}

/** Cheapest fare per day for the month (domestic one-way), from TBO's fare calendar. */
function FareCalendar({ search, onPickDate }) {
  const [days, setDays] = useState(null)
  const seg = search.segments[0]
  useEffect(() => {
    let live = true
    setDays(null)
    api('calendar', { method: 'POST', body: { from: seg.from, to: seg.to, month: seg.date.slice(0, 7), cabin: search.cabin } })
      .then((r) => live && setDays(r.days.filter((d) => d.date >= todayLocal()).sort((a, b) => a.date.localeCompare(b.date))))
      .catch(() => live && setDays([]))
    return () => { live = false }
  }, [seg.from, seg.to, seg.date.slice(0, 7)]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!days?.length) return null
  return (
    <div className="mb-5">
      <h2 className="mb-2 font-display text-[0.8rem] font-bold tracking-[0.14em] text-slate-500 uppercase">Lowest fares this month (per adult, indicative)</h2>
      <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
        {days.map((d) => (
          <button
            key={d.date} type="button" onClick={() => onPickDate(d.date)}
            className={`shrink-0 rounded-xl border px-3 py-2 text-left transition-colors ${d.date === seg.date ? 'border-navy-950 bg-navy-950 text-white' : 'border-slate-200 bg-white hover:border-navy-950'}`}
          >
            <span className="block text-[0.8rem]">{dayLabel(d.date)}</span>
            <span className={`block font-display font-bold ${d.lowest && d.date !== seg.date ? 'text-palm' : ''}`}>{money(d.price)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ResultList({ list, traceId, onPick, busy, pickLabel = 'Select', selectedId, filtersFor }) {
  const ctl = useFilters(list)
  const [showFilters, setShowFilters] = useState(false)
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <div>
        <button type="button" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} className="btn btn-ghost w-full !py-2.5 lg:hidden">
          <SlidersHorizontal size={16} aria-hidden="true" /> Filter &amp; sort{filtersFor ? ` · ${filtersFor}` : ''}
        </button>
        <div className={`${showFilters ? 'mt-3 block' : 'hidden'} lg:block`}><Filters ctl={ctl} count={ctl.shown.length} /></div>
      </div>
      <div className="grid content-start gap-4">
        {!ctl.shown.length && <p className="rounded-xl bg-white p-6 text-center text-slate-600">No flights match these filters.</p>}
        {ctl.shown.map((c) => (
          <FlightCard
            key={c.id}
            card={c}
            selected={selectedId === c.id}
            action={<button type="button" className="btn btn-brand !px-6 !py-2.5" disabled={busy} onClick={() => onPick(c.id)} aria-label={`${pickLabel} ${c.airlineName} ${hhmm(c.trips[0].dep)} for ${money(c.price)}`}>{selectedId === c.id ? 'Selected' : pickLabel}</button>}
            footer={!c.lcc && onPick && pickLabel === 'Select' ? <FareOptions traceId={traceId} card={c} onPick={onPick} busy={busy} /> : null}
          />
        ))}
      </div>
    </div>
  )
}

/** Domestic return (and special return): pick outbound and return separately. */
function SplitResults({ results, special, busy, onBook }) {
  const [ob, setOb] = useState(null)
  const [ib, setIb] = useState(null)
  const [tab, setTab] = useState(0)
  const [obList, ibAll] = results.groups
  const obCard = obList.find((c) => c.id === ob)
  // Special return fares must be the same airline both ways.
  const ibList = special && obCard ? ibAll.filter((c) => c.airline === obCard.airline) : ibAll
  const ibCard = ibList.find((c) => c.id === ib)
  const [a, b] = results.search.segments

  return (
    <div className="pb-28">
      <div role="tablist" className="mb-5 inline-flex rounded-xl bg-white p-1">
        {[`Departure · ${a.from} → ${a.to}`, `Return · ${b.from} → ${b.to}`].map((t, i) => (
          <button key={t} role="tab" type="button" aria-selected={tab === i} onClick={() => setTab(i)} className={`rounded-lg px-4 py-2 font-display text-[0.95rem] font-bold ${tab === i ? 'bg-navy-950 text-white' : 'text-slate-600'}`}>
            {t} {i === 0 && obCard ? '✓' : i === 1 && ibCard ? '✓' : ''}
          </button>
        ))}
      </div>
      {tab === 0
        ? <ResultList list={obList} onPick={(id) => { setOb(id); setIb(null); setTab(1) }} pickLabel="Choose" selectedId={ob} busy={busy} filtersFor="departure" />
        : <ResultList list={ibList} onPick={setIb} pickLabel="Choose" selectedId={ib} busy={busy} filtersFor="return" />}
      {special && obCard && <p className="mt-3 text-[0.9rem] text-slate-600">Showing {obCard.airlineName} return flights only — special return fares are booked with one airline.</p>}

      {/* Sits above the phone contact bar (72px) and clear of the desktop WhatsApp button. */}
      <div className="fixed inset-x-0 bottom-[72px] z-40 border-t border-slate-200 bg-paper/95 py-3 shadow-[0_-12px_30px_-20px_rgb(60_40_20/0.5)] backdrop-blur lg:bottom-0">
        <div className="wrap flex flex-wrap items-center justify-between gap-3 lg:!pr-72">
          <div className="text-[0.95rem]">
            <span className="text-slate-600">Departure:</span> <b>{obCard ? `${obCard.airlineName} ${hhmm(obCard.trips[0].dep)}` : '—'}</b>
            <span className="mx-2 text-slate-300">|</span>
            <span className="text-slate-600">Return:</span> <b>{ibCard ? `${ibCard.airlineName} ${hhmm(ibCard.trips[0].dep)}` : '—'}</b>
          </div>
          <div className="flex items-center gap-4">
            {obCard && ibCard && <span className="font-display text-[1.3rem] font-extrabold">{money(obCard.price + ibCard.price)}</span>}
            <button type="button" className="btn btn-gold !py-2.5" disabled={!obCard || !ibCard || busy} onClick={() => onBook([ob, ib])}>
              {busy ? 'Checking fare…' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function FlightSearch() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const initial = useMemo(() => formFromParams(params), [params])
  const [results, setResults] = useState(null)
  const [state, setState] = useState({ busy: false, error: '' })
  const [booking, setBooking] = useState(false)
  const [stale, setStale] = useState(false)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => { api('config').then((c) => setEnabled(c.enabled)).catch(() => {}) }, [])

  // Run the search whenever the URL holds a complete query (and booking is switched on).
  useEffect(() => {
    const r = toSearch(formFromParams(params))
    if (r.error || !params.get('trip') || !enabled) return
    let live = true
    setState({ busy: true, error: '' })
    setResults(null)
    setStale(false)
    api('search', { method: 'POST', body: r.search })
      .then((res) => live && (setResults(res), setState({ busy: false, error: '' })))
      .catch((e) => live && setState({ busy: false, error: e.message }))
    return () => { live = false }
  }, [params, enabled])

  useEffect(() => {
    if (!results?.traceId) return
    const t = setTimeout(() => setStale(true), RESULTS_TTL_MS)
    return () => clearTimeout(t)
  }, [results])

  const onSearch = (f, s) => setParams(paramsFrom(f, s))
  const rerun = () => setParams(new URLSearchParams(params))

  const book = async (resultIndexes) => {
    setBooking(true)
    setState((s) => ({ ...s, error: '' }))
    try {
      const d = await api('drafts', { method: 'POST', body: { traceId: results.traceId, resultIndexes, search: results.search } })
      navigate(`/flights/book/${d.id}`)
    } catch (e) {
      setBooking(false)
      setState((s) => ({ ...s, error: e.message }))
      if (e.status === 410) setStale(true)
    }
  }

  const s = results?.search
  const split = results && results.groups.length === 2
  const domesticOneWay = s && s.journeyType === 1 && countryOf(s.segments[0].from) === 'IN' && countryOf(s.segments[0].to) === 'IN'

  return (
    <>
      <section className="relative isolate overflow-hidden bg-navy-950 pt-12 pb-24 md:pt-16 md:pb-28">
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_80%_-10%,rgb(15_94_158/0.45),transparent),radial-gradient(40rem_24rem_at_0%_120%,rgb(232_163_23/0.18),transparent)]" />
        <div className="wrap">
          <span className="eyebrow eyebrow-light">Book flights online</span>
          <h1 className="mt-3 max-w-3xl font-display text-[clamp(2rem,4.6vw,3.4rem)] leading-[1.05] font-extrabold text-white text-balance">
            Live fares on every airline, booked by a Bengaluru desk you can call
          </h1>
          <p className="mt-4 max-w-2xl text-[1.1rem] text-white/75 text-pretty">
            Search domestic and international flights, choose your seats, meals and extra baggage, and pay securely.
            Your e-ticket is issued straight away — and the same team on Hospital Road answers if your plans change.
          </p>
        </div>
      </section>

      <section className="paper bg-sand pb-20">
        <div className="wrap -mt-16">
          <SearchForm initial={initial} onSearch={onSearch} busy={state.busy} />
          {!enabled && (
            <Alert tone="info" className="mt-5">
              Online booking is being switched on. Until then,{' '}
              <a className="font-semibold text-brand-500 underline" href={waLink('Hello, I would like to book a flight.')} target="_blank" rel="noopener noreferrer">send us your route on WhatsApp</a>{' '}
              and we will reply with fares.
            </Alert>
          )}

          <div className="mt-8" aria-live="polite">
            {state.busy && <div className="rounded-2xl bg-white p-8 text-center"><Spinner label="Checking every airline for live fares…" /></div>}
            {state.error && <Alert tone="error">{state.error}</Alert>}
            {stale && results && (
              <Alert className="mb-5">
                These fares are over 12 minutes old and may have changed.{' '}
                <button type="button" className="font-semibold text-brand-500 underline" onClick={rerun}>Refresh prices</button>
              </Alert>
            )}

            {results && !state.busy && (
              <>
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-[1.35rem] font-extrabold text-ink">
                    {s.segments.map((g) => `${cityOf(g.from)} → ${cityOf(g.to)}`).join(' · ')}
                  </h2>
                  <p className="text-[0.92rem] text-slate-600">
                    {s.segments.map((g) => dayLabel(g.date)).join(' – ')} · {s.adults + s.children + s.infants} traveller{s.adults + s.children + s.infants > 1 ? 's' : ''} · prices include taxes and fees
                  </p>
                </div>
                {domesticOneWay && (
                  <FareCalendar search={s} onPickDate={(d) => { const p = new URLSearchParams(params); p.set('date', d); setParams(p) }} />
                )}
                {!results.groups[0].length && (
                  <div className="rounded-2xl bg-white p-8 text-center">
                    <p className="text-ink">No flights found for these dates.</p>
                    <p className="mt-2 text-slate-600">Try nearby dates, or <a className="font-semibold text-brand-500 underline" href={waLink(`Hello, I could not find flights online for ${s.segments.map((g) => `${g.from}-${g.to} on ${g.date}`).join(', ')}.`)} target="_blank" rel="noopener noreferrer">ask our desk</a> — we can often find options.</p>
                  </div>
                )}
                {results.groups[0].length > 0 && (split
                  ? <SplitResults results={results} special={s.journeyType === 5} busy={booking || stale} onBook={book} />
                  : <ResultList list={results.groups[0]} traceId={results.traceId} onPick={(id) => book([id])} busy={booking || stale} />)}
              </>
            )}

            {!results && !state.busy && !state.error && (
              <div className="grid gap-6 md:grid-cols-3">
                {[
                  ['Every airline, live', 'IndiGo, Air India, Akasa, SpiceJet, Air India Express, Emirates, Qatar and more — fares and seats straight from the airlines.'],
                  ['Seats, meals, baggage', 'Pick your seat on the seat map, pre-book meals and extra baggage before you pay.'],
                  ['People, not a call centre', `Change or cancel online, or call ${BIZ.phoneDisplay} — the same desk in Shivaji Nagar since ${BIZ.since}.`],
                ].map(([t, d]) => (
                  <div key={t} className="rounded-2xl border border-slate-200 bg-white p-6">
                    <h2 className="font-display text-[1.1rem] font-bold text-ink">{t}</h2>
                    <p className="mt-2 text-[0.98rem] text-pretty">{d}</p>
                  </div>
                ))}
                <p className="text-[0.95rem] text-slate-600 md:col-span-3">
                  Already booked? <Link to="/flights/booking" className="font-semibold text-brand-500 underline">Find your booking</Link>.
                  Prefer to talk it through? <a className="inline-flex items-center gap-1 font-semibold text-brand-500 underline" href={waLink('Hello, I would like help booking a flight.')} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} aria-hidden="true" /> WhatsApp the desk</a>.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  )
}
