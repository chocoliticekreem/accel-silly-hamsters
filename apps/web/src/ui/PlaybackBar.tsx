// Playback: play/pause, a 14-day scrubber (nights shaded, weekends marked), and 1× / 10× / 100×.
import { useRef } from "react";
import { DAYS_PER_RUN, RUN_MINUTES } from "../api/contract";
import { useSim, type Speed } from "../state/store";
import { clockLabel } from "../sim/time";
import { WEEKDAYS } from "./format";
import { Icon } from "./icons";

const SPEEDS: Speed[] = [1, 10, 100];

export function PlaybackBar() {
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);
  const t = useSim((s) => s.t);
  const track = useRef<HTMLDivElement>(null);
  const { togglePlay, setSpeed, setT } = useSim.getState();

  const scrub = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    setT(((clientX - r.left) / r.width) * RUN_MINUTES);
  };

  return (
    <section className="playback panel" aria-label="Playback">
      <button className="play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
        <Icon name={playing ? "pause" : "play"} size={18} />
      </button>
      <div
        className="track"
        ref={track}
        role="slider"
        aria-label="Sim time"
        aria-valuemin={0}
        aria-valuemax={RUN_MINUTES}
        aria-valuenow={Math.round(t)}
        aria-valuetext={clockLabel(t)}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrub(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && scrub(e.clientX)}
      >
        {Array.from({ length: DAYS_PER_RUN }, (_, i) => (
          <div key={i} className={`day ${i % 7 >= 5 ? "weekend" : ""}`}>
            <span className="night night-am" />
            <span className="night night-pm" />
            <span className="day-label">{i % 7 === 0 || i === 0 ? `${WEEKDAYS[i % 7]} ${i + 1}` : i + 1}</span>
          </div>
        ))}
        <div className="track-fill" style={{ width: `${(t / RUN_MINUTES) * 100}%` }} />
        <div className="track-head" style={{ left: `${(t / RUN_MINUTES) * 100}%` }} />
      </div>
      <div className="speeds" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s} className={s === speed ? "on" : ""} aria-pressed={s === speed} title={s === 100 ? "14 days in about a minute" : undefined} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </section>
  );
}
