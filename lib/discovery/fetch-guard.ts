// Outbound-fetch guard for FUTURE live adapters (T-005 introduces no
// networking). Any adapter that fetches must pass every URL through
// validateFetchUrl first: http/https only, no redirects policy here
// (callers must disable auto-redirect or re-validate each hop), and no
// loopback / private / link-local / cloud-metadata destinations, including
// disguised IPv4 literals (decimal, octal, hex).

export interface FetchUrlCheck {
  ok: boolean;
  reason?: string;
}

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
  "instance-data.compute.internal",
]);

function parseIPv4(host: string): number[] | null {
  // Dotted forms: decimal, octal (0-prefix), hex (0x-prefix) per part.
  if (/^[0-9a-fA-FxX.]+$/.test(host) === false) return null;
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p) && p.length > 1) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    nums.push(n);
  }
  // Expand short forms (a, a.b, a.b.c) to 4 octets.
  let full: number[];
  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    full = nums;
  } else if (nums.length === 1) {
    const n = nums[0];
    full = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  } else if (nums.length === 2) {
    if (nums[0] > 255 || nums[1] > 0xffffff) return null;
    full = [nums[0], (nums[1] >>> 16) & 255, (nums[1] >>> 8) & 255, nums[1] & 255];
  } else {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    full = [nums[0], nums[1], (nums[2] >>> 8) & 255, nums[2] & 255];
  }
  return full;
}

function isBlockedIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 0) return true; // current network
  if (a >= 224) return true; // multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && octets[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
  return false;
}

function isBlockedIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true; // link-local
  if (h === "::" || h.startsWith("::ffff:")) {
    // IPv4-mapped: check the embedded v4 address.
    const tail = h.slice("::ffff:".length);
    if (tail.includes(".")) {
      const v4 = parseIPv4(tail);
      return v4 ? isBlockedIPv4(v4) : true;
    }
    return true;
  }
  if (/^(fc|fd)/.test(h.replace(/:/g, "").slice(0, 2))) return true; // unique-local
  return false;
}

export function validateFetchUrl(input: string): FetchUrlCheck {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "not a parseable URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: "only http/https allowed" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "credentials in URL are forbidden" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host.includes(" ") || host.includes("@"))
    return { ok: false, reason: "invalid hostname" };
  if (host === "localhost" || host.endsWith(".localhost"))
    return { ok: false, reason: "loopback forbidden" };
  if (METADATA_HOSTS.has(host))
    return { ok: false, reason: "cloud metadata forbidden" };
  if (host.includes(":")) {
    if (isBlockedIPv6(host)) return { ok: false, reason: "blocked IPv6 range" };
    return { ok: true };
  }
  const v4 = parseIPv4(host);
  if (v4) {
    if (isBlockedIPv4(v4)) return { ok: false, reason: "blocked IPv4 range" };
    return { ok: true };
  }
  // DNS names: allow (resolution-time TOCTOU is a documented limitation for
  // future live adapters, which must resolve-and-revalidate before connect).
  return { ok: true };
}
