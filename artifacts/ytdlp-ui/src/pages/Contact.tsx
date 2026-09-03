import { Mail, MessageSquare, Clock, HelpCircle, CreditCard, Shield } from 'lucide-react';
import { Link } from 'wouter';
import { Scissors } from 'lucide-react';
import { Footer } from '../components/Footer';

function TopicCard({ icon: Icon, title, desc, email, subject }: {
  icon: typeof Mail;
  title: string;
  desc: string;
  email: string;
  subject: string;
}) {
  return (
    <a
      href={`mailto:${email}?subject=${encodeURIComponent(subject)}`}
      className="flex items-start gap-4 bg-[#1a1a1a] border border-white/8 rounded-2xl p-5 hover:border-[#D1FE17]/30 hover:bg-[#1e1e1e] transition-all group"
    >
      <div className="w-10 h-10 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/20 flex items-center justify-center shrink-0 group-hover:bg-[#D1FE17]/15 transition-colors">
        <Icon className="w-5 h-5 text-[#D1FE17]" />
      </div>
      <div>
        <p className="text-white font-bold text-sm">{title}</p>
        <p className="text-white/45 text-sm mt-0.5 leading-relaxed">{desc}</p>
        <p className="text-[#D1FE17]/70 text-xs font-semibold mt-2">{email}</p>
      </div>
    </a>
  );
}

export default function Contact() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#0d0d0d]/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center">
              <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
            </div>
            <span className="font-black text-lg tracking-tight">AutoCliper</span>
          </Link>
          <Link href="/" className="text-sm font-semibold text-white/60 hover:text-white transition-colors">
            ← Back to app
          </Link>
        </div>
      </nav>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight">Contact Us</h1>
          <p className="text-white/45 mt-3 text-base max-w-xl mx-auto">
            We&apos;re a small, fast team. Reach out and we&apos;ll reply within 1–2 business days.
          </p>
          <div className="inline-flex items-center gap-2 mt-4 bg-[#D1FE17]/10 border border-[#D1FE17]/20 rounded-full px-4 py-2">
            <Clock className="w-4 h-4 text-[#D1FE17]" />
            <span className="text-[#D1FE17] text-sm font-semibold">Average response time: under 24 hours</span>
          </div>
        </div>

        {/* Topic cards */}
        <div className="space-y-3 mb-12">
          <TopicCard
            icon={HelpCircle}
            title="General support"
            desc="Questions about how AutoCliper works, clip quality, formats, or getting started."
            email="support@autocliper.pro"
            subject="Support Request"
          />
          <TopicCard
            icon={CreditCard}
            title="Billing & payments"
            desc="Subscription charges, refund requests, credit issues, or payment not reflecting."
            email="support@autocliper.pro"
            subject="Billing Enquiry"
          />
          <TopicCard
            icon={Shield}
            title="Privacy & data requests"
            desc="Request a copy of your data, account deletion, or any privacy-related concern."
            email="support@autocliper.pro"
            subject="Privacy / Data Request"
          />
          <TopicCard
            icon={MessageSquare}
            title="Business & partnerships"
            desc="Bulk plans, white-label enquiries, API access, or partnership opportunities."
            email="support@autocliper.pro"
            subject="Business Enquiry"
          />
        </div>

        {/* Direct email box */}
        <div className="bg-[#1a1a1a] border border-white/8 rounded-2xl p-6 text-center">
          <Mail className="w-8 h-8 text-[#D1FE17] mx-auto mb-3" />
          <p className="text-white font-black text-lg">Email us directly</p>
          <p className="text-white/45 text-sm mt-1">For all enquiries, one inbox:</p>
          <a
            href="mailto:support@autocliper.pro"
            className="inline-block mt-3 text-[#D1FE17] font-black text-xl hover:underline"
          >
            support@autocliper.pro
          </a>
        </div>

        {/* Legal links */}
        <div className="mt-10 flex flex-wrap justify-center gap-4 text-sm text-white/30">
          <Link href="/terms" className="hover:text-white/60 transition-colors">Terms of Service</Link>
          <span>·</span>
          <Link href="/privacy" className="hover:text-white/60 transition-colors">Privacy Policy</Link>
          <span>·</span>
          <Link href="/refund" className="hover:text-white/60 transition-colors">Refund Policy</Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
