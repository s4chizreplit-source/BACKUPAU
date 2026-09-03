/**
 * sendEmail — direct Resend API path (RESEND_API_KEY set, e.g. on a VPS).
 * The Replit-connector path needs the live proxy, so only the self-hosted
 * branch is unit-tested here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmail } from "../lib/mailer";

const ORIG_KEY = process.env.RESEND_API_KEY;

describe("sendEmail (direct Resend API via RESEND_API_KEY)", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key_123";
  });

  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIG_KEY;
    vi.unstubAllGlobals();
  });

  it("POSTs to api.resend.com with the bearer key and full payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({
      to: "user@example.com",
      subject: "Reset your password",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key_123");
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("Reset your password");
    expect(body.html).toBe("<p>hi</p>");
    expect(body.text).toBe("hi");
    expect(typeof body.from).toBe("string");
    expect(body.from.length).toBeGreaterThan(0);
  });

  it("throws loudly when Resend rejects the send", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"invalid from"}',
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendEmail({ to: "u@e.com", subject: "s", html: "<p>h</p>", text: "h" }),
    ).rejects.toThrow(/Email send failed \(422\)/);
  });
});
