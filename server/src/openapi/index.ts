/**
 * The reference for a REST API, as one OpenAPI 3.1 document built from the list of operations the
 * API already mounts.
 *
 * Five backends each wrote one, and the same few things went wrong in them:
 * - **The server is the public origin, never the request's.** Four of five built `servers` from
 *   the request's URL, and behind a reverse proxy every request arrives on the loopback — so the
 *   published reference sent every "Try it", every generated client and every agent reading it to
 *   `http://127.0.0.1:<port>`. The fifth wrote its production origin by hand, and was the only one
 *   right in production. `origin` is required and comes from config.
 * - **The server and the path together are the route.** One named no `/v1` anywhere while every
 *   operation was mounted under it, so the right host still answered 404 on every path.
 *   `basePath` is required, even when it is `""`.
 * - **An operation id names one operation.** One tool mounted on five paths published one id five
 *   times, and a generator keeps one of the five. A repeated id throws here.
 * - **Translate prose, not data.** The walk that localizes `summary` and `description` must not
 *   enter an example, a default or an enum — a response example with a field called
 *   `description` would ship translated — and a field NAMED `example` under `properties` is still
 *   a schema to walk. See `translateProse`.
 *
 * Schemas are any Standard JSON Schema (zod 4.4 and later, and the other libraries that implement
 * it) or plain JSON Schema. Nothing is imported: this runs in a Worker, and zod loads only if your
 * schemas are zod.
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** A JSON object, as it lands in the document. */
export type JsonObject = Record<string, unknown>;

/**
 * The part of the Standard JSON Schema interface this module calls. zod 4.4 and later implement
 * it on every schema; an older zod has `~standard` without `jsonSchema`, which throws here with
 * the version to install.
 */
export interface StandardJsonSchema {
  "~standard": {
    vendor: string;
    jsonSchema?: {
      input(options: { target: "draft-2020-12"; libraryOptions?: JsonObject }): JsonObject;
      output(options: { target: "draft-2020-12"; libraryOptions?: JsonObject }): JsonObject;
    };
  };
}

/** A schema the document can carry: a Standard JSON Schema, or JSON Schema itself. */
export type SchemaSource = StandardJsonSchema | JsonObject;

export interface OpenApiOperation {
  /** The operation's id unless `operationId` says otherwise, and its MCP tool's name. */
  name: string;
  method: HttpMethod;
  /** The route as your router spells it, under `basePath`: `/numbers/:id`. */
  path: string;
  /** One of `tags`. It decides the group the reference shows the operation in. */
  tag: string;
  summary: string;
  description?: string;
  /**
   * Everything the operation reads. A field a path slot names travels in the path; the rest
   * travel in the query string for a GET or DELETE, and in a JSON body otherwise.
   */
  input?: SchemaSource;
  /**
   * Input field → path slot, where the two names differ: `{ numberId: "id" }` for
   * `/numbers/:id`. A slot with no entry carries the field of its own name.
   */
  params?: Readonly<Record<string, string>>;
  /** Fields the route fills in itself, such as a `type` the path decides. Never documented. */
  fixed?: readonly string[];
  /**
   * Request headers the operation reads, such as an `Idempotency-Key`. The credential is not one:
   * `securitySchemes` names it.
   */
  headers?: readonly OpenApiHeader[];
  /** What `data` holds when the call works. Absent, the document says only that it is there. */
  response?: SchemaSource;
  /**
   * The success status. 200 by default. A 204 is documented with no body, as `noContent` sends
   * it, so it takes no `response` or `example`.
   */
  status?: number;
  /**
   * Refusals only this operation answers, beside the shared `errors`: `{ 504: "…" }` on the
   * calls that wait on someone else. A status in both takes this description.
   */
  errors?: Readonly<Record<number, string>>;
  /** An example of `data`, shown beside the success response. */
  example?: unknown;
  /** Needs no credential, so it names no security scheme. */
  keyless?: boolean;
  /** Not an MCP tool, so it stays out of `x-mcp-tools`. */
  restOnly?: boolean;
  /** Set it when one operation is mounted on more than one path; ids must not repeat. */
  operationId?: string;
  /**
   * `x-` fields to write onto the operation as they are, such as `x-credits`. They stay as
   * written in every language unless `proseExtensions` names them.
   */
  extensions?: Record<`x-${string}`, unknown>;
  /**
   * Where a generated SDK puts this operation, for `@gusnips/sdkgen` to read from this same list.
   * The reference carries it as `x-sdk`. Absent: the SDK has no method for it.
   */
  sdk?: OpenApiSdk;
}

