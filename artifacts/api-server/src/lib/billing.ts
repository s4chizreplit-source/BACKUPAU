/** INR dual-credit billing. Cutting and provider-uploading are independent. */
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "./db";

/** A generated output costs one cutting credit; a provider hand-off costs one uploading credit. */
export const CREDITS_PER_CLIP = 1;
export const CREDITS_PER_POST = 1;
export type PlanId = "30" | "100" | "250";
type LegacyPlanId = "starter" | "pro";
export type PlanInterval = "monthly" | "yearly";

export interface PlanDef {
  id: PlanId; name: string; tagline: string; monthlyCredits: number;
  priceMonthly: number; priceYearly: number;
}
export const PLANS: Record<PlanId, PlanDef> = {
  "30": { id: "30", name: "30", tagline: "For occasional creators", monthlyCredits: 30, priceMonthly: 199, priceYearly: 1999 },
  "100": { id: "100", name: "100", tagline: "For regular creators", monthlyCredits: 100, priceMonthly: 499, priceYearly: 4999 },
  "250": { id: "250", name: "250", tagline: "For serious creators", monthlyCredits: 250, priceMonthly: 899, priceYearly: 9999 },
};
/** Historical manual-request packs remain readable, but are not sold publicly. */
export const TOPUP_PACKS: never[] = [];
/** Three free generated outputs and three provider hand-offs for new accounts. */
export const SIGNUP_BONUS_CREDITS = 3;
/** Twenty of each credit type (the old 1,000 / 50-credits-per-clip reward). */
export const REFERRAL_REWARD_CREDITS = 20;
export function planPrice(plan: PlanDef, interval: PlanInterval): number {
  return interval === "yearly" ? plan.priceYearly : plan.priceMonthly;
}
export function normalizePlanId(plan: PlanId | LegacyPlanId): PlanId {
  return plan === "starter" ? "100" : plan === "pro" ? "250" : plan;
}

export interface DbUser {
  id: string; email: string; password_hash: string | null; name: string | null;
  role: "user" | "admin"; status: "active" | "disabled";
  plan: "none" | PlanId | LegacyPlanId; plan_interval: PlanInterval | null;
  plan_status: "none" | "active" | "cancelled" | "expired"; paid_until: Date | null; next_refill_at: Date | null;
  sub_credits: number; topup_credits: number; // historical columns
  subscription_cutting_credits: number; subscription_uploading_credits: number;
  topup_cutting_credits: number; topup_uploading_credits: number; legacy_topup_credits: number;
  free_trial: boolean;
  created_at: Date;
}
export interface PublicUser {
  id: string; email: string; name: string | null; role: "user" | "admin"; status: "active" | "disabled";
  plan: DbUser["plan"]; planInterval: PlanInterval | null; planStatus: DbUser["plan_status"]; paidUntil: string | null;
  credits: PublicCredits; createdAt: string;
}
export interface PublicCreditBucket {
  subscription: number;
  topup: number;
  legacy: number;
  total: number;
}
export interface PublicCredits {
  cutting: PublicCreditBucket;
  uploading: PublicCreditBucket;
  /** Deprecated cutting aliases retained while older clients are deployed. */
  sub: number;
  topup: number;
  total: number;
}
export function toPublicUser(row: DbUser): PublicUser {
  const cutting = row.subscription_cutting_credits + row.topup_cutting_credits + row.legacy_topup_credits;
  const uploading = row.subscription_uploading_credits + row.topup_uploading_credits + row.legacy_topup_credits;
  return { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status, plan: row.plan,
    planInterval: row.plan_interval, planStatus: row.plan_status, paidUntil: row.paid_until ? new Date(row.paid_until).toISOString() : null,
    credits: { cutting: { subscription: row.subscription_cutting_credits, topup: row.topup_cutting_credits, legacy: row.legacy_topup_credits, total: cutting },
      uploading: { subscription: row.subscription_uploading_credits, topup: row.topup_uploading_credits, legacy: row.legacy_topup_credits, total: uploading },
      // Deprecated aliases for clients deployed before the dual-bucket UI.
      sub: row.subscription_cutting_credits, topup: row.topup_cutting_credits + row.legacy_topup_credits, total: cutting },
    createdAt: new Date(row.created_at).toISOString() };
}
export function addMonths(d: Date, n: number): Date { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; }
export async function withTx<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect(); try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; }
  catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
}
async function ledger(c: PoolClient, id: string, delta: number, bucket: string, reason: string, meta?: Record<string, unknown>) {
  if (delta) await c.query(`INSERT INTO credit_ledger (user_id, delta, bucket, reason, meta) VALUES ($1,$2,$3,$4,$5)`, [id, delta, bucket, reason, meta ?? null]);
}
async function lockUser(c: PoolClient, id: string) { const r = await c.query<DbUser>(`SELECT * FROM users WHERE id=$1 FOR UPDATE`, [id]); return r.rows[0] ?? null; }

