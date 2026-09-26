import { describe, expect, it } from "vitest";
import { textFromHtml } from "./text-from-html.ts";

describe("textFromHtml", () => {
  it("keeps a link's address beside its label", () => {
    expect(
      textFromHtml(
        '<p>Your invoice is due. <a href="https://example.test/pay?id=7&amp;from=mail">Pay now</a></p>',
      ),
    ).toBe("Your invoice is due. Pay now: https://example.test/pay?id=7&from=mail");
  });

  it("prints the address once when the label already is it, mailto included", () => {
    expect(textFromHtml('<a href="mailto:help@example.test">help@example.test</a>')).toBe(
      "help@example.test",
    );
    expect(textFromHtml('<a href="https://example.test/a">https://example.test/a</a>')).toBe(
      "https://example.test/a",
    );
    expect(textFromHtml('<a href="mailto:help@example.test">Write to us</a>')).toBe(
      "Write to us: help@example.test",
    );
  });

  it("prints the address of a link with no text, such as an image", () => {
    expect(textFromHtml('<a href="https://example.test/go"><img src="b.png" alt="Go"></a>')).toBe(
      "https://example.test/go",
    );
  });

  it("reads an address in single quotes, in none, and never from data-href", () => {
    expect(textFromHtml("<a class='cta' href='https://example.test/s'>Open</a>")).toBe(
      "Open: https://example.test/s",
    );
    expect(textFromHtml("<a href=https://example.test/u>Open</a>")).toBe(
      "Open: https://example.test/u",
    );
    expect(textFromHtml('<a data-href="https://example.test/x">Open</a>')).toBe("Open");
  });

  it("keeps a <br> as a line break and a paragraph as one blank line, never more", () => {
    expect(textFromHtml("<p>Hello,<br>Ana</p><p></p><p></p><div></div><p>See you.</p>")).toBe(
      "Hello,\nAna\n\nSee you.",
    );
  });

  it("collapses whitespace the way HTML does, and trims each line", () => {
    expect(textFromHtml("<p>\n    Your   report\n    is ready.\n</p>\n\n   <p>  Bye </p>")).toBe(
      "Your report is ready.\n\nBye",
    );
  });

  it("reads a whole document without its head, styles, scripts or comments", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Weekly digest</title><style>p { color: red; }</style></head>
<body>
  <!-- Header -->
  <img src="https://example.test/logo.png" alt="LOGO">
  <table role="presentation"><tr><td>
    <h2>Three new matches</h2>
    <p>They match the search you saved.</p>
  </td></tr></table>
  <script>track("open")</script>
  <p><a href="https://example.test">example.test</a></p>
</body>
</html>`;
    expect(textFromHtml(html)).toBe(
      "Three new matches\n\nThey match the search you saved.\n\nexample.test: https://example.test",
    );
  });

  it("decodes entities once, so an escaped entity reads as written", () => {
    expect(textFromHtml("<p>&amp;lt; is how you write &lt;b&gt;</p>")).toBe(
      "&lt; is how you write <b>",
    );
    expect(
      textFromHtml("<p>R&#36; 10 &#x2014; &quot;ok&quot; &#39;x&#39; &copy; &unknown;</p>"),
    ).toBe("R$ 10 — \"ok\" 'x' © &unknown;");
    expect(textFromHtml("<p>a&nbsp;b &#0; &#xD800; &#1114112;</p>")).toBe(
      "a\u00a0b \ufffd \ufffd \ufffd",
    );
  });

  it("starts each list item on its own line", () => {
    expect(
      textFromHtml("<p>New:</p><ul><li>Filters</li><li><strong>Export</strong></li></ul>"),
    ).toBe("New:\n\n- Filters\n- Export");
  });

  it("puts a table's cells on one line and its rows on separate lines", () => {
    expect(
      textFromHtml(
        "<table><tr><td>Plan</td><td>Pro</td></tr><tr><td>Due</td><td>May 3</td></tr></table>",
      ),
    ).toBe("Plan Pro\nDue May 3");
  });

  it("answers an empty string for HTML with no text", () => {
    expect(textFromHtml('<img src="https://example.test/p.gif" width="1" height="1" alt="">')).toBe(
      "",
    );
  });
});