/** Where a generated SDK puts an operation. */
export interface OpenApiSdk {
  /** `sendMessage`, or `numbers.pair` in a namespace. One dot at most, and unique. */
  method: string;
  /**
   * What `data` holds, as the SDK names it: `MessageDto`, `NumberDto[]`. `void` for a status with
   * no body, such as a 204.
   */
  returns: string;
  /**
   * Safe to run twice with no key: a read sent as a POST, or a write the server dedupes on its
   * own. Default: a GET only. A write that reads an `Idempotency-Key` needs no flag: a call that
   * sends one is safe to repeat.
   */
  repeatable?: boolean;
}

/** A request header an operation reads. */
export interface OpenApiHeader {
  name: string;
  description: string;
  /** Absent, the header is optional. */
  required?: boolean;
  /** What the value may be. Pass the schema the route checks it with. Absent, any string. */
  schema?: SchemaSource;
}

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiOptions {
  info: { title: string; version: string; description?: string };
  /**
   * The public origin, from config: `https://api.example.com`. Never the request's own, which
   * behind a proxy is the loopback.
   */
  origin: string;
  /** Where the operations are mounted, such as `/v1`. `""` when they sit at the root. */
  basePath: string;
  /** The groups, in the order the reference lists them. An operation naming another tag throws. */
  tags: readonly OpenApiTag[];
  /**
   * OpenAPI security scheme objects. An operation that is not `keyless` accepts any one of them:
   * `{ bearerAuth: { type: "http", scheme: "bearer" } }`.
   */
  securitySchemes: Readonly<Record<string, JsonObject>>;
  /** Refusals any operation can answer, by status: `{ 401: "The key is missing or wrong." }`. */
  errors?: Readonly<Record<number, string>>;
  /**
   * Every `code` your API answers with. The `ApiError` schema lists them, so a generated client
   * can switch on a code and a typo in one fails to compile. Absent, a code is any string.
   */
  errorCodes?: readonly string[];
  /**
   * What `meta` may hold beside `data`, such as a page's `total` or what a call cost. Every
   * success names it as optional. Absent, the success names only `data`.
   */
  meta?: SchemaSource;
  /**
   * Also list your MCP tools under `x-mcp-tools`. Pass the tools you register, and the cards are
   * those tools, in that order. `true` lists each operation that is not `restOnly` instead, once
   * per name, which is right only when every tool takes exactly its operation's `input`: two
   * backends' tools take an idempotency key as an argument, and a card built from the operation
   * left it out, while its `additionalProperties: false` told a model the key would be refused.
   */
  mcpTools?: boolean | readonly McpToolSource[];
}

/**
 * A tool as you register it on your MCP server. `ToolOperation` from `@gusnips/server/mcp` fits as
 * it is, so the reference and `tools/list` can read one list.
 */
export interface McpToolSource {
  name: string;
  title?: string;
  description: string;
  inputSchema: SchemaSource;
  annotations?: JsonObject;
}

/** One tool, as the docs render it beside the REST reference. */
export interface McpToolCard {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  /** The tool's hints, such as `readOnlyHint`, when you pass the tools you register. */
  annotations?: JsonObject;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers: { url: string }[];
  tags: OpenApiTag[];
  paths: Record<string, Partial<Record<HttpMethod, JsonObject>>>;
  components: { schemas: Record<string, JsonObject>; securitySchemes: Record<string, JsonObject> };
  "x-mcp-tools"?: McpToolCard[];
}

/** The `{ error }` envelope every refusal answers with, from `@gusnips/http`. */
const apiError = (codes: readonly string[] | undefined): JsonObject => ({
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string",
          ...(codes !== undefined && { enum: [...codes] }),
          description: "What went wrong, as a word a program can check.",
        },
        message: { type: "string", description: "What went wrong, as a sentence." },
        messageKey: {
          type: "string",
          description:
            "`message` as a key, to show it in your reader's language, with `params` filling its blanks.",
        },
        params: {
          type: "object",
          additionalProperties: { type: ["string", "number"] },
          description: "The values that fill `messageKey`'s blanks, such as a limit.",
        },
        details: { description: "More about this error, such as retryAfterSecs." },
      },
    },
  },
});

