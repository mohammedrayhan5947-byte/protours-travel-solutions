# Pro Tours & Travel Solutions — website

Marketing website for **Pro Tours & Travel Solutions**, a travel agency at A.M. Plaza, Hospital Road,
Shivaji Nagar, Bengaluru (since 2009, IATA-accredited agent). Live at
<https://www.protoursandtravelsolutions.com>. Created and developed by [naazailabs.com](https://naazailabs.com).

## Stack

- **React 19 + Vite 7**, **Tailwind CSS v4**, **React Router 7**
- **GSAP 3.15** (ScrollTrigger, SplitText, DrawSVG, MotionPath) for scroll-driven motion, **Framer Motion** for UI transitions
- **Build-time pre-rendering** (React `prerenderToNodeStream`) so every route ships as real HTML
- Hosted on **Vercel**; online flight booking (TBO Air API v10 + Razorpay + Neon Postgres) runs as one serverless function, `api/flights.js`

## Commands

```bash
npm install
npm run dev        # dev server on http://localhost:5173
npm run build      # client build + SSR build + pre-render every route into dist/
npm run build:spa  # client build only (no pre-render) — quicker, for debugging
npm run preview    # serve dist/ locally
npm run test:flights  # booking engine + race-condition tests (simulated TBO, in-memory Postgres)
npm run db:migrate    # create/update the flight tables in DATABASE_URL (Neon)
```

## Project structure

```
index.html                 HTML shell. Route-specific <head> tags live between <!--seo:start--> / <!--seo:end-->
vercel.json                Clean URLs, apex→www redirect, security + cache headers (no SPA catch-all: real 404s)
scripts/prerender.mjs      Renders every route to dist/<route>.html, writes 404.html and sitemap.xml
public/                    Static files: logos, icons, og-image.jpg, robots.txt, llms.txt, site.webmanifest
api/flights.js             The one Vercel function for all /api/flights/* calls
server/                    Flight booking engine (not shipped to the browser)
  tbo.js                   TBO Air API v10 client: daily token, timeouts, request/response logs
  flights.js               Search, fare calendar, fare families → compact cards
  bookings.js              ★ Booking state machine: payment, ticketing, recovery, cancellation, refunds
  changes.js               Date change (re-issue) and extras after ticketing (Air Amendment), paid separately
  pricing.js / validate.js Server-side prices + TBO passenger rules (validate.js is shared with the form)
  razorpay.js / db.js      Razorpay REST, Postgres (Neon in prod, PGlite locally)
  api.js                   Router for every /api/flights/* path; staff + cron auth
  flights.test.js          The tests behind `npm run test:flights`
src/
  main.jsx                 Browser entry
  entry-server.jsx         Build-time entry used by the pre-renderer
  App.jsx                  Routes, page transitions, per-route <head> updates on navigation
  seo.js                   ★ Titles, descriptions, canonical URLs and JSON-LD for every route
  index.css                ★ Design tokens (palette, radii, shadows) + component classes
  data/site.js             ★ Business details, services, packages, reviews, FAQs, photo slots
  data/visas.js            Visa rules by country
  lib/gsap.js              GSAP plugin registration + shared easing / reduced-motion helpers
  lib/img.js               photo(url, { sizes }) → responsive srcset for Unsplash images
  components/
    fx.jsx                 Hand-made motion primitives (stamps, polaroids, circled words, flight path, …)
    motion.jsx             Scroll reveals, split headings, parallax, counters
    ui.jsx                 SectionHeading, PageHero, Accordion, Stars
    legal.jsx              Layout for the policy pages
    Navbar / Footer / FloatingActions (mobile contact bar) / EnquiryForm / SmoothScroll
  pages/                   One file per route (Home, Services, Packages, FlightsHotels, Umrah, Visa,
                           About, Contact, Terms, Privacy, RefundPolicy, Disclaimer, NotFound)
```

★ = the files you'll edit most.

## Editing content

- **Phone, email, address, hours** → `BIZ` in `src/data/site.js` (used everywhere, including structured data).
- **Packages, services, FAQs, reviews** → arrays in `src/data/site.js`. Prices are intentionally **not** shown anywhere.
- **Page titles / descriptions for Google** → `ROUTES` in `src/seo.js` (keep titles ≲ 60 and descriptions ≲ 160 characters).
- **Only publish figures the business can confirm** (no invented ratings, traveller counts or success rates).

