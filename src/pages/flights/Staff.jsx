import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Download, LogOut } from 'lucide-react'
import { api, money, dayLabel, Alert, Spinner, FlightPage } from './shared.jsx'

/* /flights/staff — the desk's console for flight bookings: what needs a
   human (failed tickets, price rises, refunds to approve), and the TBO logs
   needed for certification. Password = STAFF_PASSWORD on the server; it is
   kept only for this browser tab (sessionStorage). */

const FILTERS = [['ATTENTION', 'Needs attention'], ['TICKETING', 'Ticketing'], ['PAID', 'Paid'], ['CONFIRMED', 'Confirmed'], ['CHANGES', 'Changes'], ['CANCELLING', 'Cancelling'], ['CANCELLED', 'Cancelled'], ['AWAITING_PAYMENT', 'Awaiting payment'], ['RESOLVED', 'Closed'], ['', 'All']]
const KEY = 'pt-staff'
const readKey = () => { try { return sessionStorage.getItem(KEY) || '' } catch { return '' } }

function Login({ onLogin }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    try {
      await api('staff/bookings?status=ATTENTION', { staff: pw })
      try { sessionStorage.setItem(KEY, pw) } catch { /* storage blocked: keep in memory */ }
      onLogin(pw)
    } catch (err) { setError(err.message) }
  }
  return (
    <FlightPage eyebrow="Staff" title="Flight bookings desk">
      <form onSubmit={submit} className="max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
        <label htmlFor="st-pw" className="block font-display font-bold text-navy-900">Staff password</label>
        <input id="st-pw" type="password" className="field" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
        {error && <Alert tone="error">{error}</Alert>}
        <button className="btn btn-brand w-full">Open</button>
      </form>
    </FlightPage>
  )
}

