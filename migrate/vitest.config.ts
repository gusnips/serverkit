import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["src/test/global-setup.ts"],
    // Each test opens its own database; a lock test waits a second on purpose.
    testTimeout: 20_000,
  },
});
