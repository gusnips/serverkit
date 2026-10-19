/**
 * Sign-in for an MCP server, the way Claude, ChatGPT and Codex connect to one. They cannot paste
 * an API key into a header, so they run OAuth, and both plugin directories refuse a signed-in
 * server that has no OAuth (their review rules, read 2026-10-16). The token they get back is one
 * of YOUR API keys, made by your `mintKey`, so your key check, your keys page and revocation stay
 * the only ones there are.
 *
 * - **Discovery.** The protected-resource document (RFC 9728) and the authorization-server
 *   document (RFC 8414). Your door's 401 names the first one: pass `oauthChallenge(resource)` to
 *   `createErrorResponse`.
 * - **Three kinds of client id.** An https URL is a Client ID Metadata Document: fetched, checked
 *   and cached, which the MCP spec asks for and ChatGPT tries first. Anything else is a dynamic
 *   registration (RFC 7591) that stores nothing: the id is an envelope we signed, so anyone may
 *   register and registering costs no row. And `deviceClients` names your own scripts.
 * - **An authorization code with PKCE**, S256 only, a `resource` that must be this server's
 *   (RFC 8707), and `iss` on the way back (RFC 9207). A code works once, within five minutes.
 * - **The device flow** (RFC 8628), for a script or a CLI whose browser cannot come back to the
 *   machine: a box with no browser, a container, a chat. It prints a link and a short code, the
 *   person approves on any device, and the script's next poll gets the key, once. The person
 *   types the code into OUR page, never into the agent. Nothing here can tell a link the person
 *   started from one somebody else started and sent them, so the device page must say to go on
 *   only if they started this sign-in themselves, just now (RFC 8628 §5.4).
 *
 * Your consent and device pages sit behind your own session and reach `describe`, `approve`,
 * `describeDevice` and `decideDevice` through `oauthConsoleRoutes`. Everything public is
 * `oauthRoutes`.
 *
 * The envelope is the format the first backend to ship this signed its clients with, kept byte
 * for byte: claude.ai and ChatGPT store a client id forever, so a new format would disconnect
 * every connection already made.
 *
 * Web Crypto and `fetch` only, so a Worker runs it.
 */
import { checkUrlShape, readBounded } from "../url-guard.ts";
import { base64UrlOf, bytesOfBase64Url, hmacBytes, safeEqual, sha256Hex } from "../crypto.ts";

/** OAuth 2.1 asks for short codes, and a connector trades one within seconds. */
const CODE_TTL_SECS = 300;
/** Long enough to find a phone and sign in. RFC 8628 leaves it to us. */
const DEVICE_TTL_SECS = 600;
/** How often a script may poll. Faster gets `slow_down`. */
const DEVICE_INTERVAL_SECS = 5;
const MAX_REDIRECT_URIS = 5;
/** Five of them still fit a client id a browser and a proxy will carry in a query string. */
const MAX_REDIRECT_URI_LENGTH = 512;
const MAX_CLIENT_ID_LENGTH = 8_000;
/** A key name most products store in a 60-character column. */
const KEY_NAME_MAX = 60;
/** A metadata document is a few hundred bytes. The draft asks for a small cap. */
const CLIENT_DOCUMENT_MAX_BYTES = 5_120;
const CLIENT_DOCUMENT_TTL_MS = 5 * 60_000;
const CLIENT_DOCUMENT_CACHE_SIZE = 200;
const CLIENT_DOCUMENT_TIMEOUT_MS = 5_000;
/**
 * RFC 8628 §6.1's base-20 alphabet: no vowels, so a code never spells a word, and nothing a person
 * mixes up when reading it aloud. Eight letters are about 34 bits, against guesses that need a
 * signed-in session and run out in ten minutes.
 */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** RFC 9728's well-known path. The door's own path follows it in the document's address. */
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

const CLIENT_PURPOSE = "oauth-client";
const SECRET_PURPOSE = "oauth-client-secret";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type ClientAuthMethod = (typeof AUTH_METHODS)[number];