### Adding the business's own photos

1. Put the files in `public/photos/` (e.g. `office-front.jpg`, ≈1600px wide JPG/WebP).
2. Set the path in `PHOTOS` in `src/data/site.js`, e.g. `office: '/photos/office-front.jpg'`.
3. Rebuild. Every page that shows that slot switches from the stock fallback to the real photo, and
   captions that say "our office" / "our team" only appear once a real photo is set.

## Adding a new page

1. Create `src/pages/MyPage.jsx` (default export).
2. Add a lazy import and `<Route>` in `src/App.jsx`.
3. Add its title, description and breadcrumb label to `ROUTES` in `src/seo.js` — the pre-renderer and sitemap pick it up automatically.
4. Code must be **SSR-safe**: no `window` / `document` / `localStorage` / `matchMedia` during render or at module top level — only in effects and event handlers. `npm run build` fails loudly if a page breaks this.

## Online flight booking (TBO)

Pages: `/flights` (search), `/flights/book/:id` (travellers → seats/meals/baggage → pay),
`/flights/booking/:ref?t=…` (customer's booking: status, PNRs, e-tickets, cancel), `/flights/staff` (desk console).

Flow per TBO's pathway — LCC: Search → FareRule → FareQuote → SSR → **Ticket** → GetBookingDetails;
full-service: … → **Book** (PNR on hold) → Ticket → GetBookingDetails. Cancellation: GetCancellationCharges →
SendChangeRequest → GetChangeRequestStatus. Supported trips: one-way, return (domestic = two PNRs, international = one),
multi-city, special return; plus fare calendar and fare families (FareUpsell).

**Money rules.** The server prices everything from TBO's own responses (`server/pricing.js`): airline published fare
+ add-ons at cost + `FLIGHT_MARKUP_PERCENT` on the fare, rounded up to a rupee. Payment is captured first; the
ticket is issued after. If ticketing fails or the fare rises, the booking goes to **Needs attention** on the staff
page (the customer is told their payment is safe); staff retry, accept the higher fare, book by hand on the TBO
portal and record the PNR, or refund. Cancellation refunds are proposed automatically and paid out when staff
approve them.

**Changes after ticketing** (`server/changes.js`, booking page → "Change date" / "Add seats, meals or baggage"):
date change = TBO re-issue (Search with `SearchType=1` → FareQuote → **TicketReissue**, new BookingId, same PNR);
extras = TBO Air Amendment (SSR by BookingId → TicketReissue with an SSR array per PaxId). Each change is paid with its
own Razorpay order (fare difference + airline re-issue charge + markup on the difference + `FLIGHT_CHANGE_FEE`; extras
at cost). While a change is applied the booking is locked (`CHANGING`), so it can't be cancelled at the same moment;
only one change per booking can be open; a change sent to TBO is never sent twice. Failures go to the staff page with
a refund of that change's payment proposed. **Before go-live, confirm with TBO** the exact TicketReissue request for date
changes and the Search field names (`reissueBody` / `reissueSearchFields` in `server/changes.js`) — TBO's public docs
don't publish them in full.

**Race conditions** are settled by single atomic SQL statements — see the header of `server/bookings.js`. In short:
one payment can only mark one booking paid; exactly one request wins the right to ticket; a Ticket call that times
out is never repeated (GetBookingDetails decides, as TBO requires); a crashed worker is taken over after 330 s;
cancel and refund buttons can't double-fire. `npm run test:flights` proves each of these.

### Setting it up
1. Vercel → Storage → add **Neon** (free) → it sets `DATABASE_URL`. Run `npm run db:migrate` once with it.
2. Add the other env vars from `.env.example` (TBO API login, Razorpay keys + webhook secret, `STAFF_PASSWORD`,
   `CRON_SECRET`, `FLIGHT_MARKUP_PERCENT`). The TBO password goes only into env vars, never into code.
3. Razorpay → Webhooks → `https://www.protoursandtravelsolutions.com/api/flights/razorpay/webhook`, events
   `order.paid` and `payment.captured`.
4. Background jobs: Vercel Hobby runs the cron only once a day, so also add a free external cron
   (e.g. cron-job.org) calling `/api/flights/cron?key=<CRON_SECRET>` every 2–5 minutes.

### Certification with TBO (staging)
Set `ALLOW_FAKE_PAYMENTS=true` and `TBO_LOG_SEARCH=full`, then book the test cases TBO lists (cases 1–5 are
mandatory: GDS domestic one-way 1 adult; LCC domestic one-way 1+1+1 with SSR; LCC domestic return 2+2+1; LCC
international one-way 1+1+1 with SSR; GDS international return 2+2+1) on sectors that work on staging (DEL-BOM,
DEL-BLR, BLR-BOM, DEL-DXB, DEL-BKK). For each booking, staff page → **TBO logs (JSON)** gives the request/response
file TBO asks for. Send one file per case.

### Going live
- TBO only accepts requests from a **whitelisted static IP**. Vercel Hobby has none (Static IPs are a Pro add-on), so
  route TBO calls through a static-IP proxy: `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=…`, and give TBO the proxy's IP.
- Set `TBO_ENV=live`, the live URLs/credentials TBO provides, live Razorpay keys, and `ALLOW_FAKE_PAYMENTS=false`.
- Vercel's Hobby plan is for non-commercial use; a site taking payments should be on Pro.
- Have the business check the updated Terms, Privacy and Refund pages (online-booking sections dated 17 Oct 2026).

## Forms

The enquiry form has no backend on purpose: on submit the fields become a formatted message and WhatsApp
opens pre-filled, so enquiries land straight in the desk's chat and nothing is stored on the site. To
capture leads server-side later (e.g. a Google Sheet or email), replace the `submit` handler in
`src/components/EnquiryForm.jsx` with a `fetch()` to a serverless function — and update the Privacy Policy.

The visa data in `src/data/visas.js` is indicative and hand-maintained; review it regularly.

## Motion & accessibility rules

- Animate only `transform`, `opacity` and `clip-path`. No smooth-scroll libraries, no `touch-action`,
  never `overflow-x` on `<html>` — each of these caused real mobile scroll bugs on this site before.
- Everything respects `prefers-reduced-motion` (see `reduceMotion()` in `src/lib/gsap.js`).
- Stamps and other scaled entrances near page edges must not push the page wider than the viewport.

## Deploying (Vercel)

- Framework preset **Vite**, build command `npm run build`, output directory `dist`.
- Add both `protoursandtravelsolutions.com` and `www.protoursandtravelsolutions.com`; **www is primary**
  (`vercel.json` already 308-redirects the bare domain to www).
- A commercial site should be on the **Pro** plan (Hobby is non-commercial only).
- Env vars: see `.env.example` and "Online flight booking" above
  (never prefix them with `VITE_`; they must stay server-side). See `.env.example`.

## Note on this machine's setup

Windows Application Control blocks Rollup's native binary (`@rollup/rollup-win32-x64-msvc`), which made
`vite dev` and `vite build` fail, so `package.json` overrides Rollup with its official WebAssembly build:
`"overrides": { "rollup": "npm:@rollup/wasm-node@^4.52.4" }`. Same output; remove it on machines
without that policy if you want the (faster) native binary.

## Launch checklist (needs the owner's accounts)

- [ ] Google Search Console (Domain property via DNS TXT) → submit `/sitemap.xml`, request indexing of key pages
- [ ] Bing Webmaster Tools (import from GSC) → submit sitemap (Bing also feeds ChatGPT search / Copilot)
- [ ] Google Business Profile: primary category "Travel agency", services, real photos, weekly posts, reply to reviews
- [ ] Same name/address/phone (NAP) everywhere: GBP, Bing Places, Apple Business Connect, Justdial, Sulekha, IndiaMART, Facebook, TripAdvisor
- [ ] Add those profile URLs to `sameAs` in `src/seo.js`
- [ ] Analytics (optional): Vercel Web Analytics (cookieless) or GA4 + Microsoft Clarity — GA4/Clarity need a consent banner under the DPDP Act
- [ ] Test link previews (WhatsApp / Facebook Sharing Debugger) and Google's Rich Results Test on `/`
