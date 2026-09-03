import { describe, it, expect } from "vitest";
import {
  extractCampaignRequirements,
  enforceCaptionRequirements,
  summarizeRequirements,
  drawtextCtaFilters,
  normalizeCampaignRequirements,
} from "../lib/campaignRequirements";

// The real-world shape this feature was built for: a Whop "Content Rewards"
// rules sheet (Doug Elk's X Oceans campaign, Aug 2026) pasted into the prompt.
const WHOP_DOC = `
Doug Elk's X Oceans — Rules & Requirements
Platforms: TikTok, Instagram Reels, YouTube Shorts
Audience: A minimum of 40% US Audience Required
Clip Length: Must be longer than 15 seconds
Caption: Must tag @watchoceans & @dougelks on all platforms
CTA should be added in the first line of the caption
link to Oceans.com in Bio is mandatory
Must Do / Must Haves:
Ocean's main profile (@watchoceans) & Doug Elk's (@dougelks) must be tagged in the caption of EVERY video
Length: A minimum of 15 seconds. Videos outside this range will be rejected.
Strong hook in the first 3 seconds.
On-screen captions. Required on every video, no exceptions.
Clear call-to-action in the first line of video description AND at the end of each video.
Every caption must tag @watchoceans AND @dougelks and include a natural call-to-action mentioning both.
"Follow @dougelks & @watchoceans for more content like this."
Original content. Your own edits, your own storytelling.
What NOT to Do (Instant Rejection):
No missing caption. Every caption must tag @watchoceans AND @dougelks
No watermarks. No low effort edits. No clips shorter than 15 seconds
`;

describe("extractCampaignRequirements", () => {
  it("parses a real Whop rules sheet: tags, min length, captions, CTA rules", () => {
    const req = extractCampaignRequirements(WHOP_DOC);
    expect(req).not.toBeNull();
    expect(req!.handles).toEqual(["watchoceans", "dougelks"]);
    expect(req!.minClipSeconds).toBe(15); // NOT the "first 3 seconds" hook line
    expect(req!.onScreenCaptions).toBe(true);
    expect(req!.ctaFirstLine).toBe(true);
    expect(req!.endCta).toBe(true);
    expect(req!.ctaText).toBe("Follow @dougelks & @watchoceans for more content like this.");
  });

  it("returns null for pure moment-selection prompts", () => {
    expect(extractCampaignRequirements("clip every moment they talk about money")).toBeNull();
    expect(extractCampaignRequirements("only the funny parts")).toBeNull();
  });

  it("treats @handles as content references when no rules context exists", () => {
    expect(extractCampaignRequirements("clip the parts where @mrbeast appears on screen")).toBeNull();
  });

  it("picks up compulsory tags and hashtags from a short instruction", () => {
    const req = extractCampaignRequirements("caption me tag karo @brandx aur #ad lagao, must include");
    expect(req).not.toBeNull();
    expect(req!.handles).toEqual(["brandx"]);
    expect(req!.hashtags).toEqual(["ad"]);
    expect(req!.ctaText).toBeNull(); // no CTA rule → nothing invented
  });

  it("ignores email addresses when collecting handles", () => {
    const req = extractCampaignRequirements("must tag @realguy, questions to support@whop.com");
    expect(req).not.toBeNull();
    expect(req!.handles).toEqual(["realguy"]);
  });

  it("reads common include/use wording and an unquoted CTA declaration", () => {
    const req = extractCampaignRequirements(
      "For every post description, include @BrandHQ and use #Partner. CTA: Follow @BrandHQ for weekly tips. Put the CTA in the first line.",
    );
    expect(req).not.toBeNull();
    expect(req!.handles).toEqual(["BrandHQ"]);
    expect(req!.hashtags).toEqual(["Partner"]);
    expect(req!.ctaText).toBe("Follow @BrandHQ for weekly tips");
    expect(req!.ctaFirstLine).toBe(true);
  });

  it("preserves literal required caption copy and a no-link instruction", () => {
    const req = extractCampaignRequirements(
      'Content requirements: must write in the caption "T BIRD MOVIE STREAMING NOW". Do not link the FAWESOME streaming link. Directed by @chilla on Instagram.',
    );
    expect(req).not.toBeNull();
    expect(req!.requiredCaptionText).toBe("T BIRD MOVIE STREAMING NOW");
    expect(req!.forbidLinks).toBe(true);
    expect(req!.handles).toEqual(["chilla"]);
  });
});

