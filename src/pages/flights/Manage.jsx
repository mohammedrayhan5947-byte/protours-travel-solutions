import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Printer, Copy, MessageCircle } from 'lucide-react'
import { BIZ, waLink } from '../../data/site.js'
import { api, money, PAX_LABEL, Alert, Spinner, FlightCard, FlightPage } from './shared.jsx'
import { ChangeDatePanel, AddonsPanel, ChangesList } from './Changes.jsx'

/* /flights/booking/:ref?t=… — the customer's booking page (status, PNRs,
   e-ticket numbers, cancellation). The ?t= token is the key to manage it;
   without it, reference + surname gives a read-only view. */

function Lookup() {
  const navigate = useNavigate()
  const [f, setF] = useState({ ref: '', lastName: '' })
  const [state, setState] = useState({})
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    try {
      const view = await api('lookup', { method: 'POST', body: f })
      setState({ view })
    } catch (err) { setState({ error: err.message }) }
  }
  if (state.view) return <BookingView view={state.view} onReload={() => navigate(0)} />
  return (
    <FlightPage eyebrow="Manage booking" title="Find your flight booking">
      <form onSubmit={submit} className="max-w-xl space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
        <div>
          <label htmlFor="lk-ref" className="mb-1.5 block font-display font-bold text-navy-900">Booking reference</label>
          <input id="lk-ref" className="field uppercase" placeholder="PT…" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} required />
        </div>
        <div>
          <label htmlFor="lk-ln" className="mb-1.5 block font-display font-bold text-navy-900">Traveller’s last name</label>
          <input id="lk-ln" className="field" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} required />
        </div>
        {state.error && <Alert tone="error">{state.error}</Alert>}
        <button className="btn btn-brand" disabled={state.busy}>{state.busy ? 'Finding…' : 'Find booking'}</button>
        <p className="text-[0.9rem] text-slate-600">
          To change or cancel, open the link from your booking confirmation, or{' '}
          <a href={waLink('Hello, I need help with my flight booking.')} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-500 underline">WhatsApp us</a>.
        </p>
      </form>
    </FlightPage>
  )
}

