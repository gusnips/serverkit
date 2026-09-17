export { migrateCli, MIGRATE_USAGE, type MigrateConfig } from "./cli.ts";
export {
  runMigrations,
  DEFAULT_LOCK_KEY,
  DEFAULT_LOCK_WAIT_SECONDS,
  type Log,
  type MigrateOptions,
  type MigrateResult,
} from "./runner.ts";
export { readMigrationFiles, sortMigrationFiles, type MigrationFile } from "./files.ts";
export { readDirectives, type Directives } from "./directives.ts";
export { splitSqlStatements } from "./split.ts";
export {
  LOG_PREFIX,
  MANUAL_PENDING,
  STATUS_PENDING,
  STATUS_UP_TO_DATE,
  manualPendingLine,
  statusPendingLine,
} from "./lines.ts";
export {
  describeTarget,
  confirmationReason,
  requireLocalDatabase,
  isLocalHost,
  type Target,
  type GuardOptions,
} from "./target.ts";
export { pgSsl } from "./ssl.ts";
export { unreadableTablesCheck } from "./checks.ts";
