import { parseArgs } from "node:util";

export type FlagSpec = Record<string, { type: "boolean" | "string"; short?: string }>;

export type ParsedFlags = Record<string, string | boolean | undefined>;

/**
 * Parse argv against a fixed list of flags. An unknown flag is an error that names it.
 *
 * Every runner this package replaces ignored unknown flags, so `migrate --status` in the eight of
 * them that had no status mode APPLIED every pending migration. A flag the command does not know
 * is never a no-op here.
 */
export function parseFlags(
  argv: readonly string[],
  spec: FlagSpec,
): { flags: ParsedFlags; error?: string } {
  // `bun run x -- --flag` and `npm run x -- --flag` forward the separator on some versions.
  const args = argv.filter((arg, index) => !(arg === "--" && index === 0));
  const { tokens } = parseArgs({
    args,
    options: spec,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const flags: ParsedFlags = {};
  for (const token of tokens) {
    if (token.kind === "positional")
      return { flags, error: `Unexpected argument "${token.value}".` };
    if (token.kind === "option-terminator") continue;

    const option = spec[token.name];
    if (!option) return { flags, error: `Unknown flag "${token.rawName}".` };
    if (option.type === "boolean") {
      if (token.value !== undefined)
        return { flags, error: `${token.rawName} takes no value, but got "${token.value}".` };
      flags[token.name] = true;
    } else {
      if (token.value === undefined || token.value === "")
        return { flags, error: `${token.rawName} needs a value.` };
      flags[token.name] = token.value;
    }
  }
  return { flags };
}

export function stringFlag(flags: ParsedFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** A TCP port from a flag, or an error message. */
export function portFlag(flags: ParsedFlags, name: string): number | undefined | { error: string } {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { error: `--${name} must be a port number, but got "${value}".` };
  return port;
}
