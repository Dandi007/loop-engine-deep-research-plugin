import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/smoke-cas.ts"],
    environment: "node",
  },
});