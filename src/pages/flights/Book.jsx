import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ShieldCheck, ChevronDown, ArrowLeft } from 'lucide-react'
import { BIZ, waLink } from '../../data/site.js'
import { loadRazorpayCheckout } from '../../lib/razorpay.js'
import { checkTravellers, TITLES } from '../../../server/validate.js'
import { api, money, dayLabel, PAX_LABEL, Alert, Spinner, Countdown, Steps, FlightCard, FlightPage } from './shared.jsx'

/* /flights/book/:id — review → travellers → seats/meals/baggage → pay.
   The server holds the fare (DRAFT booking) and re-prices everything; this
   page only collects choices. Passport numbers are never stored in the browser. */

const STEPS = ['Your flight', 'Travellers', 'Seats & extras', 'Pay']
const NATIONALITIES = [['IN', 'Indian'], ['US', 'American'], ['GB', 'British'], ['AE', 'Emirati'], ['SA', 'Saudi'], ['CA', 'Canadian'], ['AU', 'Australian'], ['NP', 'Nepali'], ['LK', 'Sri Lankan'], ['BD', 'Bangladeshi']]

const blankPax = (type) => ({
  type, title: '', gender: '', firstName: '', lastName: '', dob: '', nationality: 'IN',
  passportNo: '', passportExpiry: '', passportIssueDate: '', passportIssueCountry: 'IN', pan: '',
  guardian: { title: 'Mr', firstName: '', lastName: '', pan: '' }, ff: { airline: '', number: '' },
})

function initialPax(d) {
  if (d.pax?.length) return d.pax.map((p) => ({ ...blankPax(p.type), ...p, guardian: p.guardian || blankPax(1).guardian, ff: p.ff || { airline: '', number: '' } }))
  const s = d.search
  return [
    ...Array.from({ length: s.adults }, () => blankPax(1)),
    ...Array.from({ length: s.children }, () => blankPax(2)),
    ...Array.from({ length: s.infants }, () => blankPax(3)),
  ]
}

function searchUrl(s) {
  const p = new URLSearchParams({ ad: s.adults, ch: s.children, in: s.infants, cabin: s.cabin })
  if (s.journeyType === 3) {
    p.set('trip', 'multi')
    p.set('seg', s.segments.map((g) => `${g.from}-${g.to}-${g.date}`).join(','))
  } else {
    p.set('trip', s.journeyType === 1 ? 'oneway' : 'return')
    p.set('from', s.segments[0].from); p.set('to', s.segments[0].to); p.set('date', s.segments[0].date)
    if (s.segments[1]) p.set('ret', s.segments[1].date)
    if (s.journeyType === 5) p.set('same', '1')
  }
  return `/flights?${p}`
}