/** Schemes that run or read something instead of handing the code to an app. */
const UNSAFE_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "blob:",
  "vbscript:",
  "about:",
  "ftp:",
  "ws:",
  "wss:",
  "view-source:",
  "mailto:",
  "tel:",
  "sms:",
  "intent:",
  "chrome:",
  "edge:",
  "shell:",
  "smb:",
  "search:",
  "search-ms:",
]);

export interface OAuthClient {
  id: string;
  /** What the client calls itself. Anyone can register any name, so show where it returns too. */
  name: string;
  redirectUris: readonly string[];
  authMethod: ClientAuthMethod;
}

export type GrantStatus = "pending" | "approved" | "denied" | "used";

/** One code or one device sign-in, as the store keeps it. Secrets are kept only as hashes. */
export interface OAuthGrant {
  /** SHA-256 of the code or the device code, as hex. */
  hash: string;
  kind: "code" | "device";
  clientId: string;
  clientName: string;
  /** A code's only. */
  redirectUri: string | null;
  codeChallenge: string | null;
  /** A device sign-in's only: SHA-256 of the user code, letters only, upper case. */
  userCodeHash: string | null;
  /** Who said yes, in your own terms (a user id, or JSON naming a workspace). Set on approval. */
  subject: string | null;
  keyName: string | null;
  status: GrantStatus;
  expiresAt: Date;
  /** A device sign-in's last poll, for `slow_down`. */
  polledAt: Date | null;
}

/**
 * Where grants live. `createPgOAuthStore` in `@gusnips/server/pg` is one. Keep it shared by every
 * instance of your API: a store in memory loses a sign-in to the next deploy, and the poll that
 * lands on another instance never sees its approval.
 */
export interface OAuthStore {
  insert(grant: OAuthGrant): Promise<void>;
  /**
   * An approved code becomes used, in the same step that reads it, so two exchanges of one code
   * cannot both win. `null` when it is unknown, already used or expired.
   */
  spendCode(hash: string, now: Date): Promise<OAuthGrant | null>;
  /** A pending, unexpired device sign-in by its user code. */
  findDevice(userCodeHash: string, now: Date): Promise<OAuthGrant | null>;
  /** A pending, unexpired device sign-in is approved or denied. `false` when it was not pending. */
  decideDevice(
    userCodeHash: string,
    decision: { status: "approved"; subject: string; keyName: string } | { status: "denied" },
    now: Date,
  ): Promise<boolean>;
  /**
   * One poll by `clientId`, in one step: records the time, and an approved sign-in becomes used.
   * Returns the grant as it was BEFORE this poll, or `null` when no device sign-in of that client
   * has this code. Another client's poll must change nothing, or it could spend the sign-in.
   */
  pollDevice(hash: string, clientId: string, now: Date): Promise<OAuthGrant | null>;
  /** Deletes grants that expired before `before`. Returns how many. */
  prune(before: Date): Promise<number>;
}

export interface OAuthOptions {
  /** Your API's public origin, which issues the tokens: `https://api.example.com`. */
  issuer: string;
  /** The MCP door the tokens are for: `https://api.example.com/mcp`. */
  resource: string;
  /** Your consent page, on your web app, behind your own sign-in. */
  authorizePage: string;
  /** Your device page, where a person types or checks the code: `https://example.com/device`. */
  devicePage: string;
  /**
   * Signs registered clients. Random, 32 bytes or more, and permanent: a new one unregisters
   * every client already connected.
   */
  secret: string;
  store: OAuthStore;
  /**
   * Makes the token: one of your own API keys, for whoever approved, named `keyName`. Check again
   * that they may still have one, since minutes have passed. Return `{ refused }` with a sentence
   * the person can act on, and the client is told the sign-in failed. A throw is your 500.
   */
  mintKey(grant: {
    subject: string;
    keyName: string;
    clientName: string;
  }): Promise<string | { refused: string }>;
  /** Your scripts and CLIs, by client id, for the device flow: `{ "acme-cli": "Acme CLI" }`. */
  deviceClients?: Readonly<Record<string, string>>;
  /** Shown by some clients beside the sign-in. */
  resourceName?: string;
  documentation?: string;
  /**
   * Fetches a client's metadata document. The default checks the URL's shape and never follows a
   * redirect, which is all a Worker can do. On a server, pass one built on `fetchPublic` from
   * `@gusnips/server/node`, which also refuses a name that resolves to a private address.
   * Return `null` to refuse.
   */
  fetchClientDocument?: (url: URL) => Promise<Response | null>;
  /** For tests. */
  now?: () => Date;
}

