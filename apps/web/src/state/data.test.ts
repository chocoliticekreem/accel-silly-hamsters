import { describe, expect, it } from "vitest";
import { prepareDay } from "./data";

// Runs against the mock API (VITE_API_URL is unset under vitest).
describe("prepareDay", () => {
  it("prepares a day once, shares it, and keeps the list readable synchronously", async () => {
    const day = prepareDay(1, 2);
    expect(prepareDay(1, 2)).toBe(day);
    const list = await day.promise;
    expect(list.length).toBeGreaterThan(0);
    expect(day.list).toBe(list);
  });

  it("forgets a day that failed to load, so the next render retries instead of keeping an empty list", async () => {
    const missing = prepareDay(1, 99);
    await expect(missing.promise).rejects.toThrow();
    expect(missing.list).toBeUndefined();
    expect(prepareDay(1, 99)).not.toBe(missing);
  });
});
