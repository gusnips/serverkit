/**
 * The methods an SDK exposes, written from the operation list the API already mounts, and the two
 * files they run on.
 *
 * Five generators each wrote this loop, and what they shared is here: one method per operation,
 * grouped by namespace, taking the params interface its input schema gives and returning the type
 * the operation says `data` holds; a path whose slots carry the argument's own name, so the
 * transport can fill them; and the checks that stop a wrong SDK at generation rather than in the
 * hands of whoever installs it. What differs by product comes in through options: the doc
 * comment's paragraphs, what the spec carries beyond the route, and members written by hand.
 *
 * It reads the operation list in-process, never the published OpenAPI document. The document has
 * lost the type names, the argument renames and the typed query params, and a type JSON cannot
 * carry reaches it as `{}`, where the schema writer here would have stopped.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inputJsonSchema,
  paramsInterface,
  pascalCase,
  typeNames,
  wrapLines,
  type JsonObject,
  type SchemaSource,
} from "./types.ts";

/** Where the generated SDK puts an operation. */
export interface SdkPlacement {
  /** `sendMessage`, or `numbers.pair` in a namespace. One dot at most; unique. */
  method: string;
  /** What `data` holds, as the SDK names it: `MessageDto`, `NumberDto[]`; `void` for a 204. */
  returns: string;
  /**
   * Safe to run twice with no key: a read sent as a POST, or a write the server dedupes on its
   * own. Default: a GET only.
   */
  repeatable?: boolean;
}

/**
 * The part of an operation the generator reads. It is a structural subset of `@gusnips/server`'s
 * `OpenApiOperation`, so the list an API hands `buildOpenApi` fits here unchanged.
 */
export interface SdkOperation {
  name: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  /** The route as the router spells it: `/numbers/:id`. */
  path: string;
  summary: string;
  description?: string;
  /** Everything the operation reads. It becomes the method's params interface. */
  input?: SchemaSource;
  /** Input field → path slot, where the two names differ: `{ numberId: "id" }`. */
  params?: Readonly<Record<string, string>>;
  /** Fields the route fills in itself. The SDK leaves them out. */
  fixed?: readonly string[];
  /** Request headers the operation reads. An `Idempotency-Key` here makes the call keyed. */
  headers?: readonly { readonly name: string }[];
  /** The success status. A 204, 205 or 304 has no body, so it returns `void`. */
  status?: number;
  extensions?: Readonly<Record<`x-${string}`, unknown>>;
  /** Where the generated SDK puts this operation. Absent: no method. */
  sdk?: SdkPlacement;
}

/** A member written by hand, placed beside the generated ones and held to the same names. */
export interface InjectedMember {
  /** `jobs.wait`, or `wait` at the top level. */
  method: string;
  /** Its parameters and return type: `(jobId: string, opts?: WaitOptions): Promise<JobDto>`. */
  signature: string;
  /** What it returns: `this.waitForJob(jobId, opts)`. */
  call: string;
  /** Its doc comment, one string per paragraph. */
  doc?: readonly string[];
}

export interface SdkMethodsOptions {
  /**
   * The namespaces, in the order the client lists them. Given, a namespace not in it throws, so a
   * typo cannot start a new one. Default: the order they first appear.
   */
  namespaces?: readonly string[];
  /**
   * A method's doc comment, one string per paragraph; `undefined` ones are skipped. Default: the
   * summary, then the description.
   */
  doc?: (op: SdkOperation) => readonly (string | undefined)[];
  /** Fields to add to the spec an operation hands `request`, such as its proxy block's fields. */
  specExtra?: (op: SdkOperation) => Readonly<Record<string, unknown>> | undefined;
  /** Members written by hand, each after the generated ones in its place. */
  inject?: readonly InjectedMember[];
}

export interface SdkMethods {
  /** An `export interface …Params` for each method that takes arguments: the body of `params.ts`. */
  params: string;
  /**
   * The class members: top-level methods first, then one object per namespace. Each calls
   * `this.request(spec, params, opts)`, which the class declares and the SDK implements.
   */
  members: string;
  /** The params interfaces the members name, sorted, for their import line. */
  paramTypes: string[];
  /** The declared types the `returns` name, sorted, for their import from the contract. */
  returnTypes: string[];
}

/** Success statuses with no body (RFC 9110), the same three the server's reference documents so. */
const NO_BODY = new Set([204, 205, 304]);

/** Class members a method must not be named: the seam every method calls, and the constructor. */
const RESERVED = new Set(["request", "constructor"]);