export type OAuthRefusalReason =
  /** A client id we did not sign, or a metadata document we could not fetch or read. */
  | "unknown-client"
  /** The redirect is not one the client registered. Never redirect on this one. */
  | "redirect-mismatch"
  | "invalid-request"
  /** A token asked for another server. */
  | "wrong-resource"
  /** No pending device sign-in has this code: mistyped, expired or already decided. */
  | "unknown-code";

/** Your page words its own refusal. `message` is a fallback a person can read. */
export interface OAuthRefusal {
  ok: false;
  reason: OAuthRefusalReason;
  message: string;
}

/** What the consent page shows. */
export interface ConsentView {
  ok: true;
  clientName: string;
  /** Where the code goes after the yes: a host, or an app's own scheme. */
  redirectHost: string;
  /** The key's name on your keys page. */
  keyName: string;
  /** Where "Cancel" goes: the client, told the person said no. */
  cancelUrl: string;
}

/** What the device page shows, to check against the person's screen. */
export interface DeviceView {
  ok: true;
  clientName: string;
  /** Formatted the way the script printed it: `WDJB-MJHT`. */
  userCode: string;
  keyName: string;
  expiresAt: Date;
}

/** An answer in OAuth's own shape: a top-level `error`, never your envelope. */
export interface OAuthAnswer {
  status: 200 | 201 | 400 | 401;
  body: Record<string, unknown>;
}

/** What the client sent, from the body or from HTTP Basic, whichever it used. */
export interface ClientCredentials {
  id: string | undefined;
  secret: string | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createOAuth(options: OAuthOptions) {
  const { resource, store, secret } = options;
  const issuer = options.issuer.replace(/\/+$/, "");
  if (encoder.encode(secret).length < 32)
    throw new TypeError("The OAuth secret must be at least 32 bytes. Generate a random one.");
  // The resource's metadata is served beside the issuer's, and a client looks for it on the
  // resource's own origin. A door on another host would be refused as "another server".
  if (new URL(resource).origin !== issuer)
    throw new TypeError(`The OAuth resource must be on the issuer's origin, ${issuer}`);
  const now = options.now ?? (() => new Date());
  const fetchClientDocument = options.fetchClientDocument ?? defaultFetchClientDocument;
  const resourcePath = new URL(resource).pathname.replace(/\/+$/, "");
  const documents = new Map<string, { client: OAuthClient; until: number }>();
  const deviceClients = options.deviceClients ?? {};
  const isDeviceClient = (clientId: string) => Object.hasOwn(deviceClients, clientId);

  const sign = async (purpose: string, body: string) =>
    base64UrlOf(await hmacBytes(secret, `${purpose}.${body}`));

  async function clientFromEnvelope(clientId: string): Promise<OAuthClient | null> {
    const dot = clientId.indexOf(".");
    if (dot < 1) return null;
    const body = clientId.slice(0, dot);
    if (!safeEqual(clientId.slice(dot + 1), await sign(CLIENT_PURPOSE, body))) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(decoder.decode(bytesOfBase64Url(body)));
    } catch {
      return null;
    }
    if (!isRecord(payload)) return null;
    const { n: name, r: redirectUris, a: authMethod } = payload;
    if (typeof name !== "string" || !isStringList(redirectUris)) return null;
    const method = AUTH_METHODS.find((known) => known === authMethod);
    return method ? { id: clientId, name, redirectUris, authMethod: method } : null;
  }

