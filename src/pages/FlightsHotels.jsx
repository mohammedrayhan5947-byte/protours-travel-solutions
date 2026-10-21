import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import { Plane, BedDouble, MessageCircle } from 'lucide-react'

import { BIZ, SERVICES, waLink } from '../data/site.js'
import { Reveal, SectionHeading, PageHero, Parallax, SplitHeading } from '../components/ui.jsx'
import { ImageReveal, FlightPath, Polaroid, Stamp } from '../components/fx.jsx'
import EnquiryForm from '../components/EnquiryForm.jsx'
import { useHashScroll } from '../components/SmoothScroll.jsx'
import { gsap, useGSAP, reduceMotion, enterTrigger, EASE as GSAP_EASE } from '../lib/gsap.js'
import { photo } from '../lib/img.js'

const flights = SERVICES.find((s) => s.id === 'flights')
const hotels = SERVICES.find((s) => s.id === 'hotels')

/* Responsive sources, computed once. Section photos fill half the
   container on desktop (the hotel one ~78% of that half). */
const FLIGHT_IMG = photo(flights.img, { sizes: '(min-width: 1280px) 600px, (min-width: 1024px) 46vw, 100vw', widths: [480, 768, 1080, 1440] })
const HOTEL_IMG = photo(hotels.img, { sizes: '(min-width: 1280px) 470px, (min-width: 1024px) 36vw, (min-width: 640px) 78vw, 100vw', widths: [480, 768, 1080, 1440] })
const WHY_BG = photo('https://images.unsplash.com/photo-1530521954074-e64f6810b32d?auto=format&fit=crop&w=1800&q=70', { sizes: '100vw', widths: [768, 1080, 1440, 1920] })

const WHY = [
  ['Fares compared first', 'Every major carrier out of Bengaluru, checked across GDS and airline-direct inventory before we quote you.'],
  ['Group fares held', 'Ten or more passengers travelling together get fares held on request, not re-priced every time someone confirms.'],
  ['Confirmed vouchers', 'Hotel vouchers issued before you fly, never “on request” once you have paid.'],
  ['Free-cancellation options', 'When your dates aren’t fixed yet, we book rooms that let you change your mind without a penalty.'],
  ['Help while you travel', 'Date changes, delays and hotel issues handled on WhatsApp while you are on the road.'],
]

// Quick picks for the "To" field — airport codes only, no carrier names.
const CODES = [
  ['DXB', 'Dubai'], ['SIN', 'Singapore'], ['LHR', 'London'], ['CDG', 'Paris'],
  ['DPS', 'Bali'], ['MLE', 'Malé'], ['HKT', 'Phuket'], ['JED', 'Jeddah'],
  ['MED', 'Madinah'], ['KUL', 'Kuala Lumpur'], ['IST', 'Istanbul'], ['ZRH', 'Zurich'],
]

const CABINS = ['Economy', 'Premium economy', 'Business']
const PAX = ['1 adult', '2 adults', '3 adults', '4 adults', '2 adults + children', 'Group (10+)']

const EASE = [0.16, 1, 0.3, 1]

/* Boarding-pass shape: notches punched top and bottom where the stub
   tears off (side-by-side on md+, stacked below that). */
const PASS_CSS = `
@media (min-width: 768px) {
  .fh-pass {
    --stub: 16rem;
    -webkit-mask:
      radial-gradient(circle 13px at calc(100% - var(--stub)) 0, #0000 97%, #000) ,
      radial-gradient(circle 13px at calc(100% - var(--stub)) 100%, #0000 97%, #000);
    -webkit-mask-composite: source-in;
            mask:
      radial-gradient(circle 13px at calc(100% - var(--stub)) 0, #0000 97%, #000) ,
      radial-gradient(circle 13px at calc(100% - var(--stub)) 100%, #0000 97%, #000);
            mask-composite: intersect;
  }
}
.fh-barcode {
  background: repeating-linear-gradient(90deg,
    var(--color-navy-950) 0 2px, transparent 2px 4px,
    var(--color-navy-950) 4px 5px, transparent 5px 8px,
    var(--color-navy-950) 8px 11px, transparent 11px 12px,
    var(--color-navy-950) 12px 13px, transparent 13px 17px);
}
`

