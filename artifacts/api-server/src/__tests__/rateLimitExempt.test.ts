import { describe, it, expect } from "vitest";
import { isGeneralLimiterExempt } from "../lib/rateLimitExempt";

describe("isGeneralLimiterExempt", () => {
  it("exempts high-frequency poll/stream/upload paths (they have dedicated limiters)", () => {
    for (const p of [
      "/yt/progress/abc",
      "/video/upload/chunk",
      "/video/job/3c2ff7b5946919",
      "/video/file/abc123.mp4",
      "/social/clip-status",
    ]) {
      expect(isGeneralLimiterExempt(p), p).toBe(true);
    }
  });

  it("exempts exactly the auth routes that carry their own stricter limiter", () => {
    for (const p of [
      "/auth/login",
      "/auth/signup",
      "/auth/verify-email",
      "/auth/resend-verification",
      "/auth/forgot-password",
      "/auth/reset-password",
    ]) {
      expect(isGeneralLimiterExempt(p), p).toBe(true);
    }
    // /auth/me and /auth/logout stay under the general budget — they have no
    // dedicated limiter, so exempting them would leave them unlimited.
    expect(isGeneralLimiterExempt("/auth/me")).toBe(false);
    expect(isGeneralLimiterExempt("/auth/logout")).toBe(false);
  });

  it("keeps everything else under the general budget", () => {
    for (const p of ["/video/clip", "/video/history", "/ytdlp/download", "/pay/whop/webhook", "/video/jobx"]) {
      expect(isGeneralLimiterExempt(p), p).toBe(false);
    }
  });
});