async function refreshLocked(c: PoolClient, row: DbUser): Promise<DbUser> {
  if (row.plan_status !== "active") return row;
  const plan = row.plan === "none" ? null : PLANS[normalizePlanId(row.plan)];
  const now = new Date(); let next = row.next_refill_at && new Date(row.next_refill_at); let status: DbUser["plan_status"] = row.plan_status; let changed = false;
  let cut = row.subscription_cutting_credits, upload = row.subscription_uploading_credits;
  const until = row.paid_until && new Date(row.paid_until);
  // A yearly allowance rolls over: each due month ADDS, never resets.
  while (plan && next && until && next <= now && next < until) {
    cut += plan.monthlyCredits; upload += plan.monthlyCredits;
    await ledger(c, row.id, plan.monthlyCredits, "subscription_cutting", "monthly_refill", { refillAt: next.toISOString() });
    await ledger(c, row.id, plan.monthlyCredits, "subscription_uploading", "monthly_refill", { refillAt: next.toISOString() });
    next = addMonths(next, 1); changed = true;
  }
  // Expiry deliberately retains every balance. Spending checks active status.
  if (until && until <= now) { status = "expired"; next = null; changed = true; }
  if (!changed) return row;
  const r = await c.query<DbUser>(`UPDATE users SET subscription_cutting_credits=$2, subscription_uploading_credits=$3,
    plan_status=$4,next_refill_at=$5 WHERE id=$1 RETURNING *`, [row.id, cut, upload, status, next]);
  return r.rows[0];
}
export async function refreshPlanState(userId: string, db: Pool | null = defaultPool) {
  if (!db) return null; return withTx(db, async c => { const r = await lockUser(c, userId); return r && refreshLocked(c, r); });
}
export async function grantSubscriptionTx(c: PoolClient, userId: string, rawPlan: PlanId | LegacyPlanId, interval: PlanInterval, meta?: Record<string, unknown>): Promise<DbUser> {
  const row = await lockUser(c, userId); if (!row) throw new Error("user not found");
  const planId = normalizePlanId(rawPlan), plan = PLANS[planId], now = new Date(), until = addMonths(now, interval === "yearly" ? 12 : 1);
  const r = await c.query<DbUser>(`UPDATE users SET plan=$2,plan_interval=$3,plan_status='active',paid_until=$4,next_refill_at=$5,
    subscription_cutting_credits=subscription_cutting_credits+$6,subscription_uploading_credits=subscription_uploading_credits+$6 WHERE id=$1 RETURNING *`,
    [userId, planId, interval, until, interval === "yearly" ? addMonths(now, 1) : null, plan.monthlyCredits]);
  await ledger(c,userId,plan.monthlyCredits,"subscription_cutting","subscription_grant",{plan:planId,interval,...meta});
  await ledger(c,userId,plan.monthlyCredits,"subscription_uploading","subscription_grant",{plan:planId,interval,...meta});
  // Historical referral rewards remain a shared compatibility grant so an
  // existing referrer can use it for either kind of work.
  const reward = await c.query<{ referrer_id: string }>(
    `UPDATE referrals SET status='rewarded', rewarded_at=NOW(), reward_credits=$2
     WHERE referred_id=$1 AND rewarded_at IS NULL RETURNING referrer_id`,
    [userId, REFERRAL_REWARD_CREDITS],
  );
  const referrerId = reward.rows[0]?.referrer_id;
  if (referrerId && referrerId !== userId) {
    const granted = await c.query(
      `UPDATE users SET topup_cutting_credits=topup_cutting_credits+$2,
       topup_uploading_credits=topup_uploading_credits+$2 WHERE id=$1 RETURNING id`,
      [referrerId, REFERRAL_REWARD_CREDITS],
    );
    if (granted.rowCount) {
      const rewardMeta = { referredUserId:userId, plan:planId, interval };
      await ledger(c, referrerId, REFERRAL_REWARD_CREDITS, "topup_cutting", "referral_reward", rewardMeta);
      await ledger(c, referrerId, REFERRAL_REWARD_CREDITS, "topup_uploading", "referral_reward", rewardMeta);
    }
  }
  return r.rows[0];
}
export async function grantSubscription(userId: string, p: PlanId | LegacyPlanId, i: PlanInterval, m?: Record<string,unknown>, db: Pool | null = defaultPool) {
  if (!db) throw new Error("DATABASE_URL is not configured"); return withTx(db,c=>grantSubscriptionTx(c,userId,p,i,m));
}
/** Removing access never destroys earned balances; it only blocks spending. */
export async function removePlan(id: string, meta?: Record<string, unknown>, db: Pool | null = defaultPool): Promise<DbUser | null> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, async c => {
    const row = await lockUser(c, id); if (!row) return null;
    const r = await c.query<DbUser>(`UPDATE users SET plan='none',plan_interval=NULL,plan_status='expired',paid_until=NULL,next_refill_at=NULL WHERE id=$1 RETURNING *`, [id]);
    await ledger(c, id, 0, "system", "plan_removed", meta);
    return r.rows[0];
  });
}
/** Compatibility grants use the shared legacy balance; new checkout uses explicit bucket grants. */
export async function grantTopupTx(c: PoolClient, id: string, credits: number, reason: string, meta?: Record<string,unknown>, bucket: "cutting"|"uploading"|"legacy" = "legacy"): Promise<DbUser> {
  const row=await lockUser(c,id); if(!row) throw new Error("user not found"); if (!Number.isInteger(credits) || credits <= 0) throw new Error("credits must be a positive integer");
  const col=bucket==="cutting"?"topup_cutting_credits":bucket==="uploading"?"topup_uploading_credits":"legacy_topup_credits";
  const r=await c.query<DbUser>(`UPDATE users SET ${col}=${col}+$2 WHERE id=$1 RETURNING *`,[id,credits]);
  await ledger(c,id,credits,bucket==="legacy"?"legacy_topup":`topup_${bucket}`,reason,meta); return r.rows[0];
}
export async function grantTopup(id:string,n:number,r:string,m?:Record<string,unknown>,db:Pool|null=defaultPool,b:"cutting"|"uploading"|"legacy"="legacy") {
  if(!db) throw new Error("DATABASE_URL is not configured"); return withTx(db,c=>grantTopupTx(c,id,n,r,m,b));
}
/** Atomically credit equal cutting and uploading amounts (signup/rewards). */
export async function grantDualTopup(
  id: string, credits: number, reason: string, meta?: Record<string, unknown>, db: Pool | null = defaultPool,
): Promise<DbUser> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, async (client) => {
    await grantTopupTx(client, id, credits, reason, meta, "cutting");
    return grantTopupTx(client, id, credits, reason, meta, "uploading");
  });
}