/** The spec fields the generator writes, which `specExtra` must not overwrite. */
const SPEC_FIELDS = new Set(["method", "path", "keyed", "repeatable"]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface Member {
  /** Who asked for it, for an error message. */
  where: string;
  namespace: string | undefined;
  name: string;
  doc: readonly (string | undefined)[];
  signature: string;
  call: string;
}

/**
 * The SDK's methods for every operation that names an `sdk` place, with the params interfaces they
 * take.
 *
 * ```ts
 * const { params, members, paramTypes, returnTypes } = sdkMethods(operations);
 * const file = `export abstract class GeneratedOperations {
 *     protected abstract request<T>(spec: RequestSpec, params?: object, opts?: RequestOptions): Promise<T>;
 * ${members}}\n`;
 * ```
 */
export function sdkMethods(
  operations: readonly SdkOperation[],
  options: SdkMethodsOptions = {},
): SdkMethods {
  const { doc = (op) => [op.summary, op.description], specExtra, inject = [] } = options;
  const members: Member[] = [];
  const params: string[] = [];
  const paramTypes: string[] = [];
  const returnTypes = new Set<string>();

  for (const op of operations) {
    const sdk = op.sdk;
    if (sdk === undefined) continue;
    const where = `${op.method.toUpperCase()} ${op.path} (${op.name})`;
    if (op.status !== undefined && NO_BODY.has(op.status) && sdk.returns !== "void") {
      throw new Error(
        `${where} answers ${op.status}, which has no body, so \`sdk.returns\` must be "void".`,
      );
    }
    const schema = op.input === undefined ? undefined : schemaOf(op.input, where);
    const fixed = op.fixed ?? [];
    const typeName = `${pascalCase(op.name)}Params`;
    const iface = schema === undefined ? null : paramsInterface(typeName, schema, fixed);
    if (iface !== null) {
      params.push(`/** Arguments for \`${sdk.method}()\`. */\n${iface.source}`);
      paramTypes.push(typeName);
    }
    for (const name of typeNames(sdk.returns)) returnTypes.add(name);

    const listed = schema?.["required"];
    const required = new Set(
      Array.isArray(listed)
        ? listed.filter((f): f is string => typeof f === "string" && !fixed.includes(f))
        : [],
    );
    const fields = [
      `method: "${op.method.toUpperCase()}"`,
      `path: ${JSON.stringify(sdkPath(op, required, where))}`,
    ];
    if (op.headers?.some((h) => h.name.toLowerCase() === "idempotency-key"))
      fields.push("keyed: true");
    if (sdk.repeatable !== undefined) fields.push(`repeatable: ${sdk.repeatable}`);
    for (const [key, value] of Object.entries(specExtra?.(op) ?? {})) {
      if (SPEC_FIELDS.has(key)) {
        throw new Error(
          `${where}: \`specExtra\` sets "${key}", which the generator writes itself.`,
        );
      }
      if (value !== undefined) fields.push(`${propertyKey(key)}: ${JSON.stringify(value)}`);
    }

    const argument = iface === null ? "" : `params${iface.optional ? "?" : ""}: ${typeName}, `;
    members.push({
      where,
      ...place(sdk.method, where),
      doc: doc(op),
      signature: `(${argument}opts?: RequestOptions): Promise<${sdk.returns}>`,
      call: `this.request({ ${fields.join(", ")} }, ${iface === null ? "undefined" : "params"}, opts)`,
    });
  }
  for (const member of inject) {
    const where = `The hand-written ${member.method}`;
    members.push({
      where,
      ...place(member.method, where),
      doc: member.doc ?? [],
      signature: member.signature,
      call: member.call,
    });
  }

  return {
    params: params.join("\n"),
    members: writeMembers(members, options.namespaces),
    paramTypes: paramTypes.sort(),
    returnTypes: [...returnTypes].sort(),
  };
}

/** `numbers.pair` → its namespace and name, each checked to be a name a class member can have. */
function place(method: string, where: string): { namespace: string | undefined; name: string } {
  const parts = method.split(".");
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new Error(
      `${where}: \`${method}\` is not a method name. Write \`name\`, or \`namespace.name\` with one dot.`,
    );
  }
  const [first = "", second] = parts;
  return second === undefined
    ? { namespace: undefined, name: first }
    : { namespace: first, name: second };
}

