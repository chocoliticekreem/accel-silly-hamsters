import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { environment: "node", include: ["src/**/*.test.ts"], // the mock city simulates 8 runs × 14 days: give it time on a busy machine
    testTimeout: 60_000, hookTimeout: 60_000 },
});
