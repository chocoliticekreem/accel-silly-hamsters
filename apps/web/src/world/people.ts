// Low-poly people for every crowd in the city: head, torso, arms and legs as six instanced meshes that share
// one transform per person. Limbs swing with a walk cycle. Six draw calls however many people there are.
// Colours per person: shirt (torso + arms), trousers (legs), skin (head), and an optional apron band (shop owners;
// only when created with `aprons: true`, which adds a seventh mesh).
import { BoxGeometry, Color, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, type BufferGeometry } from "three";

export const SKIN_TONES = ["#f1c9a5", "#e0ac69", "#c68642", "#8d5524", "#5c3a21", "#ffdbac", "#a86b3c"].map((c) => new Color(c));
export const TROUSERS = ["#2b2f3a", "#3a3f4b", "#1f2430", "#4a4036", "#36454f", "#5b6b7d", "#2e3b2e"].map((c) => new Color(c));

type Part = "torso" | "head" | "legL" | "legR" | "armL" | "armR" | "apron";

/** Local geometry (metres, a 1.75 m person); limbs pivot at hip / shoulder. */
function geometries(aprons: boolean): Partial<Record<Part, BufferGeometry>> {
  const leg = () => new BoxGeometry(0.17, 0.8, 0.2).translate(0, -0.4, 0);
  const arm = () => new BoxGeometry(0.11, 0.62, 0.13).translate(0, -0.31, 0);
  return {
    torso: new BoxGeometry(0.46, 0.64, 0.26).translate(0, 1.12, 0),
    head: new IcosahedronGeometry(0.17, 1).translate(0, 1.62, 0),
    legL: leg(),
    legR: leg(),
    armL: arm(),
    armR: arm(),
    // a band wrapped round the lower torso and hips, a touch proud of the torso so it reads from any side
    ...(aprons ? { apron: new BoxGeometry(0.5, 0.5, 0.3).translate(0, 0.98, 0) } : {}),
  };
}

const HIP_Y = 0.8;
const SHOULDER_Y = 1.42;

export interface People {
  group: Group;
  /** Writes person `i`. `phase` drives the walk cycle; `moving` = false stands still. `apron` null = none. */
  set(i: number, x: number, y: number, z: number, heading: number, phase: number, moving: boolean, scale: number, shirt: Color, trousers: Color, skin: Color, apron?: Color | null): void;
  /** Shows the first `n` people written this frame. */
  commit(n: number): void;
  /** The meshes by part (for picking: every part's instanceId is the person's index). */
  meshes: Partial<Record<Part, InstancedMesh>>;
  dispose(): void;
}

const base = new Matrix4();
const scaleM = new Matrix4();
const local = new Matrix4();
const rot = new Matrix4();
const out = new Matrix4();
const hidden = new Matrix4().makeScale(0, 0, 0);

export function createPeople(capacity: number, opts: { emissive?: number; aprons?: boolean } = {}): People {
  const geo = geometries(!!opts.aprons);
  const mat = new MeshStandardMaterial({ roughness: 0.65, emissive: "#ffffff", emissiveIntensity: opts.emissive ?? 0.04 });
  const meshes: Partial<Record<Part, InstancedMesh>> = {};
  (Object.keys(geo) as Part[]).forEach((p) => {
    const m = new InstancedMesh(geo[p]!, mat, capacity);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.setColorAt(0, new Color()); // allocate per-instance colour
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = p === "torso";
    m.name = p;
    meshes[p] = m;
  });
  const m = meshes as Record<Exclude<Part, "apron">, InstancedMesh> & { apron?: InstancedMesh };
  const group = new Group();
  group.name = "people";
  Object.values(meshes).forEach((x) => group.add(x));

  const limb = (mesh: InstancedMesh, i: number, ox: number, oy: number, angle: number, color: Color) => {
    local.makeTranslation(ox, oy, 0);
    rot.makeRotationX(angle);
    out.copy(base).multiply(local).multiply(rot);
    mesh.setMatrixAt(i, out);
    mesh.setColorAt(i, color);
  };

  return {
    group,
    meshes,
    set(i, x, y, z, heading, phase, moving, scale, shirt, trousers, skin, apron) {
      base.makeRotationY(heading).multiply(scaleM.makeScale(scale, scale, scale));
      base.setPosition(x, y, z);
      m.torso.setMatrixAt(i, base);
      m.torso.setColorAt(i, shirt);
      m.head.setMatrixAt(i, base);
      m.head.setColorAt(i, skin);
      const swing = moving ? Math.sin(phase) * 0.55 : 0;
      limb(m.legL, i, -0.11, HIP_Y, swing, trousers);
      limb(m.legR, i, 0.11, HIP_Y, -swing, trousers);
      limb(m.armL, i, -0.3, SHOULDER_Y, -swing * 0.8, shirt);
      limb(m.armR, i, 0.3, SHOULDER_Y, swing * 0.8, shirt);
      if (m.apron) {
        m.apron.setMatrixAt(i, apron ? base : hidden);
        if (apron) m.apron.setColorAt(i, apron);
      }
    },
    commit(n) {
      for (const mesh of Object.values(meshes)) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        // instances moved: let the next raycast recompute the bounds (three caches them)
        mesh.boundingSphere = null;
      }
    },
    dispose() {
      Object.values(geo).forEach((g) => g.dispose());
      mat.dispose();
      Object.values(meshes).forEach((x) => x.dispose());
    },
  };
}