/**
 * The statuses where this package's own code states a wait: a request with the same idempotency
 * key still running (409), a rate limit (429), and a dependency that is down for a known time
 * (503). Not 402: no raise of one in the fleet states a wait.
 */
const MAY_STATE_A_WAIT = new Set([409, 429, 503]);

const RETRY_AFTER = {
  description: "When present, how many seconds to wait before trying again.",
  schema: { type: "integer", minimum: 0 },
};

/**
 * Success statuses whose answer has no body (RFC 9110). `noContent` answers 204 with none, and the
 * reference once documented that same operation with a `{ data }` body.
 */
const NO_BODY = new Set([204, 205, 304]);

/** `name`, or `namespace.name`: what a generated SDK can put on a client as it is. */
const SDK_METHOD = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/;

const ERROR_CONTENT = {
  "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
};

/**
 * The whole document. Build it once per process, after every operation is known, and serve it
 * through `createOpenApiResponder`.
 */
export function buildOpenApi(
  operations: readonly OpenApiOperation[],
  options: OpenApiOptions,
): OpenApiDocument {
  const tagNames = new Set(options.tags.map((t) => t.name));
  const schemeNames = Object.keys(options.securitySchemes);
  const paths: OpenApiDocument["paths"] = {};
  const idsSeenAt = new Map<string, string>();
  const sdkMethodsAt = new Map<string, string>();
  const tools: McpToolCard[] = [];
  const toolNames = new Set<string>();
  const meta =
    options.meta === undefined ? undefined : jsonSchemaOf(options.meta, "output", "`meta`");

  for (const op of operations) {
    const where = `${op.method.toUpperCase()} ${op.path}`;
    if (!tagNames.has(op.tag)) {
      throw new Error(
        `${where} names the tag "${op.tag}", which is not in \`tags\`. Add it there.`,
      );
    }
    const operationId = op.operationId ?? op.name;
    const first = idsSeenAt.get(operationId);
    if (first !== undefined) {
      throw new Error(
        `${where} and ${first} share the operation id "${operationId}". Give one an \`operationId\`.`,
      );
    }
    idsSeenAt.set(operationId, where);

    const { path, slots } = openApiPath(op.path, where);
    for (const [field, slot] of Object.entries(op.params ?? {})) {
      if (!slots.includes(slot)) {
        throw new Error(
          `${where}: \`params\` sends ${field} in ":${slot}", which the path does not have.`,
        );
      }
    }
    const input = op.input === undefined ? undefined : jsonSchemaOf(op.input, "input", where);
    const headers = (op.headers ?? []).map((header) => ({
      name: header.name,
      in: "header",
      required: header.required === true,
      description: header.description,
      schema:
        header.schema === undefined
          ? { type: "string" }
          : jsonSchemaOf(header.schema, "input", `${where} header ${header.name}`),
    }));
    const status = op.status ?? 200;
    const hasBody = !NO_BODY.has(status);
    if (!hasBody && (op.response !== undefined || op.example !== undefined)) {
      throw new Error(
        `${where} answers ${status}, which has no body, so it cannot have a \`response\` or an ` +
          "`example`. Remove them, or answer 200.",
      );
    }
    if (op.sdk !== undefined) checkSdk(op, op.sdk, where, hasBody, sdkMethodsAt);
    const responses: JsonObject = {
      [String(status)]: {
        description: op.summary,
        ...(hasBody && {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: {
                  data: op.response === undefined ? {} : jsonSchemaOf(op.response, "output", where),
                  ...(meta !== undefined && { meta }),
                },
              },
              ...(op.example !== undefined && { example: { data: op.example } }),
            },
          },
        }),
      },
    };
    for (const [status, description] of Object.entries({ ...options.errors, ...op.errors })) {
      responses[status] = {
        description,
        ...(MAY_STATE_A_WAIT.has(Number(status)) && { headers: { "Retry-After": RETRY_AFTER } }),
        content: ERROR_CONTENT,
      };
    }
    responses["default"] = { description: "Any other failure.", content: ERROR_CONTENT };

    (paths[path] ??= {})[op.method] = {
      operationId,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description !== undefined && { description: op.description }),
      ...inputParts(op, input, slots, headers),
      security: op.keyless ? [] : schemeNames.map((name) => ({ [name]: [] })),
      responses,
      ...(op.sdk !== undefined && { "x-sdk": { ...op.sdk } }),
      ...op.extensions,
    };

    if (options.mcpTools === true && !op.restOnly && !toolNames.has(op.name)) {
      toolNames.add(op.name);
      tools.push({
        name: op.name,
        title: op.summary,
        description: op.description ?? op.summary,
        inputSchema: input ?? { type: "object", properties: {} },
      });
    }
  }

  return {
    openapi: "3.1.0",
    info: options.info,
    servers: [{ url: `${options.origin.replace(/\/+$/, "")}${options.basePath}` }],
    tags: [...options.tags],
    paths,
    components: {
      schemas: { ApiError: apiError(options.errorCodes) },
      securitySchemes: { ...options.securitySchemes },
    },
    ...(options.mcpTools && {
      "x-mcp-tools": options.mcpTools === true ? tools : options.mcpTools.map(toolCard),
    }),
  };
}

