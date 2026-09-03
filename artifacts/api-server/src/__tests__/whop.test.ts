import { describe, expect, it } from "vitest";
import {
  isWhopPaymentPaid,
  resolveWhopPlan,
  resolveWhopInterval,
  WHOP_STARTER_PLAN_ID,
  WHOP_STARTER_PRICE_USD,
  WHOP_STARTER_YEARLY_PLAN_ID,
  WHOP_STARTER_YEARLY_PRICE_USD,
  WHOP_PRO_PLAN_ID,
  WHOP_PRO_PRICE_USD,
  WHOP_PRO_YEARLY_PLAN_ID,
  WHOP_PRO_YEARLY_PRICE_USD,
  type WhopPaymentSnapshot,
} from "../lib/whop";

const paid = (overrides: Partial<WhopPaymentSnapshot> = {}): WhopPaymentSnapshot => ({
  id: "pay_test123",
  planId: WHOP_PRO_PLAN_ID,
  email: "buyer@example.com",
  currency: "usd",
  subtotal: WHOP_PRO_PRICE_USD,
  status: "paid",
  substatus: "succeeded",
  paidAt: new Date().toISOString(),
  membershipStatus: "active",
  ...overrides,
});

describe("Whop payment validation", () => {
  it("accepts Starter monthly — $7.99 USD", () => {
    const p = paid({ planId: WHOP_STARTER_PLAN_ID, subtotal: WHOP_STARTER_PRICE_USD });
    expect(isWhopPaymentPaid(p)).toBe(true);
    expect(resolveWhopPlan(p)).toBe("starter");
    expect(resolveWhopInterval(p.planId)).toBe("monthly");
  });

  it("accepts Starter yearly — $60 USD", () => {
    const p = paid({ planId: WHOP_STARTER_YEARLY_PLAN_ID, subtotal: WHOP_STARTER_YEARLY_PRICE_USD });
    expect(isWhopPaymentPaid(p)).toBe(true);
    expect(resolveWhopPlan(p)).toBe("starter");
    expect(resolveWhopInterval(p.planId)).toBe("yearly");
  });

  it("accepts Pro monthly — $14.99 USD", () => {
    const p = paid();
    expect(isWhopPaymentPaid(p)).toBe(true);
    expect(resolveWhopPlan(p)).toBe("pro");
    expect(resolveWhopInterval(p.planId)).toBe("monthly");
  });

  it("accepts Pro yearly — $100 USD", () => {
    const p = paid({ planId: WHOP_PRO_YEARLY_PLAN_ID, subtotal: WHOP_PRO_YEARLY_PRICE_USD });
    expect(isWhopPaymentPaid(p)).toBe(true);
    expect(resolveWhopPlan(p)).toBe("pro");
    expect(resolveWhopInterval(p.planId)).toBe("yearly");
  });

  it("rejects an unrecognised plan", () => {
    expect(isWhopPaymentPaid(paid({ planId: "plan_other" }))).toBe(false);
    expect(resolveWhopPlan(paid({ planId: "plan_other" }))).toBeNull();
  });

  it("rejects Starter monthly with wrong amount", () => {
    expect(isWhopPaymentPaid(paid({ planId: WHOP_STARTER_PLAN_ID, subtotal: 7.9 }))).toBe(false);
    expect(isWhopPaymentPaid(paid({ planId: WHOP_STARTER_PLAN_ID, subtotal: 14.99 }))).toBe(false);
  });

  it("rejects Starter yearly with wrong amount", () => {
    expect(isWhopPaymentPaid(paid({ planId: WHOP_STARTER_YEARLY_PLAN_ID, subtotal: 59 }))).toBe(false);
    expect(isWhopPaymentPaid(paid({ planId: WHOP_STARTER_YEARLY_PLAN_ID, subtotal: 7.99 }))).toBe(false);
  });

  it("rejects Pro monthly with wrong amount", () => {
    expect(isWhopPaymentPaid(paid({ subtotal: 7.99 }))).toBe(false);
    expect(isWhopPaymentPaid(paid({ subtotal: 14.9 }))).toBe(false);
  });

  it("rejects non-USD payments", () => {
    expect(isWhopPaymentPaid(paid({ currency: "inr" }))).toBe(false);
    expect(isWhopPaymentPaid(paid({ planId: WHOP_STARTER_PLAN_ID, subtotal: WHOP_STARTER_PRICE_USD, currency: "inr" }))).toBe(false);
  });

  it("rejects pending, failed, and cancelled payments", () => {
    expect(isWhopPaymentPaid(paid({ status: "pending" }))).toBe(false);
    expect(isWhopPaymentPaid(paid({ status: "failed" }))).toBe(false);
    expect(isWhopPaymentPaid(paid({ substatus: "canceled" }))).toBe(false);
  });
});