  async function clientFromDocument(clientId: string): Promise<OAuthClient | null> {
    const cached = documents.get(clientId);
    if (cached && cached.until > Date.now()) return cached.client;
    const shape = checkUrlShape(clientId);
    // The draft: an https URL with a path, and no fragment. An origin alone names no client.
    if (!shape.ok || shape.url.hash || shape.url.pathname === "/") return null;
    const response = await fetchClientDocument(shape.url).catch(() => null);
    if (!response || response.status !== 200) return null;
    const { bytes, truncated } = await readBounded(response.body, CLIENT_DOCUMENT_MAX_BYTES);
    if (truncated) return null;
    let document: unknown;
    try {
      document = JSON.parse(decoder.decode(bytes));
    } catch {
      return null;
    }
    if (!isRecord(document) || document.client_id !== clientId) return null;
    const uris = document.redirect_uris;
    if (!isStringList(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) return null;
    if (!uris.every(isAllowedRedirect)) return null;
    // A document is public, so it can hold no secret: only a public client may use one.
    const method = document.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") return null;
    const named = typeof document.client_name === "string" ? document.client_name.trim() : "";
    const client: OAuthClient = {
      id: clientId,
      name: named.slice(0, 100) || shape.url.hostname,
      redirectUris: uris,
      authMethod: "none",
    };
    // ponytail: one cache per process, oldest out first. Each instance fetches a document at most
    // once every five minutes; a shared cache is the upgrade if a client is ever hot.
    if (documents.size >= CLIENT_DOCUMENT_CACHE_SIZE)
      documents.delete(documents.keys().next().value ?? "");
    documents.set(clientId, { client, until: Date.now() + CLIENT_DOCUMENT_TTL_MS });
    return client;
  }

  async function findClient(clientId: string | undefined): Promise<OAuthClient | null> {
    if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH) return null;
    // `hasOwn`, so `constructor` and `__proto__` are not clients.
    if (isDeviceClient(clientId))
      return {
        id: clientId,
        name: deviceClients[clientId] ?? clientId,
        redirectUris: [],
        authMethod: "none",
      };
    if (clientId.startsWith("https://")) return clientFromDocument(clientId);
    return clientFromEnvelope(clientId);
  }

  /** The client, when it proved who it is: a public client by its id, any other by its secret. */
  async function authenticate(credentials: ClientCredentials): Promise<OAuthClient | null> {
    // A metadata document can only describe a public client, and the code it trades was bound to
    // this exact id when the person approved, behind their own session. Fetching it again here
    // would let anyone, signed in or not, make us fetch any URL they name.
    const { id } = credentials;
    if (id?.startsWith("https://") && id.length <= MAX_CLIENT_ID_LENGTH)
      return { id, name: id, redirectUris: [], authMethod: "none" };
    const client = await findClient(id);
    if (!client) return null;
    if (client.authMethod === "none") return client;
    const given = credentials.secret;
    return given && safeEqual(given, await sign(SECRET_PURPOSE, client.id)) ? client : null;
  }

