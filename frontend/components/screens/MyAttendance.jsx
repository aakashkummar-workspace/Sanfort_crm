"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";

const STATUSES = [
  { k: "present", label: "Present", tone: "ok",   color: "var(--ok)" },
  { k: "late",    label: "Late",    tone: "warn", color: "var(--warn)" },
  { k: "absent",  label: "Absent",  tone: "bad",  color: "var(--err, #b13c1c)" },
  { k: "leave",   label: "Leave",   tone: "warn", color: "var(--warn)" },
];
const STATUS_LABEL = { present: "Present", late: "Late", absent: "Absent", leave: "Leave" };

function Toast({ msg, tone, onClose }) {
  if (!msg) return null;
  const bg = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err, #b13c1c)" : "var(--ink)";
  return (
    <div onClick={onClose} role="status" style={{
      position: "fixed", bottom: 18, right: 18, zIndex: 9000,
      background: bg, color: "#fff", padding: "9px 14px", borderRadius: 8,
      fontSize: 12, fontWeight: 500, cursor: "pointer", maxWidth: 360,
      boxShadow: "0 12px 30px -16px rgba(0,0,0,0.35)",
    }}>{msg}</div>
  );
}

export default function ScreenMyAttendance({ E, refresh, role, session }) {
  const today = new Date().toISOString().slice(0, 10);
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [leaveReason, setLeaveReason] = useState("");
  const [lateReason,  setLateReason]  = useState("");

  const showToast = (msg, tone) => { setToast({ msg, tone }); setTimeout(() => setToast(null), 3000); };

  // Pull last 60 days of self-attendance.
  async function load() {
    try {
      const from = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const r = await fetch(`/api/teacher-attendance?fromDate=${from}&toDate=${today}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setRecords(j.records || []);
    } catch {}
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  const todays = records.find((r) => r.date === today) || null;

  async function selfMark(status) {
    if (busy) return;
    if (status === "leave" && !leaveReason.trim()) {
      showToast("Add a leave reason first", "err");
      return;
    }
    if (status === "late" && !lateReason.trim()) {
      showToast("Add a late-arrival reason first", "err");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/teacher-attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: today,
          status,
          source: "self",
          leaveReason: status === "leave" ? leaveReason.trim() : null,
          lateReason:  status === "late"  ? lateReason.trim()  : null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast(`Marked ${status} for today`, "ok");
      if (status !== "leave") setLeaveReason("");
      if (status !== "late")  setLateReason("");
      await load();
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(false); }
  }

  // Quick stats — last 30 days.
  const stats = useMemo(() => {
    const last30 = records.filter((r) => {
      const d = new Date(r.date);
      const cutoff = new Date(Date.now() - 30 * 86400000);
      return d >= cutoff;
    });
    const present = last30.filter((r) => r.status === "present").length;
    const late    = last30.filter((r) => r.status === "late").length;
    const absent  = last30.filter((r) => r.status === "absent").length;
    const leave   = last30.filter((r) => r.status === "leave").length;
    const total   = last30.length;
    // Present + Late both count as "showed up" for the headline percentage.
    const pct = total > 0 ? Math.round(((present + late) / total) * 100) : null;
    return { present, late, absent, leave, total, pct };
  }, [records]);

  const todayLabel = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  const initials = (session?.name || "T").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">My classroom · Attendance</div>
          <div className="page-title">My <span className="amber">attendance</span></div>
          <div className="page-sub">{todayLabel} · self-mark your status today</div>
        </div>
      </div>

      {/* Today's mark — the headline tile */}
      <div className="card" style={{ marginBottom: 14, padding: 22, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14,
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          color: "var(--accent-ink, #fff)",
          display: "grid", placeItems: "center",
          fontWeight: 600, fontSize: 18,
        }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>Status for {today}</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, fontFamily: "var(--font-serif)" }}>
            {todays
              ? <>You're marked <span style={{ color: STATUSES.find((s) => s.k === todays.status)?.color }}>{STATUS_LABEL[todays.status]}</span> today</>
              : "Not marked yet — pick one"}
          </div>
          {(todays?.status === "leave" || todays?.status === "late") && (todays.leaveReason || todays.lateReason) && (
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
              Reason: <em>{todays.leaveReason || todays.lateReason}</em>
            </div>
          )}
          {todays && (
            <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>
              Marked at {new Date(todays.markedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} by {todays.markedBy === (session?.name) ? "you" : todays.markedBy}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUSES.map((s) => (
            <button
              key={s.k}
              onClick={() => selfMark(s.k)}
              disabled={busy}
              style={{
                padding: "10px 18px", borderRadius: 10,
                background: todays?.status === s.k ? s.color : "var(--bg-2)",
                color: todays?.status === s.k ? "#fff" : "var(--ink-2)",
                border: 0, cursor: busy ? "not-allowed" : "pointer",
                fontSize: 13, fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 6,
                transition: "all .12s",
              }}
            >
              <Icon name={s.k === "present" ? "check" : s.k === "absent" ? "x" : "clock"} size={13} />
              {/* "late" + "leave" both render with the clock icon; the label disambiguates */}
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Reason fields — only relevant when picking Late or Leave */}
      <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>Late reason (only when picking <b>Late</b>)</div>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          value={lateReason}
          onChange={(e) => setLateReason(e.target.value)}
          placeholder="e.g. Traffic, late train, personal emergency"
        />
      </div>
      <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>Leave reason (only when picking <b>Leave</b>)</div>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          value={leaveReason}
          onChange={(e) => setLeaveReason(e.target.value)}
          placeholder="e.g. Casual leave, medical, family function"
        />
      </div>

      {/* 30-day KPIs */}
      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI label="Attendance · 30d" value={stats.pct === null ? "—" : `${stats.pct}%`} sub={`${stats.present + stats.late}/${stats.total} on-site (incl. late)`} puck="mint" puckIcon="check" />
        <KPI label="Late arrivals" value={stats.late} sub={stats.late ? "with reasons logged" : "always on time"} puck="peach" puckIcon="clock" />
        <KPI label="Absent" value={stats.absent} sub={stats.absent ? "review reasons" : "all clear"} puck="rose" puckIcon="x" />
        <KPI label="On leave" value={stats.leave} sub={stats.leave ? "with reasons logged" : "no leaves"} puck="cream" puckIcon="calendar" />
      </div>

      {/* Recent log */}
      <div className="card">
        <div className="card-head">
          <div><div className="card-title">Recent log</div><div className="card-sub">{records.length} record{records.length === 1 ? "" : "s"} · last 60 days</div></div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Status</th><th>Reason</th><th>Marked by</th><th>Marked at</th></tr>
            </thead>
            <tbody>
              {records.length === 0 && <tr><td colSpan={5} className="empty">No marks yet — use the buttons above to start.</td></tr>}
              {[...records].sort((a, b) => b.date.localeCompare(a.date)).map((r) => {
                const tone = STATUSES.find((s) => s.k === r.status)?.tone || "";
                return (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>
                      {new Date(r.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      {r.date === today && <span className="chip" style={{ marginLeft: 6, fontSize: 9.5 }}>today</span>}
                    </td>
                    <td><span className={`chip ${tone}`}><span className="dot" />{STATUS_LABEL[r.status]}</span></td>
                    <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.leaveReason || r.lateReason || "—"}</td>
                    <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.markedBy === (session?.name) ? "self" : r.markedBy}</td>
                    <td style={{ fontSize: 11, color: "var(--ink-4)", whiteSpace: "nowrap" }}>{new Date(r.markedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
