/**
 * The plain-text part of a mail, read out of its HTML.
 *
 * A mail needs one beside its HTML (see `/mail`), and the senders that built it by stripping tags
 * dropped every link's address with them: an adopter's payment reminder said "Pay now" and gave
 * nothing to pay at. So a link keeps its address. It takes a body fragment or a whole document,
 * because one adopter renders fragments and another renders full pages from templates. It has no
 * dependencies and runs in a Worker, so it serves Resend's `text` as well as `createMailer`'s.
 */

/** What a reader never sees: comments, and the head, styles and scripts with their contents. */
const HIDDEN = /<!--[\s\S]*?-->|<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// `(?:[^>]*?\s)?href` and not `\bhref`, so `data-href` is not taken for the link.
const LINK =
  /<a\b(?:[^>]*?\s)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const PARAGRAPH = /<\/?(?:p|h[1-6]|table|ul|ol|blockquote|pre|hr)\b[^>]*>/gi;
const LINE = /<\/?(?:div|tr|li|dt|dd|header|footer|section|article|main|nav|aside)\b[^>]*>/gi;
// Where a block starts or ends. Two in a row are one boundary, as in a browser, where `</tr><tr>`
// is one line break and `</p><p>` one gap; a `<br>` is a newline of its own and never merges.
const GAP = "\ue000";
const BREAK = "\ue001";
const GAPS = /[ \ue001\ue000]*\ue000[ \ue001\ue000]*/g;
const BREAKS = /[ \ue001]*\ue001[ \ue001]*/g;
const TAG = /<\/?[a-z][^>]*>|<![^>]*>/gi;
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
};

/**
 * One pass, so `&amp;lt;` reads `&lt;` and is never decoded twice. A named entity outside the
 * table above is left as written. A number HTML refuses (0, a surrogate, past U+10FFFF) reads as
 * U+FFFD, as it does in a browser.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? entity;
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex ?? "", 16);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : "�";
  });
}

/**
 *     textFromHtml('<p>Your invoice is due.</p><a href="https://example.test/pay">Pay now</a>');
 *     // → "Your invoice is due.\n\nPay now: https://example.test/pay"
 *
 * - A link reads `label: address`. A label that already is the address (`mailto:` aside) prints
 *   once, and a link with no text, such as an image, prints the address alone.
 * - Paragraphs, headings, lists and tables end in a blank line, and `<br>`, rows and `<div>` in a
 *   line break. A list item starts with `- `. Never more than one blank line in a row.
 * - Whitespace collapses the way HTML collapses it, and each line is trimmed. `<pre>` is not
 *   kept as written.
 * - Images are dropped. HTML with no text answers `""`, which `createMailer`'s `send` refuses.
 */
export function textFromHtml(html: string): string {
  return decodeEntities(
    html
      .replace(HIDDEN, "")
      .replace(/[\s\ue001\ue000]+/g, " ")
      .replace(LINK, (_link, double?: string, single?: string, bare?: string, inner = "") => {
        const label = inner.replace(TAG, "").trim();
        // Still encoded, like the rest of the text; the one decode at the end reads both. A raw
        // `<` in the address would look like a tag to the next step, so it goes in encoded too.
        const address = (double ?? single ?? bare ?? "")
          .replace(/^mailto:/i, "")
          .replace(/</g, "&lt;");
        if (!label || decodeEntities(label) === decodeEntities(address)) return address || label;
        return `${label}: ${address}`;
      })
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, `${BREAK}- `)
      .replace(PARAGRAPH, GAP)
      .replace(LINE, BREAK)
      .replace(/<\/t[dh]\s*>/gi, " ")
      .replace(TAG, "")
      .replace(GAPS, "\n\n")
      .replace(BREAKS, "\n"),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
