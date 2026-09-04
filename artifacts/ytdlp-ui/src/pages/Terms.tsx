import { LegalLayout, LegalSection } from '../components/LegalLayout';

export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" updated="August 1, 2026">
      <LegalSection title="1. About AutoCliper">
        <p>
          AutoCliper (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is an AI-powered video clipping service operated by
          AutoCliper (autocliper.com). We help creators and businesses automatically find the best
          moments in long videos and convert them into short clips for YouTube Shorts, Instagram
          Reels, and TikTok. By creating an account or using our service, you agree to these Terms.
        </p>
      </LegalSection>

      <LegalSection title="2. Eligibility">
        <p>
          You must be at least 18 years old to use AutoCliper. By accepting these Terms, you
          confirm that you are 18 or older and that you have the legal capacity to enter into a
          binding agreement. If you are using AutoCliper on behalf of a business, you represent
          that you have authority to bind that business.
        </p>
      </LegalSection>

      <LegalSection title="3. Your account">
        <p>
          You need an account to generate clips. You are responsible for:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Keeping your password and login details confidential.</li>
          <li>All activity that occurs under your account.</li>
          <li>Providing a valid email address so we can assist with billing and support.</li>
          <li>Notifying us immediately at support@autocliper.com if you suspect unauthorised access.</li>
        </ul>
        <p className="mt-3">
          You may register only one account per person. Creating multiple accounts to obtain free
          credits or bonuses is not permitted, and such accounts may be suspended.
        </p>
      </LegalSection>

      <LegalSection title="4. Credits, subscriptions & payments">
        <p>
          AutoCliper uses separate cutting and upload-processing balances. The required balance
          is shown before a job is submitted; included plan allowances and top-ups are tracked
          separately.
        </p>
        <p>
          Subscription plans add their stated monthly cutting and upload allowances while active.
          Top-ups are one-time purchases added to the matching balance. All prices are displayed
          in INR on the Pricing page.
        </p>
        <p>
          Payments are processed securely through ZapUPI. AutoCliper does not store your UPI
          credentials. By making a payment, you agree to ZapUPI&apos;s terms of service.
        </p>
      </LegalSection>

      <LegalSection title="5. Cancellations & refunds">
        <p>
          Please read our <a href="/refund" className="text-[#D1FE17] hover:underline">Cancellation &amp; Refund Policy</a> for
          full details. In summary:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Credits consumed on completed jobs are non-refundable.</li>
          <li>If a job fails on our side, held credits are returned automatically.</li>
          <li>Subscription cancellations take effect at the end of the billing period.</li>
          <li>Refund requests for unused credits or billing errors are reviewed within 5 business days.</li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Acceptable use">
        <p>You agree that you will NOT use AutoCliper to:</p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Clip or distribute content you do not own or have permission to use.</li>
          <li>Violate the terms of service of any source platform (YouTube, Twitch, Kick, etc.).</li>
          <li>Process, store or distribute unlawful, harmful, defamatory or obscene content.</li>
          <li>Infringe any intellectual property, privacy or other rights of any third party.</li>
          <li>Attempt to reverse-engineer, scrape or overload our systems.</li>
          <li>Use the service for any illegal purpose under applicable Indian or international law.</li>
        </ul>
        <p className="mt-3">
          We may suspend or terminate accounts that violate these rules. Where reasonable, we will
          warn you first before taking action.
        </p>
      </LegalSection>

      <LegalSection title="7. Your content">
        <p>
          You retain all rights to the videos you submit and the clips we generate for you. By
          using AutoCliper, you grant us a limited, non-exclusive licence to process your content
          solely to provide the service. We do not claim ownership of your clips and will not
          use them for advertising or any other purpose.
        </p>
      </LegalSection>

      <LegalSection title="8. Clips & storage">
        <p>
          Finished clips are saved to your account and accessible from any device you sign in on.
          You can delete clips from your history at any time. We reserve the right to remove
          content that violates these Terms.
        </p>
      </LegalSection>

      <LegalSection title="9. Service availability">
        <p>
          We work hard to keep AutoCliper fast and available, but we cannot guarantee uninterrupted
          service. Source platforms (YouTube, Kick, etc.) may occasionally block or rate-limit our
          servers — when that happens, we will tell you clearly and return any credits held for
          failed jobs.
        </p>
        <p>
          Features, prices, and credit costs may change. We will give at least 7 days&apos; notice
          before any price increase. Active subscriptions retain their price until renewal.
        </p>
      </LegalSection>

      <LegalSection title="10. Intellectual property">
        <p>
          All software, designs, trademarks and content on AutoCliper (excluding your submitted
          videos) are owned by or licensed to us. You may not copy, modify or redistribute our
          platform or brand without written permission.
        </p>
      </LegalSection>

      <LegalSection title="11. Limitation of liability">
        <p>
          AutoCliper is provided &quot;as is&quot; without warranties of any kind. To the maximum
          extent permitted by law, we are not liable for indirect damages, lost profits, loss of
          data, or issues caused by third-party platforms. Our total liability to you for any claim
          is limited to the amount you paid us in the 90 days preceding the claim.
        </p>
      </LegalSection>

      <LegalSection title="12. Governing law & disputes">
        <p>
          These Terms are governed by the laws of India. Any dispute arising from these Terms
          or your use of AutoCliper shall first be attempted to be resolved through good-faith
          discussion. If unresolved, disputes shall be subject to the exclusive jurisdiction of
          the courts of India.
        </p>
      </LegalSection>

      <LegalSection title="13. Changes to these Terms">
        <p>
          We may update these Terms from time to time. When we make material changes, we will
          update the &quot;Last updated&quot; date and, where appropriate, notify registered users
          by email. Continuing to use AutoCliper after changes take effect means you accept the
          revised Terms.
        </p>
      </LegalSection>

      <LegalSection title="14. Contact us">
        <p>
          For any questions about these Terms, please contact us:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Email: <a href="mailto:support@autocliper.com" className="text-[#D1FE17] hover:underline">support@autocliper.com</a></li>
          <li>Website: <a href="/contact" className="text-[#D1FE17] hover:underline">autocliper.com/contact</a></li>
        </ul>
      </LegalSection>
    </LegalLayout>
  );
}
