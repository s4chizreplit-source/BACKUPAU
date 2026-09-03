/**
 * YouTube native scheduling (publish_at) — unit tests.
 *
 * Campaigns with a hand-off lead + YouTube-only targets upload the video
 * immediately as a PRIVATE video with status.publishAt = slot, so it sits
 * visibly under "Scheduled" in YouTube Studio during the lead window and
 * YouTube itself publishes it exactly on time. Everything else keeps
 * provider-side scheduling (scheduled_at on the provider post).
 */
import { describe, it, expect } from "vitest";
import { buildPfmPostBody } from "../lib/postforme";
import { youtubeNativePublishAt } from "../routes/social";

const base = { caption: "c", accountIds: ["a1"], mediaUrl: "https://x/m.mp4" };
type YtCfg = { title?: string; privacy_status?: string; publish_at?: string };
const ytOf = (body: Record<string, unknown>): YtCfg =>
  ((body["platform_configurations"] as { youtube?: YtCfg } | undefined)?.youtube ?? {});

describe("buildPfmPostBody", () => {
  it("native mode: private + publish_at, NO provider-side scheduled_at", () => {
    const at = new Date(Date.now() + 30 * 60_000);
    const body = buildPfmPostBody({ ...base, youtubeTitle: "T", scheduledAt: at, youtubePublishAt: at });
    expect(body["scheduled_at"]).toBeUndefined();
    const yt = ytOf(body);
    expect(yt.privacy_status).toBe("private");
    expect(yt.publish_at).toBe(at.toISOString());
    expect(yt.title).toBe("T");
  });

  it("native mode works without a title", () => {
    const at = new Date(Date.now() + 10 * 60_000);
    const body = buildPfmPostBody({ ...base, youtubePublishAt: at });
    expect(body["scheduled_at"]).toBeUndefined();
    expect(ytOf(body).privacy_status).toBe("private");
    expect(ytOf(body).publish_at).toBe(at.toISOString());
  });

  it("provider-side scheduling unchanged when youtubePublishAt is absent", () => {
    const at = new Date(Date.now() + 30 * 60_000);
    const body = buildPfmPostBody({ ...base, scheduledAt: at, youtubeTitle: "T" });
    expect(body["scheduled_at"]).toBe(at.toISOString());
    const yt = ytOf(body);
    expect(yt.title).toBe("T");
    expect(yt.privacy_status).toBeUndefined();
    expect(yt.publish_at).toBeUndefined();
  });

  it("immediate post (no dates) has no schedule fields at all", () => {
    const body = buildPfmPostBody({ ...base });
    expect(body["scheduled_at"]).toBeUndefined();
    expect(body["platform_configurations"]).toBeUndefined();
  });
});

describe("youtubeNativePublishAt", () => {
  const now = Date.now();
  const in30 = new Date(now + 30 * 60_000).toISOString();

  it("campaign + lead + all-YouTube + future slot → the slot datetime", () => {
    const got = youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube", "youtube"],
      scheduledAt: in30, leadMinutes: 10, now,
    });
    expect(got?.toISOString()).toBe(in30);
  });

  it("manual 'schedule' rows never go native", () => {
    expect(youtubeNativePublishAt({
      source: "schedule", platforms: ["youtube"], scheduledAt: in30, leadMinutes: 10, now,
    })).toBeNull();
  });

  it("campaign without a lead keeps provider-side behavior", () => {
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube"], scheduledAt: in30, leadMinutes: null, now,
    })).toBeNull();
  });

  it("mixed platforms keep provider-side behavior", () => {
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube", "instagram"], scheduledAt: in30, leadMinutes: 10, now,
    })).toBeNull();
  });

  it("no platforms → null", () => {
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: [], scheduledAt: in30, leadMinutes: 10, now,
    })).toBeNull();
  });

  it("slot already passed or too close → null (publish normally)", () => {
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube"],
      scheduledAt: new Date(now - 60_000).toISOString(), leadMinutes: 10, now,
    })).toBeNull();
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube"],
      scheduledAt: new Date(now + 60_000).toISOString(), leadMinutes: 10, now,
    })).toBeNull();
  });

  it("missing or invalid slot → null", () => {
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube"], scheduledAt: null, leadMinutes: 10, now,
    })).toBeNull();
    expect(youtubeNativePublishAt({
      source: "campaign", platforms: ["youtube"], scheduledAt: "not-a-date", leadMinutes: 10, now,
    })).toBeNull();
  });
});
