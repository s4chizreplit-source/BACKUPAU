---
name: ZapUPI UPI payments
description: Trust model and gotchas for the ZapUPI gateway integration (unsigned webhook, idempotent confirm)
---

# ZapUPI UPI payments

- Single credential: `ZAPUPI_ZAP_KEY` (their "zap_key"). **Live API accepts ONLY JSON bodies** at pay.zapupi.com (create-order / order-status) — their docs' form-encoded examples return "Invalid JSON format"; wrong key-field names return "Invalid Zap Key". Verified against the real gateway. No webhook signature exists.
- **Rule: the webhook body is a HINT, never proof.** Only the order_id (regex-gated) is read from it; payment state is always re-fetched from the gateway's order-status API server-side before any grant. Webhook always answers 200 so the gateway doesn't retry-flood.
- Confirm is idempotent under webhook + return-page-poll races: gateway status fetched BEFORE the row lock, then SELECT FOR UPDATE + terminal-state re-check inside the transaction; grant (same fns as admin manual approval) and the paid flip commit atomically.
- **Never grant on anomalies** — amount mismatch or gateway test-env payment hitting prod parks the order as `review` for the admin panel instead.
- ZapUPI may report a successful collection at exactly one paise above the requested amount (observed ₹199.01 for ₹199). Accept only exact or +₹0.01; underpayments and larger differences stay in review.
- Return page polls order status every few seconds; pending polls trigger the same confirm path, so payments activate even if the webhook never arrives.
- Billing catalog advertises UPI prices only when the key is configured → UI payment buttons appear automatically once the secret is saved; nothing else to flip.
- Production ZapUPI requests must use an explicit `node:https` IPv4 socket (`family: 4`). DNS `ipv4first` is insufficient because Undici may still race families and fail with an empty-cause `fetch failed`.

**Why:** unsigned-webhook gateways make forged callbacks trivial; double-confirm + idempotent locked grant is the only safe pattern.
**How to apply:** any new payment provider without signed webhooks (or Stripe work building on this billing code) must keep the re-fetch-before-grant + row-lock shape.

## Redirect back to our site (root-caused from a real payment)
- Website/backend orders require all three query-free fields: `success_url`, `failed_url`, and `timeout_url`. The gateway appends `?order_id=<id>&utr=...`. Do not use the unsupported `redirect_url`.
- **Why:** a real payment using `redirect_url` stayed on ZapUPI's `panel.zapupi.com/order?id=...` 404. ZapUPI's current backend integration docs specify the three outcome URLs instead.
- **How to apply:** point all three outcome URLs to the same return page, which must re-fetch status server-side and activate only after verification; retain the localStorage order-id fallback.
