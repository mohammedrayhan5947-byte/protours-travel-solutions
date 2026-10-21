import { Link } from 'react-router-dom'
import { BIZ, waLink } from '../data/site.js'
import { LegalLayout, LegalSection, LegalList, LegalTable, GrievanceContact, legalLink as a } from '../components/legal.jsx'

export default function RefundPolicy() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Cancellation & Refund Policy"
      updated="17 October 2026"
      intro="What happens to your money if you cancel, or if a supplier cancels on you. Before you pay, we always tell you in writing which parts of your booking are refundable and which are not."
    >
      <LegalSection title="1. How this policy works">
        <LegalList
          items={[
            'Flights and hotels are provided by airlines and hotels, and visas are decided by governments. Their own cancellation rules decide most of what can be refunded, and we pass those rules on to you.',
            'Tour packages (including Umrah packages) follow the cancellation slabs in section 4.',
            'The cancellation terms for your booking are written on your quote or confirmation. If they differ from this page, the written terms for your booking apply.',
            'This policy applies however you paid — online through Razorpay, by bank transfer / UPI, or in cash.',
          ]}
        />
      </LegalSection>

      <LegalSection title="2. Flights">
        <LegalList
          items={[
            'Refunds and cancellation or date-change fees are set by the airline’s fare rules. Some fares are fully non-refundable; we tell you before you book.',
            'Your refund is the amount the airline returns, minus our service fee. Unused airport taxes are refunded wherever the airline returns them — including on non-refundable fares.',
            'If the airline cancels or significantly reschedules your flight, you can choose the airline’s alternative flight or a refund as the airline offers. We do not charge a service fee on refunds for airline-cancelled flights.',
            'No-shows are usually treated as fully non-refundable by airlines, apart from any taxes the airline returns.',
            'Flights booked online can be cancelled from your booking page; the airline’s cancellation charge and an estimated refund are shown before you confirm. Paid seats, meals and extra baggage are usually non-refundable.',
            'If we cannot issue your ticket after you have paid — for example the airline sold out or raised the price — you get a full refund, including our service fee, unless you choose to rebook.',
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Hotels">
        <LegalList
          items={[
            'Free-cancellation rates: cancel before the deadline shown on your voucher (hotel’s local time) for a full refund of the hotel amount.',
            'After that deadline, the hotel’s own cancellation charge applies — often one night or more, sometimes the full stay.',
            'Non-refundable rates cannot be refunded once booked. They are always marked “non-refundable” on your quote.',
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Tour packages (including Umrah)">
        <p>
          Days are counted from the day we receive your cancellation <strong>in writing</strong> (WhatsApp or
          email) to the scheduled departure date. The departure day itself is not counted.
        </p>
        <LegalTable
          head={['When you cancel', 'Refund of the package price']}
          rows={[
            ['30 days or more before departure', 'Full package price, minus non-refundable components already paid'],
            ['15 to 29 days before departure', '50% of the package price, minus non-refundable components already paid'],
            ['7 to 14 days before departure', '25% of the package price, minus non-refundable components already paid'],
            ['Less than 7 days before departure, or no-show', 'No refund'],
          ]}
        />
        <p>
          “Non-refundable components” are the costs in section 6 that we have already paid to suppliers or
          governments for your booking and cannot recover. Your written quote lists them. A refund is never
          less than zero, and we never ask you to pay more than the package price because you cancelled.
        </p>
        <p>
          <strong>Example:</strong> package price ₹1,00,000, of which ₹8,000 is a visa fee already paid. You
          cancel 20 days before departure: 50% of ₹1,00,000 = ₹50,000, minus ₹8,000 = <strong>₹42,000
          refunded</strong>.
        </p>
        <p>
          <strong>Umrah:</strong> once flights and Makkah/Madinah hotels are confirmed and paid, Umrah visa,
          Nusuk and related service charges already paid to Saudi authorities or licensed providers are
          non-refundable. <strong>Hajj:</strong> cancellation and refunds follow the rules of the Haj
          Committee of India or the registered Hajj Group Organiser concerned, which we will give you in
          writing before you pay.
        </p>
        <p>
          <strong>Changing instead of cancelling:</strong> ask us. If suppliers allow it, we can often move
          your dates or transfer the booking to someone else for only the supplier’s charges.
        </p>
      </LegalSection>

      <LegalSection title="5. Visa and passport services">
        <LegalList
          items={[
            'Government visa fees, passport fees and visa-centre charges (e.g. VFS Global, BLS International) are non-refundable once submitted, whatever the outcome — they are charged by the government or its agent, not by us.',
            'Our service fee for preparing your application is non-refundable once we have started work on your file.',
            'If your visa is refused, we will help you understand the reason and re-apply where possible, with no service fee for the first re-application. New government and visa-centre fees still apply.',
            'A visa refusal does not change the cancellation terms of flights, hotels or packages booked for that trip. Choose refundable options, or buy insurance that covers visa refusal, if you are unsure.',
          ]}
        />
      </LegalSection>

      <LegalSection title="6. What is never refundable">
        <p>Once paid or issued, the following cannot be refunded by us:</p>
        <LegalList
          items={[
            'Government fees: visa, passport, Umrah / Hajj permit and other official fees, and visa-centre charges.',
            'Non-refundable airfares and hotel rates, and any supplier cancellation charges.',
            'Our service fee, once the booking is issued or work on your file has started (except for airline-cancelled flights, see section 2).',
            'Travel insurance premiums once the policy is issued, unless the insurer offers a cancellation.',
            'Services already used, and no-shows.',
          ]}
        />
        <p>
          <strong>Tax collected at source (TCS)</strong> on overseas packages is deposited with the Income Tax
          Department against your PAN. We cannot refund it once deposited, but you can claim credit for it in
          your income-tax return.
        </p>
      </LegalSection>

      <LegalSection title="7. If we or a supplier cancel">
        <LegalList
          items={[
            'If we have to cancel a package for reasons within our control, you get a full refund of everything you paid us, or an alternative of equal value if you prefer.',
            'If a supplier cancels, or travel becomes impossible because of events outside anyone’s control (see our Terms), we refund everything we are able to recover from suppliers, without our service fee on the cancelled part, or help you move to new dates.',
          ]}
        />
      </LegalSection>

      <LegalSection title="8. How and when refunds are paid">
        <LegalList
          items={[
            'We send you a written breakdown of your refund within 7 working days of your cancellation — what was paid, what the supplier returned, and what (if anything) was deducted and why.',
            'We pay the refund within 7 working days of the supplier or airline returning the money to us. Airline refunds can take a few weeks; we chase them for you and keep you informed.',
            'Online payments are refunded to the same card, UPI or bank account through Razorpay. Your bank usually credits it within 5–10 working days after that.',
            'Bank transfer, UPI and cash payments are refunded by bank transfer to the account of the person who paid. We may ask for a cancelled cheque or bank details in writing.',
            'Refunds are made in Indian Rupees. For foreign cards, the amount you receive may differ slightly because of exchange rates and your bank’s charges.',
          ]}
        />
      </LegalSection>

      <LegalSection title="9. Chargebacks and payment disputes">
        <p>
          If something is wrong with a payment, please contact us first — most issues are sorted within a
          day. If you raise a chargeback or dispute with your bank, we will share your booking, payment and
          cancellation records with the bank and payment provider to respond. If the services were supplied
          or the charge was valid under this policy, we may contest the dispute and recover amounts wrongly
          reversed, including supplier costs already incurred.
        </p>
      </LegalSection>

      <LegalSection title="10. How to cancel or ask for a refund">
        <p>
          Flights booked online: open the link from your booking confirmation and choose “Cancel flights”.
          Everything else: send your booking name, reference and travel dates by{' '}
          <a href={waLink(`Hello ${BIZ.name}, I would like to cancel / request a refund for my booking.`)} className={a} target="_blank" rel="noopener noreferrer">WhatsApp</a>{' '}
          or email to <a href={`mailto:${BIZ.email2}`} className={a}>{BIZ.email2}</a>. We will confirm we have
          received it, and send the refund breakdown before anything is deducted.
        </p>
        <p>
          Not happy with the outcome? Contact our Grievance Officer. We acknowledge complaints within 48
          hours and aim to resolve them within one month. The full complaint steps are in our{' '}
          <Link to="/terms" className={a}>Terms &amp; Conditions</Link>.
        </p>
        <GrievanceContact />
      </LegalSection>
    </LegalLayout>
  )
}