/** A registered tool as its card, its schema converted the way an operation's `input` is. */
function toolCard(tool: McpToolSource): McpToolCard {
  return {
    name: tool.name,
    // What an MCP client shows when a tool has no title.
    title: tool.title ?? tool.name,
    description: tool.description,
    inputSchema: jsonSchemaOf(tool.inputSchema, "input", `The tool ${tool.name}`),
    ...(tool.annotations !== undefined && { annotations: { ...tool.annotations } }),
  };
}

/**
 * The checks a generated SDK would otherwise fail later, in someone's editor: a method name a client
 * can carry, one operation per name, and `void` where the answer has no body. An operation mounted
 * on several paths names its method on one of them.
 */
function checkSdk(
  op: OpenApiOperation,
  sdk: OpenApiSdk,
  where: string,
  hasBody: boolean,
  seenAt: Map<string, string>,
): void {
  if (!SDK_METHOD.test(sdk.method)) {
    throw new Error(
      `${where}: the SDK method "${sdk.method}" is not a name. Write \`name\`, or ` +
        "`namespace.name` with one dot.",
    );
  }
  const first = seenAt.get(sdk.method);
  if (first !== undefined) {
    throw new Error(
      `${where} and ${first} both want the SDK method "${sdk.method}". Rename one, or, for one ` +
        "operation mounted on several paths, give only one of them an `sdk`.",
    );
  }
  seenAt.set(sdk.method, where);
  if (!hasBody && sdk.returns !== "void") {
    throw new Error(
      `${where} answers ${op.status}, which has no body, so its SDK method returns "void", not ` +
        `${sdk.returns}.`,
    );
  }
  if (op.extensions !== undefined && "x-sdk" in op.extensions) {
    throw new Error(
      `${where} sets \`x-sdk\` in \`extensions\` and has an \`sdk\`. Keep the \`sdk\`: it is ` +
        "what the reference writes as `x-sdk`.",
    );
  }
}

/**
 * `/numbers/:id` → `/numbers/{id}`. A constraint such as `:id{[0-9]+}` is dropped, because
 * OpenAPI has no place for it. An optional slot throws: OpenAPI requires every path parameter,
 * so `/:id?` is two operations, and the reference must say which.
 */
function openApiPath(route: string, where: string): { path: string; slots: string[] } {
  const slots: string[] = [];
  const path = route.replace(/:(\w+)(\{[^}]*\})?(\?)?/g, (_match, name: string, _re, optional) => {
    if (optional) {
      throw new Error(
        `${where} has an optional slot ":${name}?". List it as two operations, with and without it.`,
      );
    }
    slots.push(name);
    return `{${name}}`;
  });
  return { path, slots };
}

function isStandard(source: SchemaSource): source is StandardJsonSchema {
  return "~standard" in source;
}

