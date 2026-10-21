import { Link } from 'react-router-dom'
import { BIZ } from '../data/site.js'
import { LegalLayout, LegalSection, LegalList, GrievanceContact, legalLink as a } from '../components/legal.jsx'

export default function Terms() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Terms & Conditions"
      updated="17 October 2026"
      intro="The rules that apply when you use this website or book a trip with us. We have kept them short and plain — if anything is unclear, ask us before you book."
    >
      <LegalSection title="1. Who we are">
        <p>
          {BIZ.name} is an IATA-accredited travel agent run by {BIZ.owner} from {BIZ.addressOneLine},
          India. Phone / WhatsApp {BIZ.phoneDisplay}, email{' '}
          <a href={`mailto:${BIZ.email2}`} className={a}>{BIZ.email2}</a>.
        </p>
        <p>
          Trading in Bengaluru since {BIZ.since}, we arrange flights, hotels, tour packages and Hajj &amp; Umrah, and act as consultants for visas, passports and travel insurance.
          {BIZ.name} is a sole proprietorship owned and run by {BIZ.owner} (Proprietor); it is not a company,
          partnership or LLP. These terms apply to this website and to every booking you make with us — online, on
          WhatsApp, by phone, by email or at our office. By booking or paying, you accept these terms, our{' '}
          <Link to="/refund-policy" className={a}>Cancellation &amp; Refund Policy</Link> and our{' '}
          <Link to="/privacy" className={a}>Privacy Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="2. Our role as your agent">
        <p>
          We are a booking agent. The flight, hotel room, transfer or tour is provided by the airline,
          hotel or local operator (the “supplier”), and their own terms and conditions — fare
          rules, check-in times, baggage rules, cancellation terms — also apply to you. We will share the key
          supplier terms with you before you pay, and full terms on request.
        </p>
      </LegalSection>

      <LegalSection title="3. Quotes and prices">
        <p>
          Tour packages, visas and most other services are quoted to you individually; package quotes are per
          person on twin sharing unless we say otherwise. Flight fares in our online booking are live airline
          prices for all the travellers searched, and include taxes, airline fees and our service fee — the
          full amount is shown before you pay.
        </p>
        <LegalList
          items={[
            'Every quote is itemised in writing (WhatsApp or email) and shows the total you will pay, including taxes (such as GST and any TCS on overseas packages) and our service fee. No hidden charges are added later.',
            'Airfares, hotel rates and visa fees are set by suppliers and governments and can change until the booking is paid and issued. If a price changes before that, we will tell you and you can choose not to go ahead.',
            'Things not included in the quote (for example, tips, personal expenses, optional tours, excess baggage) are listed as exclusions.',
          ]}
        />
      </LegalSection>

      <LegalSection title="4. How a booking is confirmed">
        <p>
          An enquiry or a quote is not a booking. A booking is confirmed only when we have received your
          payment (or the agreed deposit) and sent you a confirmation — an e-ticket, hotel voucher, visa
          application receipt or written booking confirmation. For flights booked online, that is when the
          e-ticket number appears on your booking page. Please check names, dates and details straight away;
          names must match passports exactly, and airlines may charge for corrections.
        </p>
      </LegalSection>

      <LegalSection title="5. Payments">
        <LegalList
          items={[
            'You can pay by bank transfer, UPI, cash at our office, or online through Razorpay — on our flight booking pages or by a payment link we send you. The amount is always shown or confirmed in writing before you pay.',
            'Online payments are processed by Razorpay, a PCI-DSS compliant payment gateway. We never see or store your card, UPI or net-banking credentials.',
            'Online charges are made in Indian Rupees. If you pay with a foreign card, your bank converts the amount and may add its own currency-conversion fee.',
            'Cash payments are accepted only within the limits set by Indian law, and you will always get a receipt.',
            'For packages, the balance is due by the date shown on your confirmation. If it is not paid on time, suppliers may release the booking and our cancellation terms apply.',
          ]}
        />
      </LegalSection>

      <LegalSection title="5A. Flights booked online">
        <LegalList
          items={[
            'Airlines hold a searched fare for about 15 minutes. If it expires before you pay, search again for the current price.',
            'If the airline’s price goes up between your payment and ticketing, we will not charge you more without your agreement. We will contact you to rebook at the new price or refund you in full, including our service fee.',
            'If a ticket cannot be issued after you have paid, our team contacts you as soon as possible, and within one working day, to rebook or refund you in full.',
            'Seats, meals and extra baggage bought online are provided by the airline and are usually non-refundable. For full-service airlines, meal and seat choices are passed on as requests and are not guaranteed.',
            'Our service fee is shown before you pay and is not refundable once the ticket is issued, except where the airline cancels the flight.',
            'Anyone with your booking link can view and cancel the booking, so share it only with your co-travellers.',
          ]}
        />
      </LegalSection>
      <LegalSection title="6. Passports, visas and travel documents">
        <LegalList
          items={[
            'You are responsible for having a valid passport (most countries require at least six months’ validity and blank pages), the right visa, and any transit visas, permits and health documents for every traveller.',
            'Visa decisions are made only by the embassy, consulate or immigration authority. We help prepare and submit your application, but we cannot guarantee a visa, the processing time, or the validity granted. Entry is always at the discretion of immigration at the border.',
            'Passport services are assistance only — we help you fill and file your application and book appointments. The Passport Seva / Ministry of External Affairs and the police verification process decide the outcome and timing.',
            'You must give us true, complete documents. We cannot be responsible for refusals or delays caused by incorrect or missing information.',
          ]}
        />
      </LegalSection>

      <LegalSection title="7. Hajj and Umrah">
        <LegalList
          items={[
            'Umrah visas, permits, and many hotel and transport arrangements are subject to the rules of the Ministry of Hajj and Umrah of Saudi Arabia and its Nusuk platform, and to the Saudi authorities’ decisions, which can change at short notice.',
            'Hajj from India is organised through the Haj Committee of India or through Hajj Group Organisers registered with the Ministry of Minority Affairs, under the Government of India’s Hajj Policy and the quota allotted by Saudi Arabia. Before you pay for any Hajj arrangement, we will tell you in writing who the registered organiser is and what we are arranging.',
            'Seat, hotel, tent and transport allocations are made by the authorities and licensed service providers and may change. We will pass on any change as soon as we hear of it.',
          ]}
        />
      </LegalSection>

      <LegalSection title="8. Health, safety and insurance">
        <LegalList
          items={[
            'Check vaccination and health entry rules for your destination (for example, meningitis vaccination for Hajj and Umrah, or yellow fever certificates for some countries) and speak to your doctor before travel.',
            'We strongly recommend travel insurance that covers medical costs, cancellation and lost baggage. Some visas require it. We act only as consultants: we can help you compare and choose a policy, but the insurer issues it and decides claims.',
            'Tell us about any disability, medical condition or special assistance needs at the time of booking, so we can pass them to suppliers.',
          ]}
        />
      </LegalSection>

      <LegalSection title="9. Changes and cancellations">
        <p>
          If you want to change or cancel, tell us in writing, or cancel a flight booked online from your
          booking page, where the airline’s charge is shown before you confirm. Charges depend on the supplier’s rules and
          our <Link to="/refund-policy" className={a}>Cancellation &amp; Refund Policy</Link>. If a supplier
          changes or cancels your booking, we will tell you promptly, offer the alternatives or refund the
          supplier gives, and help you claim any compensation you are entitled to.
        </p>
      </LegalSection>

      <LegalSection title="10. Events outside anyone’s control">
        <p>
          We are not liable for failures or delays caused by events beyond our reasonable control — such as
          natural disasters, extreme weather, epidemics, war, terrorism, civil unrest, strikes, airport or
          airspace closures, government orders or changes to visa or entry rules. In such cases we will
          help you rebook or recover whatever refund the supplier gives.
        </p>
      </LegalSection>

      <LegalSection title="11. Our responsibility">
        <LegalList
          items={[
            'We will arrange your booking with reasonable skill and care, and give you correct information as we have it.',
            'We are not responsible for the acts or omissions of airlines, hotels and other suppliers, or for delays, cancellations, overbooking, denied boarding, lost baggage or visa refusals — but we will help you pursue the supplier’s remedy.',
            'Where we are at fault, our liability is limited to the amount you paid us for the affected service, except where the law does not allow such a limit.',
            'Nothing in these terms takes away your rights under the Consumer Protection Act, 2019.',
          ]}
        />
      </LegalSection>

      <LegalSection title="12. Using this website">
        <LegalList
          items={[
            'We try to keep information on this site accurate and current, but itineraries, inclusions, visa rules and photos are for general guidance. Your written quote and confirmation are what count.',
            'Photos may be representative. Links to other websites are for convenience; we do not control them.',
            'Do not misuse the site, copy its content or design for commercial use, or try to disrupt it. The text, design and our logo belong to us.',
          ]}
        />
        <p>
          See also our <Link to="/disclaimer" className={a}>Disclaimer</Link>.
        </p>
      </LegalSection>

      <LegalSection title="13. Complaints and disputes">
        <p>We want to fix problems quickly. Please follow these steps:</p>
        <LegalList
          items={[
            'Step 1 — tell the person handling your booking, on WhatsApp, phone or email.',
            'Step 2 — if it is not resolved, write to our Grievance Officer (below). We will acknowledge your complaint within 48 hours and aim to resolve it within one month of receiving it.',
            'Step 3 — if you are still unhappy, you can call the National Consumer Helpline (1915) or file a complaint online at e-daakhil.nic.in with the appropriate Consumer Commission under the Consumer Protection Act, 2019.',
          ]}
        />
        <GrievanceContact />
      </LegalSection>

      <LegalSection title="14. Governing law">
        <p>
          These terms are governed by the laws of India. Subject to your right to approach a Consumer
          Commission, the courts in Bengaluru, Karnataka have exclusive jurisdiction over any dispute.
        </p>
      </LegalSection>

      <LegalSection title="15. Changes to these terms">
        <p>
          We may update these terms when our services or the law change. The “Last updated” date above shows
          the latest version. The terms in force on the day you confirm a booking apply to that booking.
        </p>
      </LegalSection>
    </LegalLayout>
  )
}
