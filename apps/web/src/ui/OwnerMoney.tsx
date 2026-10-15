// Owner page section "Your money this fortnight" (docs/PEOPLE_ECONOMY.md): the business and personal balance
// over 14 days, and where the money came from and went. Store-scoped: only this shop's owner, from /owners.
// Renders nothing when the backend doesn't serve owners.
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useOwners } from "../state/economy";
import "./economy.css";
import { fmtInt } from "./format";

const LAMP = "#ffc857";
const BLUE = "#7fb2ff";
const money = (n: number) => `${n < 0 ? "−" : ""}£${fmtInt(Math.abs(n))}`;
const STATUS: Record<string, string> = { trading: "Trading", cautious: "Cautious: cash is tight", bust: "Bust" };

export function OwnerMoney({ storeId, run }: { storeId: string; run: number }) {
  const o = useOwners(run).data?.find((x) => x.storeId === storeId);
  if (!o) return null;
  const data = [
    { day: 0, business: o.business.startGbp, personal: o.personal.startGbp },
    ...o.business.daily.map((b, i) => ({ day: i + 1, business: b, personal: o.personal.daily[i] })),
  ];
  const t = o.totals;
  const costs = [
    { label: "Stock", v: t.stockGbp },
    { label: "Wages", v: t.wagesGbp },
    { label: "Rent", v: t.rentGbp },
    { label: "Energy", v: t.energyGbp },
  ];
  const out = costs.reduce((n, c) => n + c.v, 0);
  const net = t.takingsGbp - out;
  const max = Math.max(t.takingsGbp, out, 1);
  const delta = o.business.endGbp - o.business.startGbp;
  return (
    <section className="sp-card owner-money">
      <div className="sp-card-head">
        <h2>Your money this fortnight</h2>
        <span className={`pc-status pc-${o.status}`}>{STATUS[o.status]}</span>
      </div>
      <p className="om-lead">
        Business account {delta >= 0 ? "up" : "down"} <b className={delta >= 0 ? "good" : "bad"}>{money(Math.abs(delta))}</b> to {money(o.business.endGbp)}. You took{" "}
        {money(t.drawingsGbp)} home; your own account is at {money(o.personal.endGbp)}.
      </p>
      <div className="om-chart">
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: "#8b97ad", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(d: number) => (d === 0 ? "start" : `D${d}`)} />
            <YAxis tick={{ fill: "#8b97ad", fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => money(v)} />
            <ReferenceLine y={0} stroke="rgba(255,138,122,0.5)" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{ background: "rgba(15,21,34,0.95)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 10, fontSize: 12 }}
              labelFormatter={(d) => (Number(d) === 0 ? "Start" : `End of day ${d}`)}
              formatter={(v, name) => [money(Number(v)), name === "business" ? "Business" : "Personal"]}
            />
            <Line type="monotone" dataKey="business" stroke={LAMP} strokeWidth={2.2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="personal" stroke={BLUE} strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        <div className="om-legend">
          <span>
            <i style={{ background: LAMP }} /> Business
          </span>
          <span>
            <i style={{ background: BLUE }} /> Personal
          </span>
        </div>
      </div>
      <div className="om-flows">
        <div className="om-row in">
          <span>Takings</span>
          <span className="om-bar">
            <i style={{ width: `${(t.takingsGbp / max) * 100}%` }} />
          </span>
          <b className="mono">+{money(t.takingsGbp)}</b>
        </div>
        {costs.map((c) => (
          <div key={c.label} className="om-row outc">
            <span>{c.label}</span>
            <span className="om-bar">
              <i style={{ width: `${(c.v / max) * 100}%` }} />
            </span>
            <b className="mono">−{money(c.v)}</b>
          </div>
        ))}
        <div className={`om-row om-net ${net >= 0 ? "good" : "bad"}`}>
          <span>Trading profit</span>
          <span />
          <b className="mono">
            {net >= 0 ? "+" : ""}
            {money(net)}
          </b>
        </div>
      </div>
    </section>
  );
}
