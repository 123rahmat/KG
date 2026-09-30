/**
 * Outbound network guard for tools that fetch URLs on a user's behalf.
 *
 * A server that fetches arbitrary URLs is a classic SSRF vector: a URL can
 * name, or resolve to, the loopback interface, a private network, or a
 * cloud metadata endpoint. The guard therefore:
 *
 * - accepts only http(s) on ports 80 and 443, without credentials in the URL;
 * - resolves the host itself and rejects any non-public address;
 * - hands the vetted address to the connection (`lookup`), so a second DNS
 *   answer cannot swap in a private address after the check (rebinding).
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

const v4ToInt = address => address.split('.').reduce((sum, part) => (sum << 8) + Number(part), 0) >>> 0;

function blockedV4(address) {
  const value = v4ToInt(address);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (v4ToInt(base) & mask);
  });
}

function parseIpv6(address) {
  const value = String(address ?? '').toLowerCase().split('%')[0];
  const sections = value.split('::');
  if (sections.length > 2) return null;

  const expandSection = section => {
    if (!section) return [];
    const pieces = section.split(':');
    const out = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const octets = piece.split('.').map(Number);
        if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        out.push(((octets[0] << 8) | octets[1]).toString(16));
        out.push(((octets[2] << 8) | octets[3]).toString(16));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        out.push(piece);
      }
    }
    return out;
  };

  const head = expandSection(sections[0]);
  const tail = sections.length === 2 ? expandSection(sections[1]) : [];
  if (!head || !tail) return null;

  const hextets = sections.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  if (hextets.length !== 8) return null;

  return hextets.reduce((valueBigInt, hextet) => (valueBigInt << 16n) | BigInt(parseInt(hextet, 16)), 0n);
}

function prefix(value, bits) {
  return value >> BigInt(128 - bits);
}

function blockedV6(address) {
  const value = parseIpv6(address);
  if (value === null) return true;

  // IPv4-mapped / IPv4-compatible forms must inherit IPv4 restrictions.
  if (prefix(value, 96) === 0xffffn) { // ::ffff:0:0/96
    const embedded = Number(value & 0xffffffffn) >>> 0;
    const octets = [
      (embedded >>> 24) & 255,
      (embedded >>> 16) & 255,
      (embedded >>> 8) & 255,
      embedded & 255
    ];
    return blockedV4(octets.join('.'));
  }

  // Unspecified, loopback and IPv4-compatible address space.
  if (value === 0n || value === 1n || prefix(value, 96) === 0n) return true;

  // RFC 1918/6598/link-local/etc equivalents for IPv6.
  if (prefix(value, 7) === 0x7en // ULA fc00::/7
      || prefix(value, 10) === 0x3fan // link-local fe80::/10
      || prefix(value, 8) === 0xffn // multicast ff00::/8
      || prefix(value, 32) === 0x20010db8n // documentation 2001:db8::/32
      || prefix(value, 32) === 0x64ff9bn // NAT64 64:ff9b::/96
      || prefix(value, 64) === 0x0100000000000000n // discard-only 100::/64
      || prefix(value, 28) === 0x2001001n // ORCHIDv2 / ULA-like special-use 2001:10::/28
      || prefix(value, 16) === 0x2002n) { // 6to4; private IPv4 payloads are handled below
    if (prefix(value, 16) !== 0x2002n) return true;
    const embedded = Number((value >> 80n) & 0xffffffffn) >>> 0;
    const octets = [(embedded >>> 24) & 255, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255];
    return blockedV4(octets.join('.'));
  }

  return false;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4(address);
  if (family === 6) return !blockedV6(address);
  return false;
}

export class GuardError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Validate a URL's shape before any network activity. */
export function checkUrl(raw, { ports = [80, 443] } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new GuardError('Not a valid URL', 'invalid-url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new GuardError('Only http and https URLs are allowed', 'unsupported-scheme');
  if (url.username || url.password) throw new GuardError('URLs with credentials are not allowed', 'credentials-in-url');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ports.includes(port)) throw new GuardError('Only ports 80 and 443 are allowed', 'port-not-allowed');
  return url;
}

/**
 * Resolve a host to one public address, or throw. `resolve` and
 * `isAllowed` are injectable for tests; production uses DNS and the rules
 * above.
 */
export async function resolvePublic(hostname, { resolve = host => dns.lookup(host, { all: true, verbatim: true }), isAllowed = isPublicAddress } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host);
  if (!answers.length) throw new GuardError('The host did not resolve', 'unresolvable-host');
  // Every answer must be public: a client may connect to any of them.
  const blocked = answers.find(answer => !isAllowed(answer.address));
  if (blocked) throw new GuardError('The host resolves to a non-public address', 'non-public-address');
  return answers[0];
}
