import { Link } from 'react-router-dom'
import { BIZ } from '../data/site.js'
import { LegalLayout, LegalSection, LegalList, LegalTable, GrievanceContact, legalLink as a } from '../components/legal.jsx'

export default function Privacy() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Privacy Policy"
      updated="17 October 2026"
      intro="This notice tells you, in plain words, what personal data we collect, why, who we share it with, how long we keep it, and how you can see, correct or delete it — or complain if you are unhappy."
    >
      <LegalSection title="1. Who we are">
        <p>
          {BIZ.name} (“we”, “us”) is a travel agency at {BIZ.addressOneLine}, India, run as a sole proprietorship by {BIZ.owner} (Proprietor). We decide why and
          how your personal data is used for our services, so we are the <strong>Data Fiduciary</strong> under
          India’s Digital Personal Data Protection Act, 2023 (and the “controller” under the EU/UK GDPR,
          where it applies). You are the <strong>Data Principal</strong>.
        </p>
        <p>
          This policy covers this website (www.protoursandtravelsolutions.com), including flights booked online
          on it, enquiries you send us on WhatsApp, phone or email, and bookings made at our office.
        </p>
      </LegalSection>

      <LegalSection title="2. The short version">
        <LegalList
          items={[
            'This website has no account sign-up and does not save what you type into our enquiry form. Pressing “send” opens WhatsApp with your message pre-filled; nothing is sent until you press send in WhatsApp.',
            'When you book a flight online, we store the traveller and contact details the airline needs, plus the booking and payment records, so we can issue, change, cancel and refund your tickets (sections 3 and 7).',
            'We only ask for what we need to quote and book your trip, and we only share it with the airline, hotel, embassy or other supplier that needs it.',
            'We do not sell your data, and we do not use it for advertising profiles.',
            'You can ask to see, correct or delete your data, or withdraw consent, at any time by writing to our Grievance Officer (section 11).',
          ]}
        />
      </LegalSection>

      <LegalSection title="3. What we collect and why">
        <p>Each item below is collected only for the purpose shown next to it.</p>
        <LegalTable
          head={['Personal data', 'Why we need it', 'When']}
          rows={[
            ['Name, phone / WhatsApp number, email', 'To reply to your enquiry, send quotes and keep you updated about your booking.', 'When you contact us'],
            ['Trip details — destination, dates, number and ages of travellers, room and meal preferences', 'To prepare an accurate quote and make the booking.', 'When you ask for a quote'],
            ['Passport details (name, number, nationality, date of birth, expiry), passport-size photos', 'Airlines, hotels abroad and embassies require them to issue tickets, vouchers and visas.', 'Only once you decide to book'],
            ['Visa documents — bank statements, salary slips, income-tax returns, employment or business proof, invitation letters, previous visas and travel history', 'Embassies and visa centres ask for these to decide your application. We pass them on; we do not assess them.', 'Only for visa applications'],
            ['Documents for passport assistance — address and date-of-birth proof, Aadhaar or other ID you choose to share', 'To help you fill and file your Passport Seva application correctly.', 'Only for passport help'],
            ['Online flight bookings — traveller names, gender, dates of birth, nationality; passport and PAN details only when the airline requires them; email, mobile number and address; GST details if you choose to give them; seat, meal and baggage choices', 'To book, ticket, change or cancel your flights with the airlines through our airline booking partner, and to send you your e-ticket and updates.', 'When you book a flight online'],
            ['Health or special-assistance information (e.g. wheelchair, meal needs, medical conditions, vaccination certificates)', 'Only when you tell us, so the airline, hotel or pilgrimage authority can accommodate you or meet entry rules.', 'Only if you share it'],
            ['Payment records — amount, date, method, transaction or UTR reference, invoice details (and GSTIN, if you want a GST invoice)', 'To confirm your payment, issue invoices and refunds, and keep the accounts the law requires.', 'When you pay'],
            ['Emergency contact (optional)', 'To reach someone if something goes wrong while you travel.', 'Only if you give it'],
          ]}
        />
        <p>
          <strong>Card, UPI and bank credentials.</strong> If you pay online, you enter these on the payment
          gateway’s page (Razorpay), not ours. We receive only the payment status, amount and a reference
          ID — never your full card number, CVV, UPI PIN or net-banking password.
        </p>
        <p>
          <strong>Sensitive information.</strong> Financial information and health information are
          “sensitive personal data or information” under the IT (Reasonable Security Practices and
          Procedures and Sensitive Personal Data or Information) Rules, 2011. We treat passports and visa
          files with the same care. Please send only the documents we ask for.
        </p>
      </LegalSection>

      <LegalSection title="4. Our legal basis">
        <LegalList
          items={[
            <><strong>Your consent</strong> — when you contact us and ask us to quote or book, you agree to us using your data for that request. You can withdraw consent at any time (section 8).</>,
            <><strong>Legitimate uses allowed by law</strong> — where you voluntarily give us data for a service you have asked for, and where we must keep records to comply with tax, accounting or other Indian laws, or a court or government order.</>,
            'We will not use your data for a new purpose without telling you and, where needed, asking for your consent again.',
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Children’s data">
        <p>
          Families often book for children, and minors need their own passports, visas and tickets. Under
          Indian law a child is anyone under 18.
        </p>
        <LegalList
          items={[
            'We collect a child’s data only from a parent or lawful guardian, and only what the booking, visa or passport application needs.',
            'Before we process it we ask the parent or guardian to confirm, in writing (WhatsApp or email is fine), that they are the child’s parent or guardian and consent. We may ask to see ID for the adult, and passport applications for minors follow Passport Seva’s own parental consent rules.',
            'We never use children’s data for marketing, tracking or profiling.',
            'This website is not meant for children to use on their own.',
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Who we share it with">
        <p>We share your data only with those who need it to deliver what you asked for:</p>
        <LegalList
          items={[
            'Airlines and airline booking systems (GDS), hotels, transport and local tour operators for your trip.',
            'Our airline booking partner TBO (Tek Travels Private Limited), whose systems pass your flight booking to the airline.',
            'The companies that host this website and store online booking records for us (Vercel and Neon), under contract and only to run the service.',
            'Embassies, consulates, visa application centres (e.g. VFS Global, BLS International) and online visa portals; Passport Seva for passport services.',
            'For Umrah and Hajj: the Saudi authorities and platforms (such as Nusuk), and the licensed operators in Saudi Arabia who provide your visa, hotel and transport; for Hajj, also the Government of India / Haj Committee processes that apply.',
            'Travel insurers, if you ask us to arrange insurance.',
            'Payment processors and banks (Razorpay, when used) to take payments and send refunds.',
            'Our chartered accountant, and government or law-enforcement authorities where the law requires it.',
          ]}
        />
        <p>
          Many of these are outside India because that is where you are travelling. We send only what the
          recipient needs, and we follow any restrictions the Government of India places on transfers to
          particular countries.
        </p>
      </LegalSection>

      <LegalSection title="7. How long we keep it">
        <LegalList
          items={[
            'Enquiries that do not become a booking: deleted from our systems within 12 months of our last conversation, unless you ask us to keep them.',
            'Passport scans, photos and visa supporting documents: deleted within 90 days of your trip ending or your application being decided, unless you ask us to keep them for a future application.',
            'Passport and PAN numbers given for an online flight booking: removed from our booking system automatically 90 days after the trip ends. Technical records of our messages with the airline booking system are deleted after 180 days.',
            'Invoices, payment and booking records: kept for 8 years, as Indian tax and accounting laws (such as the Income-tax Act and GST law) require.',
            'Where a complaint, refund claim or legal dispute is open, we keep the related records until it is resolved.',
          ]}
        />
        <p>
          When the purpose is over and no law requires us to keep the data, we delete it. Original
          documents you hand us (such as passports) are returned to you.
        </p>
      </LegalSection>

      <LegalSection title="8. Your rights">
        <p>You can ask us to:</p>
        <LegalList
          items={[
            <><strong>Access</strong> — get a summary of the personal data we hold about you, what we use it for, and who we have shared it with.</>,
            <><strong>Correct or update</strong> — fix anything wrong or incomplete (for example, a misspelt name on a booking).</>,
            <><strong>Erase</strong> — delete your data once it is no longer needed, unless the law requires us to keep it.</>,
            <><strong>Withdraw consent</strong> — as easily as you gave it. Withdrawal does not undo what was lawfully done before, and if a booking or visa is already in progress we may not be able to complete it without the data. Supplier cancellation charges may then apply.</>,
            <><strong>Nominate</strong> someone to exercise these rights for you if you die or become unable to act.</>,
            <><strong>Complain</strong> to our Grievance Officer, and then to the Data Protection Board of India.</>,
          ]}
        />
        <p>
          <strong>How:</strong> send a WhatsApp message or email to the Grievance Officer (section 11) saying
          what you want. We may ask you to confirm your identity before sharing or changing anything. We
          will acknowledge your request within 48 hours and act on it as soon as we can — within 30 days,
          and in any case within the time the law allows. There is no charge.
        </p>
      </LegalSection>

      <LegalSection title="9. How we protect it">
        <LegalList
          items={[
            'Only the staff handling your booking can see your documents.',
            'Devices and email and cloud accounts we use are password-protected with two-step verification where available.',
            'Passport and financial documents are not posted in group chats and are deleted from phones once uploaded to the booking or visa system.',
            'Online payments are handled by a PCI-DSS compliant gateway; we never see card details.',
            'Paper copies are kept in the office and shredded when no longer needed.',
          ]}
        />
        <p>
          No system is perfectly secure. If a personal data breach happens that affects you, we will tell
          you without delay — what happened, what it means for you, and what you can do — and we will
          report it to the Data Protection Board of India and any other authority the law requires.
        </p>
      </LegalSection>

      <LegalSection title="10. Cookies, storage and third-party services">
        <p>
          <strong>No cookies, no tracking.</strong> This website does not set cookies and does not currently
          use analytics or advertising trackers. It uses your browser’s <em>session storage</em> for one
          thing only: to remember that you have already seen the opening animation, so it does not play on
          every page. It holds no personal data and is cleared when you close the tab.
        </p>
        <p>
          If we add privacy-friendly analytics in future (for example, to count page visits), we will update
          this section first and, where the law requires it, ask for your consent before it runs.
        </p>
        <p>Some parts of the site load from other companies, which see your IP address and browser details when they do:</p>
        <LegalList
          items={[
            'Google Maps — the office map on our Contact page (Google privacy policy: policies.google.com/privacy).',
            'Google Fonts and Fontshare (Indian Type Foundry) — the typefaces used on this site.',
            'Unsplash — some destination photographs.',
            'WhatsApp (Meta) — when you tap a WhatsApp button, your message is sent through WhatsApp under its own privacy policy.',
            'Razorpay — only if you choose to pay online, under Razorpay’s privacy policy.',
          ]}
        />
        <p>We are not responsible for how these services handle data, but we choose them carefully and use only what the site needs.</p>
      </LegalSection>

      <LegalSection title="11. Grievance Officer and complaints">
        <p>For any privacy question, request or complaint, contact:</p>
        <GrievanceContact />
        <p>
          If you are not satisfied with our response, you may complain to the <strong>Data Protection Board
          of India</strong> through the process published by the Government of India (see meity.gov.in), once
          you have first raised it with us.
        </p>
      </LegalSection>

      <LegalSection title="12. Visitors from the EU and UK">
        <p>If the EU or UK GDPR applies to you:</p>
        <LegalList
          items={[
            'Our lawful bases are: taking steps at your request before and under a contract (quotes and bookings); legal obligation (tax records); consent (anything optional); and legitimate interests (keeping the website working and secure).',
            'You also have the rights to restrict or object to processing and to data portability, and you may complain to your local data protection authority (for the UK, the ICO).',
            'We are based in India, so your data is processed in India and sent to suppliers wherever your trip takes you. These transfers are necessary to perform the travel contract you have asked for.',
          ]}
        />
      </LegalSection>

      <LegalSection title="13. Changes to this policy">
        <p>
          We will update this page when our services or the law change — for example, as the remaining
          parts of the Digital Personal Data Protection Rules, 2025 come into force. The “Last updated” date
          at the top shows the latest version. If a change significantly affects how we use data you have
          already given us, we will tell you directly.
        </p>
        <p>
          See also our <Link to="/terms" className={a}>Terms &amp; Conditions</Link> and{' '}
          <Link to="/disclaimer" className={a}>Disclaimer</Link>.
        </p>
      </LegalSection>
    </LegalLayout>
  )
}