/** The schema as JSON Schema, ready to sit inside the document. */
function jsonSchemaOf(source: SchemaSource, io: "input" | "output", where: string): JsonObject {
  let json: JsonObject;
  if (isStandard(source)) {
    const standard = source["~standard"];
    if (standard.jsonSchema === undefined) {
      throw new Error(
        `${where}: this ${standard.vendor} schema cannot describe itself as JSON Schema. ` +
          "zod does from 4.4. Upgrade it, or pass JSON Schema instead.",
      );
    }
    json = standard.jsonSchema[io]({
      target: "draft-2020-12",
      // zod throws on a type JSON cannot carry, such as a Date, and one field would then take
      // the whole reference down. "any" writes `{}` for it instead.
      ...(standard.vendor === "zod" && { libraryOptions: { unrepresentable: "any" } }),
    });
  } else {
    json = source;
  }
  // ponytail: a `$ref` into the schema itself — `#` for a recursive zod schema, `#/$defs/…` for a
  // registered one — resolves against the DOCUMENT's root once it sits inside the document, so it
  // throws rather than ship a reference that points at nothing. A `#/components/…` ref you wrote
  // is fine. The upgrade is hoisting `$defs` into `components.schemas` and rewriting the refs.
  if (/"\$ref":"#(?:"|\/\$defs\/|\/definitions\/)/.test(JSON.stringify(json))) {
    throw new Error(
      `${where}: the schema refers to itself ($ref "#" or $defs), from a recursive or registered ` +
        "schema. The reference cannot carry that yet; describe the recursive part as {}.",
    );
  }
  const { $schema: _dialect, ...schema } = json;
  return schema;
}

/** The part of a JSON Schema object the split reads. */
function fieldsOf(schema: JsonObject): {
  properties: Record<string, JsonObject>;
  required: string[];
} {
  const properties: Record<string, JsonObject> = {};
  const raw = schema["properties"];
  if (isObject(raw)) {
    for (const [name, field] of Object.entries(raw)) {
      if (isObject(field)) properties[name] = field;
    }
  }
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter((name) => typeof name === "string")
    : [];
  return { properties, required };
}