export interface Reservation { ok:true; fromSub:number; fromTopup:number; fromLegacy:number }
export interface ReservationFailed { ok:false; available:number; needed:number }
async function reserve(c:PoolClient,id:string,n:number,kind:"cutting"|"uploading",reason:string,meta?:Record<string,unknown>):Promise<Reservation|ReservationFailed> {
  let row=await lockUser(c,id); if(!row)return {ok:false,available:0,needed:n}; row=await refreshLocked(c,row);
  // A never-subscribed account may spend only its explicit signup trial.
  // Migrated/no-plan balances and all lapsed/cancelled plans stay frozen.
  if (row.plan_status === "expired" || row.plan_status === "cancelled" ||
      (row.plan_status === "none" && !row.free_trial)) {
    return {ok:false,available:0,needed:n};
  }
  const sub=kind==="cutting"?row.subscription_cutting_credits:row.subscription_uploading_credits, top=kind==="cutting"?row.topup_cutting_credits:row.topup_uploading_credits;
  const available=sub+top+row.legacy_topup_credits; if(available<n)return {ok:false,available,needed:n};
  const fromSub=Math.min(sub,n), fromTopup=Math.min(top,n-fromSub), fromLegacy=n-fromSub-fromTopup;
  const subCol=kind==="cutting"?"subscription_cutting_credits":"subscription_uploading_credits", topCol=kind==="cutting"?"topup_cutting_credits":"topup_uploading_credits";
  await c.query(`UPDATE users SET ${subCol}=${subCol}-$2,${topCol}=${topCol}-$3,legacy_topup_credits=legacy_topup_credits-$4 WHERE id=$1`,[id,fromSub,fromTopup,fromLegacy]);
  await ledger(c,id,-fromSub,`subscription_${kind}`,reason,meta); await ledger(c,id,-fromTopup,`topup_${kind}`,reason,meta); await ledger(c,id,-fromLegacy,"legacy_topup",reason,meta);
  return {ok:true,fromSub,fromTopup,fromLegacy};
}
export async function reserveCreditsTx(c:PoolClient,id:string,n:number,reason="clip_reserve",m?:Record<string,unknown>){return reserve(c,id,n,"cutting",reason,m);}
export async function reserveUploadingCreditsTx(c:PoolClient,id:string,n:number,reason="post_reserve",m?:Record<string,unknown>){return reserve(c,id,n,"uploading",reason,m);}
export async function reserveCredits(id:string,n:number,m?:Record<string,unknown>,db:Pool|null=defaultPool){if(!db)throw new Error("DATABASE_URL is not configured");return withTx(db,c=>reserveCreditsTx(c,id,n,"clip_reserve",m));}
async function refund(c:PoolClient,id:string,s:number,t:number,l:number,kind:"cutting"|"uploading",reason:string,m?:Record<string,unknown>) {
  const row=await lockUser(c,id); if(!row)return; const subCol=kind==="cutting"?"subscription_cutting_credits":"subscription_uploading_credits",topCol=kind==="cutting"?"topup_cutting_credits":"topup_uploading_credits";
  // Refund subscription credits to its bucket only while spendability remains active.
  const keepSub=row.plan_status==="active"?s:0, legacy=l+(row.plan_status==="active"?0:s);
  await c.query(`UPDATE users SET ${subCol}=${subCol}+$2,${topCol}=${topCol}+$3,legacy_topup_credits=legacy_topup_credits+$4 WHERE id=$1`,[id,keepSub,t,legacy]);
  await ledger(c,id,keepSub,`subscription_${kind}`,reason,m);await ledger(c,id,t,`topup_${kind}`,reason,m);await ledger(c,id,legacy,"legacy_topup",reason,m);
}
export async function refundCreditsTx(c:PoolClient,id:string,s:number,t:number,reason:string,m?:Record<string,unknown>,legacy=0){return refund(c,id,s,t,legacy,"cutting",reason,m);}
export async function refundUploadingCreditsTx(c:PoolClient,id:string,s:number,t:number,reason:string,m?:Record<string,unknown>,legacy=0){return refund(c,id,s,t,legacy,"uploading",reason,m);}
export async function refundCredits(id:string,s:number,t:number,reason:string,m?:Record<string,unknown>,db:Pool|null=defaultPool,legacy=0){if(!db)throw new Error("DATABASE_URL is not configured");return withTx(db,c=>refundCreditsTx(c,id,s,t,reason,m,legacy));}
/** Admin adjustment defaults to shared compatibility credits. Negative values
 * safely deduct legacy first, then cutting topups/subscription credits. */
