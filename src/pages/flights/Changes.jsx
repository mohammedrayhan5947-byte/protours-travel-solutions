import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { BIZ } from '../../data/site.js'
import { loadRazorpayCheckout } from '../../lib/razorpay.js'
import { api, money, dayLabel, Alert, Spinner, FlightCard, todayLocal } from './shared.jsx'

/* Changes after ticketing, on the customer's booking page:
   date change (TBO re-issue) and extra seat / meal / baggage (Air Amendment).
   Prices come from the server; every change is paid separately. */

const legName = (view, i) => (view.legs.length > 1 ? (i === 0 ? 'Departure' : 'Return') : 'Flight')

function LegPicker({ view, value, onChange }) {
  if (view.changeableLegs.length < 2) return null
  return (
    <fieldset className="mt-3">
      <legend className="font-semibold text-ink">Which flight?</legend>
      {view.changeableLegs.map((i) => (
        <label key={i} className="flex items-center gap-2 py-1">
          <input type="radio" name="chg-leg" className="accent-brand-500" checked={value === i} onChange={() => onChange(i)} />
          {legName(view, i)} · {view.legs[i].card.trips[0].fromCity} → {view.legs[i].card.trips.at(-1).toCity} (PNR {view.legs[i].pnr})
        </label>
      ))}
    </fieldset>
  )
}

