import { useEffect, useState } from 'react'
import { ChevronDown, Plane, AlertTriangle, Clock, Luggage } from 'lucide-react'
import { AIRPORTS } from '../../data/airports.js'

/* Small pieces shared by the flight search, booking, manage and staff pages. */

/** Calls the flight API. Throws an Error with .status and .errors on failure. */
export async function api(path, { method = 'GET', body, staff } = {}) {
  const res = await fetch(`/api/flights/${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(staff ? { Authorization: `Bearer ${staff}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = {}
  try { data = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`)
    e.status = res.status
    e.errors = data.errors
    throw e
  }
  return data
}

export const money = (paise) =>
  paise == null ? '—' : `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

// TBO times are the airport's local time ("2026-11-02T06:15:00"): show them as written.
export const hhmm = (iso) => String(iso || '').slice(11, 16)
export const dayLabel = (iso) => {
  const d = String(iso || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}
export const duration = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '')
export const plusDays = (dep, arr) => {
  const a = Date.parse(String(dep).slice(0, 10))
  const b = Date.parse(String(arr).slice(0, 10))
  const n = Math.round((b - a) / 86400_000)
  return n > 0 ? `+${n}` : ''
}

export const CABINS = [[2, 'Economy'], [3, 'Premium economy'], [4, 'Business'], [6, 'First']]
export const PAX_LABEL = { 1: 'Adult', 2: 'Child', 3: 'Infant' }

/** Local YYYY-MM-DD — read in effects only (pre-rendered pages must not bake in a date). */
export const todayLocal = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Airport box: a native datalist, so it works with every keyboard and screen reader. */
export function AirportInput({ id, label, value, onChange, placeholder }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block font-display text-[0.8rem] font-bold tracking-[0.14em] text-slate-500 uppercase">{label}</label>
      <input
        id={id}
        list="pt-airports"
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  )
}

export function AirportList() {
  return (
    <datalist id="pt-airports">
      {AIRPORTS.map(([code, city, name]) => (
        <option key={code} value={`${code} · ${city} — ${name}`} />
      ))}
    </datalist>
  )
}

export function Alert({ tone = 'warn', children, className = '' }) {
  const tones = {
    warn: 'border-gold-500/40 bg-gold-500/10 text-ink',
    error: 'border-clay/40 bg-clay/10 text-ink',
    ok: 'border-palm/40 bg-palm/10 text-ink',
    info: 'border-brand-500/30 bg-brand-500/8 text-ink',
  }
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-3 rounded-xl border px-4 py-3 text-[0.98rem] ${tones[tone]} ${className}`}>
      <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function Spinner({ label = 'Loading' }) {
  return (
    <span className="inline-flex items-center gap-3 text-slate-600" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" aria-hidden="true" />
      {label}
    </span>
  )
}

/** Minutes:seconds left until `iso`; calls onExpire once. */
export function Countdown({ until, onExpire }) {
  const [left, setLeft] = useState(null)
  useEffect(() => {
    const tick = () => {
      const ms = new Date(until).getTime() - Date.now()
      setLeft(ms)
      if (ms <= 0) onExpire?.()
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [until]) // eslint-disable-line react-hooks/exhaustive-deps
  if (left == null) return null
  const s = Math.max(0, Math.floor(left / 1000))
  const urgent = s < 180
  return (
    <span className={`inline-flex items-center gap-1.5 font-display text-[0.95rem] font-bold tabular-nums ${urgent ? 'text-clay' : 'text-slate-600'}`}>
      <Clock size={15} aria-hidden="true" />
      {s > 0 ? `Fare held for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Fare expired'}
    </span>
  )
}

/** One trip of a flight card: times, airports, duration and stops. */
export function TripLine({ trip }) {
  const stops = trip.stops === 0 ? 'Non-stop' : `${trip.stops} stop${trip.stops > 1 ? 's' : ''}`
  const via = trip.segments.slice(0, -1).map((s) => s.to).join(', ')
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-5">
      <div>
        <div className="font-display text-[1.45rem] leading-none font-extrabold text-ink tabular-nums">{hhmm(trip.dep)}</div>
        <div className="mt-1 text-[0.9rem] text-slate-600">{trip.from}</div>
      </div>
      <div className="min-w-0 text-center">
        <div className="text-[0.85rem] text-slate-600">{duration(trip.minutes)}</div>
        <div className="relative my-1 h-px bg-slate-300">
          <Plane size={14} aria-hidden="true" className="absolute top-1/2 right-0 -translate-y-1/2 rotate-45 text-brand-500" />
        </div>
        <div className={`text-[0.82rem] ${trip.stops ? 'text-gold-600' : 'text-palm'}`}>{stops}{via ? ` · ${via}` : ''}</div>
      </div>
      <div className="text-right">
        <div className="font-display text-[1.45rem] leading-none font-extrabold text-ink tabular-nums">
          {hhmm(trip.arr)}<sup className="ml-0.5 text-[0.7rem] text-clay">{plusDays(trip.dep, trip.arr)}</sup>
        </div>
        <div className="mt-1 text-[0.9rem] text-slate-600">{trip.to}</div>
      </div>
    </div>
  )
}

