/**
 * Writing a JSON Schema as a TypeScript type, with each field's description kept as its doc
 * comment.
 *
 * Five generators each wrote this, and the fixes were spread across them: `type: [..., "null"]`
 * in three, `{}` as `unknown` and a record as `Record<string, T>` in two, a boolean schema and a
 * tuple in one. The rule all five kept is the one that matters most: **never guess a type into a
 * published SDK.** A schema node this does not understand throws; it never becomes `unknown`.
 */

export type JsonObject = Record<string, unknown>;

/** The part of the Standard JSON Schema interface this module calls: zod 4.4 and later. */
export interface StandardJsonSchema {
  "~standard": {
    vendor: string;
    jsonSchema?: {
      input(options: { target: "draft-2020-12"; libraryOptions?: JsonObject }): JsonObject;
      output(options: { target: "draft-2020-12"; libraryOptions?: JsonObject }): JsonObject;
    };
  };
}

/** A schema: a Standard JSON Schema such as a zod object, or JSON Schema itself. */
export type SchemaSource = StandardJsonSchema | JsonObject;

/** The schema as JSON Schema, describing what a caller SENDS. */
export function inputJsonSchema(source: SchemaSource): JsonObject {
  if (!isStandard(source)) return source;
  const standard = source["~standard"];
  if (standard.jsonSchema === undefined) {
    throw new Error(
      `This ${standard.vendor} schema cannot describe itself as JSON Schema. zod does from 4.4.`,
    );
  }
  return standard.jsonSchema.input({ target: "draft-2020-12" });
}

function isStandard(source: SchemaSource): source is StandardJsonSchema {
  return "~standard" in source;
}

/** Keywords that describe a value without constraining it, so `{ description }` is still `{}`. */
const ANNOTATIONS = new Set([
  "$schema",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** Names TypeScript itself provides, so a mention of one is not a declaration to find. */
export const BUILTIN = new Set([
  "Array",
  "ArrayBuffer",
  "Awaited",
  "Blob",
  "Capitalize",
  "Date",
  "Error",
  "Exclude",
  "Extract",
  "Lowercase",
  "Map",
  "NonNullable",
  "Omit",
  "Parameters",
  "Partial",
  "Pick",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "Record",
  "RegExp",
  "Required",
  "ReturnType",
  "Set",
  "URL",
  "Uint8Array",
  "Uncapitalize",
  "Uppercase",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A schema that is `true`, `false` or an object; anything else is not a schema. */
function asSchema(value: unknown): JsonObject | boolean {
  if (typeof value === "boolean" || isObject(value)) return value;
  throw new Error(`Not a JSON Schema: ${JSON.stringify(value)}`);
}

/**
 * The TypeScript type for one schema. `indent` is where the enclosing line starts, so an inline
 * object's fields land one level in.
 */
export function typeOf(schema: JsonObject | boolean, indent = ""): string {
  if (typeof schema === "boolean") return schema ? "unknown" : "never";
  const { enum: members, const: constant, type } = schema;
  if (Array.isArray(members)) return members.map((v) => JSON.stringify(v)).join(" | ");
  if (constant !== undefined) return JSON.stringify(constant);
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) return union.map((s) => typeOf(asSchema(s), indent)).join(" | ");
  // `type: ["number", "null"]`: each member carries the rest of the node, such as its items.
  if (Array.isArray(type))
    return type.map((t) => typeOf({ ...schema, type: t }, indent)).join(" | ");
  // The EMPTY schema, `{}`, is "any value": what zod writes for `z.unknown()`. There is no
  // narrower type to give it, so this is a shape understood, not a guess.
  if (Object.keys(schema).every((key) => ANNOTATIONS.has(key))) return "unknown";

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = schema["items"];
      // Fixed positions, each with its own type: `[number, number]`, never `number[]`, which
      // would accept one.
      const fixed = schema["prefixItems"] ?? (Array.isArray(items) ? items : undefined);
      if (Array.isArray(fixed)) {
        const rest =
          Array.isArray(items) || items === undefined || items === false
            ? ""
            : `, ...${typeOf(asSchema(items), indent)}[]`;
        return `[${fixed.map((m) => typeOf(asSchema(m), indent)).join(", ")}${rest}]`;
      }
      const item = items === undefined ? "unknown" : typeOf(asSchema(items), indent);
      // `("a" | "b")[]`: without the parens the union swallows the array, and only the last
      // member becomes one.
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const fields = fieldsOf(schema, `${indent}    `);
      if (fields) return `{\n${fields}${indent}}`;
      const values = schema["additionalProperties"];
      // A record, such as headers: no named fields, one type for every value.
      return isObject(values)
        ? `Record<string, ${typeOf(values, indent)}>`
        : "Record<string, unknown>";
    }
    default:
      throw new Error(`Cannot write this JSON Schema as a type: ${JSON.stringify(schema)}`);
  }
}

/**
 * An object schema's fields, one per line, each description kept as a doc comment. `skip` leaves
 * fields out, such as the ones a route fills in itself.
 */
export function fieldsOf(
  schema: JsonObject,
  indent = "    ",
  skip: readonly string[] = [],
): string {
  const properties = isObject(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"] : []);
  let out = "";
  for (const [name, raw] of Object.entries(properties)) {
    if (skip.includes(name)) continue;
    const field = asSchema(raw);
    const description = typeof field === "object" ? field["description"] : undefined;
    if (typeof description === "string") out += docComment(description, indent);
    // A name that is not an identifier, such as `content-type`, has to be quoted.
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    out += `${indent}${key}${required.has(name) ? "" : "?"}: ${typeOf(field, indent)};\n`;
  }
  return out;
}

/**
 * `export interface SendMessageParams { … }`, or `null` when the schema has no fields left. The
 * interface is `optional` when no remaining field is required, so the method's argument can be.
 */
export function paramsInterface(
  name: string,
  schema: JsonObject,
  skip: readonly string[] = [],
): { source: string; optional: boolean } | null {
  const fields = fieldsOf(schema, "    ", skip);
  if (!fields) return null;
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  return {
    source: `export interface ${name} {\n${fields}}\n`,
    optional: !required.some((field) => typeof field === "string" && !skip.includes(field)),
  };
}

/**
 * Prose broken into lines of at most `96 - indent.length` characters, to sit inside a comment at
 * that indent. Every caller puts them in one, so a star-slash is broken up here: it would end the
 * comment early and turn the rest of the sentence into code.
 *
 * ```ts
 * wrapLines(op.description, "    ").join("\n     * ");
 * ```
 */
export function wrapLines(text: string, indent = "    "): string[] {
  const width = 96 - indent.length;
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\*\//g, "*\\/").split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * `/** text *\/`, with continuation lines under the opener: the format all five generators wrote
 * for a field, byte for byte.
 */
export function docComment(text: string, indent = "    "): string {
  return `${indent}/** ${wrapLines(text, indent).join(`\n${indent} *  `)} */\n`;
}

/**
 * The declared names a type expression mentions: `"V1ListPage<JobDto>[] | null"` needs
 * `V1ListPage` and `JobDto`. Splitting on `|` alone, as one generator did, misses what sits
 * inside the generic.
 */
export function typeNames(expression: string): string[] {
  const names = expression.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  return [...new Set(names)].filter((name) => !BUILTIN.has(name));
}

/** `send_message` → `sendMessage`. */
export const camelCase = (name: string): string =>
  name.replace(/[_-](\w)/g, (_m, c: string) => c.toUpperCase());

/** `send_message` → `SendMessage`. */
export const pascalCase = (name: string): string => {
  const camel = camelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};
