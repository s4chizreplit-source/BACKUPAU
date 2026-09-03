import { describe, expect, it } from "vitest";
import { isYoutubeUploadRateLimit } from "../lib/postforme";

describe("isYoutubeUploadRateLimit", () => {
  it("recognizes only YouTube resumable-upload 429 results", () => {
    expect(isYoutubeUploadRateLimit(
      "youtube",
      "Failed to start YouTube resumable upload session: 429 Too Many Requests",
    )).toBe(true);
  });

  it("does not retry other platform failures or permanent YouTube rejections", () => {
    expect(isYoutubeUploadRateLimit("instagram", "429 Too Many Requests")).toBe(false);
    expect(isYoutubeUploadRateLimit("youtube", "YouTube API rate limit: 429 Too Many Requests")).toBe(false);
    expect(isYoutubeUploadRateLimit("youtube", "video is longer than the platform limit")).toBe(false);
  });
});