/**
 * UPI return page — shows the right state for a paid / failed order and
 * refreshes the session user once a payment lands.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const refresh = vi.fn(async () => {});
const apiFetch = vi.fn();

vi.mock('../lib/auth', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    useAuth: () => ({ user: { id: 'usr_1', email: 'x@test.dev' }, loading: false, refresh }),
    ApiError,
  };
});

vi.mock('../components/AppHeader', () => ({ AppHeader: () => <header /> }));

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('wouter', () => ({
  Link: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
  useLocation: () => ['/pay/upi/return', nav.push] as const,
}));

const PayUpiReturn = (await import('../pages/PayUpiReturn')).default;

const ORDER_ID = `acl_${'a'.repeat(24)}`;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PayUpiReturn />
    </QueryClientProvider>,
  );
}

function orderFixture(status: string) {
  return {
    order: {
      orderId: ORDER_ID,
      plan: 'starter',
      planInterval: 'monthly',
      amountInr: 500,
      status,
      paymentUrl: status === 'pending' ? 'https://pay.zapupi.com/mock' : null,
      utr: status === 'paid' ? 'UTR9' : null,
      txnId: null,
      failReason: status === 'failed' ? 'Payment failed or was cancelled in the UPI app' : null,
      createdAt: new Date().toISOString(),
      paidAt: status === 'paid' ? new Date().toISOString() : null,
    },
  };
}

describe('PayUpiReturn', () => {
  beforeEach(() => {
    refresh.mockClear();
    apiFetch.mockReset();
    nav.push.mockClear();
    window.history.replaceState({}, '', `/pay/upi/return?order_id=${ORDER_ID}`);
  });

  it('celebrates a paid order, refreshes the session user and auto-redirects to billing', async () => {
    apiFetch.mockResolvedValue(orderFixture('paid'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/plan is ACTIVE/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/UTR9/)).toBeInTheDocument();
    expect(screen.getByText(/taking you to your billing page/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to billing now/i })).toHaveAttribute('href', '/account');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith(`/pay/upi/order/${ORDER_ID}`);
    // The success page must not be a dead end — it moves to billing by itself.
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/account'), { timeout: 4000 });
  });

  it('shows a retry path when the payment failed', async () => {
    apiFetch.mockResolvedValue(orderFixture('failed'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/didn't go through/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /try again/i })).toHaveAttribute('href', '/pricing');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps waiting while the order is pending, with a reopen-payment button', async () => {
    apiFetch.mockResolvedValue(orderFixture('pending'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/waiting for your payment/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /reopen payment page/i })).toHaveAttribute(
      'href',
      'https://pay.zapupi.com/mock',
    );
  });
});
