import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  retrySource,
  sdkMethods,
  transportSource,
  type SdkMethodsOptions,
  type SdkOperation,
} from "./methods.ts";
import { writeGenerated } from "./write.ts";

const SEND: SdkOperation = {
  name: "send_message",
  method: "post",
  path: "/messages",
  summary: "Send a message.",
  description: "Queues it and answers with its id.",
  input: z.object({ to: z.string().describe("Who gets it."), text: z.string() }),
  headers: [{ name: "Idempotency-Key" }],
  sdk: { method: "sendMessage", returns: "MessageDto" },
};

const GET_NUMBER: SdkOperation = {
  name: "get_number",
  method: "get",
  path: "/numbers/:id{[0-9a-z_]+}",
  summary: "Read a number.",
  input: z.object({ numberId: z.string() }),
  params: { numberId: "id" },
  sdk: { method: "numbers.get", returns: "NumberDto" },
};

const LIST_NUMBERS: SdkOperation = {
  name: "list_numbers",
  method: "get",
  path: "/numbers",
  summary: "List your numbers.",
  input: z.object({ status: z.array(z.enum(["on", "off"])).optional() }),
  sdk: { method: "numbers.list", returns: "Page<NumberDto>" },
};

const DELETE_NUMBER: SdkOperation = {
  name: "delete_number",
  method: "delete",
  path: "/numbers/:id",
  summary: "Delete a number.",
  input: z.object({ id: z.string() }),
  status: 204,
  sdk: { method: "numbers.delete", returns: "void" },
};

const HEALTH: SdkOperation = {
  name: "health",
  method: "get",
  path: "/health",
  summary: "Check the API is up.",
  sdk: { method: "health", returns: "HealthDto" },
};

/** An operation with no `sdk`: the API serves it, the SDK has no method for it. */
const INTERNAL: SdkOperation = {
  name: "rebuild",
  method: "post",
  path: "/internal/rebuild",
  summary: "Rebuild the index.",
};

const ALL = [SEND, GET_NUMBER, LIST_NUMBERS, DELETE_NUMBER, HEALTH, INTERNAL];

