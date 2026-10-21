/* ============================================================
   SEO — single source of truth for every route's metadata and
   structured data. Used by the running app (App.jsx sets the tags
   on navigation) AND by the build-time pre-renderer
   (scripts/prerender.mjs), which bakes the same tags into each
   route's static HTML for crawlers that don't run JavaScript
   (most AI/answer engines and link-preview bots).
   ============================================================ */
import { BIZ, FAQS } from './data/site.js'
import { UMRAH_FAQS } from './data/umrah.js'

/** FAQs that are visible on a page get matching FAQPage structured data. */
const PAGE_FAQS = { '/': FAQS, '/umrah': UMRAH_FAQS }

export const SITE = 'https://www.protoursandtravelsolutions.com'
export const OG_IMAGE = `${SITE}/og-image.jpg`

/** Route → [title, description, breadcrumb label]. Keep titles ≲ 60 chars
    and descriptions ≲ 160 chars so search results don't truncate them. */
export const ROUTES = {
  '/': ['Pro Tours & Travel Solutions | Travel Agency in Bengaluru', 'A Bengaluru travel agency since 2009 and IATA-accredited agent: flights, hotels, visas, passports, tour packages, Hajj & Umrah, and visa & insurance consultancy. Hospital Road, Shivaji Nagar.', 'Home'],
  '/services': ['Travel Services in Bengaluru: Flights, Hotels, Visas | Pro Tours', 'Flight and hotel booking, tailor-made and group tours, visa and passport consultancy, and Umrah, handled by one desk in Shivaji Nagar, Bengaluru.', 'Services'],
  '/packages': ['Tour Packages from Bengaluru: Dubai, Bali, Maldives | Pro Tours', 'Economy, Deluxe and Premium holiday packages from Bengaluru with inclusions and exclusions listed. Dubai, Maldives, Bali, Europe, Kerala, Kashmir and more.', 'Tour packages'],
  '/flights': ['Book Flights Online from Bengaluru | Pro Tours', 'Live fares on IndiGo, Air India, Akasa, Emirates, Qatar and more. Pick seats, meals and baggage, pay securely and get your e-ticket instantly.', 'Book flights'],
  '/flights-hotels': ['Flight & Hotel Booking in Bengaluru | Pro Tours', 'Domestic and international air tickets and hotel bookings from Bengaluru, with fare rules explained and confirmed vouchers before you travel.', 'Flights & hotels'],
  '/umrah': ['Umrah Packages from Bengaluru | Pro Tours Hajj & Umrah', 'Umrah visa, flights and hotels near the Haram from Bengaluru, with walking distances quoted in metres, group co-ordinators and Ziyarat tours.', 'Hajj & Umrah'],
  '/visa': ['Visa Assistance in Bengaluru for Indian Passports | Pro Tours', 'Search visa rules for Indian passport holders and get your file checked before it goes in. Passport fresh, renewal and tatkal help in Bengaluru.', 'Visa & passport'],
  '/contact': ['Contact Pro Tours & Travel Solutions, Shivaji Nagar, Bengaluru', 'Visit us at A.M. Plaza, Hospital Road, Shivaji Nagar, Bengaluru 560001. Call +91 99005 17604, WhatsApp or walk in, Monday to Saturday 10 AM to 8 PM.', 'Contact'],
  '/about': ['About Pro Tours & Travel Solutions | Bengaluru since 2009', 'A travel desk on Hospital Road, Bengaluru, booking flights, holidays, visas and Umrah since 2009. IATA-accredited travel agent.', 'About'],
  '/terms': ['Terms & Conditions | Pro Tours & Travel Solutions', 'Terms and conditions for bookings made with Pro Tours & Travel Solutions, Bengaluru.', 'Terms & conditions'],
  '/privacy': ['Privacy Policy | Pro Tours & Travel Solutions', 'How Pro Tours & Travel Solutions collects, uses and protects your personal data, and how to exercise your rights under India\'s DPDP Act.', 'Privacy policy'],
  '/refund-policy': ['Cancellation & Refund Policy | Pro Tours & Travel Solutions', 'Cancellation charges and refund timelines for flights, hotels, tour packages, visas and Umrah booked with Pro Tours & Travel Solutions.', 'Cancellation & refunds'],
  '/disclaimer': ['Disclaimer | Pro Tours & Travel Solutions', 'Important information about visas, Hajj & Umrah, supplier terms and the accuracy of information on this website.', 'Disclaimer'],
}

export const NOT_FOUND = ['Page not found | Pro Tours & Travel Solutions', 'This page does not exist. Find flights, holidays, visas and Umrah from our Bengaluru travel desk.']

/* Booking pages under /flights/… are private (noindex) but still get a sensible tab title. */
const FLIGHT_PRIVATE = ['Your flight booking | Pro Tours & Travel Solutions', 'Complete or manage your flight booking with Pro Tours & Travel Solutions, Bengaluru.']

export const metaFor = (path) => ROUTES[path] || (path.startsWith('/flights/') ? FLIGHT_PRIVATE : NOT_FOUND)
export const canonicalFor = (path) => `${SITE}${path === '/' ? '/' : path}`

/* ---------- Structured data ---------- */

const agency = {
  '@type': 'TravelAgency',
  '@id': `${SITE}/#agency`,
  name: BIZ.name,
  url: `${SITE}/`,
  logo: `${SITE}/logo.png`,
  image: OG_IMAGE,
  telephone: '+91-99005-17604',
  email: BIZ.email2,
  foundingDate: String(BIZ.since),
  priceRange: 'On request',
  address: {
    '@type': 'PostalAddress',
    streetAddress: '21/1, G-2 Plain Street, A.M. Plaza, Ground Floor, Hospital Road, Near Infantry Road',
    addressLocality: 'Bengaluru',
    addressRegion: 'Karnataka',
    postalCode: '560001',
    addressCountry: 'IN',
  },
  areaServed: [{ '@type': 'City', name: 'Bengaluru' }, { '@type': 'State', name: 'Karnataka' }, { '@type': 'Country', name: 'India' }],
  openingHoursSpecification: [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    opens: '10:00',
    closes: '20:00',
  }],
  knowsAbout: ['Flight booking', 'Hotel booking', 'Tour packages', 'Visa consultancy', 'Passport assistance', 'Travel insurance advice', 'Umrah', 'Hajj'],
  sameAs: [BIZ.instagram],
}

const website = {
  '@type': 'WebSite',
  '@id': `${SITE}/#website`,
  url: `${SITE}/`,
  name: BIZ.name,
  inLanguage: 'en-IN',
  publisher: { '@id': `${SITE}/#agency` },
}

const faqPage = (items) => ({
  '@type': 'FAQPage',
  mainEntity: items.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
})

/** Every page gets the agency + site graph; inner pages add a breadcrumb;
    pages that show FAQs on screen add a matching FAQPage. */
export function jsonLdFor(path, { faqs } = {}) {
  const [title, desc, label] = metaFor(path)
  const graph = [agency, website, {
    '@type': 'WebPage',
    '@id': `${canonicalFor(path)}#webpage`,
    url: canonicalFor(path),
    name: title,
    description: desc,
    isPartOf: { '@id': `${SITE}/#website` },
    about: { '@id': `${SITE}/#agency` },
    inLanguage: 'en-IN',
  }]
  if (path !== '/' && ROUTES[path]) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: label, item: canonicalFor(path) },
      ],
    })
  }
  const pageFaqs = faqs || PAGE_FAQS[path]
  if (pageFaqs?.length) graph.push(faqPage(pageFaqs))
  return { '@context': 'https://schema.org', '@graph': graph }
}