function Detail({ id, staff, onChanged }) {
  const [b, setB] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState({ leg: 0, pnr: '', tickets: '' })
  const [refund, setRefund] = useState({ amount: '', reason: '', key: '' })
  const [amounts, setAmounts] = useState({})

  const load = useCallback(() => api(`staff/bookings/${id}`, { staff }).then(setB).catch((e) => setMsg({ tone: 'error', text: e.message })), [id, staff])
  useEffect(() => { setB(null); setMsg(null); load() }, [load])

  const act = async (path, body, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true); setMsg(null)
    try {
      await api(path, { method: 'POST', body: body || {}, staff })
      setMsg({ tone: 'ok', text: 'Done.' })
      await load(); onChanged()
      return true
    } catch (e) { setMsg({ tone: 'error', text: e.message }); return false } finally { setBusy(false) }
  }

  const downloadLogs = async () => {
    const logs = await api(`staff/bookings/${id}/logs`, { staff })
    const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `tbo-logs-${b.ref}.json` })
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!b) return <div className="rounded-2xl bg-white p-6"><Spinner /></div>
  const lead = b.pax?.[0]
  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 text-[0.95rem]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[1.3rem] font-extrabold text-ink">{b.ref} · {b.status}</h2>
        <span>{money(b.amount)} · payment {b.payment || '—'}</span>
      </div>
      {b.attention && <Alert>{b.attention}</Alert>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="font-display font-bold text-ink">Customer</h3>
          {lead ? <p>{lead.title} {lead.firstName} {lead.lastName}</p> : <p>—</p>}
          {b.contact && <p><a className="text-brand-500 underline" href={`tel:+91${b.contact.phone}`}>+91 {b.contact.phone}</a> · <a className="text-brand-500 underline" href={`mailto:${b.contact.email}`}>{b.contact.email}</a></p>}
          <p className="text-slate-500">{(b.pax || []).length} traveller(s) · TraceId {b.traceId}</p>
        </div>
        <div className="flex flex-wrap content-start gap-2">
          <button type="button" className="btn btn-ghost !px-3 !py-1.5 !text-[0.9rem]" disabled={busy} onClick={() => act(`staff/bookings/${id}/reconcile`)}><RefreshCw size={14} /> Check with TBO now</button>
          <button type="button" className="btn btn-ghost !px-3 !py-1.5 !text-[0.9rem]" onClick={downloadLogs}><Download size={14} /> TBO logs (JSON)</button>
        </div>
      </div>

      {b.legs.map((l, i) => (
        <div key={i} className="rounded-xl bg-sand p-4">
          <p className="font-display font-bold text-ink">Leg {i + 1} ({l.key}) · {l.lcc ? 'LCC' : 'GDS/full-service'} · {l.status}{l.manual ? ' (manual)' : ''}</p>
          <p>{l.card?.trips.map((t) => `${t.from}→${t.to} ${dayLabel(t.dep)} ${t.segments.map((s) => s.flight).join('/')}`).join(' · ')}</p>
          <p>PNR {l.pnr || '—'} · TBO BookingId {l.bookingId || '—'}</p>
          {l.error && <p className="text-clay">{l.error}</p>}
          {l.tickets?.length > 0 && <p className="text-slate-600">Tickets: {l.tickets.map((t) => `${t.name} ${t.number || '—'}${t.cancelled ? ' (cancelled)' : ''}`).join(', ')}</p>}
          {l.changeRequests?.length > 0 && <p className="text-slate-600">Change requests: {l.changeRequests.map((c) => `#${c.id} status ${c.status}${c.refunded != null ? ` refunded ${money(c.refunded)}` : ''}`).join(', ')}</p>}
          {b.status === 'ATTENTION' && l.bookingId && l.status !== 'TICKETED' && (
            <button type="button" className="mt-2 text-[0.9rem] font-semibold text-clay underline" disabled={busy} onClick={() => act(`staff/bookings/${id}/release`, { leg: i }, `Release PNR ${l.pnr}? The seats go back to the airline.`)}>Release this held PNR</button>
          )}
        </div>
      ))}

      {b.status === 'ATTENTION' && (
        <div className="space-y-3 rounded-xl border border-slate-200 p-4">
          <h3 className="font-display font-bold text-ink">Fix it</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-brand !px-4 !py-2 !text-[0.92rem]" disabled={busy} onClick={() => act(`staff/bookings/${id}/retry`, {}, 'Try ticketing again with TBO?')}>Retry ticketing</button>
            <button type="button" className="btn btn-gold !px-4 !py-2 !text-[0.92rem]" disabled={busy} onClick={() => act(`staff/bookings/${id}/retry`, { acceptIncrease: true }, 'Ticket even if the fare went up? Collect the difference from the customer separately.')}>Retry and accept a higher fare</button>
          </div>
          <p className="text-[0.85rem] text-slate-500">Retry only works within ~15 minutes of the customer’s search. After that, book it on the TBO portal and record it below.</p>
          <form className="grid gap-2 sm:grid-cols-[6rem_8rem_1fr_auto]" onSubmit={(e) => { e.preventDefault(); act(`staff/bookings/${id}/ticketed`, { leg: Number(manual.leg), pnr: manual.pnr, tickets: manual.tickets.split(',').map((s) => s.trim()) }, 'Mark this leg as ticketed by hand?') }}>
            <select className="field !py-2" aria-label="Leg" value={manual.leg} onChange={(e) => setManual({ ...manual, leg: e.target.value })}>{b.legs.map((_, i) => <option key={i} value={i}>Leg {i + 1}</option>)}</select>
            <input className="field !py-2" placeholder="PNR" aria-label="PNR" value={manual.pnr} onChange={(e) => setManual({ ...manual, pnr: e.target.value })} />
            <input className="field !py-2" placeholder="Ticket numbers, comma separated, traveller order" aria-label="Ticket numbers" value={manual.tickets} onChange={(e) => setManual({ ...manual, tickets: e.target.value })} />
            <button className="btn btn-ghost !px-4 !py-2 !text-[0.92rem]" disabled={busy}>Mark ticketed</button>
          </form>
          <button type="button" className="text-[0.9rem] font-semibold text-slate-600 underline" disabled={busy} onClick={() => { const note = window.prompt('Note for the record (what was done):'); if (note != null) act(`staff/bookings/${id}/resolve`, { note }) }}>Close as resolved</button>
        </div>
      )}

      {b.changes?.length > 0 && (
        <div className="space-y-3 rounded-xl border border-slate-200 p-4">
          <h3 className="font-display font-bold text-ink">Changes after ticketing</h3>
          {b.changes.map((c) => (
            <div key={c.id} className="rounded-lg bg-sand p-3">
              <p><b className="text-ink">{c.kind === 'reissue' ? 'Date change' : 'Extras'}</b> · leg {c.leg + 1} · <b>{c.status}</b> · {money(c.amount_paise)} · payment {c.rzp_payment_id || '—'}{c.attempted_at ? ` · sent to TBO ${new Date(c.attempted_at).toLocaleString('en-IN')}` : ''}</p>
              {c.kind === 'reissue' && c.summary?.card && <p className="text-slate-600">New: {c.summary.card.trips.map((t) => `${t.from}→${t.to} ${dayLabel(t.dep)} ${t.segments.map((s) => s.flight).join('/')}`).join(', ')}</p>}
              {c.kind === 'addons' && c.summary?.items && <p className="text-slate-600">{c.summary.items.map((i) => `${i.pax}: ${i.label}`).join('; ')}</p>}
              {c.result?.bookingId && <p className="text-slate-600">New TBO BookingId {c.result.bookingId}</p>}
              {c.attention && <p className="text-clay">{c.attention}</p>}
              {c.status === 'ATTENTION' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-ghost !px-3 !py-1.5 !text-[0.88rem]" disabled={busy} onClick={() => { const note = window.prompt('What was done on the TBO portal (new PNR / booking id)?'); if (note != null) act(`staff/changes/${c.id}/resolve`, { note, done: true }) }}>Done by hand</button>
                  <button type="button" className="btn btn-ghost !px-3 !py-1.5 !text-[0.88rem]" disabled={busy} onClick={() => act(`staff/changes/${c.id}/resolve`, { note: 'Not made — refund proposed', refund: true }, 'Close as not made and propose a full refund of this payment? You approve the refund below.')}>Not made — refund</button>
                  <button type="button" className="text-[0.88rem] font-semibold text-slate-600 underline" disabled={busy} onClick={() => { const note = window.prompt('Note for the record:'); if (note != null) act(`staff/changes/${c.id}/resolve`, { note }) }}>Close without refund</button>
                </div>
              )}
            </div>
          ))}
          <p className="text-[0.82rem] text-slate-500">A change that was sent to TBO but never confirmed keeps the booking locked (no online cancel) until you close it here — check the TBO portal first.</p>
        </div>
      )}

      <div className="space-y-3 rounded-xl border border-slate-200 p-4">
        <h3 className="font-display font-bold text-ink">Refunds · {money(b.refundable)} still refundable</h3>
        {b.refunds.length === 0 && <p className="text-slate-500">None yet.</p>}
        {b.refunds.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">{r.reason}{r.payment_id ? ' (change payment)' : ''} · <b>{r.status}</b>{r.error ? <span className="text-clay"> · {r.error}</span> : ''}{r.rzp_refund_id ? ` · ${r.rzp_refund_id}` : ''}</span>
            {['pending', 'failed'].includes(r.status) ? (
              <>
                <input className="field !w-32 !py-1.5" aria-label="Refund amount in rupees" inputMode="decimal" value={amounts[r.id] ?? r.amount_paise / 100} onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value })} />
                <button type="button" className="btn btn-brand !px-3 !py-1.5 !text-[0.9rem]" disabled={busy} onClick={() => act(`staff/refunds/${r.id}/approve`, { amount: Math.round(Number(amounts[r.id] ?? r.amount_paise / 100) * 100) }, `Refund ₹${amounts[r.id] ?? r.amount_paise / 100} to the customer's original payment method?`)}>Approve refund</button>
              </>
            ) : <span>{money(r.amount_paise)}</span>}
          </div>
        ))}
        {b.payment && b.refundable > 0 && (
          <form className="grid gap-2 sm:grid-cols-[8rem_1fr_auto]" onSubmit={(e) => { e.preventDefault(); act(`staff/bookings/${id}/refund`, { amount: Math.round(Number(refund.amount) * 100), reason: refund.reason, idemKey: refund.key || (refund.key = crypto.randomUUID()) }, `Refund ₹${refund.amount} now?`).then((ok) => ok && setRefund({ amount: '', reason: '', key: '' })) }}>
            <input className="field !py-2" placeholder="₹ amount" aria-label="New refund amount in rupees" inputMode="decimal" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} required />
            <input className="field !py-2" placeholder="Reason (e.g. ticketing failed, customer agreed)" aria-label="Refund reason" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} required />
            <button className="btn btn-ghost !px-4 !py-2 !text-[0.92rem]" disabled={busy}>New refund</button>
          </form>
        )}
      </div>

      <details>
        <summary className="cursor-pointer font-semibold text-ink">History ({b.events.length})</summary>
        <ol className="mt-2 space-y-1 font-mono text-[0.8rem]">
          {b.events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleString('en-IN')} · {e.type} {e.data ? JSON.stringify(e.data) : ''}</li>)}
        </ol>
      </details>
    </div>
  )
}

