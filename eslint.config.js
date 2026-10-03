import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
    },
  },
);
