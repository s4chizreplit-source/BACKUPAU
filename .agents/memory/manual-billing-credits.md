---
name: Manual billing & credits
description: Credit/billing architecture decisions for AutoCliper's no-gateway monetization, plus pg/Express typing gotchas hit while building it.
---

# Manual billing & credits (AutoCliper)

**Rule:** All credit grants flow through `grantSubscription`/`grantTopupTx` (transactional, ledger-logged). The manual admin-approval flow (`billing_requests` pending → admin approve) is a thin caller of those functions.
**Why:** Payment gateway (Stripe) comes later — webhooks must be able to call the exact same grant functions so approval logic never forks. Don't build Stripe-specific grant paths.
**How to apply:** When adding Stripe, replace only the "create pending request" step with checkout, and have the webhook call the grant functions with the same metadata; keep `credit_ledger` writes inside the same transaction.

**Economics (since 2026-07-31):** 50 credits = 1 clip; tools also 50 each; $1 = 1,000 credits (Starter $5 = 5,000/mo, Pro $10 = 12,500/mo); signup bonus 150 (= 3 clips). Landing `PricingCards.tsx` hand-mirrors the catalog — keep in sync.

**Rule:** Reserve credits BEFORE any expensive work (esp. paid Zyla starts), settle exactly once, refund partials. Spend sub-bucket first, then top-up.
**Why:** A 402 must fire before money is spent; refunds keep users whole on pipeline failure.

Gotchas learned here:
- node-postgres returns NUMERIC as **string** (`amount_usd`) — compare/format accordingly, don't `===` numbers.
- Express 5 + @types: putting a middleware (e.g. `requireUser`) before a route handler widens `req.params.x` to `string | string[]` — wrap with `String(...)` at first use.
- TS narrows a destructured `let { x } = row` to the narrowed literal type of `row.x` — annotate (`let x: T["x"] = row.x`) when you'll assign other members of the union.
- Session store must reuse the shared pg pool (`lib/db.ts`), or vitest hangs on open handles.

**Rule:** Mark a credit hold settled only AFTER the refund commits; a startup sweep retries unsettled holds idempotently (checks `credit_ledger` for a `clip_refund` with that jobId before re-crediting).
**Why:** Fire-and-forget refunds silently eat user credits on a DB blip; the ledger check makes restart-retries exactly-once.
