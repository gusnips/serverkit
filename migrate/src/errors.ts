/** A thrown value as the lines a person reads: the message, then Postgres's detail and hint. */
export function describeError(err: unknown, sql?: string): string[] {
  if (!(err instanceof Error)) return [String(err)];
  const lines = [err.message];
  const field = (name: string): string | undefined => {
    const value: unknown = Reflect.get(err, name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  // Postgres reports where a statement failed as a character offset into the query. For a
  // five-thousand-line baseline, a line number is the difference between reading and searching.
  const position = Number(field("position"));
  if (sql !== undefined && Number.isInteger(position) && position > 0)
    lines[0] += ` (line ${String(sql.slice(0, position - 1).split("\n").length)})`;

  const detail = field("detail");
  const hint = field("hint");
  if (detail) lines.push(`Detail: ${detail}`);
  if (hint) lines.push(`Hint: ${hint}`);
  return lines;
}
