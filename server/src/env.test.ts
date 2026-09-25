import { describe, expect, it } from "vitest";
import { EnvError, envProblems, validateEnv } from "./env.ts";

const RANDOM = "q7Vb1xN0c2Lk9sQe4Rz8Wm3Jp6Yt5Uh+AaBbCcDdEe="; // `openssl rand -base64 32`

function thrown(run: () => void): EnvError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error("expected an EnvError, and nothing was thrown");
}

describe("validateEnv", () => {
  it("names every problem in one error, with the fix last", () => {
    const error = thrown(() =>
      validateEnv(
        { SMTP_HOST: "smtp.example.com", SESSION_SECRET: "short" },
        {
          required: ["DATABASE_URL", "REDIS_URL", "SESSION_SECRET"],
          groups: { SMTP_HOST: ["SMTP_USER", "SMTP_PASS"] },
          secrets: { SESSION_SECRET: 32 },
          fix: "Copy apps/api/.env.example to apps/api/.env and fill it in.",
        },
      ),
    );
    expect(error.problems).toEqual([
      "These are not set: DATABASE_URL, REDIS_URL",
      "SMTP_HOST is set, so these must be set too: SMTP_USER, SMTP_PASS",
      "SESSION_SECRET is 5 characters and needs at least 32. Copy it again in full, or make one " +
        "with `openssl rand -base64 32`.",
    ]);
    expect(error.message).toBe(
      [
        "The environment has 3 problems:",
        ...error.problems.map((line) => `- ${line}`),
        "Copy apps/api/.env.example to apps/api/.env and fill it in.",
      ].join("\n"),
    );
  });

  it("returns when there is nothing to say", () => {
    expect(
      validateEnv(
        { DATABASE_URL: "postgres://localhost/app", SESSION_SECRET: RANDOM },
        {
          required: ["DATABASE_URL", "SESSION_SECRET"],
          secrets: { SESSION_SECRET: 32 },
        },
      ),
    ).toBeUndefined();
  });

  it("counts one problem as one", () => {
    expect(thrown(() => validateEnv({}, { required: ["A"] })).message).toBe(
      "The environment has 1 problem:\n- These are not set: A",
    );
  });

  it("never puts a value in the message", () => {
    const source = {
      DATABASE_URL: "postgres://app:hunter2-password@db.internal/app",
      SESSION_SECRET: "hunter2",
      API_KEY: "your-hunter2-key",
    };
    const error = thrown(() =>
      validateEnv(source, {
        required: ["DATABASE_URL", "REDIS_URL"],
        groups: { DATABASE_URL: ["DATABASE_POOL"] },
        secrets: { SESSION_SECRET: 32, API_KEY: 8 },
      }),
    );
    expect(error.problems).toHaveLength(4);
    expect(error.message).not.toContain("hunter2");
  });
});

