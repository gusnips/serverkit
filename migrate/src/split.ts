/**
 * Split a `-- migrate: no-transaction` file into the statements it holds.
 *
 * It has to be split. Postgres runs a query string holding several statements as one implicit
 * transaction block, and `CREATE INDEX CONCURRENTLY` refuses to run inside one ("cannot run inside
 * a transaction block", measured). Five runners sent such a file as a single query, which works
 * for one statement and fails for two; the files that need this hold up to ten.
 *
 * The scanner is the one a donor already ran in production, with the gaps it had closed:
 *
 * - block comments nest, as they do in Postgres (`/* a /* b *\/ c *\/` is one comment);
 * - `E'…'` strings take backslash escapes, so `E'it\'s'` does not end at the backslash;
 * - a `$` inside an identifier (`price$usd`) does not open a dollar quote.
 *
 * A `BEGIN ATOMIC` function body holds semicolons that do not end the statement, and telling them
 * apart needs a parser. It is refused with a way forward instead of being split wrongly.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;

  const isWordChar = (char: string | undefined) => char !== undefined && /[\w$]/.test(char);

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (char === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (char === "'") {
      const escapes = (sql[i - 1] === "E" || sql[i - 1] === "e") && !isWordChar(sql[i - 2]);
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (char === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (char === "$" && !isWordChar(sql[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(char ?? "") && !isWordChar(sql[i - 1])) {
      const word = /^[A-Za-z_]\w*/.exec(sql.slice(i))?.[0] ?? "";
      if (word.toUpperCase() === "BEGIN" && /^\s+ATOMIC\b/i.test(sql.slice(i + word.length)))
        throw new Error(
          `A BEGIN ATOMIC function body cannot be split into statements safely. Move the ` +
            `function to a file without "-- migrate: no-transaction"; it runs in a transaction there.`,
        );
      i += word.length;
      continue;
    }

    if (char === ";") {
      const statement = sql.slice(start, i + 1).trim();
      if (statement.length > 0) statements.push(statement);
      start = i + 1;
    }
    i++;
  }

  const tail = sql.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  // A statement made only of comments would still be sent, and Postgres answers it with an empty
  // result; the tail after the last `;` is usually exactly that. Keep the comment-only pieces out.
  return statements.filter((statement) => hasCode(statement));
}

function hasCode(statement: string): boolean {
  const withoutComments = statement.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutComments.trim().length > 0;
}
