import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // the mock sim tests simulate whole runs: give them room when the suite runs files in parallel
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30_000 },
});
