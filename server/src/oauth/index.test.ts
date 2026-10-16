import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { createPgOAuthStore } from "../pg/oauth-store.ts";
import {
  challengeOf,
  createOAuth,
  isAllowedRedirect,
  normalizeUserCode,
  oauthRoutes,
  type OAuthGrant,
  type OAuthOptions,
  type OAuthStore,
} from "./index.ts";

/** The README's own `CREATE TABLE`, so the table the docs tell you to make is the one tested. */
const TABLE_SQL = /```sql\n(CREATE TABLE app\.oauth_grants[\s\S]*?)```/.exec(
  readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
)?.[1];

const SECRET = "test-secret-test-secret-test-secret";
const DOC_ID = "https://agent.example/oauth/client.json";
const ISSUER = "https://api.example.com";
const CALLBACK = "https://agent.example/callback";
// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** The store contract, kept in a `Map`. Fine here: a test is one process. */
function memoryStore(): OAuthStore {
  const rows: OAuthGrant[] = [];
  const pending = (userCodeHash: string, now: Date) =>
    // The newest first, as the Postgres store orders by `created_at`.
    [...rows]
      .reverse()
      .find(
        (row) =>
          row.userCodeHash === userCodeHash &&
          row.kind === "device" &&
          row.status === "pending" &&
          row.expiresAt > now,
      );
  return {
    async insert(grant) {
      rows.push({ ...grant });
    },
    async spendCode(hash, now) {
      const row = rows.find((r) => r.hash === hash);
      if (!row || row.kind !== "code" || row.status !== "approved" || row.expiresAt <= now)
        return null;
      row.status = "used";
      return { ...row };
    },
    async findDevice(userCodeHash, now) {
      const row = pending(userCodeHash, now);
      return row ? { ...row } : null;
    },
    async decideDevice(userCodeHash, decision, now) {
      const row = pending(userCodeHash, now);
      if (!row) return false;
      row.status = decision.status;
      if (decision.status === "approved") {
        row.subject = decision.subject;
        row.keyName = decision.keyName;
      }
      return true;
    },
    async pollDevice(hash, clientId, now) {
      const row = rows.find(
        (r) => r.hash === hash && r.kind === "device" && r.clientId === clientId,
      );
      if (!row) return null;
      const before = { ...row };
      row.polledAt = now;
      if (row.status === "approved") row.status = "used";
      return before;
    },
    async prune(before) {
      const kept = rows.filter((row) => row.expiresAt >= before);
      const dropped = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return dropped;
    },
  };
}

function authorizeQuery(clientId: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1",
    resource: `${ISSUER}/mcp`,
    ...overrides,
  });
}

