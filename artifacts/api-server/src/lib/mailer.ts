/**
 * Transactional email via the Resend connector (Replit-managed credentials).
 *
 * The Replit connectors proxy handles auth/token refresh; we just POST to
 * Resend's /emails endpoint through it. Never cache the client — construct
 * it fresh per send.
 */
import { logger } from "./logger";

// Resend only lets unverified accounts send from onboarding@resend.dev.
// Set RESEND_FROM_EMAIL once a domain is verified in Resend.
const FROM = process.env.RESEND_FROM_EMAIL || "AutoCliper <onboarding@resend.dev>";

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const payload = JSON.stringify({
    from: FROM,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });

  // Self-hosted path (VPS / Railway): a plain RESEND_API_KEY talks to the
  // Resend API directly — no Replit connector proxy involved.
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const res = apiKey
    ? await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: payload,
      })
    : await (async () => {
        // Replit path. Dynamic import so the API server still boots in
        // environments where the connector SDK / proxy is unavailable —
        // sends just fail loudly.
        const { ReplitConnectors } = await import("@replit/connectors-sdk");
        const connectors = new ReplitConnectors();
        return connectors.proxy("resend", "/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
      })();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body: body.slice(0, 500) }, "email send failed");
    throw new Error(`Email send failed (${res.status})`);
  }
}
