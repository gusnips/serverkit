/**
 * Address parsing shared by the URL guard and the client-address reader. Internal: nothing here
 * is exported from the package.
 *
 * `node:net`'s `isIP` is not available in a Worker, so the two forms are parsed here.
 */

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** Dotted decimal only: no leading zeros, no hex, no shorthand. A parser that reads `010` as 8
 *  and one that reads it as 10 would disagree about where it points, so neither reading wins. */
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

export function parseIpv4(text: string): number | null {
  return IPV4.test(text) ? dottedToNumber(text) : null;
}

export function dottedToNumber(dotted: string): number {
  return dotted.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

/** A literal that says it is loopback, bracketed or not. */
export function isLoopbackAddress(address: string): boolean {
  const ip = unbracket(address);
  const v4 = parseIpv4(ip);
  if (v4 !== null) return v4 >>> 24 === 127;
  const groups = ipv6Groups(ip);
  return groups !== null && groups.every((group, i) => group === (i === 7 ? 1 : 0));
}

export function unbracket(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1");
}

/**
 * The eight 16-bit groups of an IPv6 address, or null when it does not parse. A zone id
 * (`fe80::1%eth0`) does not parse: it only ever names a link-local address, which is refused
 * anyway, and one runtime's `BlockList` let exactly that spelling through.
 */
export function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();

  // A dotted IPv4 tail ("::ffff:10.0.0.1") is the last two groups.
  const tail = /:(\d+\.[\d.]*)$/.exec(text);
  if (tail) {
    const v4 = parseIpv4(tail[1] ?? "");
    if (v4 === null) return null;
    text = `${text.slice(0, tail.index + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}