/** The same flows against each store: the memory one above, and Postgres when it is installed. */
function flows(name: string, setup: () => Promise<{ store: () => OAuthStore }>) {
  describe(name, () => {
    let store: () => OAuthStore;
    let clock: Date;
    let minted: Array<{ subject: string; keyName: string; clientName: string }>;
    let documents: Map<string, Response>;
    let fetched: string[];

    beforeAll(async () => {
      ({ store } = await setup());
    }, 30_000);

    beforeEach(() => {
      clock = new Date("2026-10-16T12:00:00.000Z");
      minted = [];
      documents = new Map();
      fetched = [];
    });

    const advance = (secs: number) => (clock = new Date(clock.getTime() + secs * 1000));

    function make(overrides: Partial<OAuthOptions> = {}) {
      return createOAuth({
        issuer: ISSUER,
        resource: `${ISSUER}/mcp`,
        authorizePage: "https://example.com/oauth/authorize",
        devicePage: "https://example.com/device",
        secret: SECRET,
        store: store(),
        deviceClients: { "acme-cli": "Acme CLI", "other-cli": "Other CLI" },
        resourceName: "Acme",
        mintKey: async (grant) => {
          minted.push(grant);
          return `ak_${minted.length}`;
        },
        fetchClientDocument: async (url) => {
          fetched.push(url.toString());
          return documents.get(url.toString()) ?? null;
        },
        now: () => clock,
        ...overrides,
      });
    }

    async function registered(oauth: ReturnType<typeof make>, body: Record<string, unknown> = {}) {
      const answer = await oauth.register({
        client_name: "Agent",
        redirect_uris: [CALLBACK],
        ...body,
      });
      expect(answer.status).toBe(201);
      return answer.body as { client_id: string; client_secret?: string };
    }

    async function approvedCode(oauth: ReturnType<typeof make>, clientId: string) {
      const approved = await oauth.approve(authorizeQuery(clientId), "user-1");
      if (!approved.ok) throw new Error(approved.message);
      return new URL(approved.redirectTo).searchParams.get("code") ?? "";
    }

    const exchange = (code: string, clientId: string, extra: Record<string, string> = {}) => ({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      resource: `${ISSUER}/mcp`,
      ...extra,
    });

    describe("an authorization code", () => {
      it("shows the consent view, sends the code back with state and iss, and trades it once", async () => {
        const oauth = make();
        const { client_id } = await registered(oauth);
        expect(await oauth.describe(authorizeQuery(client_id))).toEqual({
          ok: true,
          clientName: "Agent",
          redirectHost: "agent.example",
          keyName: "Agent (agent.example)",
          cancelUrl: `${CALLBACK}?error=access_denied&state=st-1&iss=${encodeURIComponent(ISSUER)}`,
        });

        const approved = await oauth.approve(authorizeQuery(client_id), "user-1");
        if (!approved.ok) throw new Error(approved.message);
        const back = new URL(approved.redirectTo);
        expect(back.origin + back.pathname).toBe(CALLBACK);
        expect(back.searchParams.get("state")).toBe("st-1");
        expect(back.searchParams.get("iss")).toBe(ISSUER);
        const code = back.searchParams.get("code") ?? "";

        expect(await oauth.token(exchange(code, client_id), null)).toEqual({
          status: 200,
          body: { access_token: "ak_1", token_type: "Bearer" },
        });
        expect(minted).toEqual([
          { subject: "user-1", keyName: "Agent (agent.example)", clientName: "Agent" },
        ]);
        expect(await oauth.token(exchange(code, client_id), null)).toMatchObject({
          status: 400,
          body: { error: "invalid_grant" },
        });
        expect(minted).toHaveLength(1);
      });

      it("refuses a wrong verifier, a wrong redirect and an expired code", async () => {
        const oauth = make();
        const { client_id } = await registered(oauth);
        const wrongVerifier = exchange(await approvedCode(oauth, client_id), client_id, {
          code_verifier: "x".repeat(43),
        });
        expect((await oauth.token(wrongVerifier, null)).body.error).toBe("invalid_grant");

        const wrongRedirect = exchange(await approvedCode(oauth, client_id), client_id, {
          redirect_uri: "https://agent.example/other",
        });
        expect((await oauth.token(wrongRedirect, null)).body.error).toBe("invalid_grant");

        const late = await approvedCode(oauth, client_id);
        advance(301);
        expect((await oauth.token(exchange(late, client_id), null)).body.error).toBe(
          "invalid_grant",
        );
        expect(minted).toEqual([]);
      });

      it("refuses another client's code", async () => {
        const oauth = make();
        const first = await registered(oauth);
        const second = await registered(oauth, { client_name: "Other" });
        const code = await approvedCode(oauth, first.client_id);
        expect((await oauth.token(exchange(code, second.client_id), null)).body.error).toBe(
          "invalid_grant",
        );
      });

      it("refuses a token for another server, and a consent link for one", async () => {
        const oauth = make();
        const { client_id } = await registered(oauth);
        const code = await approvedCode(oauth, client_id);
        expect(
          await oauth.token(
            exchange(code, client_id, { resource: "https://evil.example/mcp" }),
            null,
          ),
        ).toMatchObject({ status: 400, body: { error: "invalid_target" } });
        expect(
          await oauth.describe(authorizeQuery(client_id, { resource: "https://evil.example/mcp" })),
        ).toMatchObject({ ok: false, reason: "wrong-resource" });
        // A trailing slash and the bare issuer are both this server.
        expect(
          await oauth.describe(authorizeQuery(client_id, { resource: `${ISSUER}/mcp/` })),
        ).toMatchObject({ ok: true });
        expect(await oauth.describe(authorizeQuery(client_id, { resource: ISSUER }))).toMatchObject(
          { ok: true },
        );
      });

      it("never sends a code to an address the client did not register", async () => {
        const oauth = make();
        const { client_id } = await registered(oauth);
        const query = authorizeQuery(client_id, { redirect_uri: "https://evil.example/cb" });
        expect(await oauth.describe(query)).toMatchObject({
          ok: false,
          reason: "redirect-mismatch",
        });
        expect(await oauth.approve(query, "user-1")).toMatchObject({
          ok: false,
          reason: "redirect-mismatch",
        });
      });

      it("refuses plain PKCE, a missing challenge and a forged client id", async () => {
        const oauth = make();
        const { client_id } = await registered(oauth);
        const broken: Record<string, string>[] = [
          { code_challenge_method: "plain" },
          { code_challenge: "" },
          { response_type: "token" },
        ];
        for (const overrides of broken)
          expect(await oauth.describe(authorizeQuery(client_id, overrides))).toMatchObject({
            ok: false,
            reason: "invalid-request",
          });
        const forged = `${client_id.split(".")[0]}.${"A".repeat(43)}`;
        expect(await oauth.describe(authorizeQuery(forged))).toMatchObject({
          ok: false,
          reason: "unknown-client",
        });
      });

      it("asks a confidential client for its secret, in the body or by Basic", async () => {
        const oauth = make();
        const client = await registered(oauth, {
          token_endpoint_auth_method: "client_secret_basic",
        });
        expect(client.client_secret).toBeTypeOf("string");
        const code = await approvedCode(oauth, client.client_id);
        expect(await oauth.token(exchange(code, client.client_id), null)).toMatchObject({
          status: 401,
          body: { error: "invalid_client" },
        });
        expect(
          await oauth.token(exchange(code, client.client_id), {
            id: client.client_id,
            secret: client.client_secret,
          }),
        ).toMatchObject({ status: 200, body: { access_token: "ak_1" } });
      });

      it("passes the product's refusal on to the client, and makes no key", async () => {
        const oauth = make({ mintKey: async () => ({ refused: "You already have 20 keys." }) });
        const { client_id } = await registered(oauth);
        const code = await approvedCode(oauth, client_id);
        expect(await oauth.token(exchange(code, client_id), null)).toEqual({
          status: 400,
          body: { error: "invalid_grant", error_description: "You already have 20 keys." },
        });
      });
    });

    describe("registration", () => {
      it("signs the client the way the first backend did, byte for byte, both ways", async () => {
        const oauth = make();
        const client = await registered(oauth, {
          token_endpoint_auth_method: "client_secret_post",
        });
        const [body, signature] = client.client_id.split(".");
        expect(signature).toBe(
          createHmac("sha256", SECRET).update(`oauth-client.${body}`).digest("base64url"),
        );
        expect(client.client_secret).toBe(
          createHmac("sha256", SECRET)
            .update(`oauth-client-secret.${client.client_id}`)
            .digest("base64url"),
        );

        // A client id that backend issued months ago, written with node:crypto as it did.
        const legacyBody = Buffer.from(
          JSON.stringify({ n: "claude.ai", r: [CALLBACK], a: "client_secret_post", iat: 1 }),
        ).toString("base64url");
        const legacyId = `${legacyBody}.${createHmac("sha256", SECRET)
          .update(`oauth-client.${legacyBody}`)
          .digest("base64url")}`;
        const legacySecret = createHmac("sha256", SECRET)
          .update(`oauth-client-secret.${legacyId}`)
          .digest("base64url");
        expect(await oauth.describe(authorizeQuery(legacyId))).toMatchObject({
          ok: true,
          clientName: "claude.ai",
        });
        const code = await approvedCode(oauth, legacyId);
        expect(
          await oauth.token(exchange(code, legacyId, { client_secret: legacySecret }), null),
        ).toMatchObject({ status: 200 });
      });

      it("takes https, loopback http and an app's own scheme, and nothing that runs", async () => {
        const oauth = make();
        for (const uri of ["http://127.0.0.1:33418/cb", "http://localhost/cb", "cursor://auth/cb"])
          expect((await oauth.register({ redirect_uris: [uri] })).status).toBe(201);
        for (const uri of [
          "http://agent.example/cb",
          "javascript:alert(1)",
          "data:text/html,x",
          "https://agent.example/cb#frag",
          "https://user:pw@agent.example/cb",
          `https://agent.example/${"x".repeat(520)}`,
        ])
          expect(await oauth.register({ redirect_uris: [uri] })).toMatchObject({
            status: 400,
            body: { error: "invalid_redirect_uri" },
          });
        expect(
          await oauth.register({ redirect_uris: Array.from({ length: 6 }, () => CALLBACK) }),
        ).toMatchObject({ status: 400, body: { error: "invalid_client_metadata" } });
        expect(
          await oauth.register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "jwt" }),
        ).toMatchObject({ status: 400, body: { error: "invalid_client_metadata" } });
      });

      it("lets a loopback listener pick its port at sign-in, and nothing else vary", async () => {
        const oauth = make();
        const { client_id } = await registered(oauth, {
          redirect_uris: ["http://127.0.0.1/callback"],
        });
        const query = (uri: string) => authorizeQuery(client_id, { redirect_uri: uri });
        expect(await oauth.describe(query("http://127.0.0.1:53111/callback"))).toMatchObject({
          ok: true,
        });
        for (const uri of [
          "http://127.0.0.1:53111/other",
          "http://localhost:53111/callback",
          "https://127.0.0.1:53111/callback",
        ])
          expect(await oauth.describe(query(uri))).toMatchObject({ reason: "redirect-mismatch" });
      });

      it("refuses an operating system's own handlers as a redirect", async () => {
        const oauth = make();
        for (const uri of ["ms-msdt:/id", "search-ms:query=x", "mailto:a@b.example", "chrome://x"])
          expect((await oauth.register({ redirect_uris: [uri] })).status).toBe(400);
      });

      it("names a client with no name after where it returns", async () => {
        const oauth = make();
        const answer = await oauth.register({ redirect_uris: ["http://127.0.0.1:33418/cb"] });
        expect(answer.body.client_name).toBe("127.0.0.1:33418");
      });
    });

    describe("a client id that is a URL", () => {
      const ID = DOC_ID;
      const doc = (body: Record<string, unknown>, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init);

      it("fetches the document once, and signs in with its redirect", async () => {
        const oauth = make();
        documents.set(
          ID,
          doc({ client_id: ID, client_name: "Agent App", redirect_uris: [CALLBACK] }),
        );
        expect(await oauth.describe(authorizeQuery(ID))).toMatchObject({
          ok: true,
          clientName: "Agent App",
        });
        const code = await approvedCode(oauth, ID);
        expect(await oauth.token(exchange(code, ID), null)).toMatchObject({ status: 200 });
        expect(fetched).toEqual([ID]);
      });

      it("refuses a document that names another client, holds a secret, redirects or is too big", async () => {
        const cases: Array<[string, Response]> = [
          [
            "https://agent.example/a.json",
            doc({ client_id: "https://agent.example/b.json", redirect_uris: [CALLBACK] }),
          ],
          [
            "https://agent.example/c.json",
            doc({
              client_id: "https://agent.example/c.json",
              redirect_uris: [CALLBACK],
              token_endpoint_auth_method: "client_secret_basic",
            }),
          ],
          [
            "https://agent.example/d.json",
            new Response(null, { status: 302, headers: { location: "https://agent.example/e" } }),
          ],
          [
            "https://agent.example/f.json",
            doc({
              client_id: "https://agent.example/f.json",
              redirect_uris: [CALLBACK],
              padding: "x".repeat(6_000),
            }),
          ],
          [
            "https://agent.example/g.json",
            doc({ client_id: "https://agent.example/g.json", redirect_uris: ["javascript:x"] }),
          ],
        ];
        const oauth = make();
        for (const [id, response] of cases) {
          documents.set(id, response);
          expect(await oauth.describe(authorizeQuery(id))).toMatchObject({
            ok: false,
            reason: "unknown-client",
          });
        }
      });

      it("never fetches on the token endpoint, which anyone may call", async () => {
        const oauth = make();
        documents.set(
          ID,
          doc({ client_id: ID, client_name: "Agent App", redirect_uris: [CALLBACK] }),
        );
        const code = await approvedCode(oauth, ID);
        fetched.length = 0;
        expect(await oauth.token(exchange(code, ID), null)).toMatchObject({ status: 200 });
        const stranger = "https://attacker.example/c.json";
        expect((await oauth.token(exchange("bogus", stranger), null)).body.error).toBe(
          "invalid_grant",
        );
        expect(fetched).toEqual([]);
      });

      it("never fetches a private address, plain http, or an origin with no path", async () => {
        const oauth = make();
        for (const id of [
          "https://10.0.0.5/client.json",
          "https://169.254.169.254/latest",
          "https://localhost/client.json",
          "http://agent.example/client.json",
          "https://agent.example/",
        ])
          expect(await oauth.describe(authorizeQuery(id))).toMatchObject({
            ok: false,
            reason: "unknown-client",
          });
        expect(fetched).toEqual([]);
      });
    });

    describe("the device flow", () => {
      const start = (oauth: ReturnType<typeof make>, clientId = "acme-cli") =>
        oauth.deviceAuthorization({ client_id: clientId, resource: `${ISSUER}/mcp` }, null);
      const poll = (oauth: ReturnType<typeof make>, deviceCode: string, clientId = "acme-cli") =>
        oauth.token(
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: clientId,
          },
          null,
        );
      const codes = (answer: { body: Record<string, unknown> }) =>
        answer.body as {
          device_code: string;
          user_code: string;
          verification_uri_complete: string;
        };

      it("waits, slows a fast poller, and hands the key out once after the yes", async () => {
        const oauth = make();
        const started = await start(oauth);
        const { device_code, user_code, verification_uri_complete } = codes(started);
        expect(started.body).toMatchObject({
          verification_uri: "https://example.com/device",
          expires_in: 600,
          interval: 5,
        });
        expect(user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
        expect(verification_uri_complete).toBe(`https://example.com/device?code=${user_code}`);

        expect((await poll(oauth, device_code)).body.error).toBe("authorization_pending");
        advance(2);
        expect((await poll(oauth, device_code)).body.error).toBe("slow_down");
        advance(5);
        expect((await poll(oauth, device_code)).body.error).toBe("authorization_pending");

        // The person types it any way they like.
        const typed = user_code.toLowerCase().replace("-", " ");
        expect(await oauth.describeDevice(typed)).toEqual({
          ok: true,
          clientName: "Acme CLI",
          userCode: user_code,
          keyName: "Acme CLI (device sign-in)",
          expiresAt: new Date("2026-10-16T12:10:00.000Z"),
        });
        expect(await oauth.decideDevice(typed, { subject: "user-1" })).toEqual({ ok: true });
        expect(await oauth.decideDevice(typed, { subject: "user-2" })).toMatchObject({
          ok: false,
          reason: "unknown-code",
        });

        advance(5);
        expect(await poll(oauth, device_code)).toEqual({
          status: 200,
          body: { access_token: "ak_1", token_type: "Bearer" },
        });
        advance(5);
        expect((await poll(oauth, device_code)).body.error).toBe("invalid_grant");
        expect(minted).toEqual([
          { subject: "user-1", keyName: "Acme CLI (device sign-in)", clientName: "Acme CLI" },
        ]);
      });

      it("tells the script when the person said no", async () => {
        const oauth = make();
        const { device_code, user_code } = codes(await start(oauth));
        expect(await oauth.decideDevice(user_code, "deny")).toEqual({ ok: true });
        expect((await poll(oauth, device_code)).body.error).toBe("access_denied");
        expect(await oauth.describeDevice(user_code)).toMatchObject({ reason: "unknown-code" });
      });

      it("expires after ten minutes, on both sides", async () => {
        const oauth = make();
        const { device_code, user_code } = codes(await start(oauth));
        advance(601);
        expect(await oauth.describeDevice(user_code)).toMatchObject({ reason: "unknown-code" });
        expect(await oauth.decideDevice(user_code, { subject: "user-1" })).toMatchObject({
          reason: "unknown-code",
        });
        expect((await poll(oauth, device_code)).body.error).toBe("expired_token");
        expect(minted).toEqual([]);
      });

      it("answers only the client that started it, and only your own scripts", async () => {
        const oauth = make();
        const { device_code, user_code } = codes(await start(oauth));
        await oauth.decideDevice(user_code, { subject: "user-1" });
        // Another client's poll of an approved sign-in must not spend it.
        expect((await poll(oauth, device_code, "other-cli")).body.error).toBe("invalid_grant");
        expect((await poll(oauth, "not-a-code")).body.error).toBe("invalid_grant");
        expect(await poll(oauth, device_code)).toMatchObject({ status: 200 });

        const { client_id } = await registered(oauth, { client_name: "Claude" });
        for (const id of [client_id, "nobody", "constructor", "__proto__", "toString", DOC_ID])
          expect(await start(oauth, id)).toMatchObject({
            status: 400,
            body: { error: "unauthorized_client" },
          });
        expect(fetched).toEqual([]);
      });

      it("draws again when a pending sign-in already shows the code", async () => {
        const base = store();
        let clashes = 1;
        const clashing: OAuthStore = {
          ...base,
          // Only whether a grant came back is read, so an empty one stands in for the clash.
          findDevice: async (hash, at) =>
            clashes-- > 0 ? ({} as OAuthGrant) : base.findDevice(hash, at),
        };
        const inserted: OAuthGrant[] = [];
        const oauth = make({
          store: { ...clashing, insert: async (grant) => void inserted.push(grant) },
        });
        await start(oauth);
        expect(clashes).toBe(-1);
        expect(inserted).toHaveLength(1);
      });

      it("prunes what expired more than a day ago", async () => {
        const oauth = make();
        await start(oauth);
        advance(600 + 86_400 + 1);
        expect(await oauth.prune()).toBeGreaterThanOrEqual(1);
      });
    });

    it("refuses a secret too short to sign with, and a door on another origin", () => {
      expect(() => make({ secret: "short" })).toThrow(/at least 32 bytes/);
      expect(() => make({ resource: "https://mcp.example.com/mcp" })).toThrow(/issuer's origin/);
    });

    it("reads an issuer written with a trailing slash as the same issuer", () => {
      const oauth = make({ issuer: `${ISSUER}/` });
      expect(oauth.authorizationServerMetadata().issuer).toBe(ISSUER);
      expect(oauth.metadataPath).toBe("/.well-known/oauth-protected-resource/mcp");
    });
  });
}

