"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { formatClassLabel } from "@/lib/format";

const CATEGORIES = [
  { k: "sports",      label: "Sports",      tone: "ok"   },
  { k: "cultural",    label: "Cultural",    tone: "info" },
  { k: "academic",    label: "Academic",    tone: "info" },
  { k: "competition", label: "Competition", tone: "warn" },
  { k: "excursion",   label: "Excursion",   tone: "info" },
  { k: "workshop",    label: "Workshop",    tone: "info" },
  { k: "celebration", label: "Celebration", tone: "ok"   },
  { k: "other",       label: "Other",       tone: "info" },
];

const STATUSES = [
  { k: "planned",   label: "Planned",   tone: "info" },
  { k: "ongoing",   label: "Ongoing",   tone: "warn" },
  { k: "completed", label: "Completed", tone: "ok"   },
  { k: "cancelled", label: "Cancelled", tone: "err"  },
];

const ATTENDANCE = [
  { k: "pending",  label: "Pending"  },
  { k: "present",  label: "Present"  },
  { k: "absent",   label: "Absent"   },
  { k: "excused",  label: "Excused"  },
];

const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.k, c.label]));
const CATEGORY_TONE  = Object.fromEntries(CATEGORIES.map((c) => [c.k, c.tone]));
const STATUS_LABEL   = Object.fromEntries(STATUSES.map((s) => [s.k, s.label]));
const STATUS_TONE    = Object.fromEntries(STATUSES.map((s) => [s.k, s.tone]));

const CATEGORY_ICON = {
  sports: "trending", cultural: "megaphone", academic: "academic",
  competition: "reports", excursion: "bus", workshop: "book",
  celebration: "heart", other: "calendar",
};

const money = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN")}`;

function dateRangeLabel(p) {
  if (!p.startDate) return "—";
  if (!p.endDate || p.endDate === p.startDate) return p.startDate;
  return `${p.startDate} → ${p.endDate}`;
}

