/**
 * The README's examples, run. Every literal below is what the README prints beside the call, and a
 * snippet nobody executes rots quietly.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  camelCase,
  fieldsOf,
  inputJsonSchema,
  pascalCase,
  sdkMethods,
  typeNames,
  typeOf,
} from "./index.ts";

describe("README", () => {
  it("prints what the README says", () => {
    expect(typeOf({ type: ["string", "null"] })).toBe("string | null");
    expect(fieldsOf(inputJsonSchema(z.object({ to: z.string().describe("Who gets it.") })))).toBe(
      "    /** Who gets it. */\n    to: string;\n",
    );
    expect(typeNames("Page<Job>[]")).toEqual(["Page", "Job"]);
    expect([camelCase("send_message"), pascalCase("send_message")]).toEqual([
      "sendMessage",
      "SendMessage",
    ]);
    expect(
      fieldsOf({ type: "object", properties: { "content-type": { type: "string" } } }, ""),
    ).toBe('"content-type"?: string;\n');
    const { members } = sdkMethods([
      {
        name: "health",
        method: "get",
        path: "/health",
        summary: "Check the API is up.",
        sdk: { method: "health", returns: "HealthDto" },
      },
    ]);
    expect(members).toBe(`
    /**
     * Check the API is up.
     */
    health(opts?: RequestOptions): Promise<HealthDto> {
        return this.request({ method: "GET", path: "/health" }, undefined, opts);
    }
`);
  });
});