flows("createOAuth with a memory store", async () => ({ store: memoryStore }));

describe.skipIf(!hasPostgres)("createPgOAuthStore", () => {
  let server: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;

  beforeAll(async () => {
    server = await startPostgres();
    pool = new Pool({ connectionString: server.url, max: 10 });
    await pool.query("CREATE SCHEMA app");
    if (!TABLE_SQL) throw new Error("The README's CREATE TABLE for oauth_grants is gone");
    await pool.query(TABLE_SQL);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await server?.stop();
  });

  flows("against a real Postgres", async () => ({
    store: () => createPgOAuthStore(pool, { table: "app.oauth_grants" }),
  }));

  it("hands an approved device sign-in's key to exactly one of many polls", async () => {
    const minted: string[] = [];
    const oauth = createOAuth({
      issuer: ISSUER,
      resource: `${ISSUER}/mcp`,
      authorizePage: "https://example.com/oauth/authorize",
      devicePage: "https://example.com/device",
      secret: SECRET,
      store: createPgOAuthStore(pool, { table: "app.oauth_grants" }),
      deviceClients: { "acme-cli": "Acme CLI" },
      mintKey: async ({ subject }) => {
        minted.push(subject);
        return "ak_race";
      },
    });
    const started = await oauth.deviceAuthorization({ client_id: "acme-cli" }, null);
    const { device_code, user_code } = started.body as { device_code: string; user_code: string };
    const decisions = await Promise.all(
      ["user-1", "user-2", "user-3"].map((subject) => oauth.decideDevice(user_code, { subject })),
    );
    expect(decisions.filter((d) => d.ok)).toHaveLength(1);

    const polls = await Promise.all(
      Array.from({ length: 8 }, () =>
        oauth.token(
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code,
            client_id: "acme-cli",
          },
          null,
        ),
      ),
    );
    expect(polls.filter((p) => p.status === 200)).toHaveLength(1);
    expect(minted).toHaveLength(1);
  });

  it("refuses a table name that is not a name", () => {
    expect(() => createPgOAuthStore(pool, { table: "grants; DROP TABLE x" })).toThrow(TypeError);
  });
});

