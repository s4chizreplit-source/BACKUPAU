import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { Scissors, Loader2, AlertCircle, MailCheck, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../lib/auth';

const inputCls =
  'w-full bg-[#222] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/50 transition-colors';
const buttonCls =
  'w-full bg-[#D1FE17] text-black font-black rounded-xl py-3 hover:bg-[#c5f010] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="flex justify-center mb-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-[#D1FE17] flex items-center justify-center">
              <Scissors className="w-5 h-5 text-black" strokeWidth={2.5} />
            </div>
            <span className="font-black text-xl tracking-tight text-white">AutoCliper</span>
          </Link>
        </div>
        <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-8">{children}</div>
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="mt-5 flex items-start gap-2.5 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
      <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
      <p className="text-red-400 text-sm">{error}</p>
    </div>
  );
}

/** Step 1 — ask for the account email, we send a reset link. */
function RequestForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset email.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center">
        <MailCheck className="w-10 h-10 text-[#D1FE17] mx-auto" />
        <h1 className="text-white font-black text-2xl mt-4">Check your inbox</h1>
        <p className="text-white/50 text-sm mt-2">
          If an account exists for <span className="text-white/80">{email}</span>, we sent a reset
          link. It expires in 30 minutes.
        </p>
        <p className="text-white/40 text-sm mt-6">
          <Link href="/login" className="text-[#D1FE17] hover:text-[#c5f010] font-semibold">
            Back to log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-white font-black text-2xl text-center">Forgot your password?</h1>
      <p className="text-white/50 text-sm text-center mt-1.5">
        Enter your email and we&apos;ll send you a reset link
      </p>
      <ErrorBox error={error} />
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="block text-white/70 text-sm font-medium mb-1.5">Email</label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@gmail.com"
            className={inputCls}
          />
        </div>
        <button type="submit" disabled={busy} className={buttonCls}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Send reset link
        </button>
      </form>
      <p className="text-white/40 text-sm text-center mt-6">
        Remembered it?{' '}
        <Link href="/login" className="text-[#D1FE17] hover:text-[#c5f010] font-semibold">
          Log in
        </Link>
      </p>
    </>
  );
}

/** Step 2 — arrived via the emailed link, choose a new password. */
function NewPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="text-center">
        <CheckCircle2 className="w-10 h-10 text-[#D1FE17] mx-auto" />
        <h1 className="text-white font-black text-2xl mt-4">Password updated</h1>
        <p className="text-white/50 text-sm mt-2">
          You&apos;ve been logged out everywhere. Log in with your new password.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex items-center justify-center bg-[#D1FE17] text-black font-black rounded-xl px-6 py-3 hover:bg-[#c5f010] transition-all"
        >
          Log in
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-white font-black text-2xl text-center">Choose a new password</h1>
      <p className="text-white/50 text-sm text-center mt-1.5">At least 8 characters</p>
      <ErrorBox error={error} />
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="block text-white/70 text-sm font-medium mb-1.5">New password</label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-white/70 text-sm font-medium mb-1.5">
            Confirm new password
          </label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="••••••••"
            className={inputCls}
          />
        </div>
        <button type="submit" disabled={busy} className={buttonCls}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Reset password
        </button>
      </form>
      <p className="text-white/40 text-sm text-center mt-6">
        Link expired?{' '}
        <Link href="/reset-password" className="text-[#D1FE17] hover:text-[#c5f010] font-semibold">
          Request a new one
        </Link>
      </p>
    </>
  );
}

export default function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  return <Shell>{token ? <NewPasswordForm token={token} /> : <RequestForm />}</Shell>;
}
