/**
 * SSRF protection utilities.
 *
 * Blocks user-supplied URLs that point to private/loopback/link-local
 * addresses, cloud-metadata endpoints, and other internal hosts before
 * they are handed to yt-dlp, ffmpeg, or any outbound HTTP client.
 *
 * Coverage:
 *  - IPv4 private/reserved ranges (RFC 1918, loopback, link-local, CGNAT, …)
 *  - IPv6 private/reserved ranges (loopback, ULA, link-local, unspecified)
 *  - IPv4-mapped IPv6 (::ffff:w.x.y.z  AND  ::ffff:XXXX:XXXX hex form)
 *  - IPv4-compatible IPv6 (::w.x.y.z — deprecated but still accepted by some stacks)
 *  - Known internal hostnames (localhost, cloud metadata names)
 *  - Node.js WHATWG URL normalises octal/hex IPv4 literals before we inspect them
 */

import * as net from "net";
import { lookup as dnsLookup } from "node:dns/promises";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `addr` is a private/reserved/loopback IPv4 address.
 * `addr` MUST be a valid dotted-decimal IPv4 string.
 */
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true; // malformed → block
  const [a, b, c] = parts;

  if (a === 0) return true;                                      // "this" network (0.x.x.x)
  if (a === 10) return true;                                     // RFC 1918 class A
  if (a === 127) return true;                                    // loopback
  if (a === 100 && b >= 64 && b <= 127) return true;            // RFC 6598 CGNAT
  if (a === 169 && b === 254) return true;                       // link-local / APIPA / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;             // RFC 1918 class B
  if (a === 192 && b === 0 && c === 2) return true;             // TEST-NET-1
  if (a === 192 && b === 168) return true;                       // RFC 1918 class C
  if (a === 198 && b === 18) return true;                        // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;          // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;           // TEST-NET-3
  if (a >= 224) return true;                                     // multicast + reserved + broadcast

  return false;
}

/**
 * Returns true when `addr` is a private/reserved IPv6 address.
 * Also detects IPv4-mapped and IPv4-compatible IPv6 forms and delegates
 * to `isPrivateIPv4`.
 *
 * `addr` MUST be a valid IPv6 string (brackets already removed).
 */
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();

  // Unspecified / loopback
  if (lower === "::" || lower === "::1") return true;

  // ULA (fc00::/7) — fc:: and fd::
  if (/^f[cd][0-9a-f]{0,2}:/i.test(lower)) return true;

  // Link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;

  // IPv4-mapped:  ::ffff:w.x.y.z  or  ::ffff:XXXX:XXXX
  if (lower.startsWith("::ffff:")) {
    const rest = lower.slice(7); // strip "::ffff:"

    // Mixed notation: ::ffff:127.0.0.1
    if (net.isIPv4(rest)) return isPrivateIPv4(rest);

    // Pure hex notation: ::ffff:7f00:0001
    const hexPair = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIPv4(ipv4);
    }

    // Any other ::ffff: variant — block conservatively
    return true;
  }

  // IPv4-compatible (deprecated, ::w.x.y.z) — still parseable by some stacks
  if (lower.startsWith("::") && lower.includes(".")) {
    const rest = lower.slice(2);
    if (net.isIPv4(rest)) return isPrivateIPv4(rest);
    return true; // malformed but smells internal — block
  }

  return false;
}

/** Exact hostnames that are always blocked regardless of protocol. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal", // GCP metadata
  "instance-data",             // some cloud environments
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the URL is safe to fetch server-side:
 *  - scheme is `http:` or `https:`
 *  - hostname is not a loopback, private-range, reserved, or known-internal host
 *
 * The WHATWG URL parser normalises octal/hex IPv4 literals before we
 * inspect them, so `http://0x7f000001/` → hostname `127.0.0.1` → blocked.
 *
 * Note: this is a *syntactic/literal* guard. It does not resolve DNS, so a
 * public hostname that DNS-resolves to a private IP (DNS rebinding) is not
 * caught here. For production hardening consider also a connect-time check.
 */
export function isSafePublicUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  // Strip IPv6 brackets: "[::1]" → "::1"
  // Also strip trailing dot: "localhost." → "localhost" (FQDN form accepted by WHATWG URL)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return false;

  if (BLOCKED_HOSTNAMES.has(host)) return false;

  if (net.isIPv4(host)) return !isPrivateIPv4(host);
  if (net.isIPv6(host)) return !isPrivateIPv6(host);

  // Plain hostname — reject anything that looks like a bare numeric address
  // that net.isIPv4/isIPv6 didn't recognise (extra safety for odd encodings).
  // Normal public domain names pass through.
  return true;
}

/** true when `addr` (IPv4 or IPv6 string) is private/reserved/loopback. */
export function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) return isPrivateIPv4(addr);
  if (net.isIPv6(addr)) return isPrivateIPv6(addr);
  return true; // unparseable → treat as internal
}

type LookupFn = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: LookupFn = async (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Strict SSRF check for URLs we (or a third party on our behalf) will fetch:
 * the literal `isSafePublicUrl` guard PLUS a DNS resolution — every address
 * the hostname resolves to must be public. Catches public-looking hostnames
 * that resolve to loopback/RFC1918/metadata targets (DNS-rebinding setups).
 *
 * Resolution failures return false (fail closed). Run it at enqueue AND again
 * right before use — a later re-resolve shrinks the rebinding window.
 * `lookupFn` is injectable for tests.
 */
export async function urlResolvesPublic(raw: string, lookupFn: LookupFn = defaultLookup): Promise<boolean> {
  if (!isSafePublicUrl(raw)) return false;
  const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  // IP literals were already fully validated by the literal guard
  if (net.isIPv4(host) || net.isIPv6(host)) return true;
  try {
    const addrs = await lookupFn(host);
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false; // NXDOMAIN / resolver down → never hand the URL onward
  }
}
