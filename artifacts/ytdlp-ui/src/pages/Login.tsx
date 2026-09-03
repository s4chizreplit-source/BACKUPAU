import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Loader2, AlertCircle, Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { AuthLayout } from '../components/AuthLayout';

function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') ? next : '/';
}

export default function Login() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      setLocation(nextPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="text-white font-black text-3xl sm:text-[34px] tracking-tight">Welcome back</h1>
      <p className="text-white/40 text-sm mt-2">Log in to keep clipping — your videos are waiting.</p>

      {error && (
        <div className="mt-6 flex items-start gap-2.5 bg-red-500/10 border border-red-500/20 rounded-2xl px-4 py-3">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <form onSubmit={submit} className="mt-8 space-y-5">
        <div>
          <label className="block text-[11px] font-black uppercase tracking-widest text-white/40 mb-2">Email</label>
          <div className="relative">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-white/25 pointer-events-none" />
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@gmail.com"
              className="w-full bg-white/[0.04] border border-white/10 rounded-2xl pl-11 pr-4 py-3.5 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/60 focus:bg-white/[0.055] transition-all"
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[11px] font-black uppercase tracking-widest text-white/40">Password</label>
            <Link
              href="/reset-password"
              className="text-[#D1FE17] hover:text-[#c5f010] text-xs font-bold"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-white/25 pointer-events-none" />
            <input
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-white/[0.04] border border-white/10 rounded-2xl pl-11 pr-12 py-3.5 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/60 focus:bg-white/[0.055] transition-all"
            />
            <button
              type="button"
              onClick={() => setShowPw(s => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors"
              aria-label={showPw ? 'Hide password' : 'Show password'}
            >
              {showPw ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
            </button>
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-[#D1FE17] text-black font-black text-[15px] rounded-2xl py-3.5 hover:bg-[#c5f010] active:scale-[0.98] transition-all disabled:opacity-60 flex items-center justify-center gap-2 shadow-[0_12px_40px_-12px_rgba(209,254,23,0.55)]"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Log in
          {!busy && <ArrowRight className="w-4 h-4" strokeWidth={3} />}
        </button>
      </form>

      <p className="text-white/40 text-sm mt-8">
        New here?{' '}
        <Link href="/signup" className="text-[#D1FE17] hover:text-[#c5f010] font-bold">
          Create an account — it's free
        </Link>
      </p>
    </AuthLayout>
  );
}
