"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import {
  TYPE_LABELS, SEVERITY_LABELS, STATUS_LABELS, STATUSES, OPEN_STATUSES,
} from "@/lib/change-reports";

const STATUS_TONE = {
  new: "warn", acknowledged: "info", in_progress: "info",
  fixed: "ok", wont_fix: "muted", duplicate: "muted",
};
const TONE_BG = {
  ok:     { bg: "rgba(34,139,94,0.12)",  fg: "var(--ok, #1f7a52)" },
  warn:   { bg: "rgba(201,124,32,0.14)", fg: "var(--warn, #a66414)" },
  info:   { bg: "rgba(49,106,197,0.12)", fg: "var(--info, #2f5fa8)" },
  muted:  { bg: "var(--bg-2)",           fg: "var(--ink-4)" },
  err:    { bg: "rgba(179,38,30,0.1)",   fg: "var(--err, #b3261e)" },
};

function Chip({ tone = "muted", children }) {
  const t = TONE_BG[tone] || TONE_BG.muted;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, padding: "3px 8px", borderRadius: 999,
      background: t.bg, color: t.fg, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function when(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

export default function ChangeReports({ session = {}, showToast }) {
  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [canTriage, setCanTriage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("");
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (type) qs.set("type", type);
      if (severity) qs.set("severity", severity);
      qs.set("limit", "100");
      const r = await fetch(`/api/change-reports?${qs}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not load reports");
      setReports(j.reports || []);
      setTotal(j.total || 0);
      setCanTriage(!!j.canTriage);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, [status, type, severity]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => ({
    open: reports.filter((r) => OPEN_STATUSES.has(r.status)).length,
    blocking: reports.filter((r) => r.severity === "blocking" && OPEN_STATUSES.has(r.status)).length,
    fixed: reports.filter((r) => r.status === "fixed").length,
  }), [reports]);

  async function patch(id, body) {
    try {
      const r = await fetch(`/api/change-reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not update");
      setReports((prev) => prev.map((x) => (x.id === id ? j.report : x)));
      setOpen((o) => (o && o.id === id ? j.report : o));
      showToast?.("Report updated", "ok");
    } catch (e) { showToast?.(e.message || String(e), "err"); }
  }

  async function remove(r) {
    if (!window.confirm(`Delete "${r.title}"? The screenshot is deleted too.`)) return;
    try {
      const res = await fetch(`/api/change-reports/${r.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "Could not delete");
      setReports((prev) => prev.filter((x) => x.id !== r.id));
      setOpen(null);
      showToast?.("Report deleted", "ok");
    } catch (e) { showToast?.(e.message || String(e), "err"); }
  }

  return (
    <div className="screen">
      <div className="kpi-row">
        <KPI label="Open" value={counts.open} sub="need action" />
        <KPI label="Blocking" value={counts.blocking} sub="someone is stuck" tone={counts.blocking ? "warn" : undefined} />
        <KPI label="Fixed" value={counts.fixed} sub="in this list" />
        <KPI label="Total" value={total} sub={canTriage ? "all reporters" : "filed by you"} />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Change reports</div>
            <div className="card-sub">
              {canTriage
                ? "Everything reported from inside the app."
                : "The reports you have filed."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            <select className="input sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
            <select className="input sm" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All kinds</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input sm" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any severity</option>
              {Object.entries(SEVERITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <button className="btn sm ghost" onClick={load} disabled={loading}>
              <Icon name="refresh" size={12} />Refresh
            </button>
          </div>
        </div>

        {err ? (
          <div className="card-body" style={{ color: "var(--err)", fontSize: 12.5 }}>{err}</div>
        ) : loading ? (
          <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Loading…</div>
        ) : reports.length === 0 ? (
          <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.6 }}>
            No reports yet. Staff can file one from the button at the bottom-right of any screen.
          </div>
        ) : (
          <div className="card-body" style={{ padding: 0 }}>
            {reports.map((r) => (
              <div key={r.id} className="lrow" style={{ alignItems: "center", gap: 12, cursor: "pointer" }}
                onClick={() => setOpen(r)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
                    {TYPE_LABELS[r.type]?.label || r.type} · {r.reporterName || "—"}
                    {r.pageRoute ? ` · ${r.pageRoute}` : ""} · {when(r.createdAt)}
                  </div>
                </div>
                {r.severity === "blocking" && <Chip tone="err">Blocking</Chip>}
                {r.screenshotFile && <Icon name="box" size={13} />}
                <Chip tone={STATUS_TONE[r.status]}>{STATUS_LABELS[r.status] || r.status}</Chip>
              </div>
            ))}
          </div>
        )}
      </div>

      {open && (
        <DetailModal
          report={open}
          canTriage={canTriage}
          onPatch={patch}
          onDelete={() => remove(open)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function DetailModal({ report, canTriage, onPatch, onDelete, onClose }) {
  const [notes, setNotes] = useState(report.resolutionNotes || "");
  const [shotUrl, setShotUrl] = useState(null);

  // Fetch the screenshot as a blob so the authenticated endpoint is used,
  // and revoke the object URL on unmount so the blob is not retained.
  useEffect(() => {
    if (!report.screenshotFile) return undefined;
    let url = null, cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/change-reports/${report.id}/screenshot`, { cache: "no-store" });
        if (!r.ok) return;
        const blob = await r.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setShotUrl(url);
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [report.id, report.screenshotFile]);

  useEffect(() => { setNotes(report.resolutionNotes || ""); }, [report.id, report.resolutionNotes]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.5)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: "100%", maxWidth: 680, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">{report.title}</div>
            <div className="card-sub">
              {TYPE_LABELS[report.type]?.label || report.type} ·{" "}
              {SEVERITY_LABELS[report.severity]?.label || report.severity} · {report.id}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="What happened">{report.description}</Field>
          {report.expectedBehaviour && (
            <Field label="What they expected">{report.expectedBehaviour}</Field>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 11 }}>
            <Meta label="Reported by" value={`${report.reporterName || "—"}${report.reporterRole ? ` · ${report.reporterRole}` : ""}`} />
            <Meta label="Screen" value={report.pageRoute || "—"} />
            <Meta label="When" value={when(report.createdAt)} />
            <Meta label="Window size" value={report.screenSize || "—"} />
          </div>

          {report.pageUrl && <Meta label="Page address" value={report.pageUrl} wrap />}
          {report.browserInfo && <Meta label="Browser" value={report.browserInfo} wrap />}

          {report.screenshotFile && (
            <div>
              <div style={{
                fontSize: 11, fontWeight: 500, color: "var(--ink-2)",
                textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6,
              }}>Screenshot</div>
              {shotUrl ? (
                <a href={shotUrl} target="_blank" rel="noopener noreferrer">
                  <img src={shotUrl} alt="" style={{
                    width: "100%", borderRadius: 8, border: "1px solid var(--rule)",
                  }} />
                </a>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Loading…</div>
              )}
            </div>
          )}

          {canTriage && (
            <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 13, display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{
                fontSize: 11, fontWeight: 500, color: "var(--ink-2)",
                textTransform: "uppercase", letterSpacing: 0.4,
              }}>Triage</div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUSES.map((s) => (
                  <button key={s}
                    className={`btn sm ${report.status === s ? "accent" : "ghost"}`}
                    onClick={() => onPatch(report.id, { status: s })}>
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>

              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Notes on the resolution</span>
                <textarea className="input" rows={2} value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => {
                    if (notes !== (report.resolutionNotes || "")) {
                      onPatch(report.id, { resolutionNotes: notes });
                    }
                  }} />
              </label>

              <div>
                <button className="btn sm ghost" onClick={onDelete} style={{ color: "var(--err)" }}>
                  <Icon name="x" size={12} />Delete report
                </button>
              </div>
            </div>
          )}

          {!canTriage && report.resolutionNotes && (
            <Field label="Response">{report.resolutionNotes}</Field>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 500, color: "var(--ink-2)",
        textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5,
      }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{children}</div>
    </div>
  );
}

function Meta({ label, value, wrap }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{
        fontSize: 12, marginTop: 2,
        overflowWrap: wrap ? "anywhere" : "normal",
        color: "var(--ink-2)",
      }}>{value}</div>
    </div>
  );
}