/* ---------------- small form helpers ---------------- */
const lab = 'mb-1.5 block font-display text-[0.92rem] font-bold text-navy-900'
function Field({ id, label, error, hint, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={lab}>{label}{hint && <span className="ml-1 font-sans text-[0.82rem] font-medium text-slate-500">{hint}</span>}</label>
      {children}
      {error && <p id={`${id}-err`} className="mt-1 text-[0.85rem] text-clay">{error}</p>}
    </div>
  )
}
const inputProps = (id, error) => ({ id, className: `field ${error ? '!border-clay' : ''}`, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-err` : undefined })

/* ---------------- step 1: review ---------------- */
function Review({ d, onNext }) {
  const [rulesOpen, setRulesOpen] = useState(null)
  return (
    <div className="space-y-5">
      {d.legs.some((l) => l.priceChanged) && <Alert>The airline changed this fare since you searched. The price below is the new, confirmed price.</Alert>}
      {d.legs.some((l) => l.changeInfo) && <Alert>The airline updated: {d.legs.map((l) => l.changeInfo).filter(Boolean).join(', ')}. Please check the details below.</Alert>}
      {d.legs.map((l, i) => (
        <div key={i}>
          {d.legs.length > 1 && <h2 className="mb-2 font-display text-[1.05rem] font-bold text-ink">{i === 0 ? 'Departure' : 'Return'}</h2>}
          <FlightCard card={l.card} compact />
          {l.rules.length > 0 && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-white">
              <button type="button" onClick={() => setRulesOpen(rulesOpen === i ? null : i)} aria-expanded={rulesOpen === i} className="flex w-full items-center justify-between px-4 py-3 text-left font-semibold text-ink">
                Fare rules, baggage and cancellation charges <ChevronDown size={16} className={rulesOpen === i ? 'rotate-180' : ''} aria-hidden="true" />
              </button>
              {rulesOpen === i && (
                <div className="max-h-96 space-y-4 overflow-y-auto border-t border-slate-200 px-4 py-3 text-[0.88rem] whitespace-pre-line text-slate-600">
                  {l.rules.map((r, k) => (
                    <div key={k}>
                      <p className="font-semibold text-ink">{r.from} → {r.to} · {r.airline} · fare basis {r.basis}</p>
                      <p className="mt-1">{r.text.replace(/<[^>]+>/g, ' ').replace(/\\r\\n|\r\n/g, '\n').trim() || 'The airline has not published detailed rules for this fare.'}</p>
                    </div>
                  ))}
                  <p className="text-[0.82rem]">Charges shown by airlines are per passenger, per sector. GST and our service fee are extra. Cancel at least 2 hours (domestic) or 4 hours (international) before the airline’s own deadline.</p>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-brand" onClick={onNext}>Continue to traveller details</button>
    </div>
  )
}

/* ---------------- step 2: travellers ---------------- */
function Travellers({ d, pax, setPax, contact, setContact, gst, setGst, errors, onNext }) {
  const flags = d.flags
  const passport = !flags.isDomestic || flags.passport || flags.passportFull
  const [useGst, setUseGst] = useState(Boolean(gst.number) || flags.gstMandatory)
  const err = (k) => errors[k]
  const setP = (i, k, v) => setPax((list) => list.map((p, n) => (n === i ? { ...p, [k]: v } : p)))
  const setG = (i, k, v) => setPax((list) => list.map((p, n) => (n === i ? { ...p, guardian: { ...p.guardian, [k]: v } } : p)))
  const counter = { 1: 0, 2: 0, 3: 0 }

  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); onNext(useGst) }} noValidate>
      <Alert tone="info">Enter names exactly as on the passport or government ID. Name changes after booking are charged by airlines — or not allowed.</Alert>
      {pax.map((p, i) => {
        counter[p.type] += 1
        const f = (k) => `pax.${i}.${k}`
        const titles = TITLES[p.type]?.[p.gender] || []
        const dobNeeded = p.type !== 1 || passport
        return (
          <fieldset key={i} className="rounded-2xl border border-slate-200 bg-white p-5">
            <legend className="px-1 font-display text-[1.05rem] font-bold text-ink">
              {PAX_LABEL[p.type]} {counter[p.type]}{i === 0 ? ' · lead traveller' : ''}
            </legend>
            <div className="mt-2 grid gap-4 sm:grid-cols-[9rem_8rem_1fr_1fr]">
              <Field id={f('gender')} label="Gender" error={err(f('gender'))}>
                <select {...inputProps(f('gender'), err(f('gender')))} value={p.gender} onChange={(e) => { setP(i, 'gender', Number(e.target.value) || ''); setP(i, 'title', (TITLES[p.type]?.[Number(e.target.value)] || [''])[0]) }}>
                  <option value="">Choose</option><option value="1">Male</option><option value="2">Female</option>
                </select>
              </Field>
              <Field id={f('title')} label="Title" error={err(f('title'))}>
                <select {...inputProps(f('title'), err(f('title')))} value={p.title} onChange={(e) => setP(i, 'title', e.target.value)} disabled={!titles.length}>
                  {!titles.length && <option value="">—</option>}
                  {titles.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field id={f('firstName')} label="First & middle name" error={err(f('firstName'))}>
                <input {...inputProps(f('firstName'), err(f('firstName')))} value={p.firstName} onChange={(e) => setP(i, 'firstName', e.target.value)} autoComplete={i === 0 ? 'given-name' : 'off'} autoCapitalize="words" />
              </Field>
              <Field id={f('lastName')} label="Last name" error={err(f('lastName'))}>
                <input {...inputProps(f('lastName'), err(f('lastName')))} value={p.lastName} onChange={(e) => setP(i, 'lastName', e.target.value)} autoComplete={i === 0 ? 'family-name' : 'off'} autoCapitalize="words" />
              </Field>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {dobNeeded || p.dob ? (
                <Field id={f('dob')} label="Date of birth" error={err(f('dob'))}>
                  <input type="date" {...inputProps(f('dob'), err(f('dob')))} value={p.dob} onChange={(e) => setP(i, 'dob', e.target.value)} />
                </Field>
              ) : null}
              <Field id={f('nationality')} label="Nationality" error={err(f('nationality'))}>
                <select {...inputProps(f('nationality'), err(f('nationality')))} value={p.nationality} onChange={(e) => setP(i, 'nationality', e.target.value)}>
                  {NATIONALITIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                </select>
              </Field>
            </div>
            {passport && (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field id={f('passportNo')} label="Passport number" error={err(f('passportNo'))}>
                  <input {...inputProps(f('passportNo'), err(f('passportNo')))} value={p.passportNo} onChange={(e) => setP(i, 'passportNo', e.target.value.toUpperCase())} autoComplete="off" />
                </Field>
                <Field id={f('passportExpiry')} label="Passport expiry" error={err(f('passportExpiry'))}>
                  <input type="date" {...inputProps(f('passportExpiry'), err(f('passportExpiry')))} value={p.passportExpiry} onChange={(e) => setP(i, 'passportExpiry', e.target.value)} />
                </Field>
                {flags.passportFull && (
                  <Field id={f('passportIssueDate')} label="Passport issue date" error={err(f('passportIssueDate'))}>
                    <input type="date" {...inputProps(f('passportIssueDate'), err(f('passportIssueDate')))} value={p.passportIssueDate} onChange={(e) => setP(i, 'passportIssueDate', e.target.value)} />
                  </Field>
                )}
              </div>
            )}
            {flags.pan && (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field id={f('pan')} label="PAN" hint={p.type === 1 ? '(required by the airline)' : '(or a parent’s below)'} error={err(f('pan'))}>
                  <input {...inputProps(f('pan'), err(f('pan')))} value={p.pan} onChange={(e) => setP(i, 'pan', e.target.value.toUpperCase())} autoComplete="off" />
                </Field>
                {p.type !== 1 && !p.pan && (
                  <>
                    <Field id={f('guardian')} label="Parent / guardian name" error={err(f('guardian'))}>
                      <div className="grid grid-cols-2 gap-2">
                        <input className="field" aria-label="Guardian first name" value={p.guardian.firstName} onChange={(e) => setG(i, 'firstName', e.target.value)} />
                        <input className="field" aria-label="Guardian last name" value={p.guardian.lastName} onChange={(e) => setG(i, 'lastName', e.target.value)} />
                      </div>
                    </Field>
                    <Field id={`${f('guardian')}-pan`} label="Guardian PAN">
                      <input id={`${f('guardian')}-pan`} className="field" value={p.guardian.pan} onChange={(e) => setG(i, 'pan', e.target.value.toUpperCase())} />
                    </Field>
                  </>
                )}
              </div>
            )}
            {p.type !== 3 && (
              <details className="mt-4 text-[0.92rem]">
                <summary className="cursor-pointer font-semibold text-brand-500">Frequent flyer number (optional)</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_1fr]">
                  <input className="field" placeholder="Airline (e.g. AI)" aria-label="Frequent flyer airline code" maxLength={2} value={p.ff.airline} onChange={(e) => setP(i, 'ff', { ...p.ff, airline: e.target.value.toUpperCase() })} />
                  <input className="field" placeholder="Membership number" aria-label="Frequent flyer number" value={p.ff.number} onChange={(e) => setP(i, 'ff', { ...p.ff, number: e.target.value })} />
                </div>
              </details>
            )}
          </fieldset>
        )
      })}

      <fieldset className="rounded-2xl border border-slate-200 bg-white p-5">
        <legend className="px-1 font-display text-[1.05rem] font-bold text-ink">Contact details</legend>
        <p className="mt-1 text-[0.9rem] text-slate-600">The e-ticket and any airline changes go here.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field id="contact.email" label="Email" error={err('contact.email')}>
            <input type="email" {...inputProps('contact.email', err('contact.email'))} value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" />
          </Field>
          <Field id="contact.phone" label="Mobile number" error={err('contact.phone')}>
            <input type="tel" inputMode="tel" {...inputProps('contact.phone', err('contact.phone'))} value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} autoComplete="tel-national" placeholder="10-digit Indian mobile" />
          </Field>
          <Field id="contact.address" label="Address" error={err('contact.address')}>
            <input {...inputProps('contact.address', err('contact.address'))} value={contact.address} onChange={(e) => setContact({ ...contact, address: e.target.value })} autoComplete="street-address" />
          </Field>
          <Field id="contact.city" label="City" error={err('contact.city')}>
            <input {...inputProps('contact.city', err('contact.city'))} value={contact.city} onChange={(e) => setContact({ ...contact, city: e.target.value })} autoComplete="address-level2" />
          </Field>
        </div>

        {(flags.gstAllowed || flags.gstMandatory) && (
          <div className="mt-5 border-t border-slate-200 pt-4">
            {flags.gstMandatory
              ? <p className="font-semibold text-ink">GST details are required by the airline for this fare.</p>
              : <label className="flex cursor-pointer items-center gap-2 font-semibold text-ink"><input type="checkbox" className="h-4 w-4 accent-brand-500" checked={useGst} onChange={(e) => setUseGst(e.target.checked)} />Use a GST number (business travel)</label>}
            {useGst && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {[['number', 'GSTIN'], ['company', 'Company name'], ['email', 'Company email'], ['phone', 'Company phone'], ['address', 'Company address']].map(([k, t]) => (
                  <Field key={k} id={`gst.${k}`} label={t} error={err(`gst.${k}`)}>
                    <input {...inputProps(`gst.${k}`, err(`gst.${k}`))} value={gst[k] || ''} onChange={(e) => setGst({ ...gst, [k]: k === 'number' ? e.target.value.toUpperCase() : e.target.value })} />
                  </Field>
                ))}
              </div>
            )}
          </div>
        )}
      </fieldset>

      {Object.keys(errors).length > 0 && <Alert tone="error">Please fix the highlighted details.</Alert>}
      <button type="submit" className="btn btn-brand">Continue to seats &amp; extras</button>
    </form>
  )
}

/* ---------------- step 3: seats, meals, baggage ---------------- */
function SeatMap({ seg, pax, active, picks, onPick }) {
  // Columns in seat order; a gap where two aisle seats meet (e.g. C | D).
  const cols = [...new Set(seg.rows.flatMap((r) => r.seats.map((s) => s.col)))].sort()
  const typeOf = (c) => seg.rows.flatMap((r) => r.seats).find((s) => s.col === c)?.type
  const takenBy = (code) => picks.findIndex((p) => p?.seat?.[seg.key] === code)
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4">
      <div className="mx-auto w-fit">
        <div className="mb-2 flex gap-1.5 pl-8 text-center font-display text-[0.75rem] font-bold text-slate-500">
          {cols.map((c, i) => (
            <span key={c} className={`w-9 ${typeOf(c) === 2 && typeOf(cols[i + 1]) === 2 ? 'mr-5' : ''}`}>{c}</span>
          ))}
        </div>
        {seg.rows.map((r) => (
          <div key={r.row} className="mb-1.5 flex items-center gap-1.5">
            <span className="w-7 text-right font-display text-[0.75rem] font-bold text-slate-500">{r.row}</span>
            {cols.map((c, i) => {
              const s = r.seats.find((x) => x.col === c)
              const gap = typeOf(c) === 2 && typeOf(cols[i + 1]) === 2 ? 'mr-5' : ''
              if (!s) return <span key={c} className={`h-9 w-9 ${gap}`} />
              const by = takenBy(s.code)
              const mine = by === active
              const other = by >= 0 && !mine
              return (
                <button
                  key={c} type="button" disabled={!s.open || other}
                  onClick={() => onPick(mine ? '' : s.code)}
                  aria-pressed={mine}
                  aria-label={`Seat ${s.code}, ${s.open ? (s.price ? money(s.price) : 'free') : 'not available'}${other ? `, taken by ${pax[by]?.firstName || `traveller ${by + 1}`}` : ''}`}
                  title={`${s.code} · ${s.open ? (s.price ? money(s.price) : 'Free') : 'Unavailable'}`}
                  className={`grid h-9 w-9 place-items-center rounded-md text-[0.72rem] font-bold transition-colors ${gap} ${
                    mine ? 'bg-navy-950 text-white'
                      : other ? 'bg-gold-500 text-navy-950'
                        : !s.open ? 'cursor-not-allowed bg-slate-200 text-slate-400'
                          : s.price ? 'border border-brand-400 bg-brand-500/10 text-brand-600 hover:bg-brand-500/25'
                            : 'border border-palm/50 bg-palm/10 text-palm hover:bg-palm/25'
                  }`}
                >
                  {other ? (pax[by]?.firstName?.[0] || by + 1) : s.col}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-4 text-[0.8rem] text-slate-600">
        <span className="flex items-center gap-1.5"><i className="h-3.5 w-3.5 rounded bg-palm/20" />Free</span>
        <span className="flex items-center gap-1.5"><i className="h-3.5 w-3.5 rounded bg-brand-500/20" />Paid</span>
        <span className="flex items-center gap-1.5"><i className="h-3.5 w-3.5 rounded bg-slate-200" />Taken</span>
        <span className="flex items-center gap-1.5"><i className="h-3.5 w-3.5 rounded bg-navy-950" />This traveller</span>
      </div>
    </div>
  )
}

function Extras({ d, pax, ssr, sel, setSel, onNext, busy }) {
  const [active, setActive] = useState(0)
  const [segTab, setSegTab] = useState({})
  const named = (i) => `${pax[i].firstName || PAX_LABEL[pax[i].type]} ${pax[i].lastName || i + 1}`.trim()
  const setPick = (li, pi, kind, key, value) => setSel((all) => all.map((leg, l) => (l !== li ? leg : leg.map((p, n) => {
    if (n !== pi) return p
    if (kind === 'meal' || kind === 'seat' || kind === 'baggage') {
      if (key == null) return { ...p, [kind]: value } // non-LCC: plain code
      return { ...p, [kind]: { ...(p[kind] || {}), [key]: value } }
    }
    return p
  }))))
  const toggleService = (li, pi, key) => setSel((all) => all.map((leg, l) => (l !== li ? leg : leg.map((p, n) => {
    if (n !== pi) return p
    const has = (p.services || []).includes(key)
    return { ...p, services: has ? p.services.filter((x) => x !== key) : [...(p.services || []), key] }
  }))))

  return (
    <div className="space-y-6">
      {ssr.legs.map((opt, li) => {
        const legName = d.legs.length > 1 ? (li === 0 ? 'Departure' : 'Return') : null
        if (!opt) return <Alert key={li} tone="info">{legName ? `${legName}: ` : ''}This airline does not offer seat or meal pre-booking online. You can choose them at web check-in.</Alert>
        if (!opt.lcc) {
          return (
            <section key={li} className="rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="font-display text-[1.1rem] font-bold text-ink">{legName ? `${legName} · ` : ''}Meal and seat preferences</h2>
              <p className="mt-1 text-[0.9rem] text-slate-600">Passed to the airline as requests (free, subject to availability on the day).</p>
              <div className="mt-4 grid gap-4">
                {pax.map((p, pi) => (
                  <div key={pi} className="grid gap-3 sm:grid-cols-[12rem_1fr_1fr] sm:items-center">
                    <span className="font-semibold text-ink">{named(pi)}</span>
                    <select className="field" aria-label={`Meal preference for ${named(pi)}`} value={sel[li][pi]?.meal || ''} onChange={(e) => setPick(li, pi, 'meal', null, e.target.value)}>
                      <option value="">No meal preference</option>
                      {opt.meals.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
                    </select>
                    {p.type !== 3 ? (
                      <select className="field" aria-label={`Seat preference for ${named(pi)}`} value={sel[li][pi]?.seat || ''} onChange={(e) => setPick(li, pi, 'seat', null, e.target.value)}>
                        <option value="">No seat preference</option>
                        {opt.seatPrefs.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
                      </select>
                    ) : <span className="text-[0.88rem] text-slate-500">Infants sit on a lap</span>}
                  </div>
                ))}
              </div>
            </section>
          )
        }
        const seatPax = pax.map((p, i) => i).filter((i) => pax[i].type !== 3)
        const segKey = segTab[li] ?? opt.seats[0]?.key
        const seg = opt.seats.find((s) => s.key === segKey)
        return (
          <section key={li} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="font-display text-[1.15rem] font-bold text-ink">{legName ? `${legName} · ` : ''}Seats, meals and baggage</h2>

            {opt.seats.length > 0 && (
              <div>
                <h3 className="mb-2 font-display font-bold text-ink">Choose seats</h3>
                {opt.seats.length > 1 && (
                  <div role="tablist" className="mb-3 flex flex-wrap gap-2">
                    {opt.seats.map((s) => (
                      <button key={s.key} role="tab" type="button" aria-selected={s.key === segKey} onClick={() => setSegTab({ ...segTab, [li]: s.key })} className={`rounded-lg px-3 py-1.5 text-[0.9rem] font-semibold ${s.key === segKey ? 'bg-navy-950 text-white' : 'bg-slate-100 text-slate-600'}`}>{s.label}</button>
                    ))}
                  </div>
                )}
                <div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Choosing a seat for">
                  {seatPax.map((pi) => (
                    <button key={pi} type="button" role="radio" aria-checked={active === pi} onClick={() => setActive(pi)} className={`rounded-full border px-3 py-1 text-[0.9rem] ${active === pi ? 'border-navy-950 bg-navy-950 text-white' : 'border-slate-300 text-ink'}`}>
                      {named(pi)}{sel[li][pi]?.seat?.[segKey] ? ` · ${sel[li][pi].seat[segKey]}` : ''}
                    </button>
                  ))}
                </div>
                {seg && seg.rows.length > 0
                  ? <SeatMap seg={seg} pax={pax} active={seatPax.includes(active) ? active : seatPax[0]} picks={sel[li]} onPick={(code) => setPick(li, seatPax.includes(active) ? active : seatPax[0], 'seat', segKey, code)} />
                  : <p className="text-[0.9rem] text-slate-600">The seat map is not available for this flight.</p>}
              </div>
            )}

            {opt.meals.some((g) => g.options.some((o) => !o.none)) && (
              <div>
                <h3 className="mb-2 font-display font-bold text-ink">Meals</h3>
                <div className="grid gap-3">
                  {opt.meals.map((g) => pax.map((p, pi) => (
                    <div key={`${g.group}-${pi}`} className="grid gap-2 sm:grid-cols-[14rem_1fr] sm:items-center">
                      <span className="text-[0.95rem]"><b className="text-ink">{named(pi)}</b> · {g.label}</span>
                      <select className="field !py-2.5" aria-label={`Meal for ${named(pi)}, ${g.label}`} value={sel[li][pi]?.meal?.[g.group] || ''} onChange={(e) => setPick(li, pi, 'meal', g.group, e.target.value)}>
                        <option value="">No meal</option>
                        {g.options.filter((o) => !o.none).map((o) => <option key={o.code} value={o.code}>{o.label} — {o.price ? money(o.price) : 'free'}</option>)}
                      </select>
                    </div>
                  )))}
                </div>
              </div>
            )}

            {opt.baggage.some((g) => g.options.some((o) => !o.none)) && (
              <div>
                <h3 className="mb-2 font-display font-bold text-ink">Extra check-in baggage</h3>
                <div className="grid gap-3">
                  {opt.baggage.map((g) => pax.map((p, pi) => p.type === 3 ? null : (
                    <div key={`${g.group}-${pi}`} className="grid gap-2 sm:grid-cols-[14rem_1fr] sm:items-center">
                      <span className="text-[0.95rem]"><b className="text-ink">{named(pi)}</b> · {g.label}</span>
                      <select className="field !py-2.5" aria-label={`Extra baggage for ${named(pi)}, ${g.label}`} value={sel[li][pi]?.baggage?.[g.group] || ''} onChange={(e) => setPick(li, pi, 'baggage', g.group, e.target.value)}>
                        <option value="">{d.isDomestic ? 'No extra baggage' : 'Included allowance only'}</option>
                        {g.options.filter((o) => !o.none).map((o) => <option key={o.code} value={o.code}>{o.label} — {o.price ? money(o.price) : 'included'}</option>)}
                      </select>
                    </div>
                  )))}
                </div>
              </div>
            )}

            {opt.services.length > 0 && (
              <div>
                <h3 className="mb-2 font-display font-bold text-ink">Other services</h3>
                {pax.map((p, pi) => (
                  <div key={pi} className="mb-3">
                    <p className="text-[0.95rem] font-semibold text-ink">{named(pi)}</p>
                    {opt.services.map((s) => (
                      <label key={s.key} className="flex cursor-pointer items-center gap-2 py-1 text-[0.92rem]">
                        <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={(sel[li][pi]?.services || []).includes(s.key)} onChange={() => toggleService(li, pi, s.key)} />
                        {s.label} — {s.price ? money(s.price) : 'free'}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })}
      <button type="button" className="btn btn-brand" onClick={onNext} disabled={busy}>{busy ? 'Confirming price…' : 'Review and pay'}</button>
    </div>
  )
}

/** Running add-on total for the summary box (the server re-prices it exactly). */
function extrasTotal(ssr, sel) {
  if (!ssr) return 0
  let t = 0
  ssr.legs.forEach((opt, li) => {
    if (!opt?.lcc) return
    for (const p of sel[li] || []) {
      if (!p) continue
      for (const [g, code] of Object.entries(p.meal || {})) t += opt.meals[g]?.options.find((o) => o.code === code)?.price || 0
      for (const [g, code] of Object.entries(p.baggage || {})) t += opt.baggage[g]?.options.find((o) => o.code === code)?.price || 0
      for (const [k, code] of Object.entries(p.seat || {})) t += opt.seats.find((s) => s.key === k)?.rows.flatMap((r) => r.seats).find((s) => s.code === code)?.price || 0
      for (const key of p.services || []) t += opt.services.find((s) => s.key === key)?.price || 0
    }
  })
  return t
}

/* ---------------- step 4: pay ---------------- */
function Pay({ d, confirmed, onPaid, onBack }) {
  const [agree, setAgree] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | paying | ticketing
  const [error, setError] = useState('')
  const p = confirmed.price
  const pay = confirmed.payment

  const finish = async (path, body) => {
    setPhase('ticketing')
    try { await api(`drafts/${d.id}/${path}`, { method: 'POST', body }) } catch (e) {
      // Even if this call fails or times out, the booking page shows the real status.
      if (e.status === 400) { setPhase('idle'); return setError(e.message) }
    }
    onPaid()
  }

  const start = async () => {
    setError('')
    if (pay.mode === 'test') return finish('pay/test')
    setPhase('paying')
    if (!(await loadRazorpayCheckout())) { setPhase('idle'); return setError('The payment window could not load. Check your connection and try again.') }
    const rz = new window.Razorpay({
      key: pay.keyId,
      order_id: pay.orderId,
      amount: pay.amount,
      currency: 'INR',
      name: BIZ.name,
      description: `Flight booking ${confirmed.ref}`,
      prefill: { name: pay.name, email: pay.email, contact: pay.phone },
      notes: { booking: confirmed.ref },
      theme: { color: '#0f5e9e' },
      handler: (r) => finish('pay/verify', { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
      modal: { ondismiss: () => setPhase('idle') },
    })
    rz.on('payment.failed', (r) => setError(r?.error?.description || 'The payment did not go through. No money was taken — you can try again.'))
    rz.open()
  }

  if (phase === 'ticketing') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <Spinner label="Payment received — issuing your ticket with the airline…" />
        <p className="mt-4 text-[0.95rem] text-slate-600">This usually takes under a minute, sometimes a few. Please don’t close this page.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-display text-[1.1rem] font-bold text-ink">Price breakdown</h2>
        <dl className="mt-3 space-y-2 text-[0.98rem]">
          <div className="flex justify-between"><dt>Airfare, taxes and airline fees</dt><dd>{money(p.fare)}</dd></div>
          {p.ssr > 0 && <div className="flex justify-between"><dt>Seats, meals, baggage</dt><dd>{money(p.ssr)}</dd></div>}
          {p.markup > 0 && <div className="flex justify-between"><dt>Service fee</dt><dd>{money(p.markup)}</dd></div>}
          <div className="flex justify-between border-t border-slate-200 pt-2 font-display text-[1.2rem] font-extrabold text-ink"><dt>Total to pay</dt><dd>{money(p.total)}</dd></div>
        </dl>
        <p className="mt-3 text-[0.85rem] text-slate-500">Our service fee and paid add-ons are not refundable if you cancel. Airline refunds follow the fare rules.</p>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-[0.95rem]">
        <input type="checkbox" className="mt-1 h-4.5 w-4.5 accent-brand-500" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>
          I have checked the travellers’ names, and I accept the airline’s fare rules, the{' '}
          <Link to="/terms" target="_blank" className="font-semibold text-brand-500 underline">Terms</Link>,{' '}
          <Link to="/refund-policy" target="_blank" className="font-semibold text-brand-500 underline">Cancellation &amp; Refund Policy</Link> and{' '}
          <Link to="/privacy" target="_blank" className="font-semibold text-brand-500 underline">Privacy Policy</Link>.
        </span>
      </label>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="btn btn-gold" disabled={!agree || phase === 'paying'} onClick={start}>
          <ShieldCheck size={18} aria-hidden="true" />
          {pay.mode === 'test' ? `Pay ${money(p.total)} (test mode — no money charged)` : phase === 'paying' ? 'Opening payment…' : `Pay ${money(p.total)} securely`}
        </button>
        <button type="button" className="font-semibold text-brand-500 hover:underline" onClick={onBack}>Change details</button>
      </div>
      {pay.mode !== 'test' && <p className="text-[0.85rem] text-slate-500">Cards, UPI and net banking via Razorpay. We never see your card or UPI details.</p>}
    </div>
  )
}

function Summary({ d, extras, confirmed }) {
  const total = confirmed?.price?.total ?? (d.price ? d.price.total + extras : null)
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-[1.05rem] font-bold text-ink">Trip summary</h2>
        <Countdown until={d.expiresAt} />
      </div>
      <ul className="mt-3 space-y-3 text-[0.92rem]">
        {d.legs.flatMap((l) => l.card.trips).map((t, i) => (
          <li key={i} className="border-b border-dashed border-slate-200 pb-3 last:border-0">
            <b className="text-ink">{t.fromCity} → {t.toCity}</b>
            <span className="block text-slate-600">{dayLabel(t.dep)} · {t.segments.map((s) => s.flight).join(', ')}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.9rem] text-slate-600">{d.search.adults + d.search.children + d.search.infants} traveller(s)</p>
      <div className="mt-4 flex items-baseline justify-between border-t border-slate-200 pt-3">
        <span className="font-semibold text-ink">{confirmed ? 'Total' : 'Total so far'}</span>
        <span className="font-display text-[1.4rem] font-extrabold text-ink">{money(total)}</span>
      </div>
      {!confirmed && extras > 0 && <p className="text-[0.82rem] text-slate-500">Includes {money(extras)} of extras</p>}
      <p className="mt-4 text-[0.85rem] text-slate-500">
        Stuck? <a href={waLink(`Hello, I need help with flight booking ${d.ref}.`)} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-500 underline">WhatsApp us</a> or call {BIZ.phoneDisplay} — quote {d.ref}.
      </p>
    </div>
  )
}

export default function FlightBook() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [d, setD] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [step, setStep] = useState(0)
  const [pax, setPax] = useState([])
  const [contact, setContact] = useState({ email: '', phone: '', address: '', city: 'Bengaluru' })
  const [gst, setGst] = useState({})
  const [errors, setErrors] = useState({})
  const [ssr, setSsr] = useState(null)
  const [sel, setSel] = useState([])
  const [confirmed, setConfirmed] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    api(`drafts/${id}`).then((draft) => {
      if (!['DRAFT', 'AWAITING_PAYMENT'].includes(draft.status)) return navigate('/flights/booking', { replace: true })
      setD(draft)
      setPax(initialPax(draft))
      if (draft.contact) setContact((c) => ({ ...c, ...draft.contact }))
      if (draft.gst) setGst(draft.gst)
    }).catch((e) => setLoadError(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [step])

  const extras = useMemo(() => extrasTotal(ssr, sel), [ssr, sel])

  if (loadError) {
    return (
      <FlightPage eyebrow="Flight booking" title="We couldn’t find this booking">
        <Alert tone="error">{loadError}</Alert>
        <Link to="/flights" className="btn btn-brand mt-6">Search flights</Link>
      </FlightPage>
    )
  }
  if (!d) return <FlightPage><Spinner label="Loading your flight" /></FlightPage>

  const goTravellers = (useGst) => {
    const g = useGst ? gst : {}
    const list = checkTravellers({ pax, contact, gst: g }, d.search, d.flags, d.dates)
    const map = Object.fromEntries(list.map((e) => [e.field, e.message]))
    setErrors(map)
    if (list.length) {
      const first = document.getElementById(list[0].field)
      first?.focus()
      return
    }
    if (!useGst) setGst({})
    loadExtras()
  }

  const loadExtras = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api(`drafts/${id}/ssr`, { method: 'POST' })
      setSsr(r)
      setD((x) => ({ ...x, version: r.version }))
      setSel((cur) => r.legs.map((_, li) => pax.map((__, pi) => cur[li]?.[pi] || {})))
      setStep(2)
    } catch (e) {
      setError(e.message)
      if (e.status === 410) setExpired(true)
    } finally { setBusy(false) }
  }

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api(`drafts/${id}/travellers`, { method: 'POST', body: { version: d.version, pax, contact, gst: gst.number ? gst : null, ssr: sel } })
      setConfirmed(r)
      setD((x) => ({ ...x, version: r.version }))
      setStep(3)
    } catch (e) {
      if (e.errors) { setErrors(Object.fromEntries(e.errors.map((x) => [x.field, x.message]))); setStep(1) }
      setError(e.message)
      if (e.status === 410) setExpired(true)
    } finally { setBusy(false) }
  }

  const back = step > 0 && step < 3 ? () => setStep(step - 1) : null

  return (
    <FlightPage
      eyebrow={`Booking ${d.ref}`}
      title={step === 3 ? 'Review and pay' : 'Complete your booking'}
      aside={<Summary d={d} extras={extras} confirmed={step === 3 ? confirmed : null} />}
    >
      <Steps steps={STEPS} current={step} />
      <div className="mt-6">
        {(expired) && (
          <Alert tone="error" className="mb-5">
            Airlines only hold a fare for 15 minutes, and this one has expired.{' '}
            <Link to={searchUrl(d.search)} className="font-semibold text-brand-500 underline">Search again for live prices</Link>.
          </Alert>
        )}
        {error && !expired && <Alert tone="error" className="mb-5">{error}</Alert>}
        {back && <button type="button" onClick={back} className="mb-4 inline-flex items-center gap-1.5 font-semibold text-brand-500 hover:underline"><ArrowLeft size={16} /> Back</button>}

        {step === 0 && <Review d={d} onNext={() => setStep(1)} />}
        {step === 1 && <Travellers d={d} pax={pax} setPax={setPax} contact={contact} setContact={setContact} gst={gst} setGst={setGst} errors={errors} onNext={goTravellers} />}
        {step === 2 && ssr && <Extras d={d} pax={pax} ssr={ssr} sel={sel} setSel={setSel} onNext={confirm} busy={busy || expired} />}
        {step === 3 && confirmed && (
          <Pay
            d={d}
            confirmed={confirmed}
            onBack={() => setStep(2)}
            onPaid={() => navigate(`/flights/booking/${confirmed.ref}?t=${encodeURIComponent(confirmed.manageToken)}`, { replace: true })}
          />
        )}
        {busy && step === 1 && <div className="mt-4"><Spinner label="Loading seats and extras" /></div>}
      </div>
    </FlightPage>
  )
}
