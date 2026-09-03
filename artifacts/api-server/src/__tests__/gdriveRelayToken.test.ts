/**
 * Stateless Drive relay tokens — the only auth on the public media relay
 * (the posting provider fetches campaign videos through it at publish time).
 * Sign/verify roundtrip, expiry, tamper-resistance.
 */
import { describe, it, expect } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret";
const { createGDriveRelayToken, verifyGDriveRelayToken } = await import("../lib/gdriveRelayToken");

const ID = "1AbC-dEfGhIjKlMnOpQrStUvWxYz12345";

describe("gdrive relay tokens", () => {
  it("roundtrip: verify returns the file id", () => {
    expect(verifyGDriveRelayToken(createGDriveRelayToken(ID))).toBe(ID);
  });

  it("expired token → null", () => {
    const t = createGDriveRelayToken(ID, Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(verifyGDriveRelayToken(t)).toBeNull();
  });

  it("tampered file id → null", () => {
    const t = createGDriveRelayToken(ID);
    const tampered = (t[0] === "X" ? "Y" : "X") + t.slice(1);
    expect(verifyGDriveRelayToken(tampered)).toBeNull();
  });

  it("tampered signature → null", () => {
    const t = createGDriveRelayToken(ID);
    const tampered = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifyGDriveRelayToken(tampered)).toBeNull();
  });

  it("garbage tokens → null", () => {
    expect(verifyGDriveRelayToken("")).toBeNull();
    expect(verifyGDriveRelayToken("not-a-token")).toBeNull();
    expect(verifyGDriveRelayToken("../../etc/passwd")).toBeNull();
    expect(verifyGDriveRelayToken(`${ID}.9999999999999`)).toBeNull(); // no signature
  });

  it("custom TTL covers far-future publishes (provider fetches at publish time)", () => {
    const now = Date.now();
    const t = createGDriveRelayToken(ID, now, 90 * 24 * 60 * 60 * 1000);
    expect(verifyGDriveRelayToken(t, now + 80 * 24 * 60 * 60 * 1000)).toBe(ID);
    expect(verifyGDriveRelayToken(t, now + 100 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("TTL is clamped to a sane maximum", () => {
    const now = Date.now();
    const t = createGDriveRelayToken(ID, now, 10 * 365 * 24 * 60 * 60 * 1000);
    expect(verifyGDriveRelayToken(t, now + 401 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("invalid file ids are rejected at create time", () => {
    expect(() => createGDriveRelayToken("short")).toThrow();
    expect(() => createGDriveRelayToken("has/slash-but-otherwise-long-enough")).toThrow();
  });
});
