// No em dash in the text readers see. ESLint covers every string in the library source
// (eslint.config.js, NO_EM_DASH); this covers what ESLint cannot parse: the READMEs and the
// package descriptions npm shows. An em dash gives away AI-written text.

import { readFileSync } from "node:fs";

const EM_DASH = "—";

const files = [
  "README.md",
  "server/README.md",
  "migrate/README.md",
  "sdkgen/README.md",
  "server/package.json",
  "migrate/package.json",
  "sdkgen/package.json",
];

const problems = files.flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, i) => (line.includes(EM_DASH) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
);

if (problems.length > 0) {
  console.error(
    `Em dash found in ${problems.length} user-facing line(s). Use a period, comma, colon or parentheses:\n` +
      problems.join("\n"),
  );
  process.exit(1);
}
console.log(`no em dash in ${files.length} user-facing files`);