const fmtDate = (v) => {
  if (!v) return ''
  const d = new Date(`${v}T00:00:00`)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

const codeFor = (text, fallback = 'TBC') => {
  const t = text.trim()
  if (!t) return fallback
  const hit = CODES.find(([c, city]) => t.toUpperCase().includes(c) || city.toLowerCase() === t.toLowerCase())
  if (hit) return hit[0]
  if (/bengaluru|bangalore|blr/i.test(t)) return 'BLR'
  return t.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || fallback
}

/* Ticket lands like it was slid across a counter: rises, un-tilts. */
function useSlideIn(ref, { rotate = -2.5, y = 70, x = 0 } = {}) {
  useGSAP(() => {
    const el = ref.current
    if (!el || reduceMotion()) return
    gsap.fromTo(el, { autoAlpha: 0, y, x, rotation: rotate }, {
      autoAlpha: 1, y: 0, x: 0, rotation: 0, duration: 1.1, ease: 'expo.out',
      scrollTrigger: enterTrigger(el, { start: 'top 88%' }),
      onComplete: () => gsap.set(el, { clearProps: 'transform' }),
    })
  }, { scope: ref })
}

/* ============================================================
   RoutePass — "tell us your route". Not a flight search: it only
   writes a WhatsApp message for the desk to answer.
   ============================================================ */
function RoutePass() {
  const card = useRef(null)
  const route = useRef(null)
  const first = useRef(true)
  const [f, setF] = useState({
    from: 'Bengaluru (BLR)', to: '', depart: '', ret: '', pax: PAX[0], cabin: CABINS[0], hotel: false,
  })
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const fromCode = codeFor(f.from, 'BLR')
  const toCode = codeFor(f.to)
  // Today's date is read on the client only: a value baked in at pre-render
  // time would be stale (and mismatch hydration) by the time anyone visits.
  const [today, setToday] = useState('')
  useEffect(() => { setToday(new Date().toISOString().slice(0, 10)) }, [])

  useSlideIn(card)

  // The route draws once on arrival, then re-draws whenever the destination changes.
  useGSAP(() => {
    const p = route.current
    if (!p) return
    if (reduceMotion()) { gsap.set(p, { drawSVG: '100%' }); return }
    if (first.current) {
      first.current = false
      gsap.fromTo(p, { drawSVG: '0%' }, {
        drawSVG: '100%', duration: 1.4, delay: 0.4, ease: 'power2.inOut',
        scrollTrigger: enterTrigger(card.current, { start: 'top 80%' }),
      })
    } else {
      gsap.fromTo(p, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.8, ease: 'power2.inOut' })
    }
  }, { dependencies: [toCode], scope: card })

  const msg = [
    'Hello Pro Tours & Travel Solutions, please check flights for me.',
    `From: ${f.from || 'Bengaluru (BLR)'}`,
    `To: ${f.to || '(not decided yet)'}`,
    `Depart: ${fmtDate(f.depart) || 'flexible'}`,
    `Return: ${fmtDate(f.ret) || 'one-way / not fixed'}`,
    `Travellers: ${f.pax}`,
    `Cabin: ${f.cabin}`,
    `Hotel needed too: ${f.hotel ? 'Yes' : 'No'}`,
  ].join('\n')

  const label = 'mb-1.5 block font-display text-[0.7rem] font-bold tracking-[0.2em] text-slate-500 uppercase'

  return (
    <div ref={card} className="fh-pass relative grid overflow-hidden rounded-2xl border border-slate-200 bg-white md:grid-cols-[1fr_16rem]">
      {/* ---- Main half ---- */}
      <div className="p-5 sm:p-8">
        <div className="flex items-center justify-between gap-4 border-b border-dashed border-slate-300 pb-4">
          <span className="font-display text-[0.74rem] font-extrabold tracking-[0.24em] text-navy-900 uppercase">Boarding pass · draft</span>
          <span className="note text-[1.02rem] text-gold-600">fill in what you know</span>
        </div>

        {/* Big codes with the route between them */}
        <div className="mt-6 grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-5">
          <div>
            <span className="block font-display text-[2.4rem] leading-none font-black tracking-tight text-ink sm:text-[3.2rem]">{fromCode}</span>
            <span className="mt-1 block text-[0.85rem] text-slate-500">From</span>
          </div>
          <svg viewBox="0 0 220 60" aria-hidden="true" fill="none" className="h-12 w-full overflow-visible sm:h-14">
            <path d="M6 48 C 60 4, 160 4, 214 48" stroke="rgb(4 24 44 / 0.15)" strokeWidth="1.5" strokeDasharray="2 7" strokeLinecap="round" />
            <path ref={route} d="M6 48 C 60 4, 160 4, 214 48" stroke="#0f5e9e" strokeWidth="2" strokeLinecap="round" />
            <circle cx="6" cy="48" r="3.5" fill="#0f5e9e" />
            <circle cx="214" cy="48" r="3.5" fill="#e8a317" />
            <g transform="translate(98 2) rotate(45 12 12)">
              <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" fill="#04182c" />
            </g>
          </svg>
          <div className="text-right">
            <span className="relative inline-grid overflow-hidden font-display text-[2.4rem] leading-none font-black tracking-tight text-ink sm:text-[3.2rem]">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={toCode}
                  initial={{ y: '100%', opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: '-100%', opacity: 0 }}
                  transition={{ duration: 0.45, ease: EASE }}
                  className={toCode === 'TBC' ? 'text-slate-300' : ''}
                >
                  {toCode}
                </motion.span>
              </AnimatePresence>
            </span>
            <span className="mt-1 block text-[0.85rem] text-slate-500">To</span>
          </div>
        </div>

        {/* Fields */}
        <div className="mt-7 grid grid-cols-2 gap-3 sm:gap-4">
          <div className="col-span-2 sm:col-span-1">
            <label className={label} htmlFor="rp-from">From</label>
            <input id="rp-from" className="field" value={f.from} onChange={set('from')} autoComplete="off" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={label} htmlFor="rp-to">To</label>
            <input id="rp-to" className="field" value={f.to} onChange={set('to')} placeholder="City or airport" autoComplete="off" />
          </div>
          <div>
            <label className={label} htmlFor="rp-dep">Depart</label>
            <input id="rp-dep" type="date" min={today || undefined} className="field" value={f.depart} onChange={set('depart')} />
          </div>
          <div>
            <label className={label} htmlFor="rp-ret">Return <span className="sr-only sm:not-sr-only tracking-normal normal-case">(optional)</span></label>
            <input id="rp-ret" type="date" min={f.depart || today || undefined} className="field" value={f.ret} onChange={set('ret')} />
          </div>
        </div>

        <div className="mt-5">
          <span className={label} id="rp-picks">Or pick a destination</span>
          <div role="group" aria-labelledby="rp-picks" className="flex flex-wrap gap-1.5">
            {CODES.map(([c, city]) => {
              const on = toCode === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setF((s) => ({ ...s, to: `${city} (${c})` }))}
                  aria-pressed={on}
                  title={city}
                  className={`rounded-md border px-2.5 py-1 font-display text-[0.82rem] font-bold tracking-[0.12em] transition-colors ${
                    on ? 'border-navy-950 bg-navy-950 text-white' : 'border-slate-300 text-slate-600 hover:border-navy-900 hover:text-ink'
                  }`}
                >
                  {c}<span className="sr-only"> {city}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* ---- Stub ---- */}
      <div className="flex flex-col border-t-2 border-dashed border-slate-300 bg-sand/60 p-5 sm:p-8 md:border-t-0 md:border-l-2 md:p-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-1">
          <div>
            <label className={label} htmlFor="rp-pax">Travellers</label>
            <select id="rp-pax" className="field !py-2.5" value={f.pax} onChange={set('pax')}>
              {PAX.map((x) => <option key={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="rp-cabin">Cabin</label>
            <select id="rp-cabin" className="field !py-2.5" value={f.cabin} onChange={set('cabin')}>
              {CABINS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[0.98rem] text-ink">
          <input type="checkbox" checked={f.hotel} onChange={set('hotel')} className="h-5 w-5 accent-brand-500" />
          I need a hotel too
        </label>

        <div className="flex justify-center py-6 md:flex-1 md:items-center md:py-4">
          <Stamp top="Departing" main="Bengaluru" bottom="BLR" tone="navy" rotate={-6} />
        </div>
        <div aria-hidden="true" className="fh-barcode h-10 w-full opacity-80" />
        <p className="mt-1.5 text-center font-display text-[0.66rem] tracking-[0.3em] text-slate-500 uppercase" aria-hidden="true">
          {fromCode} · {toCode} · {f.cabin.split(' ')[0]}
        </p>

        <a
          href={waLink(msg)}
          target="_blank" rel="noopener noreferrer"
          className="btn btn-wa mt-5 w-full"
        >
          <MessageCircle size={18} aria-hidden="true" /> Send on WhatsApp
        </a>
      </div>
    </div>
  )
}

/* Sample hotel voucher — shows what you receive, nothing more. */
function Voucher() {
  const ref = useRef(null)
  useSlideIn(ref, { rotate: 3, y: 50 })
  const row = 'grid grid-cols-[4.6rem_1fr] gap-3 border-t border-dashed border-slate-300 py-2'
  const dt = 'font-display text-[0.68rem] font-bold tracking-[0.18em] text-slate-500 uppercase pt-1'
  return (
    <div ref={ref} className="relative w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-[var(--shadow-lift)]">
      <div className="flex items-start justify-between gap-4 pb-3">
        <div>
          <span className="block font-display text-[0.72rem] font-extrabold tracking-[0.24em] text-navy-900 uppercase">Hotel voucher</span>
          <span className="note text-[1rem] text-slate-500">sample layout</span>
        </div>
        <BedDouble size={20} className="text-brand-500" aria-hidden="true" />
      </div>
      <dl className="text-[0.92rem] leading-snug">
        <div className={row}><dt className={dt}>Guest</dt><dd className="text-ink">Your name, as on the passport</dd></div>
        <div className={row}><dt className={dt}>Hotel</dt><dd className="text-ink">Named property and room type</dd></div>
        <div className={row}><dt className={dt}>Dates</dt><dd className="text-ink">Check-in and check-out</dd></div>
        <div className={row}><dt className={dt}>Meals</dt><dd className="text-ink">As booked</dd></div>
        <div className={`${row} border-b`}><dt className={dt}>Status</dt><dd className="font-display font-bold text-palm">Confirmed</dd></div>
      </dl>
      <Stamp top="Issued" main="Confirmed" bottom="before you fly" tone="palm" rotate={-9} className="absolute right-2 -bottom-14 sm:right-auto sm:-bottom-6 sm:-left-44" />
    </div>
  )
}

/* Tick list: items rise in sequence (same motion as <Stagger>), rendered
   as a real <ul> so it reads as a list. */
function Points({ items }) {
  const ref = useRef(null)
  useGSAP(() => {
    const el = ref.current
    if (!el) return
    const kids = gsap.utils.toArray(el.children)
    if (!kids.length) return
    if (reduceMotion()) { gsap.set(kids, { opacity: 1, y: 0 }); return }
    gsap.fromTo(kids, { opacity: 0, y: 16 }, {
      opacity: 1, y: 0, duration: 0.95, ease: GSAP_EASE, stagger: { each: 0.07 },
      scrollTrigger: enterTrigger(el),
    })
  }, { scope: ref })
  return (
    <ul ref={ref} role="list" className="mt-7 grid gap-3 border-t border-slate-200 pt-6">
      {items.map((x) => (
        <li key={x} className="flex gap-3">
          <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" className="mt-1.5 h-4 w-4 shrink-0">
            <path d="M3 11c2 1.5 3.5 3 4.5 5C10 10 13 6 17.5 3" stroke="#0f5e9e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[1.05rem] text-pretty">{x}</span>
        </li>
      ))}
    </ul>
  )
}

export default function FlightsHotels() {
  // Deep links like /flights-hotels#hotels land on that block.
  useHashScroll()

  return (
    <MotionConfig reducedMotion="user">
      <style>{PASS_CSS}</style>

      <PageHero
        img="https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1800&q=74"
        alt="Aircraft wing above the clouds"
        eyebrow="Flight & hotel booking"
        title="Air tickets and hotel rooms, booked by people you can call"
        sub="Flight booking and hotel reservations from our desk in Bengaluru: fares compared across airlines, rooms confirmed in writing, and the same people on WhatsApp if your plans change."
      >
        <Link to="/flights" className="btn btn-gold">
          <Plane size={18} aria-hidden="true" className="rotate-45" /> Book flights online
        </Link>
      </PageHero>

      {/* ---------- Tell us your route ---------- */}
      <section aria-label="Where are you flying?" className="section paper overflow-x-clip bg-sand">
        <div className="wrap">
          <div className="mb-10 grid gap-6 md:grid-cols-[1.2fr_1fr] md:items-end">
            <SectionHeading
              className="!mb-0"
              eyebrow="Tell us your route"
              title="Where are you flying?"
            />
            <Reveal delay={0.1}>
              <p className="text-[1.08rem] text-pretty md:pb-2">
                Want to book yourself? <Link to="/flights" className="font-semibold text-brand-500 underline decoration-brand-500/30 underline-offset-4 hover:decoration-brand-500">Search live fares and book online</Link>,
                seats and meals included. Prefer us to look? Fill in the pass and it becomes a WhatsApp message to our
                desk; we reply with options. Nothing is booked until you say so.
              </p>
            </Reveal>
          </div>

          <RoutePass />
        </div>
      </section>

      {/* ---------- Flights ---------- */}
      <section id="flights" aria-label="International and domestic flight tickets" className="section scroll-mt-24 overflow-x-clip bg-white">
        <div className="wrap grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div className="relative">
            <ImageReveal from="left" className="relative aspect-[4/3.2] rounded-3xl">
              <Parallax speed={0.12} className="absolute inset-0">
                <img
                  {...FLIGHT_IMG}
                  alt="Aircraft wing above sunlit clouds"
                  width={1080}
                  height={864}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-x-0 -top-[8%] h-[116%] w-full object-cover"
                />
              </Parallax>
            </ImageReveal>
            <div className="absolute -right-3 -bottom-10 hidden w-44 sm:block">
              <Parallax speed={-0.25}>
                <div>
                  <Polaroid src={flights.img2} alt="" caption="window seat, please" rotate={4} imgClassName="aspect-square" />
                </div>
              </Parallax>
            </div>
          </div>

          <div>
            <Reveal>
              <span className="eyebrow">
                <Plane size={15} aria-hidden="true" className="rotate-45" /> Flight booking
              </span>
            </Reveal>
            <SplitHeading className="h-sec mt-4 text-balance">International and domestic flight tickets</SplitHeading>
            <Reveal delay={0.1}>
              <p className="mt-5 text-[1.12rem] text-pretty">{flights.desc}</p>
            </Reveal>
            <Points items={flights.points} />
            <Reveal delay={0.2}>
              <a
                href={waLink('Hello Pro Tours & Travel Solutions, I would like to ask about a flight booking.')}
                target="_blank" rel="noopener noreferrer" className="btn btn-wa mt-8"
              >
                <MessageCircle size={17} aria-hidden="true" /> Ask about flights
              </a>
              <p className="mt-5 text-[1rem] text-pretty">
                Flying abroad? Start the paperwork early with our{' '}
                <Link to="/visa" className="font-semibold text-brand-500 underline decoration-brand-500/30 underline-offset-4 hover:decoration-brand-500">visa assistance</Link>
                , or see{' '}
                <Link to="/umrah" className="font-semibold text-brand-500 underline decoration-brand-500/30 underline-offset-4 hover:decoration-brand-500">Umrah packages from Bengaluru</Link>
                {' '}with flights included.
              </p>
            </Reveal>
          </div>
        </div>

        {/* Route out of Bengaluru, drawn as you scroll — the page's one flight path */}
        <div className="wrap mt-16 md:mt-24">
          <FlightPath
            d="M 40 150 C 280 -10, 560 -10, 760 70 S 1060 170, 1160 40"
            viewBox="0 0 1200 180"
            stroke="rgb(15 94 158 / 0.85)"
            guide="rgb(4 24 44 / 0.16)"
            plane="#04182c"
            start="top 92%"
            end="bottom 45%"
          />
          <div aria-hidden="true" className="mt-3 flex items-center justify-between">
            <span className="flex items-center gap-2 font-display text-[0.78rem] font-bold tracking-[0.22em] text-slate-500 uppercase">
              <span className="h-2 w-2 rounded-full bg-brand-500" /> BLR
            </span>
            <span className="note text-[1.1rem] text-gold-600">wherever you’re headed</span>
          </div>
        </div>
      </section>

      {/* ---------- Hotels ---------- */}
      <section id="hotels" aria-label="Hotels and resorts, confirmed in writing" className="section paper scroll-mt-24 overflow-x-clip bg-sand">
        <div className="wrap grid items-center gap-14 lg:grid-cols-2 lg:gap-16">
          <div>
            <Reveal>
              <span className="eyebrow">
                <BedDouble size={15} aria-hidden="true" /> Hotel booking
              </span>
            </Reveal>
            <SplitHeading className="h-sec mt-4 text-balance">Hotels and resorts, confirmed in writing</SplitHeading>
            <Reveal delay={0.1}>
              <p className="mt-5 text-[1.12rem] text-pretty">{hotels.desc}</p>
            </Reveal>
            <Points items={hotels.points} />
            <Reveal delay={0.2}>
              <a
                href={waLink('Hello Pro Tours & Travel Solutions, I would like to ask about a hotel booking.')}
                target="_blank" rel="noopener noreferrer" className="btn btn-wa mt-8"
              >
                <MessageCircle size={17} aria-hidden="true" /> Ask about hotels
              </a>
              <p className="mt-5 text-[1rem] text-pretty">
                Want flights, hotel and transfers in one booking? Our{' '}
                <Link to="/packages" className="font-semibold text-brand-500 underline decoration-brand-500/30 underline-offset-4 hover:decoration-brand-500">tour packages from Bengaluru</Link>
                {' '}come in Economy, Deluxe and Premium.
              </p>
            </Reveal>
          </div>

          <div className="relative pb-16 sm:pb-0">
            <ImageReveal from="right" className="relative aspect-[4/3.4] rounded-3xl sm:w-[78%]">
              <Parallax speed={0.12} className="absolute inset-0">
                <img
                  {...HOTEL_IMG}
                  alt="Resort pool and sun loungers beside a timber lodge"
                  width={1080}
                  height={918}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-x-0 -top-[8%] h-[116%] w-full object-cover"
                />
              </Parallax>
            </ImageReveal>
            <div className="relative -mt-16 px-4 sm:absolute sm:right-0 sm:-bottom-12 sm:mt-0 sm:w-[18rem] sm:px-0">
              <Voucher />
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Why book both with us ---------- */}
      <section aria-label="What you get booking both with us" className="relative isolate overflow-hidden bg-navy-950 py-20 md:py-28">
        <Parallax speed={0.2} className="absolute inset-0 -z-20 overflow-hidden">
          <img
            {...WHY_BG}
            alt="" aria-hidden="true" width={1920} height={1280} loading="lazy" decoding="async"
            className="absolute inset-x-0 -top-[12%] h-[124%] w-full object-cover opacity-30"
          />
        </Parallax>
        <div className="absolute inset-0 -z-10 bg-navy-950/60" />

        <div className="wrap grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <div>
            <SectionHeading light eyebrow="Why book here" title="What you get booking both with us" className="!mb-6" />
            <Reveal delay={0.15}>
              <p className="note max-w-sm text-[1.2rem] text-white/70">
                Flying somewhere and need a room too? Send both together and we keep the dates in step.
              </p>
            </Reveal>
          </div>
          <ol>
            {WHY.map(([t, d], i) => (
              <li key={t} className="border-t border-white/15 py-6 last:border-b">
                <Reveal delay={i * 0.05} className="grid grid-cols-[2.6rem_1fr] gap-4 sm:grid-cols-[3rem_14rem_1fr] sm:gap-6">
                  <span className="note text-[1.35rem] leading-none text-gold-400">{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="font-display text-[1.15rem] font-bold !text-white">{t}</h3>
                  <p className="col-start-2 text-[1rem] text-white/70 text-pretty sm:col-start-3">{d}</p>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- Form ---------- */}
      <section aria-label="Tell us what you need" className="section bg-white">
        <div className="wrap grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Prefer a form?"
              title="Tell us what you need"
              sub="A few details are enough. We come back with fare and room options that fit your dates."
              className="!mb-6"
            />
            <Reveal delay={0.15}>
              <p className="max-w-md text-[1rem] text-slate-600 text-pretty">
                {BIZ.name} is an IATA-accredited travel agency at A.M. Plaza, Hospital Road, Shivaji Nagar,
                Bengaluru, booking flights and hotels since {BIZ.since}.{' '}
                <Link to="/contact" className="font-semibold text-brand-500 underline decoration-brand-500/30 underline-offset-4 hover:decoration-brand-500">
                  Find our office and hours
                </Link>.
              </p>
            </Reveal>
          </div>
          <Reveal>
            <div className="rounded-2xl border border-slate-200 bg-sand/50 p-6 md:p-9">
              <EnquiryForm defaultService="Flight Booking" />
            </div>
          </Reveal>
        </div>
      </section>
    </MotionConfig>
  )
}
