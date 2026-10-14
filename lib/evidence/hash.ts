// Content hashing for observations (T-007). Canonical form is
// url + newline + excerpt (no timestamps), so identical captures hash
// identically across runs while any content change alters the digest.

import { createHash } from "crypto";

export function observationHash(url: string, excerpt: string | null): string {
  return createHash("sha256")
    .update(`${url}\n${excerpt ?? ""}`, "utf8")
    .digest("hex");
}