function CancelPanel({ view, token, onDone }) {
  const [legs, setLegs] = useState(view.legs.map((l, i) => (l.status === 'TICKETED' ? i : null)).filter((x) => x != null))
  const [who, setWho] = useState('all')
  const [pax, setPax] = useState([])
  const [quote, setQuote] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sure, setSure] = useState(false)
  const adults = view.travellers.map((t, i) => [t, i]).filter(([t]) => t.type !== 3)

  const getQuote = async () => {
    setBusy(true); setError('')
    try { setQuote(await api(`bookings/${view.ref}/cancel-quote`, { method: 'POST', body: { t: token, legs } })) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const go = async () => {
    setBusy(true); setError('')
    try {
      await api(`bookings/${view.ref}/cancel`, { method: 'POST', body: { t: token, legs, pax: who === 'all' ? [] : pax, reason: 'Cancelled online by customer' } })
      onDone()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <section className="rounded-2xl border border-clay/30 bg-white p-5">
      <h2 className="font-display text-[1.15rem] font-bold text-ink">Cancel this booking</h2>
      {view.legs.length > 1 && (
        <fieldset className="mt-3">
          <legend className="font-semibold text-ink">Which flights?</legend>
          {view.legs.map((l, i) => l.status === 'TICKETED' && (
            <label key={i} className="flex items-center gap-2 py-1">
              <input type="checkbox" className="h-4 w-4 accent-clay" checked={legs.includes(i)} onChange={() => { setQuote(null); setLegs((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i])) }} />
              {l.card.trips[0].fromCity} → {l.card.trips[l.card.trips.length - 1].toCity} (PNR {l.pnr})
            </label>
          ))}
        </fieldset>
      )}
      {view.travellers.length > 1 && (
        <fieldset className="mt-3">
          <legend className="font-semibold text-ink">Who?</legend>
          <label className="flex items-center gap-2 py-1"><input type="radio" name="who" className="accent-clay" checked={who === 'all'} onChange={() => setWho('all')} />Everyone</label>
          <label className="flex items-center gap-2 py-1"><input type="radio" name="who" className="accent-clay" checked={who === 'some'} onChange={() => setWho('some')} />Some travellers</label>
          {who === 'some' && adults.map(([t, i]) => (
            <label key={i} className="ml-6 flex items-center gap-2 py-1">
              <input type="checkbox" className="h-4 w-4 accent-clay" checked={pax.includes(i)} onChange={() => setPax((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))} />{t.name}
            </label>
          ))}
          {who === 'some' && <p className="ml-6 text-[0.85rem] text-slate-500">An infant is cancelled with the adult they travel with. Partial cancellations are confirmed by the airline and can take longer.</p>}
        </fieldset>
      )}

      {!quote && <button type="button" className="btn btn-ghost mt-4" disabled={busy || !legs.length} onClick={getQuote}>{busy ? 'Checking…' : 'Check cancellation charges'}</button>}
      {quote && (
        <div className="mt-4 space-y-3">
          {quote.legs.map((q) => (
            <div key={q.leg} className="rounded-xl bg-sand p-4 text-[0.95rem]">
              <p className="font-semibold text-ink">PNR {q.pnr}</p>
              {q.charge != null
                ? <p>Airline cancellation charge: <b>{money(q.charge)}</b> · Estimated refund: <b>{money(q.estimate)}</b></p>
                : <p>{q.remarks}</p>}
            </div>
          ))}
          <p className="text-[0.85rem] text-slate-600">{quote.note} Estimates are for cancelling everyone on the flight; the airline confirms the exact amount.</p>
          <label className="flex items-start gap-2 text-[0.95rem]">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-clay" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            I understand this cannot be undone.
          </label>
          <button type="button" className="btn bg-clay text-white hover:bg-[#9a4523]" disabled={!sure || busy || (who === 'some' && !pax.length)} onClick={go}>
            {busy ? 'Cancelling…' : 'Cancel now'}
          </button>
        </div>
      )}
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
    </section>
  )
}

function BookingView({ view, token, onReload }) {
  const [cancelling, setCancelling] = useState(false)
  const [panel, setPanel] = useState(null) // 'date' | 'extras'
  const [copied, setCopied] = useState(false)
  const done = view.status === 'CONFIRMED'
  const link = typeof window !== 'undefined' ? window.location.href : ''

  return (
    <FlightPage eyebrow={`Booking ${view.ref}`} title={view.statusText}>
      <div className="space-y-6">
        {view.working && <div className="rounded-2xl bg-white p-6"><Spinner label="Working on it — this page updates by itself." /></div>}
        {view.status === 'ATTENTION' && (
          <Alert>
            Your payment is safe. The airline needs a manual step to finish this booking, and our team has been alerted —
            we will call or WhatsApp you shortly. You can also reach us on {BIZ.phoneDisplay} quoting {view.ref}.
          </Alert>
        )}
        {view.status === 'AWAITING_PAYMENT' && <Alert>We have not received the payment for this booking yet. If money was deducted, it will be confirmed within a few minutes or refunded automatically by your bank.</Alert>}
        {view.status === 'EXPIRED' && <Alert>This fare expired before payment, so nothing was booked. <Link to="/flights" className="font-semibold text-brand-500 underline">Search again</Link>.</Alert>}

        {done && (
          <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-palm/10 p-5">
            <CheckCircle2 size={28} className="text-palm" aria-hidden="true" />
            <div className="flex-1">
              <p className="font-display text-[1.2rem] font-extrabold text-ink">Your tickets are issued</p>
              <p className="text-[0.95rem] text-slate-600">Airline PNR{view.legs.length > 1 ? 's' : ''}: {view.legs.map((l) => l.pnr).filter(Boolean).join(' · ')}. Do web check-in on the airline’s website and carry a photo ID (a passport for international flights).</p>
            </div>
            <button type="button" className="btn btn-ghost !py-2" onClick={() => window.print()}><Printer size={16} aria-hidden="true" /> Print / save</button>
          </div>
        )}

        {view.legs.map((l, i) => (
          <section key={i} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-[1.1rem] font-bold text-ink">{view.legs.length > 1 ? (i === 0 ? 'Departure' : 'Return') : 'Flight'}</h2>
              {l.pnr && <span className="font-display text-[1rem]">PNR <b className="tracking-[0.12em] text-ink">{l.pnr}</b></span>}
            </div>
            <FlightCard card={l.card} compact />
            {l.tickets.length > 0 && (
              <table className="w-full overflow-hidden rounded-xl bg-white text-left text-[0.95rem]">
                <thead className="bg-slate-50 text-[0.8rem] tracking-[0.1em] text-slate-500 uppercase"><tr><th className="px-4 py-2">Traveller</th><th className="px-4 py-2">E-ticket number</th></tr></thead>
                <tbody>
                  {l.tickets.map((t, k) => (
                    <tr key={k} className="border-t border-slate-200">
                      <td className="px-4 py-2">{t.name}</td>
                      <td className="px-4 py-2 font-mono">{t.cancelled ? <span className="text-clay">Cancelled</span> : t.number || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {l.addons?.length > 0 && (
              <p className="text-[0.92rem] text-slate-600">Extras: {l.addons.map((a) => `${view.travellers[a.pax]?.name || ''} — ${a.label}`).join('; ')}</p>
            )}
            {l.cancellations.length > 0 && (
              <p className="text-[0.92rem] text-slate-600">Cancellation: {l.cancellations.map((c) => `${c.status}${c.refunded != null ? ` · airline refund ${money(c.refunded)}` : ''}`).join('; ')}</p>
            )}
          </section>
        ))}

        <ChangesList view={view} />

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-[1.05rem] font-bold text-ink">Travellers & payment</h2>
          <ul className="mt-2 text-[0.95rem]">{view.travellers.map((t, i) => <li key={i}>{t.name} <span className="text-slate-500">({PAX_LABEL[t.type]})</span></li>)}</ul>
          {view.amount != null && <p className="mt-3 text-[0.95rem]">Paid: <b>{money(view.amount)}</b>{view.price?.markup ? <span className="text-slate-500"> (incl. service fee {money(view.price.markup)})</span> : null}</p>}
          {view.refunds.length > 0 && (
            <ul className="mt-2 text-[0.95rem]">{view.refunds.map((r, i) => <li key={i}>{r.status}: <b>{money(r.amount)}</b></li>)}</ul>
          )}
          {view.contact && <p className="mt-3 text-[0.9rem] text-slate-600">Updates go to {view.contact.email} and {view.contact.phone}.</p>}
        </section>

        {token && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 print:hidden">
            <h2 className="font-display text-[1.05rem] font-bold text-ink">Keep this link</h2>
            <p className="mt-1 text-[0.95rem] text-slate-600">It is the key to view, print or cancel this booking online. Anyone with it can manage the booking — share it only with your co-travellers.</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" className="btn btn-ghost !py-2" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true) } catch { /* clipboard blocked */ } }}>
                <Copy size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy link'}
              </button>
              <a className="btn btn-wa !py-2" href={`https://wa.me/?text=${encodeURIComponent(`My flight booking ${view.ref}: ${link}`)}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={16} aria-hidden="true" /> Save to WhatsApp</a>
            </div>
          </section>
        )}

        {(view.canCancel || view.changeableLegs?.length > 0) && !cancelling && !panel && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 print:hidden">
            {view.changeableLegs?.length > 0 && (
              <>
                <button type="button" className="font-semibold text-brand-500 underline" onClick={() => setPanel('date')}>Change date</button>
                <button type="button" className="font-semibold text-brand-500 underline" onClick={() => setPanel('extras')}>Add seats, meals or baggage</button>
              </>
            )}
            {view.canCancel && <button type="button" className="font-semibold text-clay underline" onClick={() => setCancelling(true)}>Cancel flights</button>}
            <span className="text-slate-600">Name correction or something else? <a className="font-semibold text-brand-500 underline" href={waLink(`Hello, I want to change my flight booking ${view.ref}.`)} target="_blank" rel="noopener noreferrer">WhatsApp us</a>.</span>
          </div>
        )}
        {panel === 'date' && <ChangeDatePanel view={view} token={token} onDone={() => { setPanel(null); onReload() }} />}
        {panel === 'extras' && <AddonsPanel view={view} token={token} onDone={() => { setPanel(null); onReload() }} />}
        {panel && <button type="button" className="font-semibold text-slate-600 underline print:hidden" onClick={() => setPanel(null)}>Close</button>}
        {cancelling && <CancelPanel view={view} token={token} onDone={onReload} />}
      </div>
    </FlightPage>
  )
}

export default function FlightManage() {
  const { ref } = useParams()
  const [params] = useSearchParams()
  const token = params.get('t')
  const [view, setView] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api(`bookings/${ref}?t=${encodeURIComponent(token || '')}`).then(setView).catch((e) => setError(e.message))
  }, [ref, token])

  useEffect(() => { if (ref && token) load() }, [load, ref, token])

  // While ticketing or a cancellation is in progress, refresh every 8 s.
  useEffect(() => {
    if (!view?.working && view?.status !== 'AWAITING_PAYMENT') return
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [view, load])

  if (!ref || !token) return <Lookup />
  if (error) {
    return (
      <FlightPage eyebrow="Manage booking" title="We couldn’t open this booking">
        <Alert tone="error">{error}</Alert>
        <Link to="/flights/booking" className="btn btn-brand mt-6">Find it by reference</Link>
      </FlightPage>
    )
  }
  if (!view) return <FlightPage><Spinner label="Loading your booking" /></FlightPage>
  return <BookingView view={view} token={token} onReload={load} />
}