describe("normalizeCampaignRequirements", () => {
  it("keeps only bounded, well-shaped metadata carried with a clip", () => {
    expect(normalizeCampaignRequirements({
      handles: ["BrandHQ", "brandhq", "../bad"],
      hashtags: ["Partner", "partner", "x"],
      requiredCaptionText: "Watch the full movie tonight",
      ctaText: "Follow @BrandHQ",
      forbidLinks: true,
      ctaFirstLine: true,
      endCta: false,
      minClipSeconds: 20.8,
      onScreenCaptions: true,
    })).toEqual({
      handles: ["BrandHQ"],
      hashtags: ["Partner"],
      requiredCaptionText: "Watch the full movie tonight",
      ctaText: "Follow @BrandHQ",
      forbidLinks: true,
      ctaFirstLine: true,
      endCta: false,
      minClipSeconds: 21,
      onScreenCaptions: true,
    });
  });

  it("does not turn malformed metadata into a publishing rule", () => {
    expect(normalizeCampaignRequirements({ handles: ["../../bad"] })).toBeNull();
  });
});

describe("enforceCaptionRequirements", () => {
  const req = extractCampaignRequirements(WHOP_DOC)!;

  it("prepends the CTA first line and keeps the base caption", () => {
    const out = enforceCaptionRequirements("This part is crazy 🔥 #shorts", req);
    expect(out.split("\n")[0]).toBe("Follow @dougelks & @watchoceans for more content like this.");
    expect(out.toLowerCase()).toContain("@watchoceans");
    expect(out.toLowerCase()).toContain("@dougelks");
    expect(out).toContain("This part is crazy 🔥 #shorts");
  });

  it("is idempotent — enforcing twice changes nothing", () => {
    const once = enforceCaptionRequirements("Wait for the end 😂", req);
    expect(enforceCaptionRequirements(once, req)).toBe(once);
  });

  it("leaves an already-compliant caption untouched", () => {
    const compliant = "Follow @dougelks & @watchoceans for more content like this.\nGreat moment!";
    expect(enforceCaptionRequirements(compliant, req)).toBe(compliant);
  });

  it("compulsory parts survive the length cap; the base gets trimmed", () => {
    const out = enforceCaptionRequirements("x".repeat(3000), req);
    expect(out.length).toBeLessThanOrEqual(2210);
    expect(out.startsWith("Follow @dougelks & @watchoceans")).toBe(true);
  });

  it("an empty caption still gets every compulsory item", () => {
    const out = enforceCaptionRequirements("", req);
    expect(out.split("\n")[0]).toContain("@dougelks");
    expect(out.toLowerCase()).toContain("@watchoceans");
  });

  it("appends missing hashtags for tag-only requirements", () => {
    const tagReq = extractCampaignRequirements("must tag @brandx and use hashtag #ad in the caption")!;
    const out = enforceCaptionRequirements("Nice clip!", tagReq);
    expect(out).toContain("@brandx");
    expect(out).toContain("#ad");
  });

  it("keeps literal campaign copy, credits the required handle, and removes links", () => {
    const req = extractCampaignRequirements(
      'Must write in the caption "T BIRD MOVIE STREAMING NOW". Do not link the FAWESOME streaming link. Directed by @chilla on Instagram.',
    )!;
    const out = enforceCaptionRequirements("आज का सबसे बढ़िया सीन 🔥 https://fawesome.tv/watch", req);
    expect(out).toContain("T BIRD MOVIE STREAMING NOW");
    expect(out).toContain("@chilla");
    expect(out).not.toMatch(/https?:\/\/|www\./i);
  });
});