describe("sdkMethods", () => {
  it("writes a method per placed operation, top level first, each with its spec", () => {
    const { members } = sdkMethods([GET_NUMBER, SEND, INTERNAL]);
    expect(members).toBe(`
    /**
     * Send a message.
     *
     * Queues it and answers with its id.
     */
    sendMessage(params: SendMessageParams, opts?: RequestOptions): Promise<MessageDto> {
        return this.request({ method: "POST", path: "/messages", keyed: true }, params, opts);
    }

    readonly numbers = {
        /**
         * Read a number.
         */
        get: (params: GetNumberParams, opts?: RequestOptions): Promise<NumberDto> =>
            this.request({ method: "GET", path: "/numbers/:numberId" }, params, opts),
    };
`);
  });

  it("writes the params interfaces and lists the names to import", () => {
    const result = sdkMethods(ALL);
    expect(result.params).toBe(`/** Arguments for \`sendMessage()\`. */
export interface SendMessageParams {
    /** Who gets it. */
    to: string;
    text: string;
}

/** Arguments for \`numbers.get()\`. */
export interface GetNumberParams {
    numberId: string;
}

/** Arguments for \`numbers.list()\`. */
export interface ListNumbersParams {
    status?: ("on" | "off")[];
}

/** Arguments for \`numbers.delete()\`. */
export interface DeleteNumberParams {
    id: string;
}
`);
    expect(result.paramTypes).toEqual([
      "DeleteNumberParams",
      "GetNumberParams",
      "ListNumbersParams",
      "SendMessageParams",
    ]);
    expect(result.returnTypes).toEqual(["HealthDto", "MessageDto", "NumberDto", "Page"]);
  });

  it("makes params optional when nothing in them is required, and takes none without input", () => {
    const { members } = sdkMethods([LIST_NUMBERS, HEALTH]);
    expect(members).toContain(
      "list: (params?: ListNumbersParams, opts?: RequestOptions): Promise<Page<NumberDto>> =>",
    );
    expect(members).toContain("health(opts?: RequestOptions): Promise<HealthDto> {");
    expect(members).toContain(`this.request({ method: "GET", path: "/health" }, undefined, opts);`);
  });

  it("leaves out the fields the route fills in itself", () => {
    const op: SdkOperation = {
      ...SEND,
      input: z.object({ to: z.string(), type: z.literal("text") }),
      fixed: ["type"],
    };
    expect(sdkMethods([op]).params).not.toContain("type");
  });

  it("keys an operation whose headers name an Idempotency-Key, in any case, and writes repeatable", () => {
    const keyed = { ...SEND, headers: [{ name: "idempotency-key" }] };
    expect(sdkMethods([keyed]).members).toContain("keyed: true");
    expect(sdkMethods([{ ...SEND, headers: [] }]).members).not.toContain("keyed");
    const search = { ...SEND, sdk: { method: "search", returns: "MessageDto", repeatable: true } };
    expect(sdkMethods([search]).members).toContain(
      `{ method: "POST", path: "/messages", keyed: true, repeatable: true }`,
    );
  });

  it("puts namespaces in the order given, and otherwise in the order they appear", () => {
    const jobs = { ...HEALTH, name: "get_job", sdk: { method: "jobs.get", returns: "HealthDto" } };
    const byAppearance = sdkMethods([jobs, GET_NUMBER]).members;
    expect(byAppearance.indexOf("readonly jobs")).toBeLessThan(
      byAppearance.indexOf("readonly numbers"),
    );
    const ordered = sdkMethods([jobs, GET_NUMBER], { namespaces: ["numbers", "jobs", "unused"] });
    expect(ordered.members.indexOf("readonly numbers")).toBeLessThan(
      ordered.members.indexOf("readonly jobs"),
    );
    expect(ordered.members).not.toContain("unused");
  });

  it("writes the doc comment the hook gives, skipping undefined paragraphs, and none for none", () => {
    const doc: SdkMethodsOptions["doc"] = (op) => [
      op.summary,
      op.description,
      `\`${op.method.toUpperCase()} /v1${op.path}\``,
    ];
    expect(sdkMethods([HEALTH], { doc }).members).toContain(
      "    /**\n     * Check the API is up.\n     *\n     * `GET /v1/health`\n     */\n",
    );
    expect(sdkMethods([HEALTH], { doc: () => [] }).members).toBe(`
    health(opts?: RequestOptions): Promise<HealthDto> {
        return this.request({ method: "GET", path: "/health" }, undefined, opts);
    }
`);
  });

  it("adds the spec fields the hook gives, quoting a key that needs it", () => {
    const specExtra = () => ({ proxy: ["country", "city"], "x-cost": 2, skipped: undefined });
    expect(sdkMethods([SEND], { specExtra }).members).toContain(
      `{ method: "POST", path: "/messages", keyed: true, proxy: ["country","city"], "x-cost": 2 }`,
    );
  });

  it("places hand-written members after the generated ones, in a namespace of their own too", () => {
    const { members } = sdkMethods([GET_NUMBER], {
      inject: [
        {
          method: "numbers.watch",
          signature: "(numberId: string): AsyncIterable<NumberDto>",
          call: "this.watchNumber(numberId)",
          doc: ["Follow a number live."],
        },
        {
          method: "jobs.wait",
          signature: "(id: string): Promise<JobDto>",
          call: "this.waitForJob(id)",
        },
        { method: "ping", signature: "(): Promise<void>", call: "this.ping()" },
      ],
    });
    expect(members).toContain(`
    ping(): Promise<void> {
        return this.ping();
    }
`);
    expect(members)
      .toContain(`            this.request({ method: "GET", path: "/numbers/:numberId" }, params, opts),
        /**
         * Follow a number live.
         */
        watch: (numberId: string): AsyncIterable<NumberDto> =>
            this.watchNumber(numberId),
    };`);
    expect(members).toContain(`    readonly jobs = {
        wait: (id: string): Promise<JobDto> =>
            this.waitForJob(id),
    };`);
  });

  it.each<[string, SdkOperation[], SdkMethodsOptions, RegExp]>([
    [
      "a name with two dots",
      [{ ...HEALTH, sdk: { method: "a.b.c", returns: "HealthDto" } }],
      {},
      /`a\.b\.c` is not a method name/,
    ],
    [
      "a name that is not an identifier",
      [{ ...HEALTH, sdk: { method: "numbers.check-in", returns: "HealthDto" } }],
      {},
      /is not a method name/,
    ],
    [
      "two operations in one place",
      [GET_NUMBER, { ...LIST_NUMBERS, sdk: { method: "numbers.get", returns: "NumberDto" } }],
      {},
      /want to be `numbers\.get`: GET \S+ \(get_number\), and GET \/numbers \(list_numbers\)/,
    ],
    [
      "a hand-written member in a generated one's place",
      [GET_NUMBER],
      { inject: [{ method: "numbers.get", signature: "()", call: "x" }] },
      /\(get_number\), and The hand-written numbers\.get\. Rename one/,
    ],
    [
      "a 204 that returns something",
      [{ ...DELETE_NUMBER, sdk: { method: "numbers.delete", returns: "NumberDto" } }],
      {},
      /answers 204, which has no body, so `sdk\.returns` must be "void"/,
    ],
    [
      "a namespace the list does not have",
      [GET_NUMBER],
      { namespaces: ["jobs"] },
      /The namespace `numbers` is not in `namespaces`/,
    ],
    [
      "a name that is both a method and a namespace",
      [GET_NUMBER, { ...HEALTH, sdk: { method: "numbers", returns: "HealthDto" } }],
      {},
      /`numbers` is both a method and a namespace/,
    ],
    [
      "the name of the seam every method calls",
      [{ ...HEALTH, sdk: { method: "request", returns: "HealthDto" } }],
      {},
      /`request` is a class member every SDK already has/,
    ],
    [
      "a path slot filled by an optional field",
      [{ ...GET_NUMBER, input: z.object({ numberId: z.string().optional() }) }],
      {},
      /":id" is filled from `numberId`, which the input does not require/,
    ],
    [
      "a path slot with no input at all",
      [{ ...HEALTH, path: "/health/:region" }],
      {},
      /":region" is filled from `region`, which the input does not require/,
    ],
    [
      "a path slot filled by a field the route fixes",
      [{ ...DELETE_NUMBER, fixed: ["id"] }],
      {},
      /":id" is filled from `id`, which the input does not require/,
    ],
    [
      "params naming a slot the path lacks",
      [{ ...GET_NUMBER, params: { numberId: "number" } }],
      {},
      /`params` sends numberId in ":number", which the path does not have/,
    ],
    [
      "an optional slot",
      [{ ...DELETE_NUMBER, path: "/numbers/:id?" }],
      {},
      /has an optional slot ":id\?"/,
    ],
    [
      "a spec field the generator writes",
      [SEND],
      { specExtra: () => ({ path: "/elsewhere" }) },
      /`specExtra` sets "path", which the generator writes itself/,
    ],
    [
      "an input with a type JSON cannot carry",
      [{ ...SEND, input: z.object({ at: z.date() }) }],
      {},
      /^POST \/messages \(send_message\): /,
    ],
  ])("refuses %s", (_label, operations, options, message) => {
    expect(() => sdkMethods(operations, options)).toThrow(message);
  });
});

