/**
 * Tests for the sitewide Footer component.
 *
 * Covers:
 *  - brand, column headings and copyright line render
 *  - key routes are linked (pricing, terms, privacy, login, signup)
 *  - social icons exist with accessible labels and external-safe attributes
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('wouter', () => ({
  Link: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const { Footer } = await import('../components/Footer');

describe('Footer', () => {
  it('renders brand, columns and copyright', () => {
    render(<Footer />);

    expect(screen.getByText('AutoCliper')).toBeInTheDocument();
    for (const heading of ['Product', 'Works with', 'Account', 'Legal & support']) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    expect(screen.getByText(/© 2026 AutoCliper/i)).toBeInTheDocument();
  });

  it('links every key destination', () => {
    render(<Footer />);

    const expectHref = (name: RegExp, href: string) => {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
    };

    expectHref(/pricing & credits/i, '/pricing');
    expectHref(/terms of service/i, '/terms');
    expectHref(/privacy policy/i, '/privacy');
    expectHref(/sign in/i, '/login');
    expectHref(/get started — free/i, '/signup');
    expectHref(/contact us/i, '/contact');
    expectHref(/features/i, '/#features');
  });

  it('renders social icons with labels and safe external attributes', () => {
    render(<Footer />);

    for (const label of ['AutoCliper on YouTube', 'AutoCliper on X (Twitter)', 'AutoCliper on Instagram', 'AutoCliper on TikTok']) {
      const link = screen.getByRole('link', { name: label });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    }
  });
});