describe("envProblems", () => {
  it("reads a value of only spaces as not set, and 0 as set", () => {
    expect(
      envProblems({ A: "  ", B: "\n", C: "0", D: "x" }, { required: ["A", "B", "C", "D"] }),
    ).toEqual(["These are not set: A, B"]);
  });

  it("asks nothing of a group whose first key is not set", () => {
    const groups = { SMTP_HOST: ["SMTP_USER"] };
    expect(envProblems({ SMTP_USER: "" }, { groups })).toEqual([]);
    expect(envProblems({ SMTP_HOST: " ", SMTP_USER: "" }, { groups })).toEqual([]);
    expect(envProblems({ SMTP_HOST: "smtp.example.com" }, { groups })).toEqual([
      "SMTP_HOST is set, so these must be set too: SMTP_USER",
    ]);
  });

  it("names a missing key once, even when a group needs it too", () => {
    expect(
      envProblems(
        { STRIPE_SECRET_KEY: "sk_test_1" },
        {
          required: ["STRIPE_WEBHOOK_SECRET"],
          groups: { STRIPE_SECRET_KEY: ["STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO"] },
        },
      ),
    ).toEqual([
      "These are not set: STRIPE_WEBHOOK_SECRET",
      "STRIPE_SECRET_KEY is set, so these must be set too: STRIPE_PRICE_PRO",
    ]);
  });

  it("refuses each placeholder shape the fleet's .env.example files ship", () => {
    for (const placeholder of [
      "<generate: openssl rand -base64 32>",
      "<SET-BY-generate-keys.sh>",
      "your-smtp-password",
      "sk-your-deepseek-key",
      "your_api_key",
      "sk_test_your_stripe_secret_key_0123456789",
      "generate-a-random-secret",
      "dev-egress-secret-change-me",
      "changeme",
      "dev-only-key-not-for-the-box-0123456789abcdef",
      "sk-proj-xxx",
      "aact_prod_xxxx",
      "xxx",
      // 55 characters, written to pass the floor it is checked against.
      "your-super-secret-jwt-token-with-at-least-32-characters",
    ])
      expect(envProblems({ SECRET: placeholder }, { secrets: { SECRET: 32 } })).toEqual([
        "SECRET looks like a placeholder from .env.example. Put the real secret there.",
      ]);
  });

  it("passes secrets a generator made, and a vendor's", () => {
    for (const secret of [
      RANDOM,
      "3f9a0c1e7b2d4a6c8e0f1a3b5c7d9e1f", // `openssl rand -hex 16`
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "sk_test_51Hx4bPLkq2Yp0000xxxAbCdEfGh",
      "q7Vb1xN0c2Lk9sQe4Rz8Wm3Jp6Yt5UhyourAaBbXXX9", // a word inside, with nothing around it
    ])
      expect(envProblems({ SECRET: secret }, { secrets: { SECRET: 32 } })).toEqual([]);
  });

  it("measures a secret without the spaces around it, and at the floor it passes", () => {
    const secrets = { SECRET: 32 };
    expect(envProblems({ SECRET: "a".repeat(32) }, { secrets })).toEqual([]);
    expect(envProblems({ SECRET: ` ${"a".repeat(31)} ` }, { secrets })).toEqual([
      "SECRET is 31 characters and needs at least 32. Copy it again in full, or make one with " +
        "`openssl rand -base64 32`.",
    ]);
    expect(envProblems({ SECRET: "a" }, { secrets: { SECRET: 64 } })[0]).toContain(
      "`openssl rand -base64 48`",
    );
  });

  it("leaves an unset secret to `required`", () => {
    expect(envProblems({ SECRET: "" }, { secrets: { SECRET: 32 } })).toEqual([]);
  });

  it("checks a secret that is set even when its group is off", () => {
    // Three adopters asked for this to be skipped. The spec cannot see which code reads a key,
    // and a webhook route mounted either way verifies with the placeholder that would slip by.
    const spec = {
      groups: { GITHUB_APP_ID: ["GITHUB_WEBHOOK_SECRET"] },
      secrets: { GITHUB_WEBHOOK_SECRET: 32 },
    };
    expect(envProblems({ GITHUB_WEBHOOK_SECRET: "your-webhook-secret" }, spec)).toEqual([
      "GITHUB_WEBHOOK_SECRET looks like a placeholder from .env.example. Put the real secret there.",
    ]);
  });

  it("adds your own rules to the same list", () => {
    const source = { STRIPE_SECRET_KEY: "sk_live_1" };
    expect(
      envProblems(source, {
        required: ["DATABASE_URL"],
        check: (env) =>
          env.STRIPE_SECRET_KEY.startsWith("sk_test_")
            ? []
            : ["STRIPE_SECRET_KEY must be a test key while billing is in beta"],
      }),
    ).toEqual([
      "These are not set: DATABASE_URL",
      "STRIPE_SECRET_KEY must be a test key while billing is in beta",
    ]);
  });

  it("takes a Worker's env, where a binding is set and a key is not on Object's prototype", () => {
    interface WorkerEnv {
      DB: { prepare(query: string): unknown };
      LIMIT: number;
      SESSION_SECRET?: string;
    }
    const env: WorkerEnv = { DB: { prepare: () => null }, LIMIT: 0 };
    expect(
      envProblems(env, { required: ["DB", "LIMIT", "SESSION_SECRET", "constructor"] }),
    ).toEqual(["These are not set: SESSION_SECRET, constructor"]);
  });
});