export default function ScreenPrograms({ E, role, session, refresh }) {
  const canManage = role === "admin" || role === "principal" || role === "academic_director";
  const isTeacher = role === "teacher";
  const isParent  = role === "parent";

  const [items, setItems] = useState(E.PROGRAMS || []);
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterStatus, setFilterStatus]     = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);   // program being edited
  const [openId, setOpenId] = useState(null);     // program whose roster is open
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2400);
  };

  async function reload() {
    try {
      const r = await fetch("/api/programs", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setItems(j.items || []);
    } catch {}
  }
  useEffect(() => { reload(); }, []);

  const studentMap = useMemo(() => {
    const m = new Map();
    for (const s of (E.ADDED_STUDENTS || [])) m.set(s.id, s);
    return m;
  }, [E.ADDED_STUDENTS]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((p) => {
      if (filterCategory !== "all" && p.category !== filterCategory) return false;
      if (filterStatus   !== "all" && p.status   !== filterStatus)   return false;
      if (term) {
        const blob = `${p.title || ""} ${p.venue || ""} ${p.organizer || ""} ${p.audienceLabel || ""}`.toLowerCase();
        if (!blob.includes(term)) return false;
      }
      return true;
    });
  }, [items, filterCategory, filterStatus, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filterCategory, filterStatus, q]);

  const counts = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: items.length,
      upcoming: items.filter((p) => p.status !== "cancelled" && String(p.startDate || "") >= today).length,
      completed: items.filter((p) => p.status === "completed").length,
      budget: items.reduce((a, p) => a + (Number(p.budgetPlanned) || 0), 0),
    };
  }, [items]);

  async function submitNew(payload) {
    const r = await fetch("/api/programs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowForm(false);
    flash("Program created", "ok");
    await reload();
    await refresh?.();
  }

  async function submitEdit(id, payload) {
    const r = await fetch("/api/programs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setEditing(null);
    flash("Program updated", "ok");
    await reload();
    await refresh?.();
  }

  async function setStatus(id, status) {
    setBusy(id);
    try {
      const r = await fetch("/api/programs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      flash(`Marked ${STATUS_LABEL[status] || status}`, "ok");
      await reload();
      await refresh?.();
    } catch (e) {
      flash(e.message || "Failed", "err");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id) {
    if (!confirm("Delete this program and its participant roster?")) return;
    setBusy(id);
    try {
      const r = await fetch("/api/programs", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      if (openId === id) setOpenId(null);
      flash("Deleted", "ok");
      await reload();
      await refresh?.();
    } catch (e) {
      flash(e.message || "Failed", "err");
    } finally {
      setBusy(null);
    }
  }

  const school = resolveSchool(E.SETTINGS);
  const actor  = session?.name || null;

  function exportPdf() {
    downloadPdf({
      title: "School Programs",
      subtitle: `${filtered.length} program${filtered.length === 1 ? "" : "s"}`,
      school, actor,
      dateRange: "Current snapshot",
      orientation: "landscape",
      summary: [
        { label: "Total",     value: filtered.length },
        { label: "Completed", value: filtered.filter((p) => p.status === "completed").length },
        { label: "Planned",   value: filtered.filter((p) => p.status === "planned").length },
        { label: "Budget planned", value: money(filtered.reduce((a, p) => a + (Number(p.budgetPlanned) || 0), 0)) },
      ],
      columns: [
        { key: "i",        label: "#",        align: "right",  width: "32px" },
        { key: "id",       label: "ID",       width: "110px" },
        { key: "title",    label: "Program" },
        { key: "category", label: "Category", align: "center", width: "90px" },
        { key: "dates",    label: "Dates",    width: "130px" },
        { key: "venue",    label: "Venue" },
        { key: "organizer",label: "Organiser" },
        { key: "status",   label: "Status",   align: "center", width: "80px" },
        { key: "budget",   label: "Budget",   align: "right",  width: "90px" },
      ],
      rows: filtered.map((p, i) => ({
        i: i + 1, id: p.id,
        title: p.title || "—",
        category: CATEGORY_LABEL[p.category] || p.category || "—",
        dates: dateRangeLabel(p),
        venue: p.venue || "—",
        organizer: p.organizer || "—",
        status: STATUS_LABEL[p.status] || p.status || "—",
        budget: money(p.budgetPlanned),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-programs-${new Date().toISOString().slice(0, 10)}`,
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
          <div className="page-eyebrow">Operations · Events</div>
          <div className="page-title">School <span className="amber">programs</span></div>
          <div className="page-sub">
            {isParent
              ? "Events the school is running — sports day, competitions, workshops and excursions."
              : "Every event the school conducts, with its participant roster, day-of attendance and results. Budgets here are for planning only — actual spend lives in the expenses ledger."}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportPdf} disabled={filtered.length === 0} title="Open a printable, branded PDF report">
            <Icon name="download" size={13} />Export PDF
          </button>
          {canManage && (
            <button className="btn accent" onClick={() => setShowForm(true)}>
              <Icon name="plus" size={13} />New program
            </button>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 18 }}>
        <KPI label="Programs" value={counts.total} sub="on record" puck="cream" puckIcon="calendar" />
        <KPI label="Upcoming" value={counts.upcoming} sub="today or later" puck="sky" puckIcon="clock" />
        <KPI label="Completed" value={counts.completed} sub="wrapped up" puck="mint" puckIcon="check" />
        <KPI label="Budget planned" value={money(counts.budget)} sub="informational only" puck="peach" puckIcon="money" />
      </div>

      <div className="card" style={{ marginBottom: 14, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          placeholder="Search program, venue, organiser…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select className="select" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => <option key={c.k} value={c.k}>{c.label}</option>)}
        </select>
        <select className="select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{filtered.length} program{filtered.length === 1 ? "" : "s"}</div>
            <div className="card-sub">Page {page} of {totalPages}</div>
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="empty" style={{ padding: 36 }}>No programs recorded yet.</div>
        ) : (
          <div>
            {paged.map((p) => (
              <div key={p.id} className="lrow" style={{ alignItems: "flex-start", gap: 12, paddingTop: 12, paddingBottom: 12, flexWrap: "wrap" }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name={CATEGORY_ICON[p.category] || "calendar"} size={16} />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{p.title}</span>
                    <span className={`chip ${CATEGORY_TONE[p.category] || "info"}`}>
                      {CATEGORY_LABEL[p.category] || p.category}
                    </span>
                    <span className={`chip ${STATUS_TONE[p.status] || "info"}`}>
                      <span className="dot" />{STATUS_LABEL[p.status] || p.status}
                    </span>
                    {p.audienceLabel && <span className="chip">{p.audienceLabel}</span>}
                  </div>
                  {p.description && (
                    <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 5, fontWeight: 700 }}>
                      {p.description}
                    </div>
                  )}
                  <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 3, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>{dateRangeLabel(p)}</span>
                    {p.venue && <span>{p.venue}</span>}
                    {p.organizer && <span>Organiser: {p.organizer}</span>}
                    {(p.budgetPlanned > 0 || p.budgetActual > 0) && (
                      <span>Budget {money(p.budgetPlanned)}{p.budgetActual > 0 ? ` · spent ${money(p.budgetActual)}` : ""}</span>
                    )}
                    <span>{p.id}</span>
                  </div>
                  {p.outcome && (
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 5, fontWeight: 700 }}>
                      Outcome: {p.outcome}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                  <button className="btn sm" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                    {openId === p.id ? "Hide roster" : "Participants"}
                  </button>
                  {canManage && (
                    <>
                      <button className="btn sm" onClick={() => setEditing(p)} disabled={busy === p.id}>Edit</button>
                      {p.status === "planned" && (
                        <button className="btn sm" onClick={() => setStatus(p.id, "ongoing")} disabled={busy === p.id}>Start</button>
                      )}
                      {(p.status === "planned" || p.status === "ongoing") && (
                        <button className="btn sm" onClick={() => setStatus(p.id, "completed")} disabled={busy === p.id}>Complete</button>
                      )}
                      <button className="btn sm" onClick={() => remove(p.id)} disabled={busy === p.id}>Delete</button>
                    </>
                  )}
                </div>
                {openId === p.id && (
                  <div style={{ flexBasis: "100%", marginTop: 10 }}>
                    <Roster
                      programId={p.id}
                      students={E.ADDED_STUDENTS || []}
                      studentMap={studentMap}
                      canManage={canManage}
                      canMark={canManage || isTeacher}
                      flash={flash}
                    />
                  </div>
                )}
              </div>
            ))}
            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: 12, borderTop: "1px solid var(--rule)" }}>
                <button className="btn sm" onClick={() => setPage((pg) => Math.max(1, pg - 1))} disabled={page === 1}>← Previous</button>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px" }}>{page} / {totalPages}</span>
                <button className="btn sm" onClick={() => setPage((pg) => Math.min(totalPages, pg + 1))} disabled={page === totalPages}>Next →</button>
              </div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <ProgramModal
          students={E.ADDED_STUDENTS || []}
          onClose={() => setShowForm(false)}
          onSubmit={submitNew}
        />
      )}
      {editing && (
        <ProgramModal
          program={editing}
          students={E.ADDED_STUDENTS || []}
          onClose={() => setEditing(null)}
          onSubmit={(payload) => submitEdit(editing.id, payload)}
        />
      )}
    </div>
  );
}

// Roster is fetched per-program rather than carried in the bootstrap
// payload — a school year of sports days would otherwise push thousands of
// participant rows into every page load.
function Roster({ programId, students, studentMap, canManage, canMark, flash }) {
  const [rows, setRows] = useState(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      const r = await fetch(`/api/programs?id=${encodeURIComponent(programId)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      setRows(j?.ok ? (j.program?.participants || []) : []);
    } catch { setRows([]); }
  }
  useEffect(() => { load(); }, [programId]);

  async function patchParticipant(studentId, patch) {
    setBusy(studentId);
    try {
      const r = await fetch("/api/programs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: programId, studentId, ...patch }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      setRows((rs) => (rs || []).map((x) => (x.studentId === studentId ? { ...x, ...patch } : x)));
    } catch (e) {
      flash(e.message || "Failed", "err");
    } finally {
      setBusy(null);
    }
  }

  async function saveRoster(studentIds) {
    const r = await fetch("/api/programs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: programId, studentIds }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setRows(j.participants || []);
    setPicking(false);
    flash("Roster saved", "ok");
  }

  if (rows === null) {
    return <div className="empty" style={{ padding: 18 }}>Loading roster…</div>;
  }

  const present = rows.filter((r) => r.attendance === "present").length;

  return (
    <div className="card" style={{ background: "var(--surface-2, transparent)" }}>
      <div className="card-head">
        <div>
          <div className="card-title">{rows.length} participant{rows.length === 1 ? "" : "s"}</div>
          <div className="card-sub">{present} marked present</div>
        </div>
        {canManage && (
          <button className="btn sm accent" onClick={() => setPicking(true)}>
            <Icon name="plus" size={12} />Edit roster
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: 22 }}>No participants on the roster yet.</div>
      ) : (
        <div>
          {rows.map((r) => {
            const s = studentMap.get(r.studentId);
            return (
              <div key={r.studentId} className="lrow" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{s?.name || r.studentId}</div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 700 }}>
                    {s?.cls ? formatClassLabel(s.cls) : r.studentId}
                    {r.role && r.role !== "participant" ? ` · ${r.role}` : ""}
                  </div>
                </div>
                {canMark ? (
                  <>
                    <select
                      className="select"
                      value={r.attendance || "pending"}
                      disabled={busy === r.studentId}
                      onChange={(e) => patchParticipant(r.studentId, { attendance: e.target.value })}
                      style={{ width: 110 }}
                    >
                      {ATTENDANCE.map((a) => <option key={a.k} value={a.k}>{a.label}</option>)}
                    </select>
                    <input
                      className="input"
                      placeholder="Result"
                      defaultValue={r.result || ""}
                      disabled={busy === r.studentId}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (r.result || "")) patchParticipant(r.studentId, { result: v || null });
                      }}
                      style={{ width: 150 }}
                    />
                    <input
                      className="input"
                      type="number"
                      min={1}
                      placeholder="Pos"
                      defaultValue={r.position ?? ""}
                      disabled={busy === r.studentId}
                      onBlur={(e) => {
                        const v = e.target.value === "" ? null : Number(e.target.value);
                        if (v !== (r.position ?? null)) patchParticipant(r.studentId, { position: v });
                      }}
                      style={{ width: 70 }}
                    />
                  </>
                ) : (
                  <>
                    <span className={`chip ${r.attendance === "present" ? "ok" : r.attendance === "absent" ? "err" : "info"}`}>
                      {r.attendance || "pending"}
                    </span>
                    {r.result && <span className="chip">{r.result}</span>}
                    {r.position != null && <span className="chip warn">#{r.position}</span>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {picking && (
        <RosterPicker
          students={students}
          selected={rows.map((r) => r.studentId)}
          onClose={() => setPicking(false)}
          onSave={saveRoster}
        />
      )}
    </div>
  );
}

function RosterPicker({ students, selected, onClose, onSave }) {
  const [picked, setPicked] = useState(() => new Set(selected));
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const classes = useMemo(
    () => [...new Set(students.map((s) => s.cls).filter(Boolean))].sort(),
    [students]
  );

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return students.filter((s) => {
      if (cls !== "all" && s.cls !== cls) return false;
      if (term && !`${s.name || ""} ${s.id}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [students, q, cls]);

  const toggle = (id) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Adds the filtered set without clearing picks made under another filter —
  // a roster is usually built class by class.
  const addShown = () => setPicked((p) => new Set([...p, ...shown.map((s) => s.id)]));

  async function save() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await onSave([...picked]);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      zIndex: 250, display: "grid", placeItems: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 560, maxHeight: "calc(100vh - 32px)", display: "flex", flexDirection: "column" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Pick participants</div>
            <div className="card-sub">{picked.size} selected · attendance and results already recorded are kept.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "10px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--rule)" }}>
          <input className="input" placeholder="Search student…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 150 }} />
          <select className="select" value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="all">All classes</option>
            {classes.map((c) => <option key={c} value={c}>{formatClassLabel(c)}</option>)}
          </select>
          <button type="button" className="btn sm" onClick={addShown} disabled={shown.length === 0}>Add all shown</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {shown.length === 0 ? (
            <div className="empty" style={{ padding: 28 }}>No students match.</div>
          ) : shown.map((s) => (
            <label key={s.id} className="lrow" style={{ gap: 10, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{s.name}</span>
              <span className="chip">{formatClassLabel(s.cls)}</span>
            </label>
          ))}
        </div>
        {err && <div style={{ background: "var(--bad-soft, #fbe1d8)", color: "var(--bad, #b13c1c)", margin: "10px 14px 0", padding: "9px 12px", borderRadius: 7, fontSize: 12, fontWeight: 700 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: 14 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn accent" onClick={save} disabled={busy}>
            {busy ? "Saving…" : <><Icon name="check" size={13} />Save roster</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgramModal({ program, students, onClose, onSubmit }) {
  const today = new Date().toISOString().slice(0, 10);
  const isEdit = !!program;
  const [form, setForm] = useState({
    title:         program?.title || "",
    category:      program?.category || "sports",
    description:   program?.description || "",
    startDate:     program?.startDate || today,
    endDate:       program?.endDate || "",
    venue:         program?.venue || "",
    organizer:     program?.organizer || "",
    audienceLabel: program?.audienceLabel || "",
    status:        program?.status || "planned",
    budgetPlanned: program?.budgetPlanned ?? 0,
    budgetActual:  program?.budgetActual ?? 0,
    outcome:       program?.outcome || "",
    notes:         program?.notes || "",
  });
  // Only offered at creation; afterwards the roster is edited from the
  // program row itself so attendance already taken isn't at risk.
  const [pickAll, setPickAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.title.trim()) { setErr("Program title required"); return; }
    if (!form.startDate)    { setErr("Start date required"); return; }
    if (form.endDate && form.endDate < form.startDate) {
      setErr("End date can't be before the start date"); return;
    }
    setBusy(true); setErr("");
    try {
      await onSubmit({
        ...form,
        title: form.title.trim(),
        endDate: form.endDate || null,
        budgetPlanned: Number(form.budgetPlanned) || 0,
        budgetActual:  Number(form.budgetActual) || 0,
        ...(isEdit || !pickAll ? {} : { studentIds: students.map((s) => s.id) }),
      });
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      zIndex: 250, display: "grid", placeItems: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 580, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">{isEdit ? "Edit program" : "New program"}</div>
            <div className="card-sub">Sports day, competitions, workshops, excursions, celebrations.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Title *">
            <input className="input" required maxLength={140} value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Annual Sports Day 2026" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Category">
              <select className="select" value={form.category} onChange={(e) => set("category", e.target.value)}>
                {CATEGORIES.map((c) => <option key={c.k} value={c.k}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className="select" value={form.status} onChange={(e) => set("status", e.target.value)}>
                {STATUSES.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Start date *">
              <input type="date" className="input" required value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
            </Field>
            <Field label="End date" hint="Leave blank for a single-day event.">
              <input type="date" className="input" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Venue">
              <input className="input" maxLength={120} value={form.venue} onChange={(e) => set("venue", e.target.value)} placeholder="e.g. School ground" />
            </Field>
            <Field label="Organiser">
              <input className="input" maxLength={120} value={form.organizer} onChange={(e) => set("organizer", e.target.value)} placeholder="Staff member in charge" />
            </Field>
          </div>
          <Field label="Audience" hint="Who it's for, in words — e.g. “Classes VI–VIII”.">
            <input className="input" maxLength={120} value={form.audienceLabel} onChange={(e) => set("audienceLabel", e.target.value)} />
          </Field>
          <Field label="Description">
            <textarea className="input" rows={2} maxLength={600} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Budget planned (₹)" hint="Planning figure only — no expense row is created.">
              <input type="number" min={0} className="input" value={form.budgetPlanned} onChange={(e) => set("budgetPlanned", e.target.value)} />
            </Field>
            <Field label="Budget actual (₹)" hint="Record actual spend in the expenses ledger too.">
              <input type="number" min={0} className="input" value={form.budgetActual} onChange={(e) => set("budgetActual", e.target.value)} />
            </Field>
          </div>
          <Field label="Outcome" hint="Fill in after the event — what happened, who won.">
            <textarea className="input" rows={2} maxLength={600} value={form.outcome} onChange={(e) => set("outcome", e.target.value)} />
          </Field>
          <Field label="Notes">
            <textarea className="input" rows={2} maxLength={600} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          {!isEdit && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>
              <input type="checkbox" checked={pickAll} onChange={(e) => setPickAll(e.target.checked)} />
              Add every student to the roster ({students.length})
            </label>
          )}
          {err && <div style={{ background: "var(--bad-soft, #fbe1d8)", color: "var(--bad, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12, fontWeight: 700 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy}>
              {busy ? "Saving…" : <><Icon name="check" size={13} />Save</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-3)" }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 700 }}>{hint}</span>}
    </label>
  );
}