describe("summarizeRequirements", () => {
  it("names every enforced rule in the user-facing note", () => {
    const req = extractCampaignRequirements(WHOP_DOC)!;
    const s = summarizeRequirements(req, { subtitlesForced: true });
    expect(s).toContain("@watchoceans");
    expect(s).toContain("15s");
    expect(s.toLowerCase()).toContain("captions");
    expect(s).toContain("CTA");
  });
});

describe("drawtextCtaFilters", () => {
  it("builds centered drawtext filters shown over the final seconds", () => {
    const f = drawtextCtaFilters("Follow @dougelks & @watchoceans for more content like this.", 30, 1080, 1920);
    expect(f).not.toBeNull();
    expect(f!.length).toBe(2); // long CTA wraps to two lines
    expect(f![0]).toContain("drawtext=text='");
    expect(f![0]).toContain("enable='gte(t,27.00)'");
    expect(f![0]).toContain("x=(w-text_w)/2");
    // Filtergraph safety: no raw double quotes or % survive from the text.
    expect(f!.join(",")).not.toMatch(/[%"]/);
  });

  it("returns null for too-short clips and non-Latin text", () => {
    expect(drawtextCtaFilters("Follow @x for more", 5, 1080, 1920)).toBeNull();
    expect(drawtextCtaFilters("फॉलो करें @x", 30, 1080, 1920)).toBeNull();
  });

  it("strips apostrophes that would break the filtergraph quoting", () => {
    const f = drawtextCtaFilters("Don't miss Doug Elk's clips", 20, 720, 1280);
    expect(f).not.toBeNull();
    expect(f![0]).toContain("text='Dont miss Doug Elks clips'");
    expect(f![0]).toContain("enable='gte(t,17.00)'");
  });
});

describe("review regressions", () => {
  it("handle boundaries: @dougelks does NOT satisfy a required @dougelk", () => {
    const req = extractCampaignRequirements("must tag @dougelk in the caption")!;
    expect(req.handles).toEqual(["dougelk"]);
    const out = enforceCaptionRequirements("shoutout to @dougelks!", req);
    expect(/@dougelk(?![A-Za-z0-9_.])/i.test(out)).toBe(true);
  });

  it("a trailing sentence period still counts as the handle being present", () => {
    const req = extractCampaignRequirements("must tag @dougelks in the caption")!;
    const compliant = "Great clip @dougelks.";
    expect(enforceCaptionRequirements(compliant, req)).toBe(compliant);
  });

  it("tags that only lived in the trimmed-off tail are re-appended", () => {
    const req = extractCampaignRequirements(
      "must use hashtag #oceans in every caption, minimum of 20 seconds required",
    )!;
    const out = enforceCaptionRequirements("z".repeat(2500) + " #oceans", req);
    expect(out.length).toBeLessThanOrEqual(2200);
    expect(/#oceans(?![A-Za-z0-9_])/i.test(out)).toBe(true);
  });

  it("moment-selection language never triggers enforcement", () => {
    expect(extractCampaignRequirements("find a segment at least 15 seconds long about pricing")).toBeNull();
    expect(extractCampaignRequirements("clip the parts with on-screen captions where he laughs")).toBeNull();
  });

  it("summary is honest when the platform cap beats the campaign minimum", () => {
    const req = extractCampaignRequirements(
      "Length: must be a minimum of 90 seconds. Videos shorter will be rejected.",
    )!;
    expect(req.minClipSeconds).toBe(90);
    const s = summarizeRequirements(req, { minCappedTo: 60 });
    expect(s).toContain("90");
    expect(s).toContain("60");
  });
});