describe("oauthRoutes", () => {
  const oauth = createOAuth({
    issuer: ISSUER,
    resource: `${ISSUER}/mcp`,
    authorizePage: "https://example.com/oauth/authorize",
    devicePage: "https://example.com/device",
    secret: SECRET,
    store: memoryStore(),
    deviceClients: { "acme-cli": "Acme CLI" },
    documentation: "https://example.com/docs",
    mintKey: async () => "ak_1",
  });
  const app = new Hono();
  app.route("/", oauthRoutes(oauth));

  it("serves both discovery documents, at both protected-resource paths", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: `${ISSUER}/mcp`,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://example.com/docs",
      });
    }
    const server = await app.request("/.well-known/oauth-authorization-server");
    expect(await server.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: "https://example.com/oauth/authorize",
      token_endpoint: `${ISSUER}/oauth/token`,
      device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(oauth.challenge).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("answers any origin on its own paths only, not on your routes mounted after it", async () => {
    const mounted = new Hono();
    mounted.route("/", oauthRoutes(oauth));
    mounted.get("/v1/me", (c) => c.json({ me: 1 }));
    const origin = { origin: "https://elsewhere.example" };
    const later = await mounted.request("/v1/me", { headers: origin });
    expect(later.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await mounted.request("/v1/me", {
      method: "OPTIONS",
      headers: { ...origin, "access-control-request-method": "DELETE" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const own = await mounted.request("/.well-known/oauth-protected-resource/mcp", {
      headers: origin,
    });
    expect(own.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("lets any web page run discovery, with the MCP SDK's own header", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://inspector.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "mcp-protocol-version",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBe("mcp-protocol-version");
  });

  it("registers from JSON, and starts a device sign-in from a form, uncached", async () => {
    const registered = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CALLBACK] }),
    });
    expect(registered.status).toBe(201);
    expect(registered.headers.get("cache-control")).toBe("no-store");

    const started = await app.request("/oauth/device_authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=acme-cli",
    });
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(await started.json()).toMatchObject({ interval: 5, expires_in: 600 });
  });

  it("reads Basic credentials, and answers a bad one with a Basic challenge", async () => {
    const basic = (id: string, secret: string) =>
      `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic("nobody", "wrong"),
      },
      body: "grant_type=authorization_code&code=x&redirect_uri=x&code_verifier=x",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="oauth"');
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  it("answers an unknown grant type in OAuth's shape", async () => {
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=password",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("the helpers", () => {
  it("computes RFC 7636's own S256 example", async () => {
    expect(await challengeOf(VERIFIER)).toBe(CHALLENGE);
  });

  it("reads a user code however it was typed, and only from the alphabet", () => {
    expect(normalizeUserCode("wdjb mjht")).toBe("WDJBMJHT");
    expect(normalizeUserCode("WDJB-MJHT")).toBe("WDJBMJHT");
    expect(normalizeUserCode("AEIOUAEI")).toBeNull();
    expect(normalizeUserCode("WDJB")).toBeNull();
  });

  it("allows only redirects that hand the code to an app", () => {
    expect(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirect("http://[::1]:8080/cb")).toBe(true);
    expect(isAllowedRedirect("vscode://auth/cb")).toBe(true);
    expect(isAllowedRedirect("file:///etc/passwd")).toBe(false);
    expect(isAllowedRedirect("not a url")).toBe(false);
  });
});
