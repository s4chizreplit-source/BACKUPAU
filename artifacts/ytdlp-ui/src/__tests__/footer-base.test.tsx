/**
 * Footer under a non-root BASE_URL — hash anchors must carry the base prefix
 * (route links go through wouter, which handles base itself).
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('BASE_URL', '/app/');

vi.mock('wouter', () => ({
  Link: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const { Footer } = await import('../components/Footer');

describe('Footer under subpath deployment', () => {
  it('prefixes hash anchors with BASE_URL', () => {
    render(<Footer />);

    expect(screen.getByRole('link', { name: /^features$/i })).toHaveAttribute('href', '/app/#features');
  });
});
