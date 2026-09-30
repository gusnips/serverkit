/**
 * The origin an entry names, or null when it names none. An origin is a scheme and a host, with
 * nothing after them but one `/`: what a browser sends in `Origin`. `corsAllowList` builds its
 * list with this, and `EnvSpec.origins` checks with it, so a value the env check passes is one the
 * allow-list takes.
 */
export function originOf(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  // An entry such as `file:///` has an opaque origin, which is the string "null", and allowing
  // "null" allows every sandboxed iframe and every page opened from a file.
  if (url.origin === "null" || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}
