// Module: Businesses. Every real shop, café, pub and restaurant the sim doesn't model (state/businesses, baked from
// OSM) gets a small sign on its facade: a fascia plate in its type colour plus a projecting blade sign, two
// InstancedMeshes for the lot (~1,400). An invisible, slightly larger hit box per sign makes them easy to pick.
// Hover shows the name; the few nearest the camera are labelled when you're down at street level. Click opens
// ui/BusinessCard. Sim stores win: a click that also hits a sim store (or a person) is left for them.
// The "Businesses" chip (state/businesses `show`) hides the lot.
import { Html } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdditiveBlending, BoxGeometry, Color, InstancedMesh, MeshBasicMaterial, Object3D, Vector3, type Object3D as O3 } from "three";
import { toScene } from "../../sim/geometry";
import { isPoi, useBusinesses, useBusinessList, type Business } from "../../state/businesses";
import { TypeIcon } from "../../ui/TypeIcon";
import { useWorld } from "../context";
import { LAMP, STORE_COLORS } from "../palette";

const SIGN_Y = 3.4;
const NEAR_LABELS = 6;
const NEAR_DIST = 70;

/** Scene placement: position on the wall and yaw so local +z faces the street. */
function place(b: Business) {
  const [x, z] = toScene(b.x, b.z);
  const a = b.angle ?? 0;
  // contract normal (cos a, sin a) → scene (cos a, −sin a)
  const nx = Math.cos(a);
  const nz = -Math.sin(a);
  return { x, z, nx, nz, rot: Math.atan2(nx, nz) };
}

/** Did this pointer event also hit a sim store or a person? Then it's theirs. */
function claimedElsewhere(e: ThreeEvent<PointerEvent | MouseEvent>, self: O3) {
  for (const i of e.intersections) {
    if (i.object === self) continue;
    for (let o: O3 | null = i.object; o; o = o.parent) if (o.name.startsWith("store-") || o.name === "agents") return true;
  }
  return false;
}

export default function Businesses() {
  const { map, interactive } = useWorld();
  const show = useBusinesses((s) => s.show);
  const all = useBusinessList(map).list;
  const pois = useMemo(() => all.filter(isPoi), [all]);
  if (!show || !pois.length) return <SelectedBeacon />;
  return (
    <group name="businesses">
      <Signs pois={pois} interactive={interactive} />
      <Labels pois={pois} />
      <SelectedBeacon />
    </group>
  );
}

function Signs({ pois, interactive }: { pois: Business[]; interactive: boolean }) {
  const plate = useRef<InstancedMesh>(null);
  const blade = useRef<InstancedMesh>(null);
  const hit = useRef<InstancedMesh>(null);
  const geo = useMemo(() => ({ plate: new BoxGeometry(1.9, 0.5, 0.08), blade: new BoxGeometry(0.06, 0.62, 0.62), hit: new BoxGeometry(3.2, 3.2, 2.4) }), []);
  const mats = useMemo(
    () => ({
      plate: new MeshBasicMaterial({ toneMapped: false }),
      blade: new MeshBasicMaterial({ toneMapped: false }),
      hit: new MeshBasicMaterial({ visible: false }),
    }),
    [],
  );
  useEffect(() => () => {
    Object.values(geo).forEach((g) => g.dispose());
    Object.values(mats).forEach((m) => m.dispose());
  }, [geo, mats]);

  useEffect(() => {
    const o = new Object3D();
    const c = new Color();
    const edge = new Color("#f3ead8");
    pois.forEach((b, i) => {
      const p = place(b);
      o.rotation.set(0, p.rot, 0);
      o.position.set(p.x + p.nx * 0.1, SIGN_Y, p.z + p.nz * 0.1);
      o.updateMatrix();
      plate.current?.setMatrixAt(i, o.matrix);
      // muted type colour: tasteful by day, still readable at night (unlit)
      c.set(STORE_COLORS[b.cat].awning).lerp(edge, 0.12).multiplyScalar(0.85);
      plate.current?.setColorAt(i, c);
      o.position.set(p.x + p.nx * 0.5, SIGN_Y - 0.6, p.z + p.nz * 0.5);
      o.updateMatrix();
      blade.current?.setMatrixAt(i, o.matrix);
      blade.current?.setColorAt(i, c.lerp(edge, 0.35));
      o.position.set(p.x + p.nx * 1.0, SIGN_Y - 0.6, p.z + p.nz * 1.0);
      o.updateMatrix();
      hit.current?.setMatrixAt(i, o.matrix);
    });
    for (const m of [plate.current, blade.current, hit.current]) {
      if (!m) continue;
      m.count = pois.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [pois]);

  const idAt = (e: ThreeEvent<PointerEvent | MouseEvent>) => (e.instanceId !== undefined ? pois[e.instanceId]?.id ?? null : null);
  const move = (e: ThreeEvent<PointerEvent>) => {
    if (!interactive || claimedElsewhere(e, hit.current!)) return;
    e.stopPropagation();
    const id = idAt(e);
    if (useBusinesses.getState().hovered !== id) useBusinesses.getState().hover(id);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    if (!interactive) return;
    if (useBusinesses.getState().hovered) useBusinesses.getState().hover(null);
    document.body.style.cursor = "";
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!interactive || claimedElsewhere(e, hit.current!)) return;
    e.stopPropagation();
    const id = idAt(e);
    if (id) useBusinesses.getState().select(id);
  };

  const n = pois.length;
  return (
    <>
      <instancedMesh ref={plate} args={[geo.plate, mats.plate, n]} frustumCulled={false} />
      <instancedMesh ref={blade} args={[geo.blade, mats.blade, n]} frustumCulled={false} />
      <instancedMesh ref={hit} args={[geo.hit, mats.hit, n]} onPointerMove={move} onPointerOut={out} onClick={click} />
    </>
  );
}

/** Names over the hovered sign, the selected one, and the few nearest the camera when it's close to the street. */
function Labels({ pois }: { pois: Business[] }) {
  const hovered = useBusinesses((s) => s.hovered);
  const selected = useBusinesses((s) => s.selected);
  const [near, setNear] = useState<string[]>([]);
  const last = useRef(0);
  const ndc = useMemo(() => new Vector3(), []);
  useFrame(({ camera, clock }) => {
    if (clock.elapsedTime - last.current < 0.3) return;
    last.current = clock.elapsedTime;
    const cx = camera.position.x;
    const cz = -camera.position.z;
    if (camera.position.y > 90) {
      if (near.length) setNear([]);
      return;
    }
    const d2 = NEAR_DIST * NEAR_DIST;
    const found: [number, string][] = [];
    for (const b of pois) {
      const dx = b.x - cx;
      const dz = b.z - cz;
      const d = dx * dx + dz * dz + (camera.position.y - SIGN_Y) ** 2;
      if (d >= d2) continue;
      // only signs on screen
      ndc.set(b.x, SIGN_Y, -b.z).project(camera);
      if (ndc.z < 1 && Math.abs(ndc.x) < 0.95 && Math.abs(ndc.y) < 0.95) found.push([d, b.id]);
    }
    found.sort((a, b) => a[0] - b[0]);
    const ids = found.slice(0, NEAR_LABELS).map((f) => f[1]);
    if (ids.join() !== near.join()) setNear(ids);
  });
  const ids = [...new Set([hovered, selected, ...near].filter((x): x is string => !!x))];
  const byId = useMemo(() => new Map(pois.map((b) => [b.id, b])), [pois]);
  return (
    <>
      {ids.map((id) => {
        const b = byId.get(id);
        if (!b) return null;
        const p = place(b);
        const strong = id === hovered || id === selected;
        return (
          <Html key={id} position={[p.x + p.nx * 0.6, SIGN_Y + 1.6, p.z + p.nz * 0.6]} center zIndexRange={[9, 0]} style={{ pointerEvents: "none" }}>
            <div className={`map-label biz-label ${strong ? "" : "biz-label-near"}`}>
              <TypeIcon type={b.cat} size={13} />
              {b.name}
            </div>
          </Html>
        );
      })}
    </>
  );
}

/** A soft lamp-coloured beam over the selected business (POI or landmark), so it's findable from above. */
function SelectedBeacon() {
  const { map } = useWorld();
  const selected = useBusinesses((s) => s.selected);
  const b = useBusinessList(map).byId.get(selected ?? "");
  if (!b) return null;
  const p = place(b);
  const out = b.angle === null ? 0 : 1.5;
  return (
    <mesh position={[p.x + p.nx * out, 30, p.z + p.nz * out]} renderOrder={3}>
      <cylinderGeometry args={[0.4, 1.2, 60, 12, 1, true]} />
      <meshBasicMaterial color={LAMP} transparent opacity={0.3} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
