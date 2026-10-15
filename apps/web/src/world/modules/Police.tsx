// Module: Police. Response vehicles for public-safety incidents (docs/INCIDENTS.md), driven in sim time along the
// street graph: Met response cars (blue lights, siren pulse while driving) to every call they attend, a second car
// for serious ones, an ambulance when one was called, and police chases (a car pursued along a route at speed until
// it is boxed in). Place-based and synthetic: the vehicles are the story, never a person.
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";
import { useIncidents } from "../../api/incidents";
import { chaseAt, responseCarAt } from "../../sim/incidents";
import { useSim } from "../../state/store";
import { useWorld } from "../context";
import { useResponses, type Response } from "../incidents/routes";
import { Ambulance, PlainCar, PoliceCar, SirenPulse } from "../incidents/vehicles";

/** Contract heading → scene rotation about y (local +z forward). */
const rotY = (heading: number) => Math.PI - heading;

/** Keep to the left of the road (UK): metres left of the centreline. */
const LANE = 2.2;

function place(g: Group | null, p: { x: number; z: number; heading: number } | null) {
  if (!g) return;
  g.visible = !!p;
  if (!p) return;
  // left-hand normal of (sin h, cos h) in x-east / z-north is (-cos h, sin h)
  g.position.set(p.x - Math.cos(p.heading) * LANE, 0, -(p.z + Math.sin(p.heading) * LANE));
  g.rotation.y = rotY(p.heading);
}

function Call({ r }: { r: Response }) {
  const i = r.incident;
  const car1 = useRef<Group>(null);
  const car2 = useRef<Group>(null);
  const amb = useRef<Group>(null);
  const siren1 = useRef<Group>(null);
  const siren2 = useRef<Group>(null);
  const two = i.severity >= 2;
  useFrame(() => {
    const t = useSim.getState().t;
    const p1 = r.police ? responseCarAt(i, r.police, t) : null;
    // the second car is dispatched a minute later and parks behind the first
    const p2 = r.police && two ? responseCarAt({ ...i, t: i.t + 1, response: { ...i.response, durationMin: i.response.durationMin - 1 } }, r.police, t, 8) : null;
    place(car1.current, p1);
    place(car2.current, p2);
    if (siren1.current) siren1.current.visible = !!p1?.driving;
    if (siren2.current) siren2.current.visible = !!p2?.driving;
    const pa = r.ambulance ? responseCarAt({ ...i, t: i.t + 2, response: { ...i.response, durationMin: i.response.durationMin - 2 } }, r.ambulance, t, -4) : null;
    place(amb.current, pa);
  });
  return (
    <group name={`response-${i.id}`}>
      {r.police && (
        <group ref={car1} visible={false}>
          <PoliceCar />
          <group ref={siren1}>
            <SirenPulse />
          </group>
        </group>
      )}
      {r.police && two && (
        <group ref={car2} visible={false}>
          <PoliceCar />
          <group ref={siren2}>
            <SirenPulse />
          </group>
        </group>
      )}
      {r.ambulance && (
        <group ref={amb} visible={false}>
          <Ambulance />
        </group>
      )}
    </group>
  );
}

function Chase({ r }: { r: Response }) {
  const i = r.incident;
  const lead = useRef<Group>(null);
  const cop = useRef<Group>(null);
  const cop2 = useRef<Group>(null);
  const siren = useRef<Group>(null);
  const c = r.chase!;
  useFrame(() => {
    const t = useSim.getState().t;
    const on = t >= i.t && t < i.t + i.response.durationMin;
    if (!on) {
      place(lead.current, null);
      place(cop.current, null);
      place(cop2.current, null);
      return;
    }
    const s = chaseAt(c.route, i.t, c.minutes, t);
    place(lead.current, s.lead);
    place(cop.current, s.police);
    // a second car joins from the other end of the route to box it in
    const k = Math.min(1, (t - i.t) / c.minutes);
    place(cop2.current, k > 0.6 ? { ...s.lead, x: s.lead.x + Math.sin(s.lead.heading) * 7, z: s.lead.z + Math.cos(s.lead.heading) * 7, heading: s.lead.heading + Math.PI } : null);
    if (siren.current) siren.current.visible = s.moving;
  });
  return (
    <group name={`chase-${i.id}`}>
      <group ref={lead} visible={false}>
        <PlainCar color="#24272e" />
      </group>
      <group ref={cop} visible={false}>
        <PoliceCar />
        <group ref={siren}>
          <SirenPulse />
        </group>
      </group>
      <group ref={cop2} visible={false}>
        <PoliceCar />
      </group>
    </group>
  );
}

/** Mounts a call's vehicles only while it is on (a boolean selector: re-renders twice per incident). */
function Window({ r }: { r: Response }) {
  const i = r.incident;
  const on = useSim((s) => s.t >= i.t - 1 && s.t < i.t + i.response.durationMin + 1);
  if (!on) return null;
  return r.chase ? <Chase r={r} /> : <Call r={r} />;
}

export default function Police() {
  const { map, run } = useWorld();
  const incidents = useIncidents(run).data;
  const responses = useResponses(map, incidents);
  return (
    <group name="police">
      {responses
        .filter((r) => r.police || r.ambulance || r.chase)
        .map((r) => (
          <Window key={r.incident.id} r={r} />
        ))}
    </group>
  );
}
