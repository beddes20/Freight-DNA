import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "client/src/lib/__tests__/**/*.test.ts",
      "client/src/lib/workflow-os/__tests__/**/*.test.ts",
      "server/__tests__/**/*.test.ts",
    ],
    globals: false,
  },
  // Task #970 — opt the test transformer into the automatic JSX
  // runtime so source files that contain JSX (e.g. workflow-os helpers
  // that render shadcn primitives) compile under vitest without
  // requiring an explicit `import React` (which the Vite frontend
  // setup intentionally forbids).
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
});
