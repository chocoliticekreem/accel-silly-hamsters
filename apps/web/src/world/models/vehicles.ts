// Hero vehicles for London: New Routemaster bus, TX black cab, Met police car, LAS ambulance, Overground
// Class 378 carriage, delivery van and flatbed lorry. Pure geometry builders (no textures except a few canvas
// signs): bevelled bodies in "paint", glass ribbons, glowing head/tail lamps, battenberg liveries as geometry
// (so they instance), and animatable nodes: wheels (`wheelFL`, `wheelFR`, `wheelRL`, …, spin about local x),
// police/ambulance beacons (`lampL`, `lampR`, … flash them) and train doors (`doorL0a` …, slide along z).
// Frame: front +z, left (UK nearside / kerb) +x, ground y = 0, real-world size in metres.
import { Kit, type HeroModel, type V3 } from "./kit";
import { label } from "./materials";

const TYRE = "#17181b";
const HUB = "#9aa1a9";
const DARK = "#1c1d21";
const GLASS = "#1d2a36";
const CHROME = "#c9ced4";
const HEAD = "#fff4d6";
const TAIL = "#ff2a1a";
const AMBER = "#ffa31a";

/** A wheel as a node: tyre, rim, hub cap. Spin it about local x. */
function wheel(k: Kit, name: string, x: number, z: number, r: number, w: number, rim = HUB) {
  k.node(name, [x, r, z], (n) => {
    n.cylX("solid", r, w, 18, [0, 0, 0], TYRE);
    n.cylX("solid", r * 0.78, w + 0.01, 18, [0, 0, 0], "#2a2b2f");
    n.cylX("metal", r * 0.55, w + 0.03, 12, [0, 0, 0], rim);
    n.cylX("metal", r * 0.18, w + 0.06, 8, [0, 0, 0], CHROME);
    // spokes so a spinning wheel reads as spinning
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      n.box("metal", w + 0.04, r * 0.08, r * 0.5, 0, Math.sin(a) * r * 0.3, Math.cos(a) * r * 0.3, rim, [a, 0, 0]);
    }
  });
}

/** Dark wheel-arch disc on the body side so the wheel reads as sitting in an opening. */
function arch(k: Kit, x: number, z: number, r: number, y = r) {
  k.cylX("solid", r * 1.22, 0.02, 20, [x, y, z], "#0d0d0f");
}

/** Glass plane leaning back from (zb, yb) at the bottom to (zt, yt) at the top. */
function raked(k: Kit, slot: "glass" | "paint" | "solid", w: number, zb: number, yb: number, zt: number, yt: number, color: string, t = 0.05) {
  const len = Math.hypot(zt - zb, yt - yb);
  const a = Math.atan2(zt - zb, yt - yb); // lean of the plane from vertical, +z top
  k.box(slot, w, len, t, 0, (yb + yt) / 2, (zb + zt) / 2, color, [a, 0, 0]);
}

/** Two-row battenberg chequer on both sides, from z0 to z1, rows starting at y0. */
function battenberg(k: Kit, halfW: number, z0: number, z1: number, y0: number, rowH: number, cols: number, c1: string, c2: string, rows = 2) {
  const cw = (z1 - z0) / cols;
  k.mirrorX(() => {
    for (let r = 0; r < rows; r++)
      for (let i = 0; i < cols; i++) {
        const col = (i + r) % 2 === 0 ? c1 : c2;
        k.box("paint", 0.02, rowH, cw, halfW + 0.012, y0 + rowH * (r + 0.5), z0 + cw * (i + 0.5), col);
      }
  });
}

function lamps(k: Kit, halfW: number, front: number, back: number, y: number, inset = 0.12, size: V3 = [0.32, 0.16, 0.05]) {
  k.mirrorX(() => {
    k.rbox("glow", size[0], size[1], size[2], halfW - size[0] / 2 - inset, y, front, HEAD, 0.03);
    k.rbox("glow", size[0], size[1], size[2], halfW - size[0] / 2 - inset, y, back, TAIL, 0.03);
    k.box("glow", 0.05, 0.08, 0.14, halfW + 0.005, y, front - 0.25, AMBER); // side repeater
  });
}

function mirrors(k: Kit, halfW: number, y: number, z: number, color: string, arm = 0.18) {
  k.mirrorX(() => {
    k.box("solid", arm, 0.04, 0.04, halfW + arm / 2, y, z, DARK);
    k.rbox("paint", 0.08, 0.2, 0.14, halfW + arm, y + 0.02, z, color, 0.03);
  });
}

