import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** An em dash gives away AI-written text, so none may reach a reader. Checks every string,
 *  template piece and JSX-free literal in library source; comments are not nodes, so they stay
 *  free. Tests and scripts/ restate nothing: they are exempt below. The regex uses a unicode
 *  escape so this file does not contain the character itself. READMEs and package.json are
 *  covered by scripts/check-no-em-dash.ts. */
const NO_EM_DASH = ["Literal[value=/\\u2014/]", "TemplateElement[value.cooked=/\\u2014/]"].map(
  (selector) => ({
    selector,
    message: "No em dash in user-facing text. Use a period, comma, colon or parentheses.",
  }),
);

// One config for the whole repo — eslint walks up from each workspace, so `eslint src` inside a
// package resolves to this file.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The house rule: no `as any`, no `as unknown as T`. Fix the type.
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": ["error", ...NO_EM_DASH],
    },
  },
  {
    // Tests assert on strings and scripts/ is internal tooling nobody reads in the product.
    files: ["**/*.test.ts", "**/scripts/**", "**/*.config.*"],
    rules: { "no-restricted-syntax": "off" },
  },
);
