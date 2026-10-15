// The playback clock: one rAF loop outside any canvas advances `t`, so every view (incl. compare mode) shares it.
import { useEffect } from "react";
import { RUN_MINUTES } from "../api/contract";
import { RATE, useSim } from "./store";

export function useClock() {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = useSim.getState();
      if (s.playing) {
        const t = s.t + dt * RATE[s.speed];
        if (t >= RUN_MINUTES) useSim.setState({ t: RUN_MINUTES, playing: false });
        else useSim.setState({ t });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** Space = play/pause, ←/→ = ∓1 hour (shift: ∓1 day), 1/2/3 = speed, Esc = close. */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.target.type !== "range") return;
      }
      const s = useSim.getState();
      const step = e.shiftKey ? 1440 : 60;
      if (e.code === "Space") {
        e.preventDefault();
        s.togglePlay();
      } else if (e.key === "ArrowRight") s.setT(s.t + step);
      else if (e.key === "ArrowLeft") s.setT(s.t - step);
      else if (e.key === "1") s.setSpeed(1);
      else if (e.key === "2") s.setSpeed(10);
      else if (e.key === "3") s.setSpeed(100);
      else if (e.key === "Escape") {
        if (s.panel) s.openPanel(null);
        else s.selectStore(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
