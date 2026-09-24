import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  camelCase,
  docComment,
  fieldsOf,
  inputJsonSchema,
  paramsInterface,
  pascalCase,
  typeNames,
  typeOf,
  wrapLines,
} from "./types.ts";

describe("typeOf", () => {
  it.each([
    [{ type: "string" }, "string"],
    [{ type: "integer" }, "number"],
    [{ type: "boolean" }, "boolean"],
    [{ enum: ["qr", "code", null] }, '"qr" | "code" | null'],
    [{ const: 5 }, "5"],
    [{ type: ["number", "null"] }, "number | null"],
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, "string | null"],
    [{ type: "array", items: { enum: ["a", "b"] } }, '("a" | "b")[]'],
    [{ type: "array", items: { type: "string" } }, "string[]"],
    [{ type: "array" }, "unknown[]"],
    [{ type: "array", prefixItems: [{ type: "number" }, { type: "string" }] }, "[number, string]"],
    [
      { type: "array", prefixItems: [{ type: "number" }], items: { type: "boolean" } },
      "[number, ...boolean[]]",
    ],
    [{ type: "object", additionalProperties: { type: "string" } }, "Record<string, string>"],
    [{ type: "object" }, "Record<string, unknown>"],
    [{}, "unknown"],
    [{ description: "Anything at all." }, "unknown"],
  ])("writes %j as %s", (schema, type) => {
    expect(typeOf(schema)).toBe(type);
  });

  it("reads a boolean schema", () => {
    expect(typeOf(true)).toBe("unknown");
    expect(typeOf(false)).toBe("never");
  });

  it("writes an inline object one level in", () => {
    expect(
      typeOf({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "    "),
    ).toBe("{\n        a: string;\n    }");
  });

  it("refuses a schema it would have to guess at", () => {
    expect(() => typeOf({ allOf: [{ type: "string" }] })).toThrow(/Cannot write this JSON Schema/);
    expect(() => typeOf({ $ref: "#/$defs/X" })).toThrow(/Cannot write this JSON Schema/);
    expect(() => typeOf({ type: "array", items: 5 })).toThrow(/Not a JSON Schema: 5/);
  });
});

describe("fieldsOf", () => {
  it("keeps each description, marks the optional ones, and quotes a name that needs it", () => {
    const schema = inputJsonSchema(
      z.object({
        to: z.string().describe("Who gets it."),
        "reply-to": z.string().optional(),
      }),
    );
    expect(fieldsOf(schema)).toBe(
      '    /** Who gets it. */\n    to: string;\n    "reply-to"?: string;\n',
    );
  });

  it("leaves out the fields it is told to", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } };
    expect(fieldsOf(schema, "    ", ["a"])).toBe("    b?: string;\n");
  });
});

describe("paramsInterface", () => {
  const schema = inputJsonSchema(
    z.object({ id: z.string(), type: z.enum(["image"]), caption: z.string().optional() }),
  );

  it("is optional when every field left is optional", () => {
    expect(paramsInterface("SendParams", schema, ["id", "type"])).toEqual({
      source: "export interface SendParams {\n    caption?: string;\n}\n",
      optional: true,
    });
    expect(paramsInterface("SendParams", schema)?.optional).toBe(false);
  });

  it("is nothing when no field is left", () => {
    expect(paramsInterface("NoParams", { type: "object", properties: {} })).toBeNull();
  });
});

describe("docComment", () => {
  it("wraps under the opener, the way the generated files already read", () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const out = docComment(text, "    ");
    expect(out.startsWith("    /** word0 ")).toBe(true);
    expect(out).toContain("\n     *  word");
    expect(out.endsWith(" */\n")).toBe(true);
    expect(out.split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it("gives the bare lines, for a comment laid out another way", () => {
    expect(wrapLines("a */ b", "")).toEqual(["a *\\/ b"]);
    expect(wrapLines("one two three", " ".repeat(86))).toEqual(["one two", "three"]);
  });

  it("cannot be closed early by the text", () => {
    expect(docComment("Matches /files/*/ only.", "")).toBe("/** Matches /files/*\\/ only. */\n");
  });
});

describe("typeNames", () => {
  it("finds the names inside a generic, once, without TypeScript's own", () => {
    expect(typeNames("V1ListPage<JobDto>[] | Record<string, JobDto> | null")).toEqual([
      "V1ListPage",
      "JobDto",
    ]);
  });
});

describe("names", () => {
  it("turns a tool name into a method name and a type name", () => {
    expect(camelCase("send_media_image")).toBe("sendMediaImage");
    expect(pascalCase("send_media")).toBe("SendMedia");
  });
});

describe("inputJsonSchema", () => {
  it("says what to upgrade when a schema cannot describe itself", () => {
    expect(() => inputJsonSchema({ "~standard": { vendor: "zod" } })).toThrow(/zod does from 4\.4/);
  });

  it("stops on a zod type JSON Schema cannot hold, rather than writing it as any value", () => {
    expect(() => inputJsonSchema(z.object({ at: z.date() }))).toThrow(/Date cannot be represented/);
  });

  it("takes JSON Schema as it is", () => {
    const schema = { type: "object" };
    expect(inputJsonSchema(schema)).toBe(schema);
  });
});
