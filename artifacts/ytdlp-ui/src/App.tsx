import { lazy, Suspense, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Switch, Route, Redirect, Router as WouterRouter } from 'wouter';
import { AuthProvider } from './lib/auth';

// Lazy-loaded pages — each page becomes its own JS chunk so the initial
// bundle only ships what the user actually needs to see first.
const ClipperPage = lazy(() => import('./pages/ClipperPage'));
const HistoryPage = lazy(() => import('./pages/History'));
const Login = lazy(() => import('./pages/Login'));
const SignUp = lazy(() => import('./pages/SignUp'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const PayUpiReturn = lazy(() => import('./pages/PayUpiReturn'));
const Account = lazy(() => import('./pages/Account'));
const Admin = lazy(() => import('./pages/Admin'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Refund = lazy(() => import('./pages/Refund'));
const Contact = lazy(() => import('./pages/Contact'));
const SocialPage = lazy(() => import('./pages/Social'));
const SchedulePage = lazy(() => import('./pages/Schedule'));
const AutoPilotPage = lazy(() => import('./pages/AutoPilot'));

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function App() {
  // Referral links land as ?ref=CODE on any page. Stash the code for 30 days
  // (consumed at signup) and clean the URL so it doesn't linger in the bar.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = (params.get('ref') ?? '').trim().toLowerCase();
      if (/^[a-z0-9]{4,32}$/.test(ref)) {
        localStorage.setItem('autocliper_ref', JSON.stringify({ code: ref, ts: Date.now() }));
        params.delete('ref');
        const qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
      }
    } catch { /* storage unavailable — attribution just skips */ }
  }, []);

  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Suspense fallback={<div className="min-h-screen bg-[#0d0d0d]" />}>
            <Switch>
              <Route path="/" component={ClipperPage} />
              <Route path="/history" component={HistoryPage} />
              <Route path="/schedule" component={SchedulePage} />
              <Route path="/autopilot" component={AutoPilotPage} />
              <Route path="/login" component={Login} />
              <Route path="/signup" component={SignUp} />
              <Route path="/reset-password" component={ResetPassword} />
              {/* Legacy auth paths from the old provider */}
              <Route path="/sign-in/*?"><Redirect to="/login" /></Route>
              <Route path="/sign-up/*?"><Redirect to="/signup" /></Route>
              <Route path="/pricing" component={Pricing} />
              <Route path="/pay/upi/return" component={PayUpiReturn} />
              <Route path="/account" component={Account} />
              <Route path="/admin" component={Admin} />
              <Route path="/terms" component={Terms} />
              <Route path="/privacy" component={Privacy} />
              <Route path="/refund" component={Refund} />
              <Route path="/contact" component={Contact} />
              <Route path="/social" component={SocialPage} />
              <Route><Redirect to="/" /></Route>
            </Switch>
          </Suspense>
        </AuthProvider>
      </QueryClientProvider>
    </WouterRouter>
  );
}

export default App;