export async function adminAdjustCredits(
  id: string, delta: number, meta?: Record<string, unknown>, db: Pool | null = defaultPool,
): Promise<DbUser> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  if (delta > 0) return grantTopup(id, delta, "admin_adjust", meta, db, "legacy");
  if (delta === 0) throw new Error("adjustment must be non-zero");
  return withTx(db, async (client) => {
    const row = await lockUser(client, id);
    if (!row) throw new Error("user not found");
    let remaining = -delta;
    const legacy = Math.min(row.legacy_topup_credits, remaining); remaining -= legacy;
    const topup = Math.min(row.topup_cutting_credits, remaining); remaining -= topup;
    const sub = Math.min(row.subscription_cutting_credits, remaining); remaining -= sub;
    if (remaining) throw new Error("insufficient credits to remove");
    const result = await client.query<DbUser>(
      `UPDATE users SET legacy_topup_credits=legacy_topup_credits-$2,
       topup_cutting_credits=topup_cutting_credits-$3,
       subscription_cutting_credits=subscription_cutting_credits-$4 WHERE id=$1 RETURNING *`,
      [id, legacy, topup, sub],
    );
    await ledger(client, id, -legacy, "legacy_topup", "admin_adjust", meta);
    await ledger(client, id, -topup, "topup_cutting", "admin_adjust", meta);
    await ledger(client, id, -sub, "subscription_cutting", "admin_adjust", meta);
    return result.rows[0];
  });
}