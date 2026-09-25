import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenApi,
  createOpenApiResponder,
  translateProse,
  type OpenApiOperation,
  type OpenApiOptions,
} from "./index.ts";

const options: OpenApiOptions = {
  info: { title: "Example API", version: "1.0.0", description: "Send things." },
  origin: "https://api.example.test/",
  basePath: "/v1",
  tags: [{ name: "Numbers", description: "Your numbers." }, { name: "Messages" }],
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Your key." } },
  errors: {
    400: "The input is wrong.",
    401: "The key is wrong.",
    402: "Buy more.",
    429: "Slow down.",
  },
};

const pair: OpenApiOperation = {
  name: "pair_number",
  method: "post",
  path: "/numbers/:id{[0-9]+}/pair",
  tag: "Numbers",
  summary: "Pair a number",
  input: z
    .object({
      id: z.string().describe("The number's id."),
      method: z.enum(["qr", "code"]).describe("How to pair."),
      note: z.string().optional(),
    })
    .strict(),
  response: z.object({ status: z.string() }),
  status: 201,
  example: { status: "pairing" },
};

const list: OpenApiOperation = {
  name: "list_numbers",
  method: "get",
  path: "/numbers",
  tag: "Numbers",
  summary: "List numbers",
  input: z.object({ limit: z.number().describe("How many."), cursor: z.string().optional() }),
  keyless: true,
  restOnly: true,
};

type Op = Record<string, unknown> & {
  parameters?: {
    name: string;
    in: string;
    required: boolean;
    description?: string;
    schema: unknown;
  }[];
  requestBody?: {
    required: boolean;
    content: { "application/json": { schema: Record<string, unknown> } };
  };
  responses: Record<
    string,
    { description: string; headers?: object; content?: Record<string, unknown> }
  >;
};

function op(doc: ReturnType<typeof buildOpenApi>, path: string, method: "get" | "post"): Op {
  const found = doc.paths[path]?.[method];
  if (found === undefined) throw new Error(`no ${method} ${path}`);
  // Test-only: the document types operations as JSON objects, and these tests read their parts.
  return found as Op;
}