/** Top-level methods first, then one `readonly namespace = { … }` per namespace. */
function writeMembers(members: readonly Member[], order: readonly string[] | undefined): string {
  const seen = new Map<string, string>();
  const topLevel = new Set<string>();
  const namespaces: string[] = [];
  for (const { where, namespace, name } of members) {
    const full = namespace === undefined ? name : `${namespace}.${name}`;
    const first = seen.get(full);
    if (first !== undefined) {
      throw new Error(`Two methods want to be \`${full}\`: ${first}, and ${where}. Rename one.`);
    }
    seen.set(full, where);
    if (namespace === undefined) topLevel.add(name);
    else if (!namespaces.includes(namespace)) namespaces.push(namespace);
  }
  for (const name of [...topLevel, ...namespaces]) {
    if (RESERVED.has(name)) {
      throw new Error(`\`${name}\` is a class member every SDK already has. Pick another name.`);
    }
    if (topLevel.has(name) && namespaces.includes(name)) {
      throw new Error(`\`${name}\` is both a method and a namespace. Rename one.`);
    }
  }
  if (order !== undefined) {
    const unknown = namespaces.find((namespace) => !order.includes(namespace));
    if (unknown !== undefined) {
      throw new Error(
        `The namespace \`${unknown}\` is not in \`namespaces\`. Add it there, or use one of: ${order.join(", ")}.`,
      );
    }
  }

  let out = "";
  for (const member of members.filter((m) => m.namespace === undefined)) {
    out += `\n${jsdoc(member.doc, "    ")}    ${member.name}${member.signature} {\n`;
    out += `        return ${member.call};\n    }\n`;
  }
  for (const namespace of (order ?? namespaces).filter((ns) => namespaces.includes(ns))) {
    out += `\n    readonly ${namespace} = {\n`;
    for (const member of members.filter((m) => m.namespace === namespace)) {
      out += `${jsdoc(member.doc, "        ")}        ${member.name}: ${member.signature} =>\n`;
      out += `            ${member.call},\n`;
    }
    out += `    };\n`;
  }
  return out;
}

/**
 * The route with each slot named for the argument that fills it: `/numbers/:id` with
 * `{ numberId: "id" }` → `/numbers/:numberId`. A slot's argument must be required, or the SDK
 * would let a caller leave out part of the address.
 */
function sdkPath(op: SdkOperation, required: ReadonlySet<string>, where: string): string {
  // A constraint such as `:id{[0-9]+}` is the router's business, and the SDK drops it.
  const slot = /:(\w+)(\{[^}]*\})?(\?)?/g;
  const slots = new Set([...op.path.matchAll(slot)].map((match) => match[1]));
  const fieldIn = new Map<string, string>();
  for (const [field, name] of Object.entries(op.params ?? {})) {
    if (!slots.has(name)) {
      throw new Error(
        `${where}: \`params\` sends ${field} in ":${name}", which the path does not have.`,
      );
    }
    fieldIn.set(name, field);
  }
  return op.path.replace(slot, (_match, name: string, _re, optional) => {
    if (optional) {
      throw new Error(
        `${where} has an optional slot ":${name}?". List it as two operations, with and without it.`,
      );
    }
    const field = fieldIn.get(name) ?? name;
    if (!/^\w+$/.test(field)) {
      throw new Error(
        `${where}: the path's ":${name}" is filled from \`${field}\`, which a path cannot name. Rename the field.`,
      );
    }
    if (!required.has(field)) {
      throw new Error(
        `${where}: the path's ":${name}" is filled from \`${field}\`, which the input does not require. ` +
          "Make it required, or map the slot to another field with `params`.",
      );
    }
    return `:${field}`;
  });
}

/** The input as JSON Schema, with the operation named when it cannot be written. */
function schemaOf(input: SchemaSource, where: string): JsonObject {
  try {
    return inputJsonSchema(input);
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

/** `/**` over paragraphs, a blank ` *` line between them, each wrapped for its indent. */
function jsdoc(paragraphs: readonly (string | undefined)[], indent: string): string {
  const blocks = paragraphs
    .map((paragraph) => (paragraph === undefined ? [] : wrapLines(paragraph, indent)))
    .filter((lines) => lines.length > 0);
  if (blocks.length === 0) return "";
  const line = `\n${indent} * `;
  return `${indent}/**${line}${blocks.map((lines) => lines.join(line)).join(`\n${indent} *${line}`)}\n${indent} */\n`;
}

/** A key that is not an identifier has to be quoted. */
const propertyKey = (key: string): string => (IDENTIFIER.test(key) ? key : JSON.stringify(key));

/**
 * `@gusnips/http`'s retry rule, its `src/retry.ts` whole, for an SDK to carry as
 * `generated/retry.ts`. It is read from this package's own dependency, never the adopter's, so
 * every SDK built with one sdkgen carries one rule. When an sdkgen release moves the rule, each
 * SDK's `--check` fails, and that is the signal to release the SDK.
 */
export function retrySource(): string {
  const entry = createRequire(import.meta.url).resolve("@gusnips/http/retry");
  return readFileSync(join(dirname(entry), "../src/retry.ts"), "utf8");
}

/**
 * The transport every generated method runs on, for an SDK to carry as `generated/transport.ts`
 * beside `retry.ts`: this package's own `src/transport.ts`, importing the rule from `./retry.ts`.
 */
export function transportSource(): string {
  const path = fileURLToPath(new URL("../src/transport.ts", import.meta.url));
  return readFileSync(path, "utf8").replace(`from "@gusnips/http/retry";`, `from "./retry.ts";`);
}