/** Where each input field travels: the path, the query string, or the body. Headers go after the path. */
function inputParts(
  op: OpenApiOperation,
  input: JsonObject | undefined,
  slots: string[],
  headers: JsonObject[],
) {
  const { properties, required } = input === undefined ? fieldsOf({}) : fieldsOf(input);
  const fixed = new Set(op.fixed);
  const fieldIn = new Map(slots.map((slot) => [slot, slot]));
  for (const [field, slot] of Object.entries(op.params ?? {})) fieldIn.set(slot, field);
  const inPath = new Set(fieldIn.values());
  const readsQuery = op.method === "get" || op.method === "delete";

  const parameters: JsonObject[] = slots.map((name) => {
    const field = properties[fieldIn.get(name) ?? name];
    return {
      name,
      in: "path",
      // A slot is part of the address, so it is never optional — and a slot the schema does not
      // name is still a parameter, or the path template points at nothing.
      required: true,
      ...(typeof field?.["description"] === "string" && { description: field["description"] }),
      schema: field ?? { type: "string" },
    };
  });

  parameters.push(...headers);

  const rest = Object.entries(properties).filter(([name]) => !inPath.has(name) && !fixed.has(name));
  if (readsQuery) {
    for (const [name, field] of rest) {
      parameters.push({
        name,
        in: "query",
        required: required.includes(name),
        ...(typeof field["description"] === "string" && { description: field["description"] }),
        schema: field,
      });
    }
  }

  const bodyRequired = required.filter((name) => rest.some(([field]) => field === name));
  // What the schema says about the object itself, such as `additionalProperties: false`.
  const { properties: _all, required: _allRequired, ...objectFacts } = input ?? {};
  const requestBody =
    !readsQuery && rest.length > 0
      ? {
          // Required whenever it has fields: a client that always sends a body works against
          // every server, and one that skipped it because the reference said it could gets a 400
          // from any handler that parses JSON.
          required: true,
          content: {
            "application/json": {
              schema: {
                ...objectFacts,
                properties: Object.fromEntries(rest),
                ...(bodyRequired.length > 0 && { required: bodyRequired }),
              },
            },
          },
        }
      : undefined;

  return {
    ...(parameters.length > 0 && { parameters }),
    ...(requestBody !== undefined && { requestBody }),
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys whose value is data, not prose. The walk passes them through whole, because a response
 * example with a field called `description`, or an enum of `summary`, is what an API returns and
 * must not arrive translated.
 */
const DATA_KEYS = new Set(["example", "examples", "default", "enum", "const"]);

/**
 * Keys whose children are NAMES, not keywords: a field called `example` is still a schema to walk,
 * and `default` under `responses` is the answer to any other status, whose description is prose.
 */
const NAME_KEYS = new Set(["properties", "patternProperties", "responses", "content", "headers"]);

export interface TranslateOptions {
  /**
   * `x-` fields whose value is a sentence someone reads, such as `["x-credits"]` when it says
   * "1 credit per page". Every other `x-` field is data — a scope name, an SDK method — and a
   * collector listing it would ask a translator for a word the API matches on.
   */
  proseExtensions?: readonly `x-${string}`[];
}

/**
 * The document with every `summary`, every `description` and the title passed through `t`.
 *
 * Tag names, operation ids, field names, examples and the MCP cards stay as written: the cards
 * are read by agents, which is why their prose stays English. Pass a collector as `t` to list
 * every string a translation needs: `translateProse(doc, (s) => (seen.add(s), s))`.
 */
export function translateProse(
  doc: OpenApiDocument,
  t: (text: string) => string,
  options: TranslateOptions = {},
): OpenApiDocument {
  const prose = new Set<string>(["summary", "description", ...(options.proseExtensions ?? [])]);
  const walkObject = (node: JsonObject, names = false): JsonObject =>
    Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        if (names) return [key, walk(value)];
        if (DATA_KEYS.has(key)) return [key, value];
        if (prose.has(key) && typeof value === "string") {
          return [key, t(value)];
        }
        return [key, walk(value, NAME_KEYS.has(key))];
      }),
    );
  const walk = (node: unknown, names = false): unknown =>
    Array.isArray(node)
      ? node.map((entry) => walk(entry))
      : isObject(node)
        ? walkObject(node, names)
        : node;

  const paths: OpenApiDocument["paths"] = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    const translated: Partial<Record<HttpMethod, JsonObject>> = {};
    for (const [method, op] of Object.entries(item)) {
      if (isMethod(method) && op !== undefined) translated[method] = walkObject(op);
    }
    paths[path] = translated;
  }
  const mapValues = (record: Record<string, JsonObject>) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, walkObject(value)]));

  return {
    ...doc,
    info: {
      ...doc.info,
      title: t(doc.info.title),
      ...(doc.info.description !== undefined && { description: t(doc.info.description) }),
    },
    tags: doc.tags.map((tag) => ({
      name: tag.name,
      ...(tag.description !== undefined && { description: t(tag.description) }),
    })),
    paths,
    components: {
      schemas: mapValues(doc.components.schemas),
      securitySchemes: mapValues(doc.components.securitySchemes),
    },
  };
}

function isMethod(key: string): key is HttpMethod {
  return key === "get" || key === "post" || key === "put" || key === "patch" || key === "delete";
}

/**
 * `GET /openapi.json`, in any language you translate it to:
 *
 * ```ts
 * const reference = createOpenApiResponder(() => buildOpenApi(OPERATIONS, options), {
 *   "pt-BR": (text) => PT_BR[text] ?? text,
 * });
 * app.get("/openapi.json", (c) => reference(c.req.query("lang")));
 * ```
 *
 * The document is built on the first request, so the list can be filled while routes mount, and
 * each language is built once and kept. A language with no entry gets the document as written,
 * so an unknown `?lang=` cannot grow the cache. `options` goes to `translateProse`.
 */
export function createOpenApiResponder(
  build: () => OpenApiDocument,
  translations: Readonly<Record<string, (text: string) => string>> = {},
  options: TranslateOptions = {},
): (lang?: string) => Response {
  const bodies = new Map<string, string>();
  return (lang) => {
    const key = lang !== undefined && Object.hasOwn(translations, lang) ? lang : "";
    let body = bodies.get(key);
    if (body === undefined) {
      const doc = build();
      const t = translations[key];
      body = JSON.stringify(t === undefined ? doc : translateProse(doc, t, options));
      bodies.set(key, body);
    }
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // It changes only when you deploy.
        "Cache-Control": "public, max-age=300",
      },
    });
  };
}