describe("buildOpenApi", () => {
  it("names the public origin with the mount prefix, never anything from a request", () => {
    const doc = buildOpenApi([pair], options);
    expect(doc.servers).toEqual([{ url: "https://api.example.test/v1" }]);
    expect(buildOpenApi([pair], { ...options, basePath: "" }).servers).toEqual([
      { url: "https://api.example.test" },
    ]);
  });

  it("writes the route as a template, without its constraint", () => {
    expect(Object.keys(buildOpenApi([pair, list], options).paths)).toEqual([
      "/numbers/{id}/pair",
      "/numbers",
    ]);
  });

  it("sends a slot's field in the path and the rest of a write in the body", () => {
    const post = op(buildOpenApi([pair], options), "/numbers/{id}/pair", "post");
    expect(post.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        description: "The number's id.",
        schema: { type: "string", description: "The number's id." },
      },
    ]);
    const body = post.requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content["application/json"].schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["qr", "code"], description: "How to pair." },
        note: { type: "string" },
      },
      required: ["method"],
    });
  });

  it("sends a read's fields in the query string, required only where the schema requires them", () => {
    const get = op(buildOpenApi([list], options), "/numbers", "get");
    expect(get.parameters?.map(({ name, in: at, required }) => [name, at, required])).toEqual([
      ["limit", "query", true],
      ["cursor", "query", false],
    ]);
    expect(get.parameters?.[0]?.description).toBe("How many.");
    expect(get.requestBody).toBeUndefined();
    expect(Object.keys(get.responses)[0]).toBe("200");
    const remove = buildOpenApi([{ ...list, method: "delete" }], options).paths["/numbers"]?.delete;
    expect(remove?.["parameters"]).toHaveLength(2);
    expect(remove?.["requestBody"]).toBeUndefined();
  });

  it("documents a slot the schema does not name, so the template never points at nothing", () => {
    const get = op(
      buildOpenApi([{ ...list, path: "/numbers/:id", input: undefined }], options),
      "/numbers/{id}",
      "get",
    );
    expect(get.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("carries a field in a slot of another name", () => {
    const renamed = { ...pair, path: "/numbers/:number/pair", params: { id: "number" } };
    const post = op(buildOpenApi([renamed], options), "/numbers/{number}/pair", "post");
    expect(post.parameters?.map(({ name, description }) => [name, description])).toEqual([
      ["number", "The number's id."],
    ]);
    expect(post.requestBody?.content["application/json"].schema["properties"]).not.toHaveProperty(
      "id",
    );
    expect(() => buildOpenApi([{ ...renamed, params: { id: "num" } }], options)).toThrow(
      /sends id in ":num", which the path does not have/,
    );
  });

  it("leaves out a field the route fixes, and writes no body when nothing is left", () => {
    const send: OpenApiOperation = {
      name: "send_media",
      method: "post",
      path: "/messages/image",
      tag: "Messages",
      summary: "Send an image",
      input: z.object({ type: z.enum(["image", "video"]) }),
      fixed: ["type"],
    };
    const post = op(buildOpenApi([send], options), "/messages/image", "post");
    expect(post.requestBody).toBeUndefined();
    expect(post.parameters).toBeUndefined();
  });

  it("wraps the response in the data envelope, with its example", () => {
    const post = op(buildOpenApi([pair], options), "/numbers/{id}/pair", "post");
    expect(post.responses["201"]?.content).toEqual({
      "application/json": {
        schema: {
          type: "object",
          required: ["data"],
          properties: {
            data: {
              type: "object",
              properties: { status: { type: "string" } },
              required: ["status"],
              additionalProperties: false,
            },
          },
        },
        example: { data: { status: "pairing" } },
      },
    });
  });

  it("points every refusal at one ApiError, and names Retry-After only where a wait is stated", () => {
    const doc = buildOpenApi([pair], options);
    const { responses } = op(doc, "/numbers/{id}/pair", "post");
    expect(Object.keys(responses)).toEqual(["201", "400", "401", "402", "429", "default"]);
    expect(responses["429"]?.headers).toHaveProperty("Retry-After");
    expect(responses["402"]?.headers).toBeUndefined();
    expect(responses["400"]?.headers).toBeUndefined();
    expect(responses["default"]?.content).toEqual({
      "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
    });
    expect(doc.components.schemas["ApiError"]).toMatchObject({ required: ["error"] });
  });

  it("asks for a credential unless the operation is keyless", () => {
    const doc = buildOpenApi([pair, list], options);
    expect(op(doc, "/numbers/{id}/pair", "post")["security"]).toEqual([{ bearerAuth: [] }]);
    expect(op(doc, "/numbers", "get")["security"]).toEqual([]);
  });

  it("lists each tool once, keeps REST-only operations out, and uses the whole input", () => {
    const alias = { ...pair, path: "/pair/:id", operationId: "pair_number_short" };
    const doc = buildOpenApi([pair, alias, list], { ...options, mcpTools: true });
    expect(doc["x-mcp-tools"]?.map((tool) => tool.name)).toEqual(["pair_number"]);
    expect(doc["x-mcp-tools"]?.[0]?.inputSchema).toMatchObject({
      required: ["id", "method"],
    });
    expect(buildOpenApi([pair], options)).not.toHaveProperty("x-mcp-tools");
  });

  it("refuses an operation id that repeats, naming both routes", () => {
    expect(() => buildOpenApi([pair, { ...pair, path: "/pair/:id" }], options)).toThrow(
      /POST \/pair\/:id and POST \/numbers\/:id\{\[0-9\]\+\}\/pair share the operation id "pair_number"/,
    );
  });

  it("refuses a tag the options do not list", () => {
    expect(() => buildOpenApi([{ ...pair, tag: "Billing" }], options)).toThrow(/"Billing"/);
  });

  it("refuses an optional slot, which OpenAPI cannot express", () => {
    expect(() => buildOpenApi([{ ...list, path: "/numbers/:id?" }], options)).toThrow(
      /optional slot ":id\?"/,
    );
  });

  it("refuses a schema that refers to itself, which would resolve against the document", () => {
    const node: z.ZodType = z.lazy(() => z.object({ children: z.array(node) }));
    expect(() => buildOpenApi([{ ...pair, response: node }], options)).toThrow(/refers to itself/);
    const id = z.string().meta({ id: "Ident" });
    const registered = z.object({ a: id, b: id });
    expect(() => buildOpenApi([{ ...pair, response: registered }], options)).toThrow(
      /refers to itself/,
    );
    const yours = { type: "object", properties: { a: { $ref: "#/components/schemas/ApiError" } } };
    expect(() => buildOpenApi([{ ...pair, response: yours }], options)).not.toThrow();
  });

  it("describes a type JSON cannot carry as anything, rather than failing the whole reference", () => {
    const post = op(
      buildOpenApi([{ ...pair, response: z.object({ at: z.date() }) }], options),
      "/numbers/{id}/pair",
      "post",
    );
    const schema = post.responses["201"]?.content?.["application/json"];
    expect(JSON.stringify(schema)).toContain('"at":{}');
  });

  it("takes plain JSON Schema as it is", () => {
    const post = op(
      buildOpenApi(
        [
          {
            ...pair,
            input: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            response: { type: "array", items: { type: "string" } },
          },
        ],
        options,
      ),
      "/numbers/{id}/pair",
      "post",
    );
    expect(post.parameters?.[0]?.schema).toEqual({ type: "integer" });
    expect(JSON.stringify(post.responses["201"])).toContain('"data":{"type":"array"');
  });

  it("says what to do with a schema that cannot describe itself", () => {
    const old = { "~standard": { vendor: "zod" } };
    expect(() => buildOpenApi([{ ...pair, input: old }], options)).toThrow(/zod does from 4\.4/);
  });
});

describe("the envelope", () => {
  it("names meta beside data when told what it holds, and never requires it", () => {
    const success = (
      doc: ReturnType<typeof buildOpenApi>,
    ): { required: string[]; properties: Record<string, unknown> } =>
      JSON.parse(JSON.stringify(op(doc, "/numbers/{id}/pair", "post").responses["201"]?.content))[
        "application/json"
      ].schema;
    const total = { type: "object", properties: { total: { type: "integer" } } };
    const withMeta = success(buildOpenApi([pair], { ...options, meta: total }));
    expect(withMeta.required).toEqual(["data"]);
    expect(withMeta.properties["meta"]).toEqual(total);
    expect(success(buildOpenApi([pair], options)).properties).not.toHaveProperty("meta");
  });

  it("adds an operation's own refusals to the shared ones, and only on that operation", () => {
    const send: OpenApiOperation = {
      ...pair,
      name: "send",
      path: "/messages",
      errors: { 429: "Slow down, this number is warming up.", 504: "It may still arrive." },
    };
    const doc = buildOpenApi([pair, send], options);
    const own = op(doc, "/messages", "post").responses;
    expect(Object.keys(own)).toEqual(["201", "400", "401", "402", "429", "504", "default"]);
    expect(own["429"]?.description).toBe("Slow down, this number is warming up.");
    expect(own["504"]?.description).toBe("It may still arrive.");
    expect(op(doc, "/numbers/{id}/pair", "post").responses).not.toHaveProperty("504");
  });

  it("lists the error codes, so a client can switch on one", () => {
    const codes = ["NOT_FOUND", "RATE_LIMIT_EXCEEDED"];
    const doc = buildOpenApi([pair], { ...options, errorCodes: codes });
    const error = doc.components.schemas["ApiError"]?.["properties"];
    expect(JSON.stringify(error)).toContain('"enum":["NOT_FOUND","RATE_LIMIT_EXCEEDED"]');
    const open = buildOpenApi([pair], options).components.schemas["ApiError"];
    expect(JSON.stringify(open)).not.toContain("enum");
  });
});

describe("translateProse", () => {
  const upper = (text: string) => text.toUpperCase();

  it("translates the title, tag descriptions, summaries and descriptions", () => {
    const doc = translateProse(buildOpenApi([pair], options), upper);
    expect(doc.info).toMatchObject({ title: "EXAMPLE API", description: "SEND THINGS." });
    expect(doc.tags[0]).toEqual({ name: "Numbers", description: "YOUR NUMBERS." });
    const post = op(doc, "/numbers/{id}/pair", "post");
    expect(post["summary"]).toBe("PAIR A NUMBER");
    expect(post.parameters?.[0]?.description).toBe("THE NUMBER'S ID.");
    expect(post.responses["429"]?.description).toBe("SLOW DOWN.");
    expect(doc.components.securitySchemes["bearerAuth"]?.["description"]).toBe("YOUR KEY.");
  });

  it("leaves data alone: examples, enums, defaults, and a field named like a keyword", () => {
    const withData: OpenApiOperation = {
      ...pair,
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          example: { type: "string", description: "A sample." },
          kind: { type: "string", enum: ["summary"], default: "summary" },
        },
      },
      example: { description: "a product description from the database" },
    };
    const doc = translateProse(buildOpenApi([withData], options), upper);
    const post = op(doc, "/numbers/{id}/pair", "post");
    const body = post.requestBody?.content["application/json"].schema;
    expect(body?.["properties"]).toEqual({
      example: { type: "string", description: "A SAMPLE." },
      kind: { type: "string", enum: ["summary"], default: "summary" },
    });
    expect(JSON.stringify(post.responses["201"])).toContain(
      '"example":{"data":{"description":"a product description from the database"}}',
    );
    expect(post["operationId"]).toBe("pair_number");
  });

  it("translates only the x- fields it is told are prose", () => {
    const billed: OpenApiOperation = {
      ...pair,
      extensions: { "x-credits": "1 credit per pair.", "x-grant": "numbers:write" },
    };
    const doc = translateProse(buildOpenApi([billed], options), upper, {
      proseExtensions: ["x-credits"],
    });
    const post = op(doc, "/numbers/{id}/pair", "post");
    expect(post["x-credits"]).toBe("1 CREDIT PER PAIR.");
    expect(post["x-grant"]).toBe("numbers:write");
    const plain = op(
      translateProse(buildOpenApi([billed], options), upper),
      "/numbers/{id}/pair",
      "post",
    );
    expect(plain["x-credits"]).toBe("1 credit per pair.");
  });

  it("keeps the MCP cards as written, because agents read them", () => {
    const doc = translateProse(buildOpenApi([pair], { ...options, mcpTools: true }), upper);
    expect(doc["x-mcp-tools"]?.[0]).toMatchObject({ title: "Pair a number" });
  });

  it("lists every string a translation needs when handed a collector", () => {
    const seen = new Set<string>();
    translateProse(buildOpenApi([pair], options), (text) => (seen.add(text), text));
    expect(seen).toContain("Pair a number");
    // `default` is data under a schema and the catch-all under `responses`; this one is prose.
    expect(seen).toContain("Any other failure.");
    expect(seen).not.toContain("pair_number");
  });
});

