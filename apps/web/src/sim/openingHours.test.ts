import { describe, expect, it } from "vitest";
import { nextChange, openAt, parseOpeningHours, weekRows } from "./openingHours";

describe("parseOpeningHours", () => {
  it("reads day ranges, off days and split shifts", () => {
    const w = parseOpeningHours("Mo-Fr 07:00-17:00; Sa 09:00-17:00,18:00-22:00; Su off")!;
    expect(w[0]).toEqual([[420, 1020]]);
    expect(w[5]).toHaveLength(2);
    expect(w[6]).toEqual([]);
    expect(weekRows(w)[0]).toEqual(["Mon–Fri", "07:00–17:00"]);
  });
  it("handles past-midnight hours and 24/7", () => {
    const w = parseOpeningHours("Fr-Sa 18:00-02:00")!;
    expect(openAt(w, 5, 60)).toBe(true); // Saturday 01:00, from Friday night
    expect(openAt(w, 0, 60)).toBe(false); // Monday 01:00: Sunday was shut
    expect(parseOpeningHours("24/7")![3]).toEqual([[0, 1440]]);
  });
  it("returns null for what it can't read", () => {
    expect(parseOpeningHours("by appointment")).toBeNull();
    expect(parseOpeningHours("")).toBeNull();
  });
  it("says when it next opens or closes", () => {
    const w = parseOpeningHours("Mo-Su 10:00-19:00")!;
    expect(nextChange(w, 0, 12 * 60)).toBe("closes 19:00");
    expect(nextChange(w, 0, 20 * 60)).toBe("opens tomorrow 10:00");
  });
});
