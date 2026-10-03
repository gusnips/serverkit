import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Check strings and template pieces in library source. Implementation comments, tests and
 *  scripts/ stay exempt. scripts/check-no-em-dash.ts covers READMEs, package.json, published
 *  JSDoc and HTML entities in source text. The unicode escape keeps the character out of this file. */
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
