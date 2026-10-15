// Low-poly people for every crowd in the city: head, torso, arms and legs as six instanced meshes that share
// one transform per person. Limbs swing with a walk cycle. Six draw calls however many people there are.
// Colours per person: shirt (torso + arms), trousers (legs), skin (head).
import { BoxGeometry, Color, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, type BufferGeometry } from "three";

export const SKIN_TONES = ["#f1c9a5", "#e0ac69", "#c68642", "#8d5524", "#5c3a21", "#ffdbac", "#a86b3c"].map((c) => new Color(c));
export const TROUSERS = ["#2b2f3a", "#3a3f4b", "#1f2430", "#4a4036", "#36454f", "#5b6b7d", "#2e3b2e"].map((c) => new Color(c));

type Part = "torso" | "head" | "legL" | "legR" | "armL" | "armR";

/** Local geometry (metres, a 1.75 m person); limbs pivot at hip / shoulder. */
function geometries(): Record<Part, BufferGeometry> {
  const leg = () => new BoxGeometry(0.17, 0.8, 0.2).translate(0, -0.4, 0);
  const arm = () => new BoxGeometry(0.11, 0.62, 0.13).translate(0, -0.31, 0);
  return {
    torso: new BoxGeometry(0.46, 0.64, 0.26).translate(0, 1.12, 0),
    head: new IcosahedronGeometry(0.17, 1).translate(0, 1.62, 0),
    legL: leg(),
    legR: leg(),
    armL: arm(),
    armR: arm(),
  };
}

const HIP_Y = 0.8;
const SHOULDER_Y = 1.42;

export interface People {
  group: Group;
  /** Writes person `i`. `phase` drives the walk cycle; `moving` = false stands still. */
  set(i: number, x: number, y: number, z: number, heading: number, phase: number, moving: boolean, scale: number, shirt: Color, trousers: Color, skin: Color): void;
  /** Shows the first `n` people written this frame. */
  commit(n: number): void;
  dispose(): void;
}

const base = new Matrix4();
const scaleM = new Matrix4();
const local = new Matrix4();
const rot = new Matrix4();
const out = new Matrix4();

export function createPeople(capacity: number, opts: { emissive?: number } = {}): People {
  const geo = geometries();
  const mat = new MeshStandardMaterial({ roughness: 0.65, emissive: "#ffffff", emissiveIntensity: opts.emissive ?? 0.04 });
  const meshes = {} as Record<Part, InstancedMesh>;
  (Object.keys(geo) as Part[]).forEach((p) => {
    meshes[p] = (() => {
      const m = new InstancedMesh(geo[p], mat, capacity);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.setColorAt(0, new Color()); // allocate per-instance colour
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = p === "torso";
      return m;
    })();
  });
  const group = new Group();
  group.name = "people";
  Object.values(meshes).forEach((m) => group.add(m));

  const limb = (m: InstancedMesh, i: number, ox: number, oy: number, angle: number, color: Color) => {
    local.makeTranslation(ox, oy, 0);
    rot.makeRotationX(angle);
    out.copy(base).multiply(local).multiply(rot);
    m.setMatrixAt(i, out);
    m.setColorAt(i, color);
  };

  return {
    group,
    set(i, x, y, z, heading, phase, moving, scale, shirt, trousers, skin) {
      base.makeRotationY(heading).multiply(scaleM.makeScale(scale, scale, scale));
      base.setPosition(x, y, z);
      meshes.torso.setMatrixAt(i, base);
      meshes.torso.setColorAt(i, shirt);
      meshes.head.setMatrixAt(i, base);
      meshes.head.setColorAt(i, skin);
      const swing = moving ? Math.sin(phase) * 0.55 : 0;
      limb(meshes.legL, i, -0.11, HIP_Y, swing, trousers);
      limb(meshes.legR, i, 0.11, HIP_Y, -swing, trousers);
      limb(meshes.armL, i, -0.3, SHOULDER_Y, -swing * 0.8, shirt);
      limb(meshes.armR, i, 0.3, SHOULDER_Y, swing * 0.8, shirt);
    },
    commit(n) {
      for (const m of Object.values(meshes)) {
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      Object.values(geo).forEach((g) => g.dispose());
      mat.dispose();
      Object.values(meshes).forEach((m) => m.dispose());
    },
  };
}