describe("retrySource and transportSource", () => {
  it("copies @gusnips/http's retry rule whole, with nothing to import", () => {
    const source = retrySource();
    for (const name of ["shouldRetry", "retryDelayMs", "retryAfterSecs", "parseRetryAfter"]) {
      expect(source).toContain(`export function ${name}(`);
    }
    expect(source).not.toMatch(/^import /m);
  });

  it("copies the transport importing the rule from beside it, and nothing else", () => {
    const specifiers = [...transportSource().matchAll(/^import [^;]* from "([^"]+)";$/gm)];
    expect(specifiers.map((match) => match[1])).toEqual(["./retry.ts"]);
  });
});

/** The type errors in `file` and what it imports, under strict settings plus `options`. */
function typeErrors(file: string, options: ts.CompilerOptions): string[] {
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    ...options,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
}

describe("SdkOperation", () => {
  it("takes the operation list an API already hands buildOpenApi, unchanged", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const file = join(mkdtempSync(join(tmpdir(), "sdkgen-fits-")), "fits.ts");
    writeFileSync(
      file,
      `import type { OpenApiOperation } from ${JSON.stringify(join(here, "../../server/src/openapi/index.ts"))};
import type { SdkOperation } from ${JSON.stringify(join(here, "methods.ts"))};
export const fits = (operations: readonly OpenApiOperation[]): readonly SdkOperation[] => operations;
`,
    );
    const errors = typeErrors(file, {
      lib: ["lib.es2022.d.ts"],
      types: ["node"],
      typeRoots: [join(here, "../node_modules/@types")],
    });
    expect(errors).toEqual([]);
  }, 60_000);
});

