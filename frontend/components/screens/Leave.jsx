"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { resolveSchool, downloadPdf } from "@/lib/export";

const LEAVE_TYPES = [
  { k: "casual",  label: "Casual" },
  { k: "sick",    label: "Sick" },
  { k: "planned", label: "Planned" },
  { k: "family",  label: "Family / personal" },
  { k: "exam",    label: "Exam prep" },
  { k: "other",   label: "Other" },
];

const STATUS_TONE = {
  pending:   "warn",
  approved:  "ok",
  rejected:  "bad",
  cancelled: "info",
};

function fmtRange(from, to) {
  if (!from || !to) return "—";
  const f = new Date(from), t = new Date(to);
  const days = Math.max(1, Math.round((t - f) / 86_400_000) + 1);
  const opts = { day: "2-digit", month: "short" };
  return `${f.toLocaleDateString("en-IN", opts)} → ${t.toLocaleDateString("en-IN", opts)} · ${days}d`;
}

export default function ScreenLeave({ E, role, session, refresh }) {
  const isManager = role === "admin" || role === "principal";
  const isTeacher = role === "teacher";
  const isParent  = role === "parent";

  const [items, setItems] = useState(E.LEAVE_REQUESTS || []);
  const [busy, setBusy] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2400);
  };

  // Refresh from API on mount + when role changes; also pulls fresh
  // status after each approve/reject.
  async function reload() {
    try {
      const r = await fetch("/api/leave-requests", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setItems(j.items || []);
    } catch {}
  }
  useEffect(() => { reload(); }, []);

  // Resolve a friendly name for a request — students from the roster,
  // teachers from the user list — falling back to id when unresolved.
  const studentMap = useMemo(() => {
    const m = new Map();
    for (const s of (E.ADDED_STUDENTS || [])) m.set(s.id, s);
    return m;
  }, [E.ADDED_STUDENTS]);
  // Resolve a teacher's display name from any of: USERS, STAFF, or the
  // signed-in session itself (when it's the viewer's own row). Teachers
  // don't get the full USERS / STAFF list for privacy, so we have to fall
  // back to session.name for self-resolution.
  const userMap = useMemo(() => {
    const m = new Map();
    for (const u of (E.USERS || [])) m.set(u.id, u);
    for (const s of (E.STAFF || [])) {
      if (!m.has(s.id)) m.set(s.id, { id: s.id, name: s.name, role: s.role });
    }
    return m;
  }, [E.USERS, E.STAFF]);

  // The viewer's own user/staff id — used to detect their own rows so we
  // can render a "You" pill and resolve the name even when they're not in
  // the USERS / STAFF list returned to their role.
  const myUserId  = session?.sub || session?.id || null;
  const myStaffId = session?.staffId || (session?.linkedId && String(session.linkedId).startsWith("STF-") ? session.linkedId : null);
  const isMyRow = (r) =>
    r.requesterType === "teacher"
    && (r.requesterId === myUserId || r.requesterId === myStaffId);

  const nameOf = (r) => {
    if (r.requesterName) return r.requesterName;
    if (r.requesterType === "student") return studentMap.get(r.requesterId)?.name || r.requesterId;
    if (r.requesterType === "teacher") {
      if (isMyRow(r) && session?.name) return session.name;
      return userMap.get(r.requesterId)?.name || r.requesterId;
    }
    return r.requesterId;
  };
  const clsOf = (r) => r.requesterCls || studentMap.get(r.requesterId)?.cls || null;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((r) => {
      if (statusFilter !== "all" && r.approvalStatus !== statusFilter) return false;
      if (typeFilter !== "all" && r.leaveType !== typeFilter) return false;
      if (term) {
        const blob = `${nameOf(r)} ${clsOf(r) || ""} ${r.leaveType} ${r.reason || ""}`.toLowerCase();
        if (!blob.includes(term)) return false;
      }
      return true;
    });
  }, [items, statusFilter, typeFilter, q, studentMap, userMap]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [statusFilter, typeFilter, q]);

  const counts = useMemo(() => {
    const c = { all: items.length, pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const r of items) c[r.approvalStatus] = (c[r.approvalStatus] || 0) + 1;
    return c;
  }, [items]);

  async function review(id, status) {
    setBusy(id);
    try {
      const r = await fetch("/api/leave-requests", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      flash(`Leave ${status}`, "ok");
      await reload();
      await refresh?.();
    } catch (ex) {
      flash(ex.message || "Failed", "err");
    } finally {
      setBusy(null);
    }
  }

  async function submitNew(payload) {
    const r = await fetch("/api/leave-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowForm(false);
    flash("Leave request submitted", "ok");
    await reload();
    await refresh?.();
  }

  const school = resolveSchool(E.SETTINGS);
  const actor  = session?.name || null;

  function exportPdf() {
    downloadPdf({
      title: "Leave Requests",
      subtitle: `${filtered.length} request${filtered.length === 1 ? "" : "s"}`,
      school, actor,
      dateRange: "Current snapshot",
      orientation: "landscape",
      summary: [
        { label: "Total",    value: filtered.length },
        { label: "Pending",  value: filtered.filter((r) => r.approvalStatus === "pending").length },
        { label: "Approved", value: filtered.filter((r) => r.approvalStatus === "approved").length },
        { label: "Rejected", value: filtered.filter((r) => r.approvalStatus === "rejected").length },
      ],
      columns: [
        { key: "i",          label: "#",         align: "right",  width: "32px" },
        { key: "id",         label: "ID",        width: "100px" },
        { key: "requester",  label: "Requester" },
        { key: "type",       label: "Role",      align: "center", width: "80px" },
        { key: "cls",        label: "Class",     align: "center", width: "60px" },
        { key: "leaveType",  label: "Leave type",width: "100px" },
        { key: "fromDate",   label: "From",      align: "right",  width: "90px" },
        { key: "toDate",     label: "To",        align: "right",  width: "90px" },
        { key: "reason",     label: "Reason" },
        { key: "status",     label: "Status",    align: "center", width: "90px" },
      ],
      rows: filtered.map((r, i) => ({
        i: i + 1, id: r.id,
        requester: nameOf(r) || "—",
        type: r.requesterType || "—",
        cls: clsOf(r) || "—",
        leaveType: r.leaveType || "—",
        fromDate: r.fromDate || "—",
        toDate: r.toDate || "—",
        reason: r.reason || "—",
        status: (r.approvalStatus || "—").replace(/^./, (c) => c.toUpperCase()),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-leave-requests-${new Date().toISOString().slice(0, 10)}`,
    });
  }

  return (
    <div className="page">
      {toast && (
        <div role="status" style={{
          position: "fixed", bottom: 18, right: 18, zIndex: 9000,
          background: toast.tone === "err" ? "var(--bad, #b13c1c)" : "var(--ok)",
          color: "#fff", padding: "9px 14px", borderRadius: 8,
          fontSize: 12, fontWeight: 700,
        }}>{toast.msg}</div>
      )}

      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Workflow</div>
          <div className="page-title">Leave <span className="amber">requests</span></div>
          <div className="page-sub">
            {isManager
              ? "Review and approve leave for students and staff."
              : isTeacher
                ? "Your leave + leave for students in your assigned classes."
                : isParent
                  ? "Submit and track leave for your child."
                  : "Submit and track leave requests."}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportPdf} disabled={filtered.length === 0} title="Open a printable, branded PDF report">
            <Icon name="download" size={13} />Export PDF
          </button>
          {!isManager && (
            <button className="btn accent" onClick={() => setShowForm(true)}>
              <Icon name="plus" size={13} />Request leave
            </button>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 18 }}>
        <KPI label="All requests" value={counts.all} sub="this term" puck="cream" puckIcon="calendar" />
        <KPI label="Pending review" value={counts.pending || 0} sub="awaiting approval" puck="peach" puckIcon="warning" />
        <KPI label="Approved" value={counts.approved || 0} sub="this term" puck="mint" puckIcon="check" />
        <KPI label="Rejected" value={counts.rejected || 0} sub="this term" puck="rose" puckIcon="x" />
      </div>

      <div className="card" style={{ marginBottom: 14, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          placeholder="Search name, class, reason…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All leave types</option>
          {LEAVE_TYPES.map((t) => <option key={t.k} value={t.k}>{t.label}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{filtered.length} request{filtered.length === 1 ? "" : "s"}</div>
            <div className="card-sub">
              Page {page} of {totalPages}
            </div>
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="empty" style={{ padding: 36 }}>No requests match the filters.</div>
        ) : (
          <div>
            {paged.map((r) => (
              <div key={r.id} className="lrow" style={{ alignItems: "flex-start", gap: 12, paddingTop: 12, paddingBottom: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--bg-2)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name={r.requesterType === "teacher" ? "staff" : "students"} size={16} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{nameOf(r)}</span>
                    {isMyRow(r) && (
                      <span className="chip accent" style={{ fontSize: 10.5, fontWeight: 600 }}>
                        You
                      </span>
                    )}
                    {clsOf(r) && <span className="chip">{clsOf(r)}</span>}
                    <span className="chip">{r.leaveType}</span>
                    <span className={`chip ${STATUS_TONE[r.approvalStatus] || "info"}`}>
                      <span className="dot" />{r.approvalStatus}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
                    {fmtRange(r.fromDate, r.toDate)}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 3 }}>
                    {r.id} · submitted {new Date(r.createdAt).toLocaleString("en-IN")}
                  </div>
                </div>
                {isManager && r.approvalStatus === "pending" && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      className="btn sm" onClick={() => review(r.id, "rejected")}
                      disabled={busy === r.id}
                    >Reject</button>
                    <button
                      className="btn sm accent" onClick={() => review(r.id, "approved")}
                      disabled={busy === r.id}
                    >Approve</button>
                  </div>
                )}
              </div>
            ))}
            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: 12, borderTop: "1px solid var(--rule)" }}>
                <button className="btn sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                  ← Previous
                </button>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px" }}>
                  {page} / {totalPages}
                </span>
                <button className="btn sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <NewLeaveModal
          role={role}
          session={session}
          onClose={() => setShowForm(false)}
          onSubmit={submitNew}
        />
      )}
    </div>
  );
}

function NewLeaveModal({ role, session, onClose, onSubmit }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    leaveType: "casual",
    reason: "",
    fromDate: today,
    toDate: today,
    requesterType: role === "teacher" ? "teacher" : "student",
    requesterId: role === "teacher" ? session?.sub : session?.linkedId || "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await onSubmit(form);
    } catch (ex) {
      setErr(ex.message || "Failed");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      zIndex: 250, display: "grid", placeItems: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 480 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Request leave</div>
            <div className="card-sub">Submit for review by admin / principal.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Leave type">
            <select className="select" value={form.leaveType} onChange={(e) => set("leaveType", e.target.value)}>
              {LEAVE_TYPES.map((t) => <option key={t.k} value={t.k}>{t.label}</option>)}
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="From">
              <input type="date" className="input" value={form.fromDate} onChange={(e) => set("fromDate", e.target.value)} required />
            </Field>
            <Field label="To">
              <input type="date" className="input" value={form.toDate} onChange={(e) => set("toDate", e.target.value)} required />
            </Field>
          </div>
          <Field label="Reason">
            <textarea
              className="input" rows={3}
              value={form.reason}
              onChange={(e) => set("reason", e.target.value.slice(0, 500))}
              placeholder="Brief reason — what the school should know."
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>
          {err && <div style={{ background: "var(--bad-soft, #fbe1d8)", color: "var(--bad, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12, fontWeight: 700 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy}>
              {busy ? "Submitting…" : <><Icon name="check" size={13} />Submit request</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-3)" }}>{label}</span>
      {children}
    </label>
  );
}