/** Segment-by-segment details (flight numbers, terminals, layovers, baggage). */
export function TripDetails({ trip }) {
  return (
    <ol className="space-y-3">
      {trip.segments.map((s, i) => (
        <li key={i}>
          {i > 0 && (
            <p className="mb-3 rounded-lg bg-sand px-3 py-2 text-[0.88rem] text-slate-600">
              Change planes in {s.fromCity || s.from}{trip.segments[i - 1].layover ? ` · ${duration(trip.segments[i - 1].layover)} layover` : ''}
            </p>
          )}
          <div className="grid gap-1 text-[0.95rem] sm:grid-cols-[9rem_1fr]">
            <div className="font-display font-bold text-ink">
              {s.airlineName || s.airline} {s.flight}
              {s.operatedBy && <span className="block text-[0.8rem] font-normal text-slate-500">Operated by {s.operatedBy}</span>}
            </div>
            <div className="text-slate-600">
              {dayLabel(s.dep)} · {hhmm(s.dep)} {s.fromCity} ({s.from}{s.fromTerminal ? ` T${s.fromTerminal}` : ''}) → {hhmm(s.arr)} {s.toCity} ({s.to}{s.toTerminal ? ` T${s.toTerminal}` : ''})
              {s.minutes ? ` · ${duration(s.minutes)}` : ''}
              {(s.baggage || s.cabinBaggage) && (
                <span className="mt-1 flex items-center gap-1.5 text-[0.88rem]">
                  <Luggage size={14} aria-hidden="true" />
                  {s.baggage ? `Check-in ${s.baggage}` : ''}{s.baggage && s.cabinBaggage ? ' · ' : ''}{s.cabinBaggage ? `Cabin ${s.cabinBaggage}` : ''}
                </span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** A flight option (search result or chosen flight). */
export function FlightCard({ card, action, footer, selected, compact }) {
  const [open, setOpen] = useState(false)
  if (!card) return null
  return (
    <article className={`rounded-2xl border bg-white p-4 transition-colors sm:p-5 ${selected ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-slate-200'}`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="md:w-40 md:shrink-0">
          <div className="font-display text-[1.05rem] font-bold text-ink">{card.airlineName || card.airline}</div>
          <div className="text-[0.85rem] text-slate-500">{[...new Set(card.trips.flatMap((t) => t.segments.map((s) => s.flight)))].join(', ')}</div>
        </div>
        <div className="grid flex-1 gap-3">
          {card.trips.map((t, i) => <TripLine key={i} trip={t} />)}
        </div>
        {!compact && (
          <div className="flex items-center justify-between gap-4 border-t border-dashed border-slate-200 pt-3 md:w-48 md:shrink-0 md:flex-col md:items-end md:border-t-0 md:border-l md:pt-0 md:pl-5">
            <div className="md:text-right">
              <div className="font-display text-[1.5rem] font-extrabold text-ink">{money(card.price)}</div>
              <div className="text-[0.8rem] text-slate-500">all travellers, incl. taxes</div>
            </div>
            {action}
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.82rem]">
        <span className={`rounded-md px-2 py-0.5 font-semibold ${card.refundable ? 'bg-palm/10 text-palm' : 'bg-slate-100 text-slate-600'}`}>
          {card.refundable ? 'Refundable' : 'Non-refundable'}
        </span>
        {card.fareType && card.fareType !== 'RegularFare' && <span className="rounded-md bg-gold-500/15 px-2 py-0.5 font-semibold text-gold-600">{card.fareType}</span>}
        {card.transitVisa && <span className="rounded-md bg-clay/10 px-2 py-0.5 font-semibold text-clay">Transit visa may be needed</span>}
        {card.seatsLeft != null && card.seatsLeft <= 5 && <span className="rounded-md bg-clay/10 px-2 py-0.5 font-semibold text-clay">{card.seatsLeft} seat{card.seatsLeft > 1 ? 's' : ''} left</span>}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ml-auto inline-flex items-center gap-1 font-semibold text-brand-500 hover:underline">
          Flight details <ChevronDown size={15} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <div className="mt-4 space-y-5 border-t border-slate-200 pt-4">
          {card.trips.map((t, i) => (
            <div key={i}>
              {card.trips.length > 1 && <h4 className="mb-2 font-display text-[0.95rem] font-bold text-ink">{t.fromCity} → {t.toCity} · {dayLabel(t.dep)}</h4>}
              <TripDetails trip={t} />
            </div>
          ))}
          {card.remark && <p className="text-[0.85rem] text-slate-500">Airline note: {card.remark}</p>}
        </div>
      )}
      {footer}
    </article>
  )
}

export function Steps({ steps, current }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.9rem]" aria-label="Booking steps">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            aria-current={i === current ? 'step' : undefined}
            className={`grid h-7 w-7 place-items-center rounded-full font-display text-[0.85rem] font-bold ${
              i < current ? 'bg-palm text-white' : i === current ? 'bg-navy-950 text-white' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {i + 1}
          </span>
          <span className={i === current ? 'font-semibold text-ink' : 'text-slate-500'}>{s}</span>
          {i < steps.length - 1 && <span aria-hidden="true" className="mx-1 h-px w-6 bg-slate-300" />}
        </li>
      ))}
    </ol>
  )
}

/** Page shell for the booking pages (no photo hero: these are working pages). */
export function FlightPage({ eyebrow, title, children, aside }) {
  return (
    <section className="paper min-h-[70vh] bg-sand pt-10 pb-20 md:pt-14">
      <div className="wrap">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        {title && <h1 className="mt-3 font-display text-[clamp(1.8rem,3.6vw,2.6rem)] leading-tight font-extrabold text-ink text-balance">{title}</h1>}
        {aside ? (
          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
            <div className="min-w-0">{children}</div>
            <aside className="lg:sticky lg:top-24">{aside}</aside>
          </div>
        ) : (
          <div className="mt-8">{children}</div>
        )}
      </div>
    </section>
  )
}