describe("a generated SDK", () => {
  /** An SDK the way an adopter's script writes one, from these operations. */
  async function generate(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "sdkgen-sdk-"));
    const { params, members, paramTypes, returnTypes } = sdkMethods(ALL, {
      namespaces: ["numbers"],
    });
    await writeGenerated(
      {
        "contract.ts": `export interface MessageDto { id: string }
export interface NumberDto { id: string; status: "on" | "off" }
export interface Page<T> { items: T[] }
export interface HealthDto { ok: boolean }
`,
        "params.ts": params,
        "operations.ts": `import type { ${returnTypes.join(", ")} } from "./contract.ts";
import type { ${paramTypes.join(", ")} } from "./params.ts";
import type { RequestOptions, RequestSpec } from "./transport.ts";

export abstract class GeneratedOperations {
    protected abstract request<T>(spec: RequestSpec, params?: object, opts?: RequestOptions): Promise<T>;
${members}}
`,
        "retry.ts": retrySource(),
        "transport.ts": transportSource(),
        "client.ts": `import { GeneratedOperations } from "./operations.ts";
import { send, type Failure, type RequestOptions, type RequestSpec, type Transport } from "./transport.ts";

export class ExampleError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(failure: Failure) {
        super(failure.error?.message ?? \`\${failure.method} \${failure.path} failed with \${failure.status}.\`);
        this.status = failure.status;
        this.code = failure.error?.code;
    }
}

export class Example extends GeneratedOperations {
    private readonly transport: Transport;
    constructor(options: { apiKey: string; fetch: typeof fetch }) {
        super();
        this.transport = {
            baseUrl: "https://api.example.test/v1",
            headers: { authorization: \`Bearer \${options.apiKey}\` },
            fetch: options.fetch,
            mintKeys: true,
            error: (failure) => new ExampleError(failure),
        };
    }
    protected async request<T>(spec: RequestSpec, params?: object, opts?: RequestOptions): Promise<T> {
        return (await send<T>(this.transport, spec, params, opts)).data;
    }
}
`,
      },
      { root: dir },
    );
    return dir;
  }

  // Written once for both tests: formatting six files is most of the time either one takes.
  let written: Promise<string> | undefined;
  const sdk = () => (written ??= generate());

  it("typechecks under the settings SDKs publish with, with no Node types", async () => {
    const dir = await sdk();
    // The flags the SDKs on this stack publish with. DOM and no Node types: an SDK runs wherever
    // fetch does, so the transport may lean on nothing only Node has.
    const errors = typeErrors(join(dir, "client.ts"), {
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
      types: [],
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
    });
    expect(errors).toEqual([]);
  }, 60_000);

  it("calls the API through the generated methods", async () => {
    const dir = await sdk();
    const sent: { url: string; init: RequestInit }[] = [];
    const replies = [
      Response.json({ data: { id: "n 1", status: "on" } }),
      Response.json({ data: { id: "m1" } }),
      new Response(null, { status: 204 }),
      Response.json({ error: { code: "NOT_FOUND", message: "No such number." } }, { status: 404 }),
    ];
    const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(input), init });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no reply left");
      return reply;
    };
    const { Example } = await import(pathToFileURL(join(dir, "client.ts")).href);
    const client = new Example({ apiKey: "k", fetch });

    expect(await client.numbers.get({ numberId: "n 1" })).toEqual({ id: "n 1", status: "on" });
    expect(sent[0]!.url).toBe("https://api.example.test/v1/numbers/n%201");

    expect(await client.sendMessage({ to: "a", text: "hi" })).toEqual({ id: "m1" });
    const headers = new Headers(sent[1]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer k");
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]!.init.body).toBe(`{"to":"a","text":"hi"}`);

    expect(await client.numbers.delete({ id: "n1" })).toBeUndefined();
    expect(sent[2]!.init.method).toBe("DELETE");

    await expect(client.numbers.get({ numberId: "gone" })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "No such number.",
    });
  }, 60_000);
});
