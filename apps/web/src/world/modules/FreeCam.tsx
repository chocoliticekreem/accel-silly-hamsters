// Module: FreeCam. A WASD fly camera, toggled with F or the Go-to bar's "Free cam" button (state/travel `freecam`;
// the F / Esc keys live in ui/GoToBar so compare mode's two canvases don't both toggle it).
// W/S forward/back and A/D strafe along the camera's horizontal heading, E up, Q down (Space stays play/pause),
// Shift goes fast, drag the mouse to look. Works inside landmark interiors too: the camera never drops below the
// ground, or below the selected floor's slab when it is over an open interior. While it is on, OrbitControls is
// disabled and the orbit rig ignores fly-tos; on exit (F or Esc) the orbit target is put in front of the camera so
// the view carries on unchanged.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Euler, Vector3 } from "three";
import { useTravel } from "../../state/travel";
import { useWorld } from "../context";
import { freeCamActive, interiorFloor } from "../flyTo";
import { groundY } from "../ground";

const SPEED = 28; // m/s
const FAST = 4;
const LOOK = 0.0032; // rad per pixel
const EYE = 1.6;
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);

export const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export default function FreeCam() {
  const { interactive } = useWorld();
  const on = useTravel((s) => s.freecam);
  return on && interactive ? <Fly /> : null;
}

function Fly() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean; target: Vector3; update: () => void } | null;
  const keys = useRef(new Set<string>());
  /** Keys released before any frame saw them (a quick tap still moves one step). */
  const tapped = useRef(new Set<string>());
  const seen = useRef(new Set<string>());
  const euler = useRef(new Euler(0, 0, 0, "YXZ"));

  useEffect(() => {
    freeCamActive.current = true;
    euler.current.setFromQuaternion(camera.quaternion, "YXZ");
    if (controls) controls.enabled = false;
    const down = keys.current;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey) return;
      if (!MOVE_KEYS.has(e.code)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!down.has(e.code)) seen.current.delete(e.code);
      down.add(e.code);
    };
    const onUp = (e: KeyboardEvent) => {
      if (down.has(e.code) && !seen.current.has(e.code)) tapped.current.add(e.code);
      down.delete(e.code);
    };
    const clear = () => down.clear();
    // drag to look
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0 || e.button === 2) drag = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const eu = euler.current;
      eu.y -= (e.clientX - drag.x) * LOOK;
      eu.x = Math.max(-1.5, Math.min(1.5, eu.x - (e.clientY - drag.y) * LOOK));
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUpPtr = () => (drag = null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", clear);
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUpPtr);
    el.style.cursor = "grab";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", clear);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUpPtr);
      el.style.cursor = "";
      down.clear();
      freeCamActive.current = false;
      if (controls) {
        // orbit around a point straight ahead (where the view meets the ground, or 40 m out)
        const dir = new Vector3();
        camera.getWorldDirection(dir);
        const toGround = dir.y < -0.05 ? (camera.position.y - groundY(camera.position.x, camera.position.z)) / -dir.y : 40;
        controls.target.copy(camera.position).addScaledVector(dir, Math.max(8, Math.min(400, toGround)));
        controls.enabled = true;
        controls.update();
      }
    };
  }, [camera, gl, controls]);

  const fwd = useRef(new Vector3());
  const right = useRef(new Vector3());
  useFrame((_, dt) => {
    const k = new Set([...keys.current, ...tapped.current]);
    tapped.current.clear();
    keys.current.forEach((c) => seen.current.add(c));
    // a tap is worth at least a tenth of a second of travel
    const d = Math.max(Math.min(dt, 0.1), k.size && !keys.current.size ? 0.1 : 0) * SPEED * (k.has("ShiftLeft") || k.has("ShiftRight") ? FAST : 1);
    const eu = euler.current;
    fwd.current.set(-Math.sin(eu.y), 0, -Math.cos(eu.y));
    right.current.set(Math.cos(eu.y), 0, -Math.sin(eu.y));
    const p = camera.position;
    if (k.has("KeyW")) p.addScaledVector(fwd.current, d);
    if (k.has("KeyS")) p.addScaledVector(fwd.current, -d);
    if (k.has("KeyD")) p.addScaledVector(right.current, d);
    if (k.has("KeyA")) p.addScaledVector(right.current, -d);
    if (k.has("KeyE")) p.y += d;
    if (k.has("KeyQ")) p.y -= d;
    // floor: the ground, or the selected slab when over an open interior
    let min = groundY(p.x, p.z) + EYE;
    const f = interiorFloor.current;
    if (f) {
      const dx = p.x - f.x;
      const dz = p.z - f.z;
      const c = Math.cos(f.rot);
      const s = Math.sin(f.rot);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) < f.hw && Math.abs(lz) < f.hd) min = f.y + EYE;
    }
    if (p.y < min) p.y = min;
    camera.quaternion.setFromEuler(eu);
  });
  return null;
}
