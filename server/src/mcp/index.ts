/**
 * An MCP door beside your REST API: the same operations, the same errors, the same limits.
 *
 * Eight backends each wrote one, and each fix lived in one or two of them:
 * - **A tool handler must never throw.** The SDK answers a throw with the error's own message as
 *   the tool's result, and nothing logs it. Three doors rethrew what they could not place, so
 *   `connect ECONNREFUSED 10.0.0.5:5432` reached the agent and no log line saw it.
 * - **A limit counts tool calls, not POSTs.** One POST can carry a JSON-RPC batch, and the SDK
 *   runs every call in it (measured with 3 and with 50). Six doors limited the POST.
 * - **Pass the zod object, not its `.shape`.** Handed a shape, the SDK builds a loose object and
 *   drops an argument the agent invented before the handler can see it. Handed a `.strict()`
 *   object, it refuses the call and names the key.
 * - **A GET is refused.** The stateless transport answers a GET with an event stream it never
 *   writes to, which holds the connection until the server's idle timeout.
 * - **A browser origin is checked**, as the MCP spec requires. Two doors did.
 * - **`/mcp/` is served as well as `/mcp`.** Seven doors said so in a comment, and five of them
 *   answered 404, because a sub-app mounted at `/mcp` folds both spellings into one.
 *
 * Measured on SDK 1.29.0 and 1.30.1, the two ends of the fleet. `@modelcontextprotocol/sdk` and
 * `hono` are optional peers, and this subpath is the only place that imports the SDK.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono, type Context, type Env } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../logger/index.ts";
import type { ErrorAnswer } from "../responses.ts";

/** What the SDK hands each tool call: its session id, if any, and a signal for cancellation. */
export type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The shape every operation layer in the fleet already has. */
export interface ToolOperation<Deps, Args, Result> {
  name: string;
  title?: string;
  description: string;
  /**
   * The zod object itself, made `.strict()`. A `.shape` does not compile here: the SDK would
   * rebuild it as a loose object and drop any argument the agent invented.
   */
  inputSchema: AnySchema;
  annotations?: ToolAnnotations;
  run(deps: Deps, args: Args): Promise<Result>;
}

interface ToolErrorOptions {
  /** Your bound `createErrorResponse(...)`, the one your REST door answers with. */
  errorResponse: (err: unknown) => ErrorAnswer;
  logger: Logger;
  /** The request id your logs use, so a tool's failure is on the same id as its request. */
  requestId?: string;
  /** For a throw nobody raised on purpose, which is where an alert belongs. Must not throw. */
  onUnexpected?: (err: unknown, tool: string) => void;
}

export interface ToolDoor<Deps> extends ToolErrorOptions {
  /** What each call runs with. Build it inside `mcpRoutes`' `build`, where the request is. */
  deps: (extra: ToolCallExtra) => Deps | Promise<Deps>;
  /**
   * Runs before every tool call, such as your rate limit; throw your 429 to refuse the call. One
   * POST can carry many calls, so a limit on the POST lets a batch through. `null` to go without.
   */
  beforeCall: ((tool: string, deps: Deps) => void | Promise<void>) | null;
  /**
   * The answer to a call that worked. By default the REST body, `{ data }`, as one text block. It
   * gets the call's own `deps`, so what an operation handed back on the side (an image to show, a
   * cost) belongs to this call and no other, and it may be async. A throw here answers the call as
   * failed after the operation already ran, so catch what is only nice to have.
   */
  present?: (result: unknown, tool: string, deps: Deps) => CallToolResult | Promise<CallToolResult>;
}

const textResult = (body: unknown, isError?: true): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  ...(isError && { isError }),
});

/**
 * The answer to a tool call that failed, for a door that registers its own tools: the same
 * envelope your REST door sends, as a tool error. A 5xx and an escaped throw are logged with the
 * raw error, and an escaped throw is masked, as on REST. Return it from your handler's `catch`;
 * never rethrow.
 */
