/**
 * Checking the environment when a process boots, so a box with a wrong `.env` stops at once,
 * with a list of what to change, instead of failing one request at a time.
 *
 * What the twelve copies in the fleet taught:
 * - **Every problem in one error.** One copy threw at the first, so a box with two problems took
 *   two restarts to fix.
 * - **No value in any message.** A connection URL carries a password, and this error goes to a
 *   boot log. Only one copy said so.
 * - **A placeholder is not a secret.** None of the twelve refused the value their own
 *   `.env.example` ships, and one example key passed that repo's own 32-character floor. A
 *   placeholder that boots is worse than a missing one: it signs and verifies, and anyone who
 *   has read the example can forge with it.
 * - **The source is an argument.** A Worker has no `process.env`, and a test passes an object.
 * - **It never turns itself off.** One copy returned early under `NODE_ENV=test`, so a single
 *   variable switched the whole check off.
 */

export interface EnvSpec<Source extends object> {
  /** Must be set. A value of only spaces counts as not set. */
  required?: readonly string[];
  /**
   * When the key is set, the keys in its list must be set too, so half an integration fails at
   * boot: `{ SMTP_HOST: ["SMTP_USER", "SMTP_PASS"] }`. For both-or-neither, list each in the
   * other's.
   */
  groups?: Readonly<Record<string, readonly string[]>>;
  /**
   * Secrets, each with the fewest characters it may have. When one is set, it must be at least
   * that long and must not be a placeholder from `.env.example`. Use 32 for a secret you make with
   * `openssl rand -base64 32`, and a vendor's own length for one they give you.
   */
  secrets?: Readonly<Record<string, number>>;
  /** Your own rules, returned as more lines for the same list. Keep values out of them. */
  check?: (source: Source) => readonly string[];
  /** The error's last line, such as "Copy .env.example to .env and fill it in." */
  fix?: string;
}

/**
 * The shapes placeholders take in the `.env.example` files the fleet commits, one per line. Each
 * is a word or a bracket, and a secret made by a random generator has neither.
 */
const PLACEHOLDERS = [
  /^<.*>$/s, // <generate: openssl rand -base64 32>
  /\byour[-_]/i, // your-smtp-password, sk-your-deepseek-key
  /^generate[-_: ]/i, // generate-a-random-secret
  /change-?me/i, // dev-egress-secret-change-me
  /dev-only/i, // dev-only-key-not-for-the-box-0123456789abcdef
  /(?:^|[-_,.])x{3,}$/, // sk-proj-xxx, aact_prod_xxxx
];

/** Thrown by `validateEnv`. The message lists every problem, and `problems` holds each one. */
export class EnvError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[], fix?: string) {
    const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
    const lines = [`The environment has ${count}:`, ...problems.map((line) => `- ${line}`)];
    super(fix ? [...lines, fix].join("\n") : lines.join("\n"));
    this.name = "EnvError";
    this.problems = problems;
  }
}

/**
 * Throws an `EnvError` listing every problem with `source`, and returns nothing when there is
 * none. Call it first thing at boot:
 *
 *     validateEnv(process.env, { required: ["DATABASE_URL"] });
 */
export function validateEnv<Source extends object>(source: Source, spec: EnvSpec<Source>): void {
  const problems = envProblems(source, spec);
  if (problems.length > 0) throw new EnvError(problems, spec.fix);
}

/** `validateEnv`'s list without the throw, for a test of your spec. */
export function envProblems<Source extends object>(
  source: Source,
  spec: EnvSpec<Source>,
): string[] {
  // A Map, so a key named "constructor" is looked up in the source and not on Object's prototype.
  const values = new Map<string, unknown>(Object.entries(source));
  const textOf = (key: string): string => {
    const value = values.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  // A Worker's `env` holds more than strings: a database binding, or a number from `[vars]`.
  const isSet = (key: string): boolean => {
    const value = values.get(key);
    return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
  };
  const problems: string[] = [];

  const unset = (spec.required ?? []).filter((key) => !isSet(key));
  if (unset.length > 0) problems.push(`These are not set: ${unset.join(", ")}`);

  for (const [head, members] of Object.entries(spec.groups ?? {})) {
    if (!isSet(head)) continue;
    const missing = members.filter((key) => !isSet(key) && !unset.includes(key));
    if (missing.length > 0)
      problems.push(`${head} is set, so these must be set too: ${missing.join(", ")}`);
  }

  for (const [key, fewest] of Object.entries(spec.secrets ?? {})) {
    const value = textOf(key);
    if (value === "") continue;
    if (PLACEHOLDERS.some((shape) => shape.test(value)))
      problems.push(
        `${key} looks like a placeholder from .env.example. Put the real secret there.`,
      );
    else if (value.length < fewest) {
      // Base64 writes 4 characters for every 3 bytes.
      const bytes = Math.max(32, Math.ceil(fewest / 4) * 3);
      problems.push(
        `${key} is ${value.length} characters and needs at least ${fewest}. Copy it again in ` +
          `full, or make one with \`openssl rand -base64 ${bytes}\`.`,
      );
    }
  }

  problems.push(...(spec.check?.(source) ?? []));
  return problems;
}