describe("createOpenApiResponder", () => {
  it("builds each language once and answers an unknown one with the document as written", async () => {
    let builds = 0;
    const reference = createOpenApiResponder(
      () => {
        builds += 1;
        return buildOpenApi([pair], options);
      },
      { upper: (text) => text.toUpperCase() },
    );
    const titleIn = async (lang?: string): Promise<string> => {
      const doc: { info: { title: string } } = JSON.parse(await reference(lang).text());
      return doc.info.title;
    };
    expect(await titleIn()).toBe("Example API");
    expect(await titleIn("upper")).toBe("EXAMPLE API");
    expect(await titleIn("xx")).toBe("Example API");
    // A name every object inherits is not a language anybody registered.
    expect(await titleIn("toString")).toBe("Example API");
    await titleIn("upper");
    expect(builds).toBe(2);
  });

  it("hands its options to the translation", async () => {
    const billed: OpenApiOperation = { ...pair, extensions: { "x-credits": "1 credit per pair." } };
    const reference = createOpenApiResponder(
      () => buildOpenApi([billed], options),
      { upper: (text) => text.toUpperCase() },
      { proseExtensions: ["x-credits"] },
    );
    expect(await reference("upper").text()).toContain('"x-credits":"1 CREDIT PER PAIR."');
  });

  it("answers JSON that a CDN may keep for five minutes", () => {
    const res = createOpenApiResponder(() => buildOpenApi([pair], options))();
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
