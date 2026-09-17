#!/usr/bin/env node
/**
 * One bin with a scoped name, and two commands under it.
 *
 * The package once shipped `migrate`, `db-types` and `supabase-stand-in`. Each bare name belongs
 * to an unrelated npm package or can be registered by anyone, so `bunx migrate` in a CI job
 * without this package installed downloads a stranger's code and runs it with DATABASE_URL in its
 * environment. Two generic names would also collide in an adopter's node_modules/.bin.
 *
 * The command is read before any flag parsing, so everything else still goes through the runner's
 * rule that an unknown flag or argument is an error.
 */
import { migrateCli } from "../cli.ts";
import { dbTypesCli } from "../db-types-cli.ts";
import { standInCli } from "../stand-in.ts";

const [command, ...rest] = process.argv.slice(2);

process.exitCode =
  command === "db-types"
    ? await dbTypesCli(rest)
    : command === "supabase-stand-in"
      ? await standInCli(rest)
      : await migrateCli();
