import { describe, expect, it } from "vitest";
import { listUnsubscribeHeaders } from "./unsubscribe.ts";

describe("listUnsubscribeHeaders", () => {
  it("writes both headers for an https link", () => {
    expect(listUnsubscribeHeaders("https://example.test/unsubscribe?token=abc.def")).toEqual({
      "List-Unsubscribe": "<https://example.test/unsubscribe?token=abc.def>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("writes no one-click header for a plain http link", () => {
    expect(listUnsubscribeHeaders("http://localhost:3000/unsubscribe?t=1")).toEqual({
      "List-Unsubscribe": "<http://localhost:3000/unsubscribe?t=1>",
    });
  });

  it("encodes what could close the brackets or start another header", () => {
    const headers = listUnsubscribeHeaders("https://example.test/u?t=a>b c\r\nBcc: x@evil.test");
    expect(headers["List-Unsubscribe"]).toBe(
      "<https://example.test/u?t=a%3Eb%20cBcc:%20x@evil.test>",
    );
  });

  it("refuses a mailto link and anything that is not a URL", () => {
    for (const url of [
      "mailto:unsubscribe@example.test",
      "javascript:alert(1)",
      "/unsubscribe",
      "",
    ])
      expect(() => listUnsubscribeHeaders(url)).toThrow("An unsubscribe link is an http or https");
  });
});
