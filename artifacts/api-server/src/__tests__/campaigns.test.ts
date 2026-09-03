/**
 * Pure-logic tests for Auto-Pilot campaigns — day selection, slot planning,
 * range math and timezone "today". No network, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  todayInTz, rangeDays, nextMaterializeDate, planDaySlots, nextRunAt,
  sanitizeClipParams, parseLeadMinutes, campaignCaptionMode, resolveCampaignCaption,
} from "../routes/campaigns";

describe("campaign caption modes", () => {
  const base = { source_kind: "folder" };

  it("uses the readable filename only in filename mode", () => {
    const c = { ...base, caption: "", ai_captions: false };
    expect(campaignCaptionMode(c as never)).toBe("filename");
    expect(resolveCampaignCaption(c as never, "english_subtitle-(10).mp4", "seed"))
      .toBe("english subtitle (10)");
  });

  it("uses exactly the same saved text in custom mode", () => {
    const c = { ...base, caption: "Use this exact caption #brand", ai_captions: false };
    expect(campaignCaptionMode(c as never)).toBe("custom");
    expect(resolveCampaignCaption(c as never, "one.mp4", "one")).toBe("Use this exact caption #brand");
    expect(resolveCampaignCaption(c as never, "two.mp4", "two")).toBe("Use this exact caption #brand");
  });

  it("uses the AI result in AI mode and never falls back to the filename", () => {
    const c = { ...base, caption: "", ai_captions: true };
    expect(campaignCaptionMode(c as never)).toBe("ai");
    expect(resolveCampaignCaption(c as never, "english subtitle (1).mp4", "seed", "AI wrote this 🔥\n#viral"))
      .toBe("AI wrote this 🔥\n#viral");
    const fallback = resolveCampaignCaption(c as never, "english subtitle (1).mp4", "seed", null);
    expect(fallback).not.toBe("english subtitle (1)");
    expect(fallback).toMatch(/#[A-Za-z0-9_]+/);
  });
});

describe("sanitizeClipParams", () => {
  it("returns null for anything that isn't an object (legacy rows stay null)", () => {
    expect(sanitizeClipParams(undefined)).toBeNull();
    expect(sanitizeClipParams(null)).toBeNull();
    expect(sanitizeClipParams("5 clips")).toBeNull();
    expect(sanitizeClipParams(7)).toBeNull();
    expect(sanitizeClipParams([{ clipCount: 5 }])).toBeNull();
  });

  it("keeps valid settings as-is", () => {
    expect(sanitizeClipParams({ clipCount: 12, quality: "fast" })).toEqual({ clipCount: 12, quality: "fast" });
    expect(sanitizeClipParams({ clipCount: "7", quality: "quality" })).toEqual({ clipCount: 7, quality: "quality" });
  });

  it("clamps the count into 1..50 and falls back to defaults on junk", () => {
    expect(sanitizeClipParams({ clipCount: 999 })).toEqual({ clipCount: 50, quality: "quality" });
    expect(sanitizeClipParams({ clipCount: 0 })).toEqual({ clipCount: 1, quality: "quality" });
    expect(sanitizeClipParams({ clipCount: 3.5, quality: "weird" })).toEqual({ clipCount: 5, quality: "quality" });
    expect(sanitizeClipParams({})).toEqual({ clipCount: 5, quality: "quality" });
  });
});

describe("todayInTz", () => {
  it("rolls the date at the zone's midnight, not UTC's", () => {
    // 2026-08-11 20:00 UTC = 2026-08-12 01:30 IST
    const now = new Date("2026-08-11T20:00:00.000Z");
    expect(todayInTz("Asia/Kolkata", now)).toBe("2026-08-12");
    expect(todayInTz("UTC", now)).toBe("2026-08-11");
    expect(todayInTz("America/New_York", now)).toBe("2026-08-11");
  });
});

describe("rangeDays", () => {
  it("is inclusive", () => {
    expect(rangeDays("2026-08-11", "2026-08-11")).toBe(1);
    expect(rangeDays("2026-08-11", "2026-08-21")).toBe(11);
  });
  it("crosses month/leap boundaries", () => {
    expect(rangeDays("2028-02-28", "2028-03-01")).toBe(3); // 2028 is a leap year
  });
});

describe("nextMaterializeDate", () => {
  const range = { start_date: "2026-08-11", end_date: "2026-08-21" };
  it("starts at start_date on the first run", () => {
    expect(nextMaterializeDate({ ...range, last_planned_date: null }, "2026-08-11"))
      .toBe("2026-08-11");
  });
  it("waits when the campaign starts in the future", () => {
    expect(nextMaterializeDate({ ...range, last_planned_date: null }, "2026-08-09"))
      .toBeNull();
  });
  it("plans the next day after the last planned one", () => {
    expect(nextMaterializeDate({ ...range, last_planned_date: "2026-08-11" }, "2026-08-12"))
      .toBe("2026-08-12");
  });
  it("does nothing twice on the same day", () => {
    expect(nextMaterializeDate({ ...range, last_planned_date: "2026-08-12" }, "2026-08-12"))
      .toBeNull();
  });
  it("skips days missed during downtime instead of backfilling", () => {
    expect(nextMaterializeDate({ ...range, last_planned_date: "2026-08-12" }, "2026-08-17"))
      .toBe("2026-08-17");
  });
  it("stops after the end date", () => {
    expect(nextMaterializeDate({ ...range, last_planned_date: "2026-08-21" }, "2026-08-22"))
      .toBeNull();
    expect(nextMaterializeDate({ ...range, last_planned_date: null }, "2026-08-25"))
      .toBeNull();
  });
  it("re-clamps to start_date when the range was moved forward", () => {
    expect(nextMaterializeDate(
      { start_date: "2026-09-01", end_date: "2026-09-10", last_planned_date: "2026-08-12" },
      "2026-09-01",
    )).toBe("2026-09-01");
  });
});

describe("planDaySlots", () => {
  const noon = new Date("2026-08-11T00:00:00.000Z").getTime(); // midnight UTC
  it("repeats each time per_slot times, sorted", () => {
    const slots = planDaySlots(["18:00", "09:00"], 2, "2026-08-11", "UTC", noon);
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-08-11T09:00:00.000Z", "2026-08-11T09:00:00.000Z",
      "2026-08-11T18:00:00.000Z", "2026-08-11T18:00:00.000Z",
    ]);
  });
  it("recovers a slot missed within the grace at now+5min; drops older ones", () => {
    const at1730 = new Date("2026-08-11T17:30:00.000Z").getTime();
    const slots = planDaySlots(["17:10", "09:00", "18:00"], 1, "2026-08-11", "UTC", at1730);
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-08-11T17:35:00.000Z", // 17:10 passed 20 min ago (≤ grace) → now+5
      "2026-08-11T18:00:00.000Z", // still ahead → untouched
      // 09:00 missed by hours → NOT posted today (video rides tomorrow's slot)
    ]);
    // <5 min out counts as passed too; per_slot videos share the recovered time
    const at1757 = new Date("2026-08-11T17:57:00.000Z").getTime();
    expect(planDaySlots(["18:00"], 3, "2026-08-11", "UTC", at1757).map((s) => s.toISOString())).toEqual([
      "2026-08-11T18:02:00.000Z", "2026-08-11T18:02:00.000Z", "2026-08-11T18:02:00.000Z",
    ]);
  });
  it("mid-day creation posts ONLY remaining times — no same-day burst (user bug)", () => {
    // Created 17:50 IST with times 12:00/16:00/18:00 IST — the old catch-up
    // fired all three within ~10 minutes; only 18:00 IST (12:30 UTC) is due.
    const at1750ist = new Date("2026-08-21T12:20:00.000Z").getTime();
    const slots = planDaySlots(["12:00", "16:00", "18:00"], 1, "2026-08-21", "Asia/Kolkata", at1750ist);
    expect(slots.map((s) => s.toISOString())).toEqual(["2026-08-21T12:30:00.000Z"]);
  });
  it("every slot long-passed → empty plan (day consumed, videos wait)", () => {
    const at1700 = new Date("2026-08-11T17:00:00.000Z").getTime();
    expect(planDaySlots(["07:00", "09:00"], 1, "2026-08-11", "UTC", at1700)).toEqual([]);
  });
  it("staggers several recovered slots 10 min apart", () => {
    const at1700 = new Date("2026-08-11T17:00:00.000Z").getTime();
    const slots = planDaySlots(["16:40", "16:50"], 1, "2026-08-11", "UTC", at1700);
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-08-11T17:05:00.000Z", "2026-08-11T17:15:00.000Z",
    ]);
  });
  it("converts wall time in the campaign timezone", () => {
    const slots = planDaySlots(["16:00"], 2, "2026-08-11", "Asia/Kolkata", noon);
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-08-11T10:30:00.000Z", "2026-08-11T10:30:00.000Z",
    ]);
  });
});

describe("nextRunAt", () => {
  const c = { times: ["16:00"], start_date: "2026-08-11", end_date: "2026-08-21", timezone: "UTC" };
  it("returns today's slot when it is still ahead", () => {
    const now = new Date("2026-08-11T08:00:00.000Z");
    expect(nextRunAt(c, now)?.toISOString()).toBe("2026-08-11T16:00:00.000Z");
  });
  it("shows a catch-up in minutes when a slot passed within the grace", () => {
    const now = new Date("2026-08-11T16:10:00.000Z");
    expect(nextRunAt(c, now)?.toISOString()).toBe("2026-08-11T16:15:00.000Z");
  });
  it("rolls to tomorrow when today's slot passed beyond the grace", () => {
    const now = new Date("2026-08-11T17:00:00.000Z");
    expect(nextRunAt(c, now)?.toISOString()).toBe("2026-08-12T16:00:00.000Z");
  });
  it("rolls to tomorrow when today was already planned", () => {
    const now = new Date("2026-08-11T17:00:00.000Z");
    expect(nextRunAt({ ...c, last_planned_date: "2026-08-11" }, now)?.toISOString())
      .toBe("2026-08-12T16:00:00.000Z");
  });
  it("returns null once the last day is planned and its slot passed", () => {
    const now = new Date("2026-08-21T17:00:00.000Z");
    expect(nextRunAt({ ...c, last_planned_date: "2026-08-21" }, now)).toBeNull();
  });
  it("returns null after the range ends", () => {
    const now = new Date("2026-08-22T01:00:00.000Z");
    expect(nextRunAt(c, now)).toBeNull();
  });
  it("returns the first start-date slot for future campaigns", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    expect(nextRunAt(c, now)?.toISOString()).toBe("2026-08-11T16:00:00.000Z");
  });
});

describe("parseLeadMinutes (schedule-ahead window)", () => {
  it("absent/null/empty clear the setting (hand off immediately)", () => {
    expect(parseLeadMinutes(undefined)).toEqual({ ok: true, value: null });
    expect(parseLeadMinutes(null)).toEqual({ ok: true, value: null });
    expect(parseLeadMinutes("")).toEqual({ ok: true, value: null });
  });

  it("accepts whole minutes within 5..1440, numbers or numeric strings", () => {
    expect(parseLeadMinutes(5)).toEqual({ ok: true, value: 5 });
    expect(parseLeadMinutes("90")).toEqual({ ok: true, value: 90 });
    expect(parseLeadMinutes(1440)).toEqual({ ok: true, value: 1440 });
  });

  it("rejects out-of-range and junk values", () => {
    for (const bad of [4, 1441, 0, -10, 2.5, "abc", {}, [], true]) {
      expect(parseLeadMinutes(bad).ok).toBe(false);
    }
  });
});
