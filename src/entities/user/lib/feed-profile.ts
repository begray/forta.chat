import type { User } from "../model/types";

function decode(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A raw `getuserprofile` row (as `rpc-ex` attaches to feed pages: `name`,
 * `i` image, `a` about, `s` site, `l` language) → our User. Null without an
 * address.
 */
export function feedProfileToUser(row: Record<string, unknown>): User | null {
  const address = typeof row.address === "string" ? row.address : "";
  if (!address) return null;
  return {
    address,
    name: decode(row.name),
    about: decode(row.a),
    image: typeof row.i === "string" ? row.i : "",
    site: decode(row.s),
    language: typeof row.l === "string" ? row.l : "",
    cachedAt: Date.now(),
  };
}