// ---------------------------------------------------------------------------------------------------------

/** New Routemaster (NB4L): 11.2 m, two decks, swooping stair glazing, three doors on the nearside. */
export function routemaster(): HeroModel {
  const k = new Kit();
  const W = 2.52, hw = W / 2, L = 11.2, hl = L / 2;
  const RED = "#c8102e";
  // body + skirt + roof
  k.rbox("solid", W - 0.04, 0.5, L - 0.2, 0, 0.55, 0, "#151517", 0.12);
  k.rbox("paint", W, 3.78, L, 0, 0.62 + 1.89, 0, RED, 0.28, 3);
  k.rbox("paint", W - 0.16, 0.12, L - 0.6, 0, 4.42, -0.1, "#b00d27", 0.05);
  // deck band between the glazing (slightly proud, darker red)
  k.mirrorX(() => k.box("paint", 0.02, 0.28, L - 0.8, hw + 0.004, 2.62, -0.1, "#a90c25"));

  // side glazing: lower deck and upper deck ribbons
  const pane = (x: number, y0: number, y1: number, z0: number, z1: number) => k.slab("glass", x, x + 0.03, y0, y1, z0, z1, GLASS);
  for (const s of [1, -1]) {
    const x = s > 0 ? hw - 0.01 : -hw - 0.02;
    pane(x, 2.95, 4.0, -5.0, 4.75); // upper deck
    if (s > 0) {
      pane(x, 1.4, 2.35, 0.75, 3.55);
      pane(x, 1.4, 2.35, -3.15, -0.75);
    } else pane(x, 1.4, 2.35, -4.7, 3.95);
    // window pillars
    for (let z = -4.6; z < 4.7; z += 1.32) k.box("paint", 0.05, 1.05, 0.11, s * (hw + 0.012), 3.47, z, RED);
    for (let z = -4.3; z < 3.6; z += 1.32) if (s < 0 || Math.abs(z) > 0.85) k.box("paint", 0.05, 0.95, 0.11, s * (hw + 0.012), 1.87, z, RED);
  }
  // the signature diagonal stair glazing: nearside front, offside rear
  const stair = (x: number, z: number) => {
    const a = Math.atan2(1.85, 2.7);
    k.box("glass", 0.035, 0.7, 3.3, x, 2.68, z, GLASS, [a, 0, 0]);
  };
  stair(hw + 0.006, 3.65);
  stair(-hw - 0.006, -3.75);

  // nearside doors: front, middle, rear (glass leaves with steel frames)
  for (const [z, w] of [[4.55, 1.05], [0, 1.2], [-3.95, 1.1]] as const) {
    k.slab("glass", hw - 0.005, hw + 0.03, 0.42, 2.45, z - w / 2, z + w / 2, "#22303d");
    k.box("metal", 0.04, 2.0, 0.05, hw + 0.03, 1.43, z, "#3a3e44");
    k.box("solid", 0.05, 0.06, w + 0.08, hw + 0.03, 2.47, z, "#111214");
    k.box("solid", 0.05, 0.06, w + 0.08, hw + 0.03, 0.42, z, "#111214");
  }

  // front: big wrap windscreen, upper front window, destination blind, lamps, mirrors
  k.rbox("glass", W - 0.22, 1.5, 0.12, 0, 1.72, hl - 0.02, GLASS, 0.08);
  k.rbox("glass", W - 0.3, 1.0, 0.12, 0, 3.5, hl - 0.04, GLASS, 0.1);
  k.box("solid", W - 0.5, 0.36, 0.06, 0, 2.7, hl + 0.02, "#0b0b0c");
  k.sign("rm-blind", W - 0.56, 0.3, [0, 2.7, hl + 0.055], [512, 64], (c, w, h) => {
    c.fillStyle = "#050505";
    c.fillRect(0, 0, w, h);
    label(c, "38", 46, h / 2 + 2, 80, 52, "#ffcc33");
    label(c, "Victoria", w / 2 + 40, h / 2 + 2, w - 130, 44, "#ffcc33");
  });
  k.mirrorX(() => {
    k.rbox("glow", 0.34, 0.16, 0.06, hw - 0.36, 0.86, hl + 0.01, HEAD, 0.04);
    k.rbox("glow", 0.16, 0.1, 0.06, hw - 0.16, 1.06, hl + 0.01, AMBER, 0.03);
    k.rbox("glow", 0.12, 0.32, 0.06, hw - 0.16, 1.1, -hl - 0.01, TAIL, 0.03);
    k.rbox("glow", 0.12, 0.32, 0.06, hw - 0.16, 3.9, -hl - 0.01, TAIL, 0.03);
    // mirrors on stalks, swept forward
    k.bar("metal", [hw - 0.05, 2.3, hl - 0.2], [hw + 0.2, 2.45, hl + 0.35], 0.04, "#2a2c30");
    k.rbox("solid", 0.1, 0.42, 0.16, hw + 0.22, 2.25, hl + 0.36, DARK, 0.04);
  });
  k.box("solid", W - 0.1, 0.32, 0.12, 0, 0.52, hl + 0.02, "#151517"); // bumper
  k.box("solid", W - 0.1, 0.32, 0.12, 0, 0.52, -hl - 0.02, "#151517");
  // rear upper window
  k.rbox("glass", W - 0.6, 0.6, 0.08, 0, 3.55, -hl - 0.01, GLASS, 0.08);
  // roundel on both sides (between decks, front)
  for (const s of [1, -1])
    k.sign("rm-roundel", 0.62, 0.42, [s * (hw + 0.02), 2.62, 1.5], [128, 96], (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.strokeStyle = "#ffffff";
      c.lineWidth = 11;
      c.beginPath();
      c.arc(w / 2, h / 2, 32, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#ffffff";
      c.fillRect(14, h / 2 - 9, w - 28, 18);
    }, false, [0, (s * Math.PI) / 2, 0]);

  // wheels: front axle, rear axle (twin)
  for (const [n, z] of [["F", 3.55], ["R", -2.35]] as const) {
    arch(k, hw + 0.006, z, 0.5, 0.5);
    arch(k, -hw - 0.006, z, 0.5, 0.5);
    wheel(k, `wheel${n}L`, hw - 0.12, z, 0.5, 0.32);
    wheel(k, `wheel${n}R`, -hw + 0.12, z, 0.5, 0.32);
  }
  return k.model("routemaster", { ao: 1.6 });
}

/** LEVC TX black cab: tall glasshouse, round lamps, oval grille, amber TAXI sign. */
export function blackCab(paint = "#0e0f11"): HeroModel {
  const k = new Kit();
  const W = 1.94, hw = W / 2, L = 4.85, hl = L / 2;
  k.rbox("paint", W, 0.82, L, 0, 0.71, 0, paint, 0.2, 3);
  // bonnet hump + wheel arch flares
  k.rbox("paint", W - 0.1, 0.16, 1.25, 0, 1.12, 1.75, paint, 0.08);
  k.mirrorX(() => {
    for (const z of [1.5, -1.45]) k.rbox("paint", 0.12, 0.42, 1.0, hw - 0.03, 0.7, z, paint, 0.06);
  });
  // glasshouse, roof, pillars
  k.rbox("glass", W - 0.12, 0.7, 2.9, 0, 1.47, -0.42, GLASS, 0.12);
  raked(k, "glass", W - 0.16, 1.62, 1.12, 1.02, 1.8, GLASS, 0.08);
  k.rbox("paint", W - 0.08, 0.11, 2.95, 0, 1.86, -0.42, paint, 0.05);
  for (const z of [0.2, -0.95, -1.82]) k.box("paint", W - 0.1, 0.68, 0.11, 0, 1.47, z, paint);
  raked(k, "paint", W - 0.08, 1.66, 1.12, 1.05, 1.82, paint, 0.03); // A-pillar strip edges come from body
  k.box("glass", W - 0.16, 0.6, 0.06, 0, 1.45, -1.9, GLASS);
  // face: oval chrome grille with slats, round lamps with chrome bezels
  k.rbox("metal", 0.82, 0.34, 0.08, 0, 0.74, hl + 0.01, CHROME, 0.15);
  for (let i = 0; i < 4; i++) k.box("solid", 0.72, 0.03, 0.03, 0, 0.64 + i * 0.065, hl + 0.05, "#0a0a0a");
  k.mirrorX(() => {
    k.cylZ("glow", 0.13, 0.06, 16, [0.7, 0.84, hl], HEAD);
    k.torus("metal", 0.14, 0.022, 6, 18, [0.7, 0.84, hl + 0.02], CHROME);
    k.rbox("glow", 0.1, 0.32, 0.05, hw - 0.1, 0.95, -hl, TAIL, 0.03);
    k.box("glow", 0.12, 0.05, 0.04, 0.55, 0.62, hl + 0.02, AMBER);
    k.box("metal", 0.03, 0.03, 0.16, hw + 0.01, 1.05, 0.1, CHROME); // door handles
    k.box("metal", 0.03, 0.03, 0.16, hw + 0.01, 1.05, -1.1, CHROME);
  });
  mirrors(k, hw, 1.2, 1.05, paint);
  k.rbox("solid", W + 0.02, 0.24, 0.16, 0, 0.42, hl - 0.03, DARK, 0.06);
  k.rbox("solid", W + 0.02, 0.24, 0.16, 0, 0.42, -hl + 0.03, DARK, 0.06);
  // TAXI sign
  k.rbox("glow", 0.56, 0.17, 0.2, 0, 2.0, 0.75, AMBER, 0.05);
  k.sign("taxi", 0.5, 0.13, [0, 2.0, 0.856], [128, 32], (c, w, h) => {
    c.fillStyle = "#ffb000";
    c.fillRect(0, 0, w, h);
    label(c, "TAXI", w / 2, h / 2 + 1, w - 10, 28, "#1a1205");
  });
  for (const [n, z] of [["F", 1.5], ["R", -1.45]] as const) {
    arch(k, hw + 0.006, z, 0.36);
    arch(k, -hw - 0.006, z, 0.36);
    wheel(k, `wheel${n}L`, hw - 0.12, z, 0.36, 0.24);
    wheel(k, `wheel${n}R`, -hw + 0.12, z, 0.36, 0.24);
  }
  return k.model("black-cab", { ao: 1.0 });
}

/** Saloon/estate base shared by the police car: low body, glasshouse, roof. */
function estateBody(k: Kit, paint: string, W: number, L: number) {
  const hw = W / 2, hl = L / 2;
  k.rbox("paint", W, 0.68, L, 0, 0.66, 0, paint, 0.18, 3);
  k.rbox("paint", W - 0.06, 0.14, 1.3, 0, 0.98, 1.6, paint, 0.07); // bonnet
  k.rbox("glass", W - 0.16, 0.5, 2.55, 0, 1.24, -0.45, GLASS, 0.1);
  raked(k, "glass", W - 0.2, 1.42, 0.98, 0.82, 1.47, GLASS, 0.06);
  k.rbox("paint", W - 0.12, 0.07, 2.55, 0, 1.5, -0.45, paint, 0.03);
  for (const z of [0.82, -0.25, -1.68]) k.box("paint", W - 0.14, 0.48, 0.09, 0, 1.24, z, paint);
  k.rbox("solid", W + 0.02, 0.2, 0.14, 0, 0.4, hl - 0.02, DARK, 0.05);
  k.rbox("solid", W + 0.02, 0.2, 0.14, 0, 0.4, -hl + 0.02, DARK, 0.05);
  k.box("solid", 0.9, 0.16, 0.04, 0, 0.66, hl + 0.01, "#101215"); // grille
  // roof rails
  k.mirrorX(() => k.box("metal", 0.04, 0.05, 2.3, hw - 0.18, 1.56, -0.5, "#2b2d31"));
  lamps(k, hw, hl + 0.005, -hl - 0.005, 0.8);
  mirrors(k, hw, 1.06, 0.85, paint);
  for (const [n, z] of [["F", 1.45], ["R", -1.4]] as const) {
    arch(k, hw + 0.006, z, 0.34);
    arch(k, -hw - 0.006, z, 0.34);
    wheel(k, `wheel${n}L`, hw - 0.12, z, 0.34, 0.24, "#7d848c");
    wheel(k, `wheel${n}R`, -hw + 0.12, z, 0.34, 0.24, "#7d848c");
  }
}

/** Met Police estate: white, blue/yellow battenberg, roof light bar with two flashing beacons. */
export function policeCar(): HeroModel {
  const k = new Kit();
  const W = 1.84, L = 4.72, hw = W / 2;
  estateBody(k, "#f5f6f4", W, L);
  battenberg(k, hw, -2.05, 2.05, 0.42, 0.25, 12, "#1b3c9a", "#e9f01d");
  // hi-vis chevrons on the tailgate
  for (let i = 0; i < 6; i++) k.box("paint", 0.2, 0.32, 0.02, -0.55 + i * 0.22, 0.8, -L / 2 - 0.01, i % 2 ? "#e02020" : "#e9f01d", [0, 0, 0.6]);
  k.sign("police-bonnet", 1.1, 0.26, [0, 1.06, 1.85], [256, 64], (c, w, h) => {
    c.clearRect(0, 0, w, h);
    label(c, "POLICE", w / 2, h / 2, w - 8, 52, "#1b3c9a");
  }, false, [-Math.PI / 2 + 0.08, 0, 0]);
  for (const s of [1, -1])
    k.sign("police-side", 1.0, 0.18, [s * (hw + 0.03), 1.1, 0.25], [256, 48], (c, w, h) => {
      c.clearRect(0, 0, w, h);
      label(c, "POLICE", w / 2, h / 2, w - 8, 40, "#1b3c9a");
    }, false, [0, (s * Math.PI) / 2, 0]);
  // light bar: dark base + two blue beacons as nodes + white takedown lamps
  k.rbox("solid", 1.3, 0.08, 0.32, 0, 1.59, -0.15, "#24262a", 0.03);
  k.box("glow", 0.16, 0.06, 0.04, 0, 1.64, 0.02, "#ffffff");
  for (const [n, x] of [["lampL", 0.34], ["lampR", -0.34]] as const)
    k.node(n, [x, 1.69, -0.15], (m) => {
      m.rbox("glow", 0.5, 0.12, 0.28, 0, 0, 0, "#1f5bff", 0.05);
      m.rbox("glow", 0.12, 0.08, 0.04, 0, 0, 0.14, "#9fc0ff", 0.02);
    });
  // grille lamps (blue) in the front bumper
  k.mirrorX(() => k.box("glow", 0.12, 0.06, 0.03, 0.35, 0.5, L / 2 + 0.03, "#2a62ff"));
  return k.model("police-car", { ao: 1.0 });
}

/** London Ambulance Service Sprinter: hi-vis yellow box, green/yellow battenberg, four beacons. */
export function ambulance(): HeroModel {
  const k = new Kit();
  const W = 2.3, hw = W / 2, L = 6.9, hl = L / 2;
  const YEL = "#f2e21a", GRN = "#00843d";
  // cab + bonnet
  k.rbox("paint", 2.02, 0.78, 1.15, 0, 0.82, hl - 0.6, YEL, 0.18, 3);
  k.rbox("paint", 2.06, 1.7, 1.4, 0, 1.25, hl - 1.6, YEL, 0.16, 3);
  raked(k, "glass", 1.84, hl - 1.02, 1.25, hl - 1.62, 2.02, GLASS, 0.08);
  k.mirrorX(() => k.slab("glass", 1.02, 1.045, 1.3, 1.92, hl - 2.2, hl - 1.15, GLASS));
  k.rbox("solid", 1.7, 0.2, 0.08, 0, 0.72, hl, DARK, 0.04); // grille
  k.rbox("solid", 2.1, 0.24, 0.16, 0, 0.42, hl - 0.03, DARK, 0.06);
  k.mirrorX(() => {
    k.rbox("glow", 0.3, 0.14, 0.05, 0.75, 0.95, hl - 0.01, HEAD, 0.03);
    k.box("glow", 0.1, 0.08, 0.04, 0.85, 0.55, hl + 0.06, "#2a62ff");
  });
  mirrors(k, 1.03, 1.85, hl - 1.1, YEL, 0.28);
  // box body
  const bz0 = -hl, bz1 = hl - 2.25;
  k.rbox("paint", W, 2.5, bz1 - bz0, 0, 0.45 + 1.25, (bz0 + bz1) / 2, YEL, 0.1, 2);
  battenberg(k, hw, bz0 + 0.1, bz1 - 0.05, 0.5, 0.42, 8, GRN, YEL);
  battenberg(k, 1.03, hl - 2.25, hl - 1.0, 0.5, 0.3, 3, GRN, YEL, 1);
  k.mirrorX(() => {
    k.box("paint", 0.02, 0.12, bz1 - bz0 - 0.2, hw + 0.012, 1.42, (bz0 + bz1) / 2, GRN);
    k.slab("glass", hw - 0.005, hw + 0.02, 1.7, 2.35, bz1 - 1.3, bz1 - 0.35, "#203040");
    k.rbox("glow", 0.12, 0.4, 0.05, hw - 0.12, 1.1, -hl - 0.01, TAIL, 0.03);
  });
  for (const s of [1, -1])
    k.sign("amb-side", 2.6, 0.42, [s * (hw + 0.03), 2.15, -0.9], [512, 96], (c, w, h) => {
      c.clearRect(0, 0, w, h);
      label(c, "AMBULANCE", w / 2, h / 2 + 2, w - 12, 76, "#0b5a2a");
    }, false, [0, (s * Math.PI) / 2, 0]);
  // rear doors with windows and chevrons
  k.box("solid", 0.02, 2.2, 0.02, 0, 1.6, -hl - 0.02, "#333");
  k.mirrorX(() => k.slab("glass", 0.15, 0.85, 2.0, 2.55, -hl - 0.03, -hl - 0.01, "#203040"));
  for (let i = 0; i < 7; i++) k.box("paint", 0.22, 0.6, 0.02, -0.9 + i * 0.3, 1.0, -hl - 0.025, i % 2 ? "#e02020" : YEL, [0, 0, 0.6]);
  // beacons: cab light bar + rear box corners
  k.rbox("solid", 1.5, 0.08, 0.3, 0, 2.14, hl - 1.6, "#24262a", 0.03);
  for (const [n, p] of [
    ["lampL", [0.42, 2.24, hl - 1.6]],
    ["lampR", [-0.42, 2.24, hl - 1.6]],
    ["lampRearL", [hw - 0.12, 3.02, -hl + 0.15]],
    ["lampRearR", [-hw + 0.12, 3.02, -hl + 0.15]],
  ] as const)
    k.node(n, p, (m) => m.rbox("glow", n.startsWith("lampRear") ? 0.2 : 0.55, 0.13, 0.24, 0, 0, 0, "#1f5bff", 0.05));
  for (const [n, z] of [["F", hl - 0.75], ["R", -hl + 1.25]] as const) {
    for (const s of [1, -1]) arch(k, s * (hw + 0.006), z, 0.4);
    wheel(k, `wheel${n}L`, hw - 0.15, z, 0.4, 0.26);
    wheel(k, `wheel${n}R`, -hw + 0.15, z, 0.4, 0.26);
  }
  return k.model("ambulance", { ao: 1.4 });
}

/**
 * London Overground Class 378 carriage (20.3 m): white body, Overground orange doors, blue skirt, black
 * window band. `cab` adds the yellow-fronted driving end at +z; otherwise both ends are gangways.
 * Door leaves are nodes `door{L|R}{0..2}{a|b}` (a = toward +z): slide ±0.8 m along z to open.
 */
export function overgroundCar(opts: { cab?: boolean } = {}): HeroModel {
  const cab = opts.cab ?? true;
  const k = new Kit();
  const W = 2.8, hw = W / 2, L = 20.3, hl = L / 2;
  const WHITE = "#f1f2f0", ORANGE = "#ee7623", BLUE = "#203a8f";
  k.rbox("paint", W, 2.95, L, 0, 0.78 + 1.475, 0, WHITE, 0.32, 3);
  k.rbox("solid", W - 0.3, 0.25, L - 0.4, 0, 3.78, 0, "#a7abb0", 0.1);
  // roof kit: ac pods
  for (const z of [-5, 5]) k.rbox("solid", 1.6, 0.3, 2.6, 0, 3.95, z, "#8f9398", 0.1);
  k.mirrorX(() => {
    k.box("paint", 0.02, 0.38, L - 0.8, hw + 0.006, 1.0, 0, BLUE);
    k.slab("glass", hw - 0.01, hw + 0.02, 1.78, 2.82, -hl + 0.8, hl - (cab ? 2.4 : 0.8), "#151c24");
    for (let z = -hl + 1.6; z < hl - 1.6; z += 1.7) k.box("paint", 0.04, 1.06, 0.18, hw + 0.012, 2.3, z, WHITE);
  });
  // doorways: black surround + two orange leaves each with a window
  const doorZ = [-6.2, 0, 6.2];
  for (const [s, side] of [[1, "L"], [-1, "R"]] as const)
    doorZ.forEach((z, i) => {
      k.slab("solid", s > 0 ? hw - 0.01 : -hw - 0.02, s > 0 ? hw + 0.02 : -hw + 0.01, 0.9, 3.2, z - 0.86, z + 0.86, "#111316");
      for (const [leaf, dz] of [["a", 0.4], ["b", -0.4]] as const)
        k.node(`door${side}${i}${leaf}`, [s * (hw + 0.035), 2.05, z + dz], (m) => {
          m.box("paint", 0.04, 2.2, 0.78, 0, 0, 0, ORANGE);
          m.box("glass", 0.05, 0.95, 0.5, 0, 0.35, 0, "#18202a");
          m.box("solid", 0.05, 2.2, 0.03, 0, 0, -dz * 0.97, "#202226");
        });
      k.box("glow", 0.04, 0.06, 0.2, s * (hw + 0.02), 3.3, z, "#ffb000"); // door indicator lamp
    });
  // bogies
  for (const z of [-hl + 3.2, hl - 3.2]) {
    k.rbox("solid", 2.3, 0.55, 3.0, 0, 0.55, z, "#2a2c30", 0.08);
    for (const dz of [-1.05, 1.05]) k.mirrorX(() => k.cylX("metal", 0.42, 0.12, 16, [0.74, 0.42, z + dz], "#3b3e43"));
  }
  // ends
  if (cab) {
    k.rbox("paint", W - 0.06, 1.55, 0.8, 0, 1.6, hl - 0.15, "#ffd200", 0.3);
    k.rbox("glass", W - 0.5, 0.95, 0.5, 0, 2.75, hl - 0.25, "#141a20", 0.2);
    k.rbox("solid", W - 0.3, 0.35, 0.3, 0, 0.75, hl - 0.05, "#1a1b1e", 0.08); // coupler fairing
    k.mirrorX(() => {
      k.rbox("glow", 0.32, 0.16, 0.06, 0.9, 1.25, hl + 0.26, HEAD, 0.05);
      k.rbox("glow", 0.14, 0.12, 0.06, 0.9, 1.5, hl + 0.26, TAIL, 0.04);
    });
    k.box("glow", 1.0, 0.16, 0.04, 0, 3.32, hl + 0.06, "#ffb000"); // destination
  } else k.rbox("solid", 1.4, 2.4, 0.4, 0, 2.0, hl + 0.1, "#1a1b1e", 0.1);
  k.rbox("solid", 1.4, 2.4, 0.4, 0, 2.0, -hl - 0.1, "#1a1b1e", 0.1);
  // roundel-style Overground logo on the sides
  for (const s of [1, -1])
    k.sign("overground-logo", 0.9, 0.6, [s * (hw + 0.03), 2.98, s * 3.1], [128, 96], (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.strokeStyle = ORANGE;
      c.lineWidth = 13;
      c.beginPath();
      c.arc(w / 2, h / 2, 32, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#0019a8";
      c.fillRect(10, h / 2 - 10, w - 20, 20);
    }, false, [0, (s * Math.PI) / 2, 0]);
  return k.model(cab ? "overground-378-cab" : "overground-378", { ao: 1.4 });
}

/** Panel van (Transit-like), white so it can be repainted per fleet. */
export function deliveryVan(paint = "#f3f4f2"): HeroModel {
  const k = new Kit();
  const W = 2.05, hw = W / 2, L = 5.5, hl = L / 2;
  k.rbox("paint", W, 2.05, 4.1, 0, 0.42 + 1.02, -0.7, paint, 0.14, 3);
  k.rbox("paint", W - 0.04, 0.85, 1.5, 0, 0.84, hl - 0.75, paint, 0.2, 3);
  raked(k, "glass", W - 0.16, hl - 0.75, 1.25, 1.3, 2.3, GLASS, 0.1);
  k.mirrorX(() => {
    k.slab("glass", hw - 0.01, hw + 0.015, 1.32, 2.05, 0.45, 1.3, GLASS);
    k.box("solid", 0.02, 1.7, 0.02, hw + 0.012, 1.3, -0.1, "#9b9fa4"); // sliding door seam
    k.box("solid", 0.025, 0.03, 1.6, hw + 0.012, 2.18, -0.9, "#9b9fa4"); // door rail
  });
  k.box("solid", 0.02, 1.9, 0.02, 0, 1.45, -hl - 0.21, "#555"); // rear door split
  k.rbox("solid", W + 0.02, 0.26, 0.16, 0, 0.44, hl - 0.03, DARK, 0.06);
  k.rbox("solid", W + 0.02, 0.26, 0.16, 0, 0.44, -hl - 0.17, DARK, 0.06);
  k.rbox("solid", 1.2, 0.3, 0.06, 0, 0.82, hl + 0.01, "#202226", 0.05);
  k.mirrorX(() => {
    k.rbox("glow", 0.3, 0.16, 0.05, 0.78, 1.0, hl, HEAD, 0.04);
    k.rbox("glow", 0.12, 0.45, 0.05, hw - 0.1, 1.05, -hl - 0.2, TAIL, 0.03);
  });
  mirrors(k, hw, 1.75, 1.15, DARK, 0.22);
  for (const [n, z] of [["F", hl - 0.9], ["R", -hl + 0.65]] as const) {
    for (const s of [1, -1]) arch(k, s * (hw + 0.006), z, 0.36);
    wheel(k, `wheel${n}L`, hw - 0.13, z, 0.36, 0.24);
    wheel(k, `wheel${n}R`, -hw + 0.13, z, 0.36, 0.24);
  }
  return k.model("delivery-van", { ao: 1.2 });
}

/** Cab-over flatbed lorry carrying strapped pallets of bricks and a builder's bag. */
export function flatbedLorry(paint = "#2f6db5"): HeroModel {
  const k = new Kit();
  const W = 2.5, hw = W / 2, L = 8.6, hl = L / 2;
  // cab
  k.rbox("paint", W - 0.04, 2.35, 1.75, 0, 0.62 + 1.17, hl - 0.88, paint, 0.16, 3);
  k.rbox("glass", W - 0.3, 0.95, 0.08, 0, 2.3, hl, GLASS, 0.06);
  k.mirrorX(() => k.slab("glass", hw - 0.03, hw - 0.005, 1.85, 2.65, hl - 0.95, hl - 0.15, GLASS));
  k.rbox("solid", 1.6, 0.55, 0.06, 0, 1.25, hl + 0.01, "#1d1f22", 0.05);
  for (let i = 0; i < 5; i++) k.box("metal", 1.5, 0.03, 0.03, 0, 1.05 + i * 0.1, hl + 0.05, CHROME);
  k.rbox("paint", W - 0.3, 0.5, 1.3, 0, 3.22, hl - 1.0, paint, 0.15); // roof fairing
  k.rbox("solid", W + 0.04, 0.32, 0.18, 0, 0.62, hl - 0.04, DARK, 0.06);
  k.mirrorX(() => {
    k.rbox("glow", 0.32, 0.16, 0.05, hw - 0.3, 0.7, hl + 0.02, HEAD, 0.04);
    k.rbox("glow", 0.14, 0.14, 0.05, hw - 0.12, 0.98, -hl, TAIL, 0.03);
    k.rbox("solid", 0.4, 0.9, 0.6, hw - 0.3, 1.1, hl - 2.4, "#2a2c30", 0.05); // tank / box
  });
  mirrors(k, hw, 2.2, hl - 0.2, DARK, 0.3);
  // chassis + deck + drop sides
  k.mirrorX(() => k.box("solid", 0.16, 0.3, L - 0.6, 0.5, 0.85, -0.2, "#1f2124"));
  k.box("solid", W, 0.16, 6.6, 0, 1.22, -0.95, "#6b5845");
  k.mirrorX(() => k.box("metal", 0.05, 0.38, 6.6, hw - 0.025, 1.47, -0.95, "#9aa1a8"));
  k.box("metal", W, 0.38, 0.05, 0, 1.47, -hl + 0.04, "#9aa1a8");
  k.box("metal", W, 1.2, 0.08, 0, 1.9, 2.33, "#4a4f55"); // headboard
  // load: two brick pallets + a white builder's bag
  for (const z of [0.8, -1.0]) {
    k.box("solid", 1.15, 0.14, 1.15, 0.6, 1.37, z, "#9b7b54");
    k.box("brick", 1.1, 0.8, 1.1, 0.6, 1.84, z, "#b8613f");
    k.box("solid", 1.12, 0.04, 1.12, 0.6, 2.25, z, "#d9dde0");
  }
  k.rbox("solid", 1.0, 0.9, 1.0, -0.6, 1.75, -0.1, "#ecebe5", 0.2);
  k.box("solid", 1.02, 0.25, 1.02, -0.6, 2.05, -0.1, "#2e6fbf");
  k.rbox("solid", 1.0, 0.7, 1.0, -0.6, 1.65, -2.6, "#d6c9a8", 0.1);
  for (const [n, z] of [["F", hl - 0.9], ["R", -1.9], ["R2", -3.1]] as const) {
    for (const s of [1, -1]) arch(k, s * (hw - 0.05), z, 0.5);
    wheel(k, `wheel${n}L`, hw - 0.2, z, 0.5, 0.34);
    wheel(k, `wheel${n}R`, -hw + 0.2, z, 0.5, 0.34);
  }
  return k.model("flatbed-lorry", { ao: 1.4 });
}