export default function FlightStaff() {
  const [staff, setStaff] = useState('')
  const [filter, setFilter] = useState('ATTENTION')
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)
  const [balance, setBalance] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => { setStaff(readKey()) }, [])

  const load = useCallback(() => {
    if (!staff) return
    api(`staff/bookings${filter ? `?status=${filter}` : ''}`, { staff }).then(setRows).catch((e) => {
      setError(e.message)
      if (e.status === 401) { setStaff(''); try { sessionStorage.removeItem(KEY) } catch { /* ignore */ } }
    })
  }, [staff, filter])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (staff) api('staff/balance', { staff }).then(setBalance).catch(() => {}) }, [staff])

  if (!staff) return <Login onLogin={setStaff} />
  return (
    <FlightPage eyebrow="Staff" title="Flight bookings desk">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map(([k, t]) => (
            <button key={k} type="button" onClick={() => { setFilter(k); setOpen(null) }} className={`rounded-lg px-3 py-1.5 text-[0.9rem] font-semibold ${filter === k ? 'bg-navy-950 text-white' : 'bg-white text-slate-600'}`}>{t}</button>
          ))}
        </div>
        <div className="flex items-center gap-4 text-[0.92rem]">
          {balance && !balance.error && <span>TBO wallet: <b>₹{Number(balance.cash).toLocaleString('en-IN')}</b>{balance.credit ? ` · credit ₹${Number(balance.credit).toLocaleString('en-IN')}` : ''}</span>}
          <button type="button" className="inline-flex items-center gap-1 text-slate-600 hover:text-ink" onClick={load}><RefreshCw size={15} /> Refresh</button>
          <button type="button" className="inline-flex items-center gap-1 text-slate-600 hover:text-ink" onClick={() => { try { sessionStorage.removeItem(KEY) } catch { /* ignore */ } setStaff('') }}><LogOut size={15} /> Sign out</button>
        </div>
      </div>
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {!rows ? <div className="p-6"><Spinner /></div> : !rows.length ? <p className="p-6 text-slate-600">Nothing here.</p> : (
            <ul className="divide-y divide-slate-200">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(r.id)} className={`w-full px-4 py-3 text-left hover:bg-sand ${open === r.id ? 'bg-sand' : ''}`}>
                    <div className="flex justify-between gap-3">
                      <b className="text-ink">{r.ref}</b>
                      <span className="text-[0.85rem]">{r.status}{r.refunds_waiting ? ` · ${r.refunds_waiting} refund(s) to approve` : ''}{r.changes_waiting ? ` · ${r.changes_waiting} change(s) open` : ''}</span>
                    </div>
                    <div className="text-[0.88rem] text-slate-600">
                      {r.lead ? `${r.lead.firstName} ${r.lead.lastName} · ` : ''}{r.search.segments.map((g) => `${g.from}→${g.to}`).join(', ')} · {dayLabel(r.search.segments[0].date)} · {money(r.amount_paise)}
                    </div>
                    {r.attention && <div className="mt-1 truncate text-[0.85rem] text-clay">{r.attention}</div>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>{open ? <Detail id={open} staff={staff} onChanged={load} /> : <p className="rounded-2xl bg-white p-6 text-slate-600">Pick a booking to see details and actions.</p>}</div>
      </div>
    </FlightPage>
  )
}
