import { LegalLayout, LegalSection } from '../components/LegalLayout';

export default function Refund() {
  return (
    <LegalLayout title="Cancellation & Refund Policy" updated="August 1, 2026">
      <LegalSection title="1. Overview">
        <p>
          At AutoCliper, we want every customer to be satisfied. This policy explains when and
          how you can cancel a subscription, request a refund, or get credits returned for
          failed jobs. Please read it before making a purchase. If you have questions, email us
          at <a href="mailto:support@autocliper.pro" className="text-[#D1FE17] hover:underline">support@autocliper.pro</a>.
        </p>
      </LegalSection>

      <LegalSection title="2. Credits — automatic return on failed jobs">
        <p>
          When you start a clip job, the required credits (50 per clip) are reserved from your
          balance. If the job fails for any reason on our side (server error, processing failure,
          source video unavailable), your reserved credits are <strong className="text-white/80">returned
          automatically</strong> to your balance — no action needed on your part.
        </p>
        <p>
          Credits that have been successfully spent on completed clip jobs or tool runs are
          non-refundable, as the computing resources to generate those clips have already been used.
        </p>
      </LegalSection>

      <LegalSection title="3. Subscription plans — cancellation">
        <p>
          You may cancel your Starter or Pro subscription at any time from your Account page or
          by emailing support@autocliper.pro.
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Cancellation takes effect at the <strong className="text-white/80">end of the current billing period</strong> — you retain full access and your monthly credits until then.</li>
          <li>We do not charge a cancellation fee.</li>
          <li>Unused subscription credits at the time of cancellation are not refunded, but they remain available in your balance until used.</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. Subscription plans — refunds">
        <p>
          If you are charged for a renewal you did not intend, or if there is a billing error on
          our part, contact us within <strong className="text-white/80">7 days</strong> of the charge
          at support@autocliper.pro with your registered email and payment reference. We will
          investigate and, if the charge was in error, issue a full refund within
          <strong className="text-white/80"> 5–7 business days</strong>.
        </p>
        <p>
          Refunds for change-of-mind cancellations after the billing cycle has started are at our
          discretion and will be considered on a case-by-case basis.
        </p>
      </LegalSection>

      <LegalSection title="5. Top-up credit packs">
        <p>
          Credit top-up packs are one-time purchases and do not expire. Once purchased and added
          to your account, they are non-refundable except in the following cases:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>A billing error resulted in a duplicate or incorrect charge.</li>
          <li>Credits were not added to your account after a confirmed payment.</li>
        </ul>
        <p>
          In these cases, contact us within 7 days with your payment reference and we will
          resolve the issue promptly.
        </p>
      </LegalSection>

      <LegalSection title="6. How to request a refund">
        <p>To request a refund or report a billing issue:</p>
        <ol className="list-decimal pl-5 space-y-2 mt-2">
          <li>Email <a href="mailto:support@autocliper.pro" className="text-[#D1FE17] hover:underline">support@autocliper.pro</a> with the subject line <strong className="text-white/80">&quot;Refund Request&quot;</strong>.</li>
          <li>Include your registered email address, the date of purchase, and the payment reference or transaction ID.</li>
          <li>Briefly describe the reason for your refund request.</li>
        </ol>
        <p className="mt-3">
          We will acknowledge your request within 2 business days and resolve it within
          5–7 business days. Refunds are processed back to the original payment method.
        </p>
      </LegalSection>

      <LegalSection title="7. Service disruptions">
        <p>
          If AutoCliper experiences a significant outage or service disruption that prevents you
          from using your subscription for more than 48 continuous hours, you may request a
          prorated credit extension. We handle such cases generously and on a case-by-case basis.
        </p>
      </LegalSection>

      <LegalSection title="8. Payment disputes & chargebacks">
        <p>
          Before raising a payment dispute or chargeback with your bank or payment provider,
          please contact us first at support@autocliper.pro — we resolve billing issues quickly
          and prefer to handle them directly. Unresolved fraudulent chargebacks may result in
          account suspension.
        </p>
      </LegalSection>

      <LegalSection title="9. Contact us">
        <p>
          For any refund or cancellation queries:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Email: <a href="mailto:support@autocliper.pro" className="text-[#D1FE17] hover:underline">support@autocliper.pro</a></li>
          <li>Response time: within 2 business days</li>
          <li>Website: <a href="/contact" className="text-[#D1FE17] hover:underline">autocliper.pro/contact</a></li>
        </ul>
      </LegalSection>
    </LegalLayout>
  );
}
