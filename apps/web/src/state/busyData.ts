// Busy-times data over the day files: arrivals per store per day, and per-weekday averages.
// Shares the "day:run:day" cache with the 3D view, so the day on screen is never fetched twice.
import { api } from "../api/client";
import { arrivalsOfDay, averageDays, daysOfWeekday, type DayArrivals } from "../sim/busyTimes";
import { load, useResource } from "./data";

const arrivals = (run: number, day: number) =>
  load<DayArrivals>(`busy:${run}:${day}`, () => load(`day:${run}:${day}`, () => api.day(run, day)).then(arrivalsOfDay));

/** Arrival minutes per store on `day` (null = skip). */
export const useDayArrivals = (run: number, day: number | null) =>
  useResource<DayArrivals>(day == null ? null : `busy:${run}:${day}`, () => arrivals(run, day!));

/** Per-store visits by hour averaged over the run's days on weekday `w` (0 = Mon; null = skip). Days that fail to load are left out. */
export const useWeekdayHours = (run: number, w: number | null) =>
  useResource<Map<string, number[]>>(w == null ? null : `busy-wd:${run}:${w}`, async () => {
    const days = await Promise.all(daysOfWeekday(w!).map((d) => arrivals(run, d).catch(() => null)));
    const ok = days.filter((d): d is DayArrivals => d != null);
    if (!ok.length) throw new Error("no day files");
    return averageDays(ok);
  });
