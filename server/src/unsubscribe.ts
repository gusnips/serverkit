/**
 * The two headers that give a mail client its own unsubscribe button: RFC 2369's link and RFC
 * 8058's one-click POST.
 *
 * nodemailer has a `list.unsubscribe` option, and it writes only the first. Its `comment` form
 * lands inside that same header, so no version from 6 to 10 writes `List-Unsubscribe-Post` at
 * all. Two backends passed it believing otherwise, and their tests checked the options object
 * they handed over, not the mail that went out. Gmail and Yahoo ask bulk senders for both
 * headers. So this returns a plain record, which fits nodemailer's `headers`, Resend's `headers`,
 * or a message you build yourself.
 */

/**
 * `List-Unsubscribe: <url>`, plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` when the
 * link is https, because mail providers POST to it and RFC 8058 requires https for that.
 *
 *     headers: listUnsubscribeHeaders(`https://example.com/unsubscribe?token=${token}`)
 *
 * Throws a TypeError for anything but an http or https link. A `mailto:` would need a mailbox
 * that somebody reads for it.
 */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  // `href` percent-encodes spaces, `<` and `>`, and drops line breaks, so nothing in it can close
  // the angle brackets or start a second header.
  const link = URL.parse(url);
  if (link?.protocol !== "https:" && link?.protocol !== "http:")
    throw new TypeError(`An unsubscribe link is an http or https URL, not ${JSON.stringify(url)}`);
  const headers: Record<string, string> = { "List-Unsubscribe": `<${link.href}>` };
  if (link.protocol === "https:") headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return headers;
}
