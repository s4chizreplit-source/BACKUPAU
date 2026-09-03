import { LegalLayout, LegalSection } from '../components/LegalLayout';

export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" updated="August 1, 2026">
      <LegalSection title="1. Introduction">
        <p>
          AutoCliper (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is committed to protecting your personal
          information. This Privacy Policy explains what data we collect, how we use it, and
          your rights regarding your data when you use autocliper.pro.
        </p>
        <p>
          By creating an account or using our service, you agree to the practices described in
          this policy.
        </p>
      </LegalSection>

      <LegalSection title="2. Information we collect">
        <p>We collect the following types of information:</p>
        <p className="font-semibold text-white/70 mt-3">Account information</p>
        <ul className="list-disc pl-5 space-y-1 mt-1">
          <li>Name (optional) and email address provided during signup.</li>
          <li>Password, stored only as a one-way bcrypt hash — we cannot see your password.</li>
          <li>Account creation date and plan/billing status.</li>
        </ul>
        <p className="font-semibold text-white/70 mt-3">Usage & clip data</p>
        <ul className="list-disc pl-5 space-y-1 mt-1">
          <li>Video URLs you submit for clipping.</li>
          <li>Clip settings (format, duration, caption style, etc.).</li>
          <li>Job status, error messages, and processing logs.</li>
          <li>Credit balance, usage history, and payment records.</li>
        </ul>
        <p className="font-semibold text-white/70 mt-3">Technical data</p>
        <ul className="list-disc pl-5 space-y-1 mt-1">
          <li>Session data stored in a secure, HTTP-only cookie.</li>
          <li>Basic server logs (request paths, timestamps, error codes) for debugging.</li>
        </ul>
        <p className="font-semibold text-white/70 mt-3">Optional: uploaded cookies file</p>
        <ul className="list-disc pl-5 space-y-1 mt-1">
          <li>If you choose to upload a YouTube cookies file (to access region-locked videos),
            we store it securely and use it exclusively to download videos on your behalf.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. How we use your information">
        <p>We use your information only to provide and improve the AutoCliper service:</p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Processing your clip jobs and delivering finished clips to your account.</li>
          <li>Managing your credit balance, subscriptions, and payment records.</li>
          <li>Keeping you signed in across devices via your session.</li>
          <li>Sending transactional emails (receipts, password reset, support replies).</li>
          <li>Debugging errors and improving service reliability.</li>
        </ul>
        <p className="mt-3">
          We do <strong className="text-white">not</strong> use your data for advertising, profiling,
          or any purpose unrelated to the service.
        </p>
      </LegalSection>

      <LegalSection title="4. What we never do">
        <ul className="list-disc pl-5 space-y-1">
          <li>We do not sell your personal data to any third party.</li>
          <li>We do not show advertising of any kind.</li>
          <li>We do not share your data with third parties except as described in Section 5.</li>
          <li>We do not read or view your clips for any purpose other than delivering them to you.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Third parties we work with">
        <p>
          To run the service, we share limited data with trusted providers:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li><strong className="text-white/80">Hosting & storage</strong> — our server and clip storage providers handle your clips under strict confidentiality.</li>
          <li><strong className="text-white/80">Payment providers</strong> — ZapUPI processes UPI payment transactions. They receive payment details needed to process the transaction; we receive only a confirmation and never store UPI credentials.</li>
          <li><strong className="text-white/80">Email delivery</strong> — we use Resend to send transactional emails (receipts, password resets). Resend receives your email address for delivery purposes only.</li>
          <li><strong className="text-white/80">Video platforms</strong> — when you submit a YouTube, Kick, Twitch, Drive or Dropbox link, we interact with those platforms on your behalf. Their own privacy policies apply to that interaction.</li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Data retention">
        <p>
          We retain your account data as long as your account is active. Finished clips are stored
          permanently in your history until you delete them. If you delete your account, we remove
          your personal data within 30 days, except where retention is required by law (e.g. payment records).
        </p>
      </LegalSection>

      <LegalSection title="7. Security">
        <p>
          We implement industry-standard security measures including hashed passwords, HTTPS-only
          connections, HTTP-only session cookies, and restricted access to production systems. No
          system is 100% secure. If we become aware of a data breach that affects you, we will
          notify you promptly.
        </p>
      </LegalSection>

      <LegalSection title="8. Cookies">
        <p>
          AutoCliper uses one essential session cookie to keep you signed in. We do not use
          tracking, advertising, or analytics cookies. You can delete this cookie at any time
          via your browser settings, which will sign you out.
        </p>
      </LegalSection>

      <LegalSection title="9. Your rights">
        <p>You have the right to:</p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li><strong className="text-white/80">Access</strong> — request a copy of the data we hold about you.</li>
          <li><strong className="text-white/80">Correction</strong> — ask us to correct inaccurate data.</li>
          <li><strong className="text-white/80">Deletion</strong> — ask us to delete your account and personal data.</li>
          <li><strong className="text-white/80">Objection</strong> — object to any processing you believe is not in your interest.</li>
        </ul>
        <p className="mt-3">
          To exercise any of these rights, email us at <a href="mailto:support@autocliper.pro" className="text-[#D1FE17] hover:underline">support@autocliper.pro</a>.
          We will respond within 15 business days.
        </p>
      </LegalSection>

      <LegalSection title="10. Children's privacy">
        <p>
          AutoCliper is not directed at children under 18. We do not knowingly collect personal
          data from anyone under 18. If you believe a minor has provided us with their data,
          please contact us and we will delete it promptly.
        </p>
      </LegalSection>

      <LegalSection title="11. Changes to this policy">
        <p>
          If we make material changes to this Privacy Policy, we will update the &quot;Last
          updated&quot; date and notify registered users by email where appropriate. Continued
          use of AutoCliper after changes take effect constitutes acceptance of the revised policy.
        </p>
      </LegalSection>

      <LegalSection title="12. Contact us">
        <p>
          For any privacy questions or data requests, contact us at:
        </p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Email: <a href="mailto:support@autocliper.pro" className="text-[#D1FE17] hover:underline">support@autocliper.pro</a></li>
          <li>Website: <a href="/contact" className="text-[#D1FE17] hover:underline">autocliper.pro/contact</a></li>
        </ul>
      </LegalSection>
    </LegalLayout>
  );
}
