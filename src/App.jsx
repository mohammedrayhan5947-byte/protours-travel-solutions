import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'

import Navbar from './components/Navbar.jsx'
import Footer from './components/Footer.jsx'
import FloatingActions from './components/FloatingActions.jsx'
import SmoothScroll from './components/SmoothScroll.jsx'
import { Preloader } from './components/fx.jsx'
import { metaFor, canonicalFor, ROUTES } from './seo.js'

// Home ships in the main bundle; every other route is code-split so the
// first paint stays small.
import Home from './pages/Home.jsx'
const Services      = lazy(() => import('./pages/Services.jsx'))
const Packages      = lazy(() => import('./pages/Packages.jsx'))
const FlightsHotels = lazy(() => import('./pages/FlightsHotels.jsx'))
const Umrah         = lazy(() => import('./pages/Umrah.jsx'))
const Visa          = lazy(() => import('./pages/Visa.jsx'))
const Contact       = lazy(() => import('./pages/Contact.jsx'))
const About         = lazy(() => import('./pages/About.jsx'))
const Terms         = lazy(() => import('./pages/Terms.jsx'))
const Privacy       = lazy(() => import('./pages/Privacy.jsx'))
const RefundPolicy  = lazy(() => import('./pages/RefundPolicy.jsx'))
const Disclaimer    = lazy(() => import('./pages/Disclaimer.jsx'))
const NotFound      = lazy(() => import('./pages/NotFound.jsx'))
const FlightSearch  = lazy(() => import('./pages/flights/Search.jsx'))
const FlightBook    = lazy(() => import('./pages/flights/Book.jsx'))
const FlightManage  = lazy(() => import('./pages/flights/Manage.jsx'))
const FlightStaff   = lazy(() => import('./pages/flights/Staff.jsx'))

/** True while scripts/prerender.mjs renders pages to static HTML in Node. */
const SSR = typeof window === 'undefined'

/** Lightweight placeholder while a route chunk loads. */
function RouteFallback() {
  return (
    <div className="grid min-h-[70vh] place-items-center bg-white">
      <div className="flex flex-col items-center gap-4">
        <span className="h-11 w-11 animate-spin rounded-full border-[3px] border-slate-200 border-t-brand-500" />
        <span className="font-display text-[0.84rem] font-bold tracking-[0.22em] text-slate-500 uppercase">
          Loading
        </span>
      </div>
    </div>
  )
}

const fade = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
}

/* Keeps <title>, description, canonical and OG tags in step with the route
   during client-side navigation (the pre-renderer bakes the same values
   into each page's static HTML — both read src/seo.js). */
function useRouteMeta(pathname) {
  useEffect(() => {
    const [title, desc] = metaFor(pathname)
    const known = Boolean(ROUTES[pathname])
    document.title = title
    const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val)
    set('meta[name="description"]', 'content', desc)
    set('meta[property="og:title"]', 'content', title)
    set('meta[property="og:description"]', 'content', desc)
    set('meta[property="og:url"]', 'content', canonicalFor(pathname))
    set('meta[name="twitter:title"]', 'content', title)
    set('meta[name="twitter:description"]', 'content', desc)
    set('link[rel="canonical"]', 'href', canonicalFor(known ? pathname : '/'))
    set('meta[name="robots"]', 'content', known ? 'index, follow, max-image-preview:large' : 'noindex, follow')
  }, [pathname])
}

function Page({ children }) {
  // Rendered visible in static HTML (no fade-from-0), animated in the browser.
  return <motion.main id="main" tabIndex={-1} {...fade} initial={SSR ? false : fade.initial}>{children}</motion.main>
}

export default function App() {
  const location = useLocation()
  useRouteMeta(location.pathname)

  return (
    // MotionConfig reducedMotion="user" is Framer Motion's own switch: every
    // animate/whileHover/transition across the app (drawer, page transitions,
    // accordion, floating buttons) auto-respects the OS "reduce motion"
    // setting, without auditing each component individually.
    //
    // SmoothScroll resets scroll on navigation and keeps ScrollTrigger's
    // measurements in sync, which is why ScrollToTop is no longer mounted.
    <MotionConfig reducedMotion="user">
    <SmoothScroll>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-full focus:bg-navy-950 focus:px-5 focus:py-3 focus:font-display focus:font-bold focus:text-white"
      >
        Skip to content
      </a>
      <Preloader />
      <Navbar />
      <AnimatePresence mode="wait">
        <Suspense fallback={<RouteFallback />}>
          <Routes location={location} key={location.pathname}>
            <Route path="/"               element={<Page><Home /></Page>} />
            <Route path="/services"       element={<Page><Services /></Page>} />
            <Route path="/packages"       element={<Page><Packages /></Page>} />
            <Route path="/flights-hotels" element={<Page><FlightsHotels /></Page>} />
            <Route path="/flights"        element={<Page><FlightSearch /></Page>} />
            <Route path="/flights/book/:id" element={<Page><FlightBook /></Page>} />
            <Route path="/flights/booking" element={<Page><FlightManage /></Page>} />
            <Route path="/flights/booking/:ref" element={<Page><FlightManage /></Page>} />
            <Route path="/flights/staff"  element={<Page><FlightStaff /></Page>} />
            <Route path="/umrah"          element={<Page><Umrah /></Page>} />
            <Route path="/visa"           element={<Page><Visa /></Page>} />
            <Route path="/contact"        element={<Page><Contact /></Page>} />
            <Route path="/about"          element={<Page><About /></Page>} />
            <Route path="/terms"          element={<Page><Terms /></Page>} />
            <Route path="/privacy"        element={<Page><Privacy /></Page>} />
            <Route path="/refund-policy"  element={<Page><RefundPolicy /></Page>} />
            <Route path="/disclaimer"     element={<Page><Disclaimer /></Page>} />
            {/* A real 404 (noindex) instead of silently showing Home — search
                engines treat "every URL returns the homepage" as soft 404s. */}
            <Route path="*"               element={<Page><NotFound /></Page>} />
          </Routes>
        </Suspense>
      </AnimatePresence>
      <Footer />
      <FloatingActions />
    </SmoothScroll>
    </MotionConfig>
  )
}
