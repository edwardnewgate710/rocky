/**
 * @packageDocumentation
 * Unified client identity and IP resolution for the trusted edge boundary.
 *
 * Implements an explicit trusted-hop proxy contract that:
 * 1. Resolves client identity from socket peer address for direct (unproxied) requests.
 * 2. Resolves client identity from `X-Forwarded-For` using right-to-left hop traversal
 *    when operating behind trusted reverse proxies (e.g. nginx, ingress-nginx).
 * 3. Rejects attacker-supplied prefixes in forwarded chains to guarantee spoof resistance.
 * 4. Normalizes IPv4-mapped IPv6 addresses (e.g. `::ffff:192.0.2.1` -> `192.0.2.1`) and IPv6 literals.
 */

import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/** Trusted proxy configuration: boolean toggle or positive hop count. */
export type TrustProxy = boolean | number;

/** Request interface containing headers and socket peer address. */
export interface ClientIpRequestLike {
  readonly headers: IncomingHttpHeaders;
  readonly socket: {
    readonly remoteAddress?: string | undefined;
  };
}

/**
 * Normalizes an IP address into a canonical string representation:
 * - Unmaps IPv4-mapped IPv6 addresses (e.g. `::ffff:192.0.2.1` -> `192.0.2.1`).
 * - Trims whitespace and strips surrounding IPv6 brackets (`[2001:db8::1]` -> `2001:db8::1`).
 * - Lowers case for IPv6 hex characters.
 * - Returns null if input is undefined, empty, or not a valid IPv4/IPv6 address.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.length === 0) return null;

  // Unbracket IPv6 literal if present
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1).trim();
  }

  // IPv4-mapped IPv6: ::ffff:192.0.2.1
  if (ip.toLowerCase().startsWith('::ffff:')) {
    const unmapped = ip.slice(7).trim();
    if (isIP(unmapped) === 4) {
      return unmapped;
    }
  }

  const ver = isIP(ip);
  if (ver === 4) return ip;
  if (ver === 6) return ip.toLowerCase();
  return null;
}

/**
 * Splits an X-Forwarded-For header into trimmed IP entries from left to right.
 */
export function parseForwardedFor(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolves a TRUST_PROXY environment variable value into a boolean or hop count.
 * - undefined, "", "0", "false" -> false (0 hops, direct connection)
 * - "true" -> true (1 hop)
 * - "1", "2", ... -> number (exact hop count)
 * Throws if the value is invalid.
 */
export function resolveTrustProxyEnv(val: string | undefined): TrustProxy {
  if (val === undefined || val === '') return false;
  const lower = val.trim().toLowerCase();
  if (lower === 'false' || lower === '0') return false;
  if (lower === 'true') return true;
  const num = Number(lower);
  if (Number.isSafeInteger(num) && num >= 0) {
    return num === 0 ? false : num;
  }
  throw new Error(
    `resolveConfig: TRUST_PROXY must be "true", "false", or a non-negative integer (received ${JSON.stringify(val)})`,
  );
}

/**
 * Resolves the authentic client IP address according to the explicit trusted-hop contract.
 *
 * - When trustProxy is false or <= 0:
 *   Derives identity strictly from the direct TCP peer socket (`socket.remoteAddress`).
 *   Any forwarded headers are ignored.
 *
 * - When trustProxy is true or > 0:
 *   Trusts `hops` proxy layers (where `true` means 1 hop).
 *   Reads `X-Forwarded-For` from right to left, selecting the entry `hops` places
 *   from the socket peer.
 *   Entries to the left of the trusted boundary are discarded as untrusted client input.
 *   If the header is absent, empty, or has fewer entries than configured hops,
 *   falls back safely to the direct socket remoteAddress.
 */
export function resolveClientIp(
  req: ClientIpRequestLike,
  trustProxy: TrustProxy = false,
): string | null {
  const socketIp = normalizeIp(req.socket.remoteAddress);
  const hops =
    typeof trustProxy === 'number'
      ? trustProxy > 0
        ? trustProxy
        : 0
      : trustProxy
        ? 1
        : 0;

  if (hops === 0) {
    return socketIp;
  }

  const entries = parseForwardedFor(req.headers['x-forwarded-for']);
  if (entries.length >= hops) {
    const targetIndex = entries.length - hops;
    const candidate = entries[targetIndex];
    const normalized = normalizeIp(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return socketIp;
}
