"use client";

import { useEffect, useState } from "react";
import Icon from "./Icon";

// KPI card. Pass `details` to make it clickable — clicking opens a popup
// with `details.title`, `details.sub`, and either `details.items` (a list of
// rows: [{ label, value, sub? }]) or `details.body` (free-form node).
export const KPI = ({ label, value, unit, delta, deltaDir, sub, sparkData, puck, puckIcon, details }) => {
  const arrow = deltaDir === "up" ? "arrowUp" : deltaDir === "down" ? "arrowDown" : null;
  const [open, setOpen] = useState(false);
  const clickable = !!details;
  return (
    <>
      <div
        className={`kpi ${clickable ? "kpi-clickable" : ""}`}
        onClick={clickable ? () => setOpen(true) : undefined}
        style={clickable ? { cursor: "pointer" } : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } } : undefined}
      >
        <div className="kpi-top">
          <div className="lbl">{label}</div>
          {puck && (
            <div className={`kpi-puck ${puck}`}>
              <Icon name={puckIcon || "spark"} size={16} />
            </div>
          )}
        </div>
        <div className="val-row">
          <div className="val">
            {value}
            {unit ? <span className="unit">{unit}</span> : null}
          </div>
          {delta && (
            <span className={`delta ${deltaDir}`}>
              {arrow && <Icon name={arrow} size={10} stroke={2.2} />}
              {delta}
            </span>
          )}
        </div>
        <div className="meta">{sub && <span>{sub}</span>}</div>
        {sparkData && <Sparkline data={sparkData} w={80} h={24} className="spark" />}
      </div>
      {open && clickable && (
        <KpiDetailsModal
          title={details.title || label}
          sub={details.sub}
          items={details.items}
          body={details.body}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

// Single row inside a KPI details popup. If `item.children` is a non-empty
// array, the row becomes expandable — clicking it toggles a panel that
// renders each child with the same styling, indented one level.
function KpiItem({ item, depth = 0 }) {
  const it = item;
  const hasChildren = Array.isArray(it.children) && it.children.length > 0;
  const [open, setOpen] = useState(false);
  const toneColor = it.tone === "ok"
    ? "var(--ok)"
    : it.tone === "bad"
      ? "var(--bad)"
      : it.tone === "warn"
        ? "var(--warn, #b07a18)"
        : "var(--ink-2)";
  return (
    <>
      <div
        onClick={hasChildren ? () => setOpen((v) => !v) : undefined}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onKeyDown={hasChildren ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } } : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "8px 10px",
          background: depth > 0 ? "var(--card)" : "var(--bg-2)",
          border: "1px solid var(--rule-2)", borderRadius: 8,
          cursor: hasChildren ? "pointer" : "default",
          marginLeft: depth * 14,
        }}
      >
        {hasChildren && (
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>{it.label}</div>
          {it.sub && <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{it.sub}</div>}
        </div>
        {it.value != null && (
          <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: toneColor }}>
            {it.value}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {it.children.map((child, i) => (
            <KpiItem key={i} item={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </>
  );
}

function KpiDetailsModal({ title, sub, items, body, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 480, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">{title}</div>
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {body}
          {Array.isArray(items) && items.length === 0 && (
            <div className="empty">Nothing to show yet.</div>
          )}
          {Array.isArray(items) && items.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {items.map((it, i) => (
                <KpiItem key={i} item={it} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const Sparkline = ({ data, w = 100, h = 28, stroke = "var(--accent-2)", fill = "var(--accent-soft)", className }) => {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - 2) + 1;
    const y = h - 1 - ((v - min) / range) * (h - 2);
    return [x, y];
  });
  const d = "M " + pts.map((p) => p.join(",")).join(" L ");
  const area = d + ` L ${w - 1},${h - 1} L 1,${h - 1} Z`;
  return (
    <svg className={className} width={w} height={h}>
      <path d={area} fill={fill} opacity="0.6" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const ChartEmpty = ({ h }) => (
  <div style={{ height: h || 200, display: "grid", placeItems: "center", color: "var(--ink-4)", fontSize: 12.5 }}>
    No data yet
  </div>
);

export const LineBarChart = ({ data, w, h, lineKeys = ["inc"], barKey, xKey = "w", palette }) => {
  if (!data || data.length === 0) return <ChartEmpty h={h} />;
  const pad = { t: 16, r: 16, b: 22, l: 36 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const vals = data.flatMap((d) => [...lineKeys.map((k) => d[k]), barKey ? d[barKey] : 0]);
  const max = Math.ceil(Math.max(...vals) / 10) * 10;
  const bw = (iw / data.length) * 0.5;
  const xAt = (i) => pad.l + (i + 0.5) * (iw / data.length);
  const yAt = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  return (
    <svg width={w} height={h} className="chartbox" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={pad.l + iw} y1={yAt(t)} y2={yAt(t)} stroke="var(--rule)" strokeDasharray="2 3" />
          <text x={pad.l - 6} y={yAt(t) + 3} textAnchor="end" fontSize="10" fill="var(--ink-4)" fontFamily="var(--font-mono)">
            {t}
          </text>
        </g>
      ))}
      {barKey && data.map((d, i) => (
        <rect key={i} x={xAt(i) - bw / 2} y={yAt(d[barKey])} width={bw} height={ih - (yAt(d[barKey]) - pad.t)} rx="2" fill="var(--rule-2)" />
      ))}
      {lineKeys.map((k, ki) => {
        const color = palette?.[ki] || "var(--accent-2)";
        const pts = data.map((d, i) => [xAt(i), yAt(d[k])]);
        const path = "M " + pts.map((p) => p.join(",")).join(" L ");
        const area = path + ` L ${xAt(data.length - 1)},${pad.t + ih} L ${xAt(0)},${pad.t + ih} Z`;
        return (
          <g key={k}>
            {ki === 0 && <path d={area} fill={color} opacity="0.08" />}
            <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {pts.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r="2.5" fill="var(--card)" stroke={color} strokeWidth="1.5" />
            ))}
          </g>
        );
      })}
      {data.map((d, i) => (
        <text key={i} x={xAt(i)} y={h - 6} textAnchor="middle" fontSize="10" fill="var(--ink-4)" fontFamily="var(--font-mono)">
          {d[xKey]}
        </text>
      ))}
    </svg>
  );
};

export const BarChart = ({ data, w, h, xKey, yKey, yKey2, labelFmt, palette = ["var(--accent)", "var(--rule-2)"] }) => {
  if (!data || data.length === 0) return <ChartEmpty h={h} />;
  const pad = { t: 12, r: 8, b: 28, l: 8 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const max = Math.max(...data.map((d) => d[yKey]));
  const bw = (iw / data.length) * 0.62;
  const xAt = (i) => pad.l + (i + 0.5) * (iw / data.length);
  const yAt = (v) => pad.t + ih - (v / max) * ih;
  return (
    <svg width={w} height={h} className="chartbox" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h }}>
      {data.map((d, i) => {
        const y1 = yAt(d[yKey]);
        const y2 = yKey2 ? yAt(d[yKey] + d[yKey2]) : y1;
        return (
          <g key={i}>
            {yKey2 && <rect x={xAt(i) - bw / 2} y={y2} width={bw} height={y1 - y2} fill={palette[1]} rx="2" />}
            <rect x={xAt(i) - bw / 2} y={y1} width={bw} height={pad.t + ih - y1} fill={palette[0]} rx="2" />
            <text x={xAt(i)} y={h - 12} textAnchor="middle" fontSize="10" fill="var(--ink-3)" fontFamily="var(--font-mono)">
              {d[xKey]}
            </text>
            <text x={xAt(i)} y={h - 2} textAnchor="middle" fontSize="9.5" fill="var(--ink-4)" fontFamily="var(--font-mono)">
              {labelFmt ? labelFmt(d) : d[yKey]}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export const Ring = ({ pct, size = 72, stroke = 8, color = "var(--accent)", track = "var(--rule-2)", label, sub }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="ring" style={{ width: size, height: size, position: "relative" }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 15 }}>{label}</div>
          {sub && <div style={{ color: "var(--ink-3)", fontSize: 10.5 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
};

const STATUS_TONE = {
  Open: "bad",
  "In Progress": "warn",
  Resolved: "ok",
  New: "info",
  Contacted: "warn",
  Converted: "ok",
  Rejected: "bad",
  paid: "ok",
  pending: "warn",
  overdue: "bad",
  running: "ok",
  delayed: "warn",
  done: "ok",
  current: "accent",
  low: "bad",
  ok: "ok",
  top: "ok",
};
export const statusChip = (status) => STATUS_TONE[status] || "";

export const StatusChip = ({ status, children }) => (
  <span className={`chip ${statusChip(status)}`}>
    <span className="dot" />
    {children || status}
  </span>
);

// Build the standard UPI deep-link URI from the bits the bank QR needs.
// Returns null if the payee VPA is missing — caller should render a CTA
// asking the user to configure their UPI ID instead of an unscannable QR.
export function buildUpiUri({ upiId, payeeName, amount, note, transactionRef }) {
  if (!upiId) return null;
  const params = new URLSearchParams();
  params.set("pa", upiId);
  if (payeeName) params.set("pn", payeeName);
  if (amount && Number(amount) > 0) params.set("am", String(Math.floor(Number(amount))));
  params.set("cu", "INR");
  if (note) params.set("tn", note);
  if (transactionRef) params.set("tr", transactionRef);
  return `upi://pay?${params.toString()}`;
}

// Real, scannable QR rendered as a PNG by the public api.qrserver.com
// generator (no extra npm dep). Falls back to a friendly placeholder when
// the UPI ID hasn't been configured in Settings yet.
export const UpiQR = ({ size = 180, uri, hint }) => {
  if (!uri) {
    return (
      <div style={{
        width: size, height: size,
        border: "1.5px dashed var(--rule)", borderRadius: 12,
        display: "grid", placeItems: "center", padding: 14, textAlign: "center",
        background: "var(--bg-2)", color: "var(--ink-3)", fontSize: 11.5, lineHeight: 1.5,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)", marginBottom: 6 }}>
            UPI not configured
          </div>
          {hint || "Add a UPI ID under Settings → Finance to make this QR scannable."}
        </div>
      </div>
    );
  }
  // Branded QR rendered server-side by /api/fees/qr-image — Sanfort blue +
  // orange with the school logo in the center. 2x size for retina sharpness.
  const src = `/api/fees/qr-image?size=${size * 2}&data=${encodeURIComponent(uri)}`;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="UPI QR code"
      style={{ display: "block", borderRadius: 6, background: "#fff" }}
    />
  );
};

export const FakeQR = ({ size = 156, seed = 7 }) => {
  const n = 21;
  const cells = [];
  let s = seed;
  const next = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (next() > 0.52) cells.push([x, y]);
    }
  }
  const finder = (fx, fy) => [
    <rect key={`f1-${fx}-${fy}`} x={fx} y={fy} width="7" height="7" fill="currentColor" />,
    <rect key={`f2-${fx}-${fy}`} x={fx + 1} y={fy + 1} width="5" height="5" fill="var(--card)" />,
    <rect key={`f3-${fx}-${fy}`} x={fx + 2} y={fy + 2} width="3" height="3" fill="currentColor" />,
  ];
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} style={{ color: "var(--ink)", display: "block" }}>
      <rect width={n} height={n} fill="var(--card)" />
      {cells
        .filter(([x, y]) => !(x < 8 && y < 8) && !(x > n - 9 && y < 8) && !(x < 8 && y > n - 9))
        .map(([x, y], i) => (
          <rect key={i} x={x} y={y} width="1" height="1" fill="currentColor" />
        ))}
      {finder(0, 0)}
      {finder(n - 7, 0)}
      {finder(0, n - 7)}
    </svg>
  );
};

export const AvatarChip = ({ initials, color }) => (
  <div className="avatar" style={color ? { background: color } : undefined}>
    {initials}
  </div>
);