  /** RFC 8707: a token for another server is not ours to issue. A trailing slash is noise. */
  function isOurResource(value: string): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const given = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    return given === issuer || given === `${issuer}${resourcePath}`;
  }

  /** The client's own address with the answer on it, `state` echoed and `iss` named. */
  function backTo(request: AuthorizeRequest, answer: Record<string, string>): string {
    const back = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(answer)) back.searchParams.set(key, value);
    if (request.state !== undefined) back.searchParams.set("state", request.state);
    back.searchParams.set("iss", issuer);
    return back.toString();
  }

  async function checkRequest(
    query: URLSearchParams,
  ): Promise<
    { ok: true; request: AuthorizeRequest; client: OAuthClient; view: ConsentView } | OAuthRefusal
  > {
    const request = readAuthorizeRequest(query);
    if (!request.ok) return request;
    const client = await findClient(request.clientId);
    if (!client)
      return refusal("unknown-client", "We could not identify the app asking to connect.");
    // Never redirect on these two: an unknown client, or a redirect it never registered, is how
    // an open redirect gets built.
    if (!client.redirectUris.some((uri) => sameRedirect(uri, request.redirectUri)))
      return refusal("redirect-mismatch", "This app's sign-in link is not valid.");
    if (request.resource !== undefined && !isOurResource(request.resource))
      return refusal("wrong-resource", "This sign-in link is for another server.");
    const redirectHost = destinationOf(request.redirectUri);
    return {
      ok: true,
      request,
      client,
      view: {
        ok: true,
        clientName: client.name,
        redirectHost,
        keyName: `${client.name} (${redirectHost})`.slice(0, KEY_NAME_MAX),
        cancelUrl: backTo(request, { error: "access_denied" }),
      },
    };
  }

  async function exchangeCode(
    client: OAuthClient,
    fields: Record<string, string>,
  ): Promise<OAuthAnswer> {
    const { code, redirect_uri: redirectUri, code_verifier: verifier } = fields;
    if (!code || !redirectUri || !verifier)
      return oauthError("invalid_request", "code, redirect_uri and code_verifier are required");
    const spent = await store.spendCode(await sha256Hex(code), now());
    if (
      !spent ||
      spent.clientId !== client.id ||
      spent.redirectUri !== redirectUri ||
      spent.codeChallenge !== (await challengeOf(verifier))
    )
      return oauthError(
        "invalid_grant",
        "The code is wrong, expired or already used. Start the connection again.",
      );
    return mint(spent);
  }

  async function pollDevice(client: OAuthClient, deviceCode: string | undefined) {
    if (!deviceCode) return oauthError("invalid_request", "device_code is required");
    const at = now();
    const before = await store.pollDevice(await sha256Hex(deviceCode), client.id, at);
    if (!before)
      return oauthError("invalid_grant", "This device code is not one we issued to this client.");
    if (before.expiresAt <= at)
      return oauthError("expired_token", "The code expired. Start the sign-in again.");
    switch (before.status) {
      case "pending":
        return before.polledAt &&
          at.getTime() - before.polledAt.getTime() < DEVICE_INTERVAL_SECS * 1000
          ? oauthError("slow_down", `Poll at most every ${DEVICE_INTERVAL_SECS} seconds.`)
          : oauthError("authorization_pending", "Waiting for the person to approve.");
      case "denied":
        return oauthError("access_denied", "The person said no.");
      case "used":
        return oauthError("invalid_grant", "This sign-in already handed out its key.");
      case "approved":
        return mint(before);
    }
  }

  async function mint(grant: OAuthGrant): Promise<OAuthAnswer> {
    if (grant.subject === null || grant.keyName === null)
      return oauthError("invalid_grant", "This sign-in was never approved.");
    const made = await options.mintKey({
      subject: grant.subject,
      keyName: grant.keyName,
      clientName: grant.clientName,
    });
    if (typeof made !== "string") return oauthError("invalid_grant", made.refused);
    // ponytail: no expiry and no refresh token. The key lives until someone revokes it, like one
    // pasted by hand. Short-lived tokens with rotating refresh tokens are the upgrade, and they
    // need a token table.
    return { status: 200, body: { access_token: made, token_type: "Bearer" } };
  }

  return {
    /** For `createErrorResponse`'s `challenge`: a 401 that tells a client where to sign in. */
    challenge: oauthChallenge(resource),
    /** Where `oauthRoutes` serves the protected-resource document, besides the bare path. */
    metadataPath: `${PROTECTED_RESOURCE_PATH}${resourcePath}`,

    /** RFC 9728. */
    protectedResourceMetadata(): Record<string, unknown> {
      return {
        resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        ...(options.resourceName !== undefined && { resource_name: options.resourceName }),
        ...(options.documentation !== undefined && {
          resource_documentation: options.documentation,
        }),
      };
    },

    /** RFC 8414. The authorization endpoint is your consent page; the rest are `oauthRoutes`. */
    authorizationServerMetadata(): Record<string, unknown> {
      return {
        issuer,
        authorization_endpoint: options.authorizePage,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", DEVICE_GRANT],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [...AUTH_METHODS],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        ...(options.documentation !== undefined && {
          service_documentation: options.documentation,
        }),
      };
    },

    /** RFC 7591. Stores nothing: the client id is our signature over what the client sent. */
    async register(raw: unknown): Promise<OAuthAnswer> {
      if (!isRecord(raw)) return oauthError("invalid_client_metadata", "Send a JSON object");
      // Not strict: RFC 7591 §2 says to ignore metadata we do not use, and clients send plenty.
      const uris = raw.redirect_uris;
      if (!isStringList(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
        return oauthError(
          "invalid_client_metadata",
          `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} addresses`,
        );
      const bad = uris.find(
        (uri) => uri.length > MAX_REDIRECT_URI_LENGTH || !isAllowedRedirect(uri),
      );
      if (bad !== undefined)
        return oauthError(
          "invalid_redirect_uri",
          `${bad.slice(0, 100)} is not allowed: use https, http on localhost, or your app's own scheme, in ${MAX_REDIRECT_URI_LENGTH} characters or fewer`,
        );
      const requested = raw.token_endpoint_auth_method ?? "none";
      const authMethod = AUTH_METHODS.find((method) => method === requested);
      if (!authMethod)
        return oauthError(
          "invalid_client_metadata",
          `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`,
        );
      const named = typeof raw.client_name === "string" ? raw.client_name.trim().slice(0, 100) : "";
      const name = named || destinationOf(uris[0] ?? "");
      const body = base64UrlOf(
        encoder.encode(JSON.stringify({ n: name, r: uris, a: authMethod, iat: Date.now() })),
      );
      const clientId = `${body}.${await sign(CLIENT_PURPOSE, body)}`;
      return {
        status: 201,
        body: {
          client_id: clientId,
          ...(authMethod !== "none" && {
            client_secret: await sign(SECRET_PURPOSE, clientId),
            client_secret_expires_at: 0,
          }),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: name,
          redirect_uris: uris,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: authMethod,
        },
      };
    },

    /**
     * What the consent page shows, and the proof the request is ours to answer, before a button
     * is drawn. Pass the query string the client sent to your page, as it came.
     */
    async describe(query: URLSearchParams): Promise<ConsentView | OAuthRefusal> {
      const checked = await checkRequest(query);
      return checked.ok ? checked.view : checked;
    },

    /**
     * The person said yes. `subject` is who, in your terms, and comes back to `mintKey`. Check
     * that they may have a key before calling this, so a refusal shows on your page instead of
     * vanishing inside the client. Send the browser to `redirectTo`.
     */
    async approve(
      query: URLSearchParams,
      subject: string,
    ): Promise<{ ok: true; redirectTo: string } | OAuthRefusal> {
      const checked = await checkRequest(query);
      if (!checked.ok) return checked;
      const code = randomToken();
      await store.insert({
        hash: await sha256Hex(code),
        kind: "code",
        clientId: checked.client.id,
        clientName: checked.client.name,
        redirectUri: checked.request.redirectUri,
        codeChallenge: checked.request.codeChallenge,
        userCodeHash: null,
        subject,
        keyName: checked.view.keyName,
        status: "approved",
        expiresAt: new Date(now().getTime() + CODE_TTL_SECS * 1000),
        polledAt: null,
      });
      return { ok: true, redirectTo: backTo(checked.request, { code }) };
    },

    /** The token endpoint, for a code and for a device poll. Answer with `no-store`. */
    async token(fields: Record<string, string>, basic: ClientCredentials | null) {
      const grantType = fields.grant_type;
      if (grantType !== "authorization_code" && grantType !== DEVICE_GRANT)
        return oauthError(
          "unsupported_grant_type",
          `grant_type must be authorization_code or ${DEVICE_GRANT}`,
        );
      const client = await authenticate(
        basic ?? { id: fields.client_id, secret: fields.client_secret },
      );
      if (!client) return oauthError("invalid_client", "Unknown client, or a wrong secret", 401);
      if (fields.resource !== undefined && !isOurResource(fields.resource))
        return oauthError("invalid_target", `Tokens here are for ${resource}`);
      return grantType === DEVICE_GRANT
        ? pollDevice(client, fields.device_code)
        : exchangeCode(client, fields);
    },

    /** RFC 8628 §3.1: a script asks to sign in, and gets a link and a code to show the person. */
    async deviceAuthorization(
      fields: Record<string, string>,
      basic: ClientCredentials | null,
    ): Promise<OAuthAnswer> {
      // Only your own scripts, checked before anything else so no client id is ever fetched
      // here. A registered client names itself, so anyone could start a sign-in called "Claude".
      const id = basic?.id ?? fields.client_id;
      if (id === undefined || !isDeviceClient(id))
        return oauthError("unauthorized_client", "This client may not use the device flow");
      const client = await authenticate({ id, secret: basic?.secret ?? fields.client_secret });
      if (!client) return oauthError("invalid_client", "Unknown client, or a wrong secret", 401);
      if (fields.resource !== undefined && !isOurResource(fields.resource))
        return oauthError("invalid_target", `Tokens here are for ${resource}`);
      const deviceCode = randomToken();
      const at = now();
      // A code another pending sign-in already shows would let one approval answer the wrong
      // script, so draw again. At 20^8 codes this loop almost never runs twice.
      let userCode = randomUserCode();
      for (
        let draw = 1;
        draw < 5 && (await store.findDevice(await sha256Hex(userCode), at));
        draw++
      )
        userCode = randomUserCode();
      await store.insert({
        hash: await sha256Hex(deviceCode),
        kind: "device",
        clientId: client.id,
        clientName: client.name,
        redirectUri: null,
        codeChallenge: null,
        userCodeHash: await sha256Hex(userCode),
        subject: null,
        keyName: null,
        status: "pending",
        expiresAt: new Date(at.getTime() + DEVICE_TTL_SECS * 1000),
        polledAt: null,
      });
      const shown = formatUserCode(userCode);
      const complete = new URL(options.devicePage);
      complete.searchParams.set("code", shown);
      return {
        status: 200,
        body: {
          device_code: deviceCode,
          user_code: shown,
          verification_uri: options.devicePage,
          verification_uri_complete: complete.toString(),
          expires_in: DEVICE_TTL_SECS,
          interval: DEVICE_INTERVAL_SECS,
        },
      };
    },

    /** What the device page shows for a code the person typed or followed a link with. */
    async describeDevice(userCode: string): Promise<DeviceView | OAuthRefusal> {
      const letters = normalizeUserCode(userCode);
      if (!letters) return unknownCode();
      const grant = await store.findDevice(await sha256Hex(letters), now());
      if (!grant) return unknownCode();
      return {
        ok: true,
        clientName: grant.clientName,
        userCode: formatUserCode(letters),
        keyName: deviceKeyName(grant.clientName),
        expiresAt: grant.expiresAt,
      };
    },

    /** The person approved (`subject` is who) or said no. Check they may have a key first. */
    async decideDevice(
      userCode: string,
      decision: { subject: string } | "deny",
    ): Promise<{ ok: true } | OAuthRefusal> {
      const letters = normalizeUserCode(userCode);
      if (!letters) return unknownCode();
      const hash = await sha256Hex(letters);
      const at = now();
      if (decision === "deny")
        return (await store.decideDevice(hash, { status: "denied" }, at))
          ? { ok: true }
          : unknownCode();
      const grant = await store.findDevice(hash, at);
      if (!grant) return unknownCode();
      const decided = await store.decideDevice(
        hash,
        { status: "approved", subject: decision.subject, keyName: deviceKeyName(grant.clientName) },
        at,
      );
      return decided ? { ok: true } : unknownCode();
    },

    /** Deletes grants that expired more than a day ago. Run it once a night. */
    prune(): Promise<number> {
      return store.prune(new Date(now().getTime() - 86_400_000));
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  resource: string | undefined;
}

/** The fields that matter in the query a client sent to the consent page. Scope is ignored. */
function readAuthorizeRequest(
  query: URLSearchParams,
): ({ ok: true } & AuthorizeRequest) | OAuthRefusal {
  const clientId = query.get("client_id") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  const codeChallenge = query.get("code_challenge") ?? "";
  const state = query.get("state") ?? undefined;
  const resource = query.get("resource") ?? undefined;
  if (
    !clientId ||
    clientId.length > MAX_CLIENT_ID_LENGTH ||
    !redirectUri ||
    redirectUri.length > 2_000 ||
    query.get("response_type") !== "code" ||
    // OAuth 2.1 drops `plain`: a challenge sent in the clear proves nothing.
    query.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge) ||
    (state !== undefined && state.length > 2_000) ||
    (resource !== undefined && resource.length > 2_000)
  )
    return refusal(
      "invalid-request",
      "This sign-in link is missing something. Start the connection again from the app.",
    );
  return { ok: true, clientId, redirectUri, codeChallenge, state, resource };
}

/**
 * Where a code may be sent: https; plain http on this machine, for a desktop client's own
 * listener; or an app's own scheme (RFC 8252 §7.1, how Cursor's and other editors' sign-in comes
 * back). Never a fragment, which a code must not ride in, and never a scheme that runs something.
 */
export function isAllowedRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url);
  // `ms-` is Windows' own family (`ms-msdt:`, `ms-officecmd:`), which opens system tools.
  return !UNSAFE_SCHEMES.has(url.protocol) && !url.protocol.startsWith("ms-");
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/**
 * The redirect a client registered, matched exactly, except that a desktop app's listener on this
 * machine may pick any free port each time (RFC 8252 §7.3).
 */
function sameRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL, b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || b.protocol !== "http:" || !isLoopback(a)) return false;
  a.port = b.port;
  return a.toString() === b.toString();
}

/**
 * The `WWW-Authenticate` value for your door's 401, from the door's URL alone, so the error
 * response can be built before `createOAuth` is. It equals `createOAuth(...).challenge`.
 *
 *     createErrorResponse({ ..., challenge: oauthChallenge("https://api.example.com/mcp") });
 */
export function oauthChallenge(resource: string): string {
  const url = new URL(resource);
  return `Bearer resource_metadata="${url.origin}${PROTECTED_RESOURCE_PATH}${url.pathname.replace(/\/+$/, "")}"`;
}

/** The S256 challenge a verifier must match. */
export async function challengeOf(verifier: string): Promise<string> {
  return base64UrlOf(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
  );
}

/** Letters only, upper case, so `wdjb mjht` and `WDJB-MJHT` are one code. `null` when it cannot be one. */
export function normalizeUserCode(input: string): string | null {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === USER_CODE_LENGTH &&
    [...letters].every((letter) => USER_CODE_ALPHABET.includes(letter))
    ? letters
    : null;
}

function formatUserCode(letters: string): string {
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function randomUserCode(): string {
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 240 is the largest multiple of 20 under 256: a byte past it would favour the first letters.
      if (byte < 240 && code.length < USER_CODE_LENGTH)
        code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
}

function randomToken(): string {
  return base64UrlOf(crypto.getRandomValues(new Uint8Array(32)));
}

function deviceKeyName(clientName: string): string {
  return `${clientName} (device sign-in)`.slice(0, KEY_NAME_MAX);
}

/** A host for a web address, the scheme for an app's own (`cursor:`). */
function destinationOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol;
  } catch {
    return uri;
  }
}

function unknownCode(): OAuthRefusal {
  return refusal(
    "unknown-code",
    "We don't recognize this code. It may have expired (codes last 10 minutes) or been used already. Start the sign-in again from the app.",
  );
}

function refusal(reason: OAuthRefusalReason, message: string): OAuthRefusal {
  return { ok: false, reason, message };
}

function oauthError(error: string, description: string, status: 400 | 401 = 400): OAuthAnswer {
  return { status, body: { error, error_description: description } };
}

async function defaultFetchClientDocument(url: URL): Promise<Response | null> {
  // `manual`, so a redirect comes back as a 3xx and is refused: a hop is a URL nobody checked.
  return fetch(url, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CLIENT_DOCUMENT_TIMEOUT_MS),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export { isOAuthPath, oauthConsoleRoutes, oauthRoutes } from "./routes.ts";
export type { OAuthConsoleOptions, OAuthRoutesOptions } from "./routes.ts";