/** Pay for a quoted change (Razorpay, or the no-charge test mode on staging). */
function PayChange({ view, token, change, lines, onDone }) {
  const [agree, setAgree] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const pay = change.payment

  const finish = async (path, body) => {
    setPhase('working')
    try { await api(`bookings/${view.ref}/changes/${change.id}/${path}`, { method: 'POST', body: { t: token, ...body } }) } catch (e) {
      if (e.status === 400) { setPhase('idle'); return setError(e.message) }
    }
    onDone()
  }

  const start = async () => {
    setError('')
    if (pay.mode === 'test') return finish('pay/test')
    setPhase('paying')
    if (!(await loadRazorpayCheckout())) { setPhase('idle'); return setError('The payment window could not load. Check your connection and try again.') }
    const rz = new window.Razorpay({
      key: pay.keyId, order_id: pay.orderId, amount: pay.amount, currency: 'INR',
      name: BIZ.name, description: `Change to booking ${view.ref}`,
      prefill: { name: pay.name, email: pay.email, contact: pay.phone },
      theme: { color: '#0f5e9e' },
      handler: (r) => finish('pay/verify', { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
      modal: { ondismiss: () => setPhase('idle') },
    })
    rz.on('payment.failed', (r) => setError(r?.error?.description || 'The payment did not go through. No money was taken.'))
    rz.open()
  }

  if (phase === 'working') return <div className="rounded-xl bg-sand p-5"><Spinner label="Payment received — making the change with the airline…" /></div>
  if (!pay) return null
  return (
    <div className="space-y-4">
      <dl className="space-y-1.5 rounded-xl bg-sand p-4 text-[0.95rem]">
        {lines.filter(([, v]) => v > 0).map(([k, v]) => <div key={k} className="flex justify-between gap-4"><dt>{k}</dt><dd>{money(v)}</dd></div>)}
        <div className="flex justify-between border-t border-slate-300 pt-2 font-display text-[1.1rem] font-extrabold text-ink"><dt>To pay now</dt><dd>{money(change.amount)}</dd></div>
      </dl>
      <label className="flex items-start gap-2 text-[0.92rem]">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-500" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I accept the airline’s change rules and the <Link to="/refund-policy" target="_blank" className="font-semibold text-brand-500 underline">Cancellation &amp; Refund Policy</Link>. Change charges are not refundable once the change is made.</span>
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      <button type="button" className="btn btn-gold" disabled={!agree || phase === 'paying'} onClick={start}>
        <ShieldCheck size={18} aria-hidden="true" />
        {pay.mode === 'test' ? `Pay ${money(change.amount)} (test mode — no money charged)` : phase === 'paying' ? 'Opening payment…' : `Pay ${money(change.amount)} securely`}
      </button>
    </div>
  )
}

/** Date change: new date(s) → re-issue options with "what you pay now" → pay → done. */
export function ChangeDatePanel({ view, token, onDone }) {
  const [leg, setLeg] = useState(view.changeableLegs[0])
  const trips = view.legs[leg].card.trips
  const [dates, setDates] = useState(trips.map(() => ''))
  const [found, setFound] = useState(null)
  const [change, setChange] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const tomorrow = (() => { const d = new Date(`${todayLocal()}T00:00:00`); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10) })()

  const search = async (e) => {
    e.preventDefault()
    setBusy(true); setError(''); setFound(null); setChange(null)
    try { setFound(await api(`bookings/${view.ref}/reissue/search`, { method: 'POST', body: { t: token, leg, dates } })) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const choose = async (resultIndex) => {
    setBusy(true); setError('')
    try {
      const c = await api(`bookings/${view.ref}/reissue/quote`, { method: 'POST', body: { t: token, leg, traceId: found.traceId, resultIndex } })
      if (c.status === 'AWAITING_PAYMENT') setChange(c)
      else onDone()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <section className="rounded-2xl border border-brand-500/30 bg-white p-5">
      <h2 className="font-display text-[1.15rem] font-bold text-ink">Change travel date</h2>
      <p className="mt-1 text-[0.92rem] text-slate-600">The whole ticket is re-issued for everyone on it, same route. You pay the airline’s change charge and any fare difference; a cheaper new fare is not refunded.</p>
      <LegPicker view={view} value={leg} onChange={(i) => { setLeg(i); setDates(view.legs[i].card.trips.map(() => '')); setFound(null); setChange(null) }} />
      {!change && (
        <form onSubmit={search} className="mt-4 flex flex-wrap items-end gap-3">
          {trips.map((t, i) => (
            <div key={i}>
              <label htmlFor={`chg-date-${i}`} className="mb-1.5 block font-display text-[0.9rem] font-bold text-navy-900">
                {t.fromCity} → {t.toCity} <span className="font-sans font-normal text-slate-500">(now {dayLabel(t.dep)})</span>
              </label>
              <input id={`chg-date-${i}`} type="date" className="field" min={(i > 0 && dates[i - 1]) || tomorrow} value={dates[i]} onChange={(e) => setDates((d) => d.map((x, n) => (n === i ? e.target.value : x)))} required />
            </div>
          ))}
          <button className="btn btn-brand !py-3" disabled={busy}>{busy && !found ? 'Searching…' : 'Find flights'}</button>
        </form>
      )}
      {error && <Alert tone="error" className="mt-4">{error}</Alert>}
      {found && !change && (
        <div className="mt-5 space-y-3">
          {!found.options.length && <p className="text-slate-600">No flights the airline can change you to on those dates. Try another date.</p>}
          {found.options.map((o) => (
            <FlightCard
              key={o.id} card={o}
              action={<button type="button" className="btn btn-brand !px-5 !py-2" disabled={busy} onClick={() => choose(o.id)}>Choose</button>}
              footer={<p className="mt-2 text-[0.85rem] text-slate-600">You pay {money(o.price)}: fare difference {money(o.change.difference)}, airline change charge {money(o.change.charges)}{o.change.markup + o.change.fee > 0 ? `, service fee ${money(o.change.markup + o.change.fee)}` : ''}.</p>}
            />
          ))}
        </div>
      )}
      {change && (
        <div className="mt-5 space-y-4">
          <FlightCard card={change.summary.card} compact />
          {change.summary.priceChanged && <Alert>The airline updated the price since you searched — the amount below is the confirmed one.</Alert>}
          <PayChange view={view} token={token} change={change} onDone={onDone} lines={[
            ['Fare difference', change.price.difference], ['Airline change charge', change.price.charges], ['Service fee', change.price.markup + change.price.fee],
          ]} />
        </div>
      )}
    </section>
  )
}

/** Extras after ticketing: seats, meals, extra baggage, other services. */
export function AddonsPanel({ view, token, onDone }) {
  const [leg, setLeg] = useState(view.changeableLegs[0])
  const [opt, setOpt] = useState(null)
  const [sel, setSel] = useState([])
  const [change, setChange] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async (i = leg) => {
    setBusy(true); setError(''); setOpt(null); setChange(null)
    try {
      const o = await api(`bookings/${view.ref}/addons/options`, { method: 'POST', body: { t: token, leg: i } })
      setOpt(o)
      setSel(o.travellers.map(() => ({})))
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const set = (pi, kind, key, value) => setSel((all) => all.map((p, n) => (n !== pi ? p : { ...p, [kind]: { ...(p[kind] || {}), [key]: value } })))
  const toggle = (pi, key) => setSel((all) => all.map((p, n) => {
    if (n !== pi) return p
    const has = (p.services || []).includes(key)
    return { ...p, services: has ? p.services.filter((x) => x !== key) : [...(p.services || []), key] }
  }))

  const total = !opt ? 0 : sel.reduce((t, p) => {
    let s = 0
    for (const [g, code] of Object.entries(p.baggage || {})) s += opt.options.baggage[g]?.options.find((o) => o.code === code)?.price || 0
    for (const [g, code] of Object.entries(p.meal || {})) s += opt.options.meals[g]?.options.find((o) => o.code === code)?.price || 0
    for (const [k, code] of Object.entries(p.seat || {})) s += opt.options.seats.find((x) => x.key === k)?.rows.flatMap((r) => r.seats).find((x) => x.code === code)?.price || 0
    for (const key of p.services || []) s += opt.options.services.find((x) => x.key === key)?.price || 0
    return t + s
  }, 0)
  const taken = (segKey, pi) => new Set(sel.filter((_, n) => n !== pi).map((p) => p.seat?.[segKey]).filter(Boolean))

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const c = await api(`bookings/${view.ref}/changes/${opt.changeId}/addons`, { method: 'POST', body: { t: token, ssr: sel } })
      if (c.status === 'AWAITING_PAYMENT') setChange(c)
      else onDone()
    } catch (err) {
      setError(err.message)
      if (err.status === 409 || err.status === 410) setOpt(null)
    } finally { setBusy(false) }
  }

  const sel2 = 'field !py-2.5'
  return (
    <section className="rounded-2xl border border-brand-500/30 bg-white p-5">
      <h2 className="font-display text-[1.15rem] font-bold text-ink">Add seats, meals or baggage</h2>
      <p className="mt-1 text-[0.92rem] text-slate-600">Bought from the airline at its price. Extras are usually non-refundable.</p>
      <LegPicker view={view} value={leg} onChange={(i) => { setLeg(i); setOpt(null); setChange(null) }} />
      {!opt && !change && <button type="button" className="btn btn-brand mt-4 !py-2.5" disabled={busy} onClick={() => load()}>{busy ? 'Loading…' : 'Show what’s available'}</button>}
      {error && <Alert tone="error" className="mt-4">{error}</Alert>}

      {opt && !change && (
        <div className="mt-5 space-y-5">
          {opt.travellers.map((p, pi) => (
            <fieldset key={pi} className="rounded-xl bg-sand p-4">
              <legend className="px-1 font-display font-bold text-ink">{p.name}</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {p.type !== 3 && opt.options.seats.map((seg) => (
                  <label key={seg.key} className="text-[0.92rem]">
                    <span className="mb-1 block font-semibold">Seat · {seg.label}</span>
                    <select className={sel2} value={sel[pi]?.seat?.[seg.key] || ''} onChange={(e) => set(pi, 'seat', seg.key, e.target.value)}>
                      <option value="">No seat</option>
                      {seg.rows.flatMap((r) => r.seats).filter((s) => s.open && !taken(seg.key, pi).has(s.code)).map((s) => (
                        <option key={s.code} value={s.code}>{s.code} — {s.price ? money(s.price) : 'free'}</option>
                      ))}
                    </select>
                  </label>
                ))}
                {opt.options.meals.filter((g) => g.options.some((o) => !o.none)).map((g) => (
                  <label key={`m${g.group}`} className="text-[0.92rem]">
                    <span className="mb-1 block font-semibold">Meal · {g.label}</span>
                    <select className={sel2} value={sel[pi]?.meal?.[g.group] || ''} onChange={(e) => set(pi, 'meal', g.group, e.target.value)}>
                      <option value="">No meal</option>
                      {g.options.filter((o) => !o.none).map((o) => <option key={o.code} value={o.code}>{o.label} — {o.price ? money(o.price) : 'free'}</option>)}
                    </select>
                  </label>
                ))}
                {p.type !== 3 && opt.options.baggage.filter((g) => g.options.some((o) => !o.none)).map((g) => (
                  <label key={`b${g.group}`} className="text-[0.92rem]">
                    <span className="mb-1 block font-semibold">Extra baggage · {g.label}</span>
                    {p.hasBaggage
                      ? <span className="block text-slate-500">Already has extra baggage — the airline doesn’t allow more online.</span>
                      : (
                        <select className={sel2} value={sel[pi]?.baggage?.[g.group] || ''} onChange={(e) => set(pi, 'baggage', g.group, e.target.value)}>
                          <option value="">No extra baggage</option>
                          {g.options.filter((o) => !o.none).map((o) => <option key={o.code} value={o.code}>{o.label} — {money(o.price)}</option>)}
                        </select>
                      )}
                  </label>
                ))}
              </div>
              {opt.options.services.length > 0 && (
                <div className="mt-3">
                  {opt.options.services.map((s) => (
                    <label key={s.key} className="flex items-center gap-2 py-0.5 text-[0.92rem]">
                      <input type="checkbox" className="h-4 w-4 accent-brand-500" checked={(sel[pi]?.services || []).includes(s.key)} onChange={() => toggle(pi, s.key)} />
                      {s.label} — {s.price ? money(s.price) : 'free'}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          ))}
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-display text-[1.15rem] font-extrabold text-ink">Extras: {money(total)}</span>
            <button type="button" className="btn btn-brand !py-2.5" disabled={busy} onClick={submit}>{busy ? 'Confirming…' : 'Continue to payment'}</button>
          </div>
        </div>
      )}

      {change && (
        <div className="mt-5 space-y-4">
          <ul className="space-y-1 text-[0.95rem]">{change.summary.items.map((it, k) => <li key={k}><b className="text-ink">{it.pax}</b> · {it.label} — {money(it.price)}</li>)}</ul>
          <PayChange view={view} token={token} change={change} onDone={onDone} lines={[['Extras', change.price.addons]]} />
        </div>
      )}
    </section>
  )
}

/** History of changes on the booking page. */
export function ChangesList({ view }) {
  if (!view.changes?.length) return null
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="font-display text-[1.05rem] font-bold text-ink">Changes</h2>
      <ul className="mt-2 space-y-2 text-[0.95rem]">
        {view.changes.map((c) => (
          <li key={c.id} className="border-t border-slate-200 pt-2 first:border-0 first:pt-0">
            <b className="text-ink">{c.kind === 'reissue' ? 'Date change' : 'Extras'}</b> · {c.statusText}{c.amount ? ` · ${money(c.amount)}` : ''}
            {c.kind === 'reissue' && c.summary?.card && <span className="block text-slate-600">New flight: {c.summary.card.trips.map((t) => `${t.from} → ${t.to} ${dayLabel(t.dep)}`).join(', ')}</span>}
            {c.kind === 'addons' && c.summary?.items && <span className="block text-slate-600">{c.summary.items.map((i) => `${i.pax}: ${i.label}`).join('; ')}</span>}
            {c.status === 'ATTENTION' && <span className="block text-clay">Your payment is safe — our team will contact you to finish this change or refund it.</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
