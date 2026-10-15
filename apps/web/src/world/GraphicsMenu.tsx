// "Graphics: High / Medium / Low" pill (bottom-right of the main view). Auto lets the frame rate step it down.
import { useEffect, useRef, useState } from "react";
import { QUALITIES, useQuality, type Quality } from "./quality";
import { requestedBackend, switchBackend, webgpuAvailable, type Backend } from "./renderer";

const LABEL: Record<Quality, string> = { high: "High", medium: "Medium", low: "Low" };

const pill: React.CSSProperties = {
  position: "absolute",
  right: 16,
  bottom: 16,
  zIndex: 5,
  fontSize: 12,
  color: "var(--text)",
  fontFamily: "var(--font)",
};
const box: React.CSSProperties = {
  background: "var(--glass)",
  border: "1px solid var(--line-strong)",
  borderRadius: 10,
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
};

export function GraphicsMenu() {
  const { level, auto, tiltShift, setLevel, setAuto, setTiltShift } = useQuality();
  const [open, setOpen] = useState(false);
  const backend: Backend = requestedBackend();
  const gpuOk = webgpuAvailable();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={ref} style={pill}>
      {open && (
        <div style={{ ...box, position: "absolute", right: 0, bottom: 36, padding: 6, minWidth: 168, display: "grid", gap: 2 }}>
          {QUALITIES.map((q) => (
            <button key={q} onClick={() => setLevel(q)} style={row(level === q && !auto)}>
              {LABEL[q]}
              {level === q && <span style={{ color: "var(--lamp)" }}>●</span>}
            </button>
          ))}
          <div style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
          <button onClick={() => setAuto(!auto)} style={row(auto)}>
            Auto (match frame rate) <span style={{ color: auto ? "var(--lamp)" : "var(--faint)" }}>{auto ? "on" : "off"}</span>
          </button>
          <button onClick={() => setTiltShift(!tiltShift)} style={row(tiltShift)} disabled={level === "low"}>
            Tilt-shift <span style={{ color: tiltShift && level !== "low" ? "var(--lamp)" : "var(--faint)" }}>{tiltShift && level !== "low" ? "on" : "off"}</span>
          </button>
          <div style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
          <div style={{ padding: "2px 8px", color: "var(--faint)", fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" }}>Renderer</div>
          <button onClick={() => backend !== "webgl" && switchBackend("webgl")} style={row(backend === "webgl")}>
            WebGL {backend === "webgl" && <span style={{ color: "var(--lamp)" }}>●</span>}
          </button>
          <button onClick={() => gpuOk && backend !== "webgpu" && switchBackend("webgpu")} style={{ ...row(backend === "webgpu"), opacity: gpuOk ? 1 : 0.45 }} disabled={!gpuOk} title={gpuOk ? "Metal via WebGPU" : "WebGPU isn't available in this browser"}>
            WebGPU {backend === "webgpu" && <span style={{ color: "var(--lamp)" }}>●</span>}
          </button>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} style={{ ...box, padding: "6px 10px", color: "var(--text)", cursor: "pointer", display: "flex", gap: 6, alignItems: "center" }} aria-label="Graphics quality">
        <span style={{ color: "var(--muted)" }}>Graphics</span>
        <b style={{ fontWeight: 600 }}>{LABEL[level]}</b>
        {auto && <span style={{ color: "var(--faint)", fontSize: 10 }}>AUTO</span>}
      </button>
    </div>
  );
}

function row(on: boolean): React.CSSProperties {
  return {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    padding: "6px 8px",
    borderRadius: 6,
    border: 0,
    background: on ? "var(--lamp-soft)" : "transparent",
    color: "var(--text)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 12,
  };
}
