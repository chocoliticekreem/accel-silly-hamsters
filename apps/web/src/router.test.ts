import { describe, expect, it } from "vitest";
import { parseRoute, storePath } from "./router";

describe("router", () => {
  it("routes / to the area view and /store/:id to the owner page", () => {
    expect(parseRoute("/")).toEqual({ page: "area" });
    expect(parseRoute("/?run=3&t=100")).toEqual({ page: "area" });
    expect(parseRoute("/store/s13")).toEqual({ page: "store", storeId: "s13", run: undefined });
    expect(parseRoute("/store/s13?run=6")).toEqual({ page: "store", storeId: "s13", run: 6 });
  });

  it("round-trips store paths", () => {
    expect(parseRoute(storePath("s 1", 2))).toEqual({ page: "store", storeId: "s 1", run: 2 });
  });
});