export function toolError(err: unknown, tool: string, options: ToolErrorOptions): CallToolResult {
  const answer = options.errorResponse(err);
  if (answer.kind !== "client")
    options.logger.error("tool failed", {
      requestId: options.requestId,
      tool,
      kind: answer.kind,
      error: err,
    });
  if (answer.kind === "unexpected") options.onUnexpected?.(err, tool);
  // The `Retry-After` header has nowhere to go in a tool result. The wait is in `details` too.
  return textResult(answer.body, true);
}

/**
 * Registers one operation as a tool. The handler never throws: a failure comes back through
 * `toolError`.
 *
 *     for (const op of OPERATIONS) registerOperation(server, op, door);
 *
 * `op` takes an operation with any arguments, so a list of different ones registers in one loop.
 * `run` is a method, which is what lets `{ id: string }` stand where `unknown` is asked for.
 */
export function registerOperation<Deps>(
  server: McpServer,
  op: ToolOperation<Deps, unknown, unknown>,
  door: ToolDoor<Deps>,
): void {
  const { name, title, description, inputSchema, annotations } = op;
  server.registerTool(
    name,
    { title, description, inputSchema, annotations },
    // The SDK has parsed `args` with the operation's own `inputSchema` before this runs. Its
    // callback type is one function per zod major, so the parameters are named, not inferred.
    async (args: unknown, extra: ToolCallExtra) => {
      try {
        const deps = await door.deps(extra);
        await door.beforeCall?.(name, deps);
        const result = await op.run(deps, args);
        return door.present ? await door.present(result, name, deps) : textResult({ data: result });
      } catch (err) {
        return toolError(err, name, door);
      }
    },
  );
}

/** A JSON-RPC error with no id, which is how the SDK itself answers a request it will not take. */
function refuse(c: Context, status: ContentfulStatusCode, message: string, headers = {}) {
  return c.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, status, headers);
}

/**
 * The door itself: `path` and `path/`, POST only, with no sessions. `build` makes a fresh server
 * for each request, because a stateless transport serves one request, and it is closed after.
 *
 *     app.use("/mcp/*", checkApiKey); // yours: the kit ships no API key check
 *     app.route("/", mcpRoutes("/mcp", buildServer, { allowedOrigins: new Set([APP_ORIGIN]) }));
 *
 * Mount it at the root, as above: mounted at `path`, Hono folds both spellings into one. And guard
 * `"/mcp/*"`, which covers both. Guarding `"/mcp"` alone leaves `/mcp/` open.
 */
export function mcpRoutes<E extends Env = Env>(
  path: `/${string}`,
  build: (c: Context<E>) => McpServer | Promise<McpServer>,
  options: {
    /**
     * The browser origins allowed to call it. A request with no `Origin`, from an agent or a
     * script, always may. An empty set refuses every browser.
     */
    allowedOrigins: ReadonlySet<string>;
  },
): Hono<E> {
  const handle = async (c: Context<E>): Promise<Response> => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !options.allowedOrigins.has(origin))
      return refuse(
        c,
        403,
        "This web page's origin may not call this MCP server. Call it from an MCP client instead.",
      );
    if (c.req.method !== "POST")
      return refuse(
        c,
        405,
        "Send MCP requests as POST. This server keeps no sessions or streams.",
        {
          Allow: "POST",
        },
      );
    // Reading the body uses it up, and Hono keeps what it read, so hand that over. A body that is
    // not JSON is handed nothing, and the transport answers it with a JSON-RPC parse error.
    const parsedBody: unknown = await c.req.json().catch(() => undefined);
    const server = await build(c);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(
        c.req.raw,
        parsedBody === undefined ? undefined : { parsedBody },
      );
    } finally {
      await server.close();
    }
  };
  return new Hono<E>().all(path, handle).all(`${path}/`, handle);
}
