"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { formatClassLabel } from "@/lib/format";
import { KPI, StatusChip } from "../ui";

// Three buckets every parent complaint falls into. Order matters — it's the
// order shown in the picker chips and the staff filter strip. The default
// assignee for each is used to auto-route the ticket on submission.
const COMPLAINT_CATEGORIES = [
  { key: "academic",     label: "Academic",     icon: "academic",  defaultAssignee: "Class Teacher" },
  { key: "non_academic", label: "Non-academic", icon: "complaint", defaultAssignee: "Admin Desk" },
  { key: "transport",    label: "Transport",    icon: "bus",       defaultAssignee: "Transport Coordinator" },
];
const CATEGORY_BY_KEY = Object.fromEntries(COMPLAINT_CATEGORIES.map((c) => [c.key, c]));

export default function ScreenComplaints({ E, refresh, role, session }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const isParent = role === "parent";
  const isStaff = role === "principal" || role === "teacher" || role === "admin" || role === "academic_director";

  const [status, setStatus] = useState("All");
  // Staff can filter the complaints register by category — parents only ever
  // see their own tickets so the chip strip is hidden from them.
  const [categoryFilter, setCategoryFilter] = useState("All");
  const complaints = E.COMPLAINTS || [];
  const filtered = useMemo(() => {
    let list = complaints;
    if (status !== "All") list = list.filter((c) => c.status === status);
    if (categoryFilter !== "All") list = list.filter((c) => (c.category || "non_academic") === categoryFilter);
    return list;
  }, [complaints, status, categoryFilter]);

  // Toast feedback
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  const child = isParent ? (E.ADDED_STUDENTS || [])[0] : null;
  const [showForm, setShowForm] = useState(false);
  const [showStaffLog, setShowStaffLog] = useState(false);
  const students = E.ADDED_STUDENTS || [];

  const change = async (id, newStatus) => {
    try {
      const r = await fetch("/api/complaints", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status: newStatus }),
      });
      const json = await r.json().catch(() => ({}));
      if (json.ok) { flash(`Complaint → ${newStatus}`); await refresh?.(); }
      else flash(json.error || "Update failed", "bad");
    } catch (e) { flash("Network error", "bad"); }
  };

  const submitNew = async (form) => {
    try {
      // Auto-route by category when the parent files a general complaint.
      // Leave requests bypass the category picker and always go to the
      // class teacher.
      const cat = form.type === "general" ? CATEGORY_BY_KEY[form.category] : null;
      const assignee = form.type === "leave_request"
        ? "Class Teacher"
        : (cat?.defaultAssignee || "Admin Desk");
      const r = await fetch("/api/complaints", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          student: child ? child.name : "",
          studentId: child ? child.id : null,
          cls: child ? child.cls : "",
          parent: form.parent || (child ? `Parent of ${child.name}` : ""),
          issue: form.issue,
          type: form.type,
          category: form.type === "general" ? form.category : null,
          submittedBy: "parent",
          assigned: assignee,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (json.ok) {
        flash(form.type === "leave_request" ? "Leave request submitted" : "Complaint submitted");
        await refresh?.();
        setShowForm(false);
      } else flash(json.error || "Could not submit", "bad");
    } catch (e) { flash("Network error", "bad"); }
  };

  // Staff (principal/admin/director/teacher) logs a complaint on behalf of a
  // walk-in or phone-call parent. Picks the student from the roster.
  const submitStaffLog = async (form) => {
    try {
      const stu = students.find((s) => s.id === form.studentId);
      const cat = form.type === "general" ? CATEGORY_BY_KEY[form.category] : null;
      const r = await fetch("/api/complaints", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          student: stu?.name || "—",
          studentId: stu?.id || null,
          cls: stu?.cls || "",
          parent: form.parent || (stu ? `Parent of ${stu.name}` : "Walk-in"),
          issue: form.issue,
          type: form.type,
          category: form.type === "general" ? form.category : null,
          submittedBy: role,
          assigned: form.assigned || (form.type === "leave_request"
            ? "Class Teacher"
            : (cat?.defaultAssignee || "Admin Desk")),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (json.ok) {
        flash("Complaint logged");
        setShowStaffLog(false);
        await refresh?.();
      } else flash(json.error || "Could not log", "bad");
    } catch (e) { flash("Network error", "bad"); }
  };

  const exportPdf = () => {
    if (complaints.length === 0) { flash("Nothing to export", "bad"); return; }
    const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const rows = filtered.length ? filtered : complaints;
    downloadPdf({
      title: `Parent Complaints · ${status}`,
      subtitle: `${rows.length} complaint${rows.length === 1 ? "" : "s"} · current snapshot`,
      school, actor,
      dateRange: today,
      orientation: "landscape",
      summary: [
        { label: "Open",        value: complaints.filter((c) => c.status === "Open").length },
        { label: "In progress", value: complaints.filter((c) => c.status === "In Progress").length },
        { label: "Resolved",    value: complaints.filter((c) => c.status === "Resolved").length },
        { label: "Total",       value: complaints.length },
      ],
      columns: [
        { key: "i",        label: "#",        align: "right",  width: "32px" },
        { key: "id",       label: "ID",       width: "90px" },
        { key: "student",  label: "Student" },
        { key: "cls",      label: "Class",    align: "center", width: "60px" },
        { key: "parent",   label: "Parent" },
        { key: "category", label: "Category", width: "110px" },
        { key: "issue",    label: "Issue" },
        { key: "assigned", label: "Assigned to" },
        { key: "status",   label: "Status",   align: "center", width: "100px" },
        { key: "date",     label: "Date",     align: "right",  width: "90px" },
      ],
      rows: rows.map((c, i) => ({
        i: i + 1, id: c.id,
        student: c.student || "—", cls: c.cls || "—",
        parent: c.parent || "—",
        category: c.category ? (CATEGORY_BY_KEY[c.category]?.label || c.category) : "—",
        issue: c.issue || "—",
        assigned: c.assigned || "—",
        status: c.status || "—",
        date: c.date || "—",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-complaints-${status.toLowerCase().replace(" ", "-")}-${today.replace(/\s+/g, "-").toLowerCase()}`,
    });
    flash(`Opened PDF preview · ${rows.length} complaint${rows.length === 1 ? "" : "s"}`);
  };

  return (
    <div className="page">
      <Toast toast={toast} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">{isParent ? "Family · Raise query" : "CRM · Complaints"}</div>
          <div className="page-title">
            {isParent ? <>Talk to <span className="amber">the school</span></> : <>Parent <span className="amber">complaints</span></>}
          </div>
          <div className="page-sub">
            {isParent
              ? "Raise a concern, or submit a leave request for your child. We respond as soon as possible."
              : "Open · in progress · resolved · auto-routed by category"}
          </div>
        </div>
        <div className="page-actions">
          {isParent ? (
            <button className="btn accent" onClick={() => setShowForm(true)}><Icon name="plus" size={13} />New query</button>
          ) : (
            <>
              <button className="btn" onClick={exportPdf} disabled={complaints.length === 0} title="Open a printable, branded PDF report">
                <Icon name="download" size={13} />Export PDF
              </button>
              {isStaff && (
                <button className="btn accent" onClick={() => setShowStaffLog(true)}>
                  <Icon name="plus" size={13} />Log complaint
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {(() => {
          const open = complaints.filter((c) => c.status === "Open");
          const inProg = complaints.filter((c) => c.status === "In Progress");
          const resolved = complaints.filter((c) => c.status === "Resolved");
          const leaves = complaints.filter((c) => c.type === "leave_request");
          const itemFor = (c, tone) => ({
            label: c.issue?.slice(0, 50) || "—",
            value: formatClassLabel(c.cls),
            sub: `${c.student || ""}${c.date ? ` · ${c.date}` : ""}`,
            tone,
          });
          return (
            <>
              <KPI
                label={isParent ? "My open" : "Open"} value={open.length} sub="needs action"
                puck="rose" puckIcon="warning"
                details={{
                  title: `Open · ${open.length}`,
                  sub: open.length === 0 ? "Nothing open right now" : "Awaiting first response",
                  items: open.map((c) => itemFor(c, "bad")),
                }}
              />
              <KPI
                label="In progress" value={inProg.length} sub="being handled"
                puck="peach" puckIcon="clock"
                details={{
                  title: `In progress · ${inProg.length}`,
                  sub: inProg.length === 0 ? "Nothing actively being worked" : "Being handled",
                  items: inProg.map((c) => itemFor(c, "warn")),
                }}
              />
              <KPI
                label="Resolved" value={resolved.length} sub="closed out"
                puck="mint" puckIcon="check"
                details={{
                  title: `Resolved · ${resolved.length}`,
                  sub: "Recently closed",
                  items: resolved.slice(0, 12).map((c) => itemFor(c, "ok")),
                }}
              />
              <KPI
                label={isParent ? "Leave requests" : "Parent CSAT"}
                value={isParent ? leaves.length : "—"}
                sub={isParent ? "submitted by you" : "needs survey data"}
                puck="cream" puckIcon={isParent ? "calendar" : "heart"}
                details={isParent ? {
                  title: `Leave requests · ${leaves.length}`,
                  sub: "Tickets filed as leave requests",
                  items: leaves.map((c) => itemFor(c, c.status === "Resolved" ? "ok" : "warn")),
                } : undefined}
              />
            </>
          );
        })()}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{isParent ? "Your queries" : "Complaint queue"}</div>
            <div className="card-sub">{isParent ? "Queries you've raised, with their current status" : "Auto-routed by category"}</div>
          </div>
          <div className="card-actions">
            <div className="segmented">
              {["All", "Open", "In Progress", "Resolved"].map((s) => (
                <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>{s}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Category filter strip — staff only. Counts reflect the underlying
            complaints array, not the currently-filtered view, so toggling a
            category never makes its own pill go to zero. */}
        {!isParent && (
          <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--rule-2)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, marginRight: 4 }}>
              Category
            </span>
            <button
              onClick={() => setCategoryFilter("All")}
              className={`chip ${categoryFilter === "All" ? "accent" : ""}`}
              style={{ cursor: "pointer", padding: "4px 10px" }}
            >
              All · {complaints.length}
            </button>
            {COMPLAINT_CATEGORIES.map((cat) => {
              const n = complaints.filter((c) => (c.category || "non_academic") === cat.key).length;
              return (
                <button
                  key={cat.key}
                  onClick={() => setCategoryFilter(cat.key)}
                  className={`chip ${categoryFilter === cat.key ? "accent" : ""}`}
                  style={{ cursor: "pointer", padding: "4px 10px" }}
                >
                  <Icon name={cat.icon} size={10} />{cat.label} · {n}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                {!isParent && <th>Student · Parent</th>}
                <th>Type</th>
                <th>Category</th>
                <th>Issue</th>
                {!isParent && <th>Assigned</th>}
                <th>Date</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={isParent ? 7 : 9} className="empty">
                  {isParent
                    ? `You haven't raised any queries yet. Click "New query" to start.`
                    : "No complaints match this filter."}
                </td></tr>
              )}
              {filtered.map((c) => {
                const cat = c.category ? CATEGORY_BY_KEY[c.category] : null;
                return (
                <tr key={c.id}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>{c.id}</td>
                  {!isParent && (
                    <td>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{c.student} <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>{formatClassLabel(c.cls)}</span></div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{c.parent}</div>
                    </td>
                  )}
                  <td>
                    {c.type === "leave_request"
                      ? <span className="chip info"><Icon name="calendar" size={10} />Leave</span>
                      : <span className="chip"><span className="dot" />Issue</span>}
                  </td>
                  <td>
                    {cat
                      ? <span className="chip"><Icon name={cat.icon} size={10} />{cat.label}</span>
                      : <span style={{ fontSize: 11, color: "var(--ink-4)" }}>—</span>}
                  </td>
                  <td style={{ fontSize: 13, maxWidth: 360 }}>{c.issue}</td>
                  {!isParent && <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.assigned}</td>}
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.date}</td>
                  <td><StatusChip status={c.status} /></td>
                  <td>
                    {isStaff && (
                      <div style={{ display: "flex", gap: 4 }}>
                        {c.status === "Open" && <button className="btn sm" onClick={() => change(c.id, "In Progress")}>Start</button>}
                        {c.status === "In Progress" && <button className="btn sm accent" onClick={() => change(c.id, "Resolved")}>Resolve</button>}
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && child && (
        <NewTicketModal
          child={child}
          onClose={() => setShowForm(false)}
          onSubmit={submitNew}
        />
      )}
      {showForm && !child && (
        <NewTicketModal
          child={{ id: null, name: "", cls: "" }}
          onClose={() => setShowForm(false)}
          onSubmit={submitNew}
        />
      )}
      {showStaffLog && isStaff && (
        <StaffLogModal
          students={students}
          onClose={() => setShowStaffLog(false)}
          onSubmit={submitStaffLog}
        />
      )}
    </div>
  );
}


// ---------- log complaint modal (staff side) ----------
// Used when a parent walks in or calls — staff records the complaint on
// their behalf, picking the student from the live roster so it links.
function StaffLogModal({ students, onClose, onSubmit }) {
  const [type, setType] = useState("general");
  const [category, setCategory] = useState("academic");
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [parent, setParent] = useState("");
  const [issue, setIssue] = useState("");
  const [assigned, setAssigned] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stu = students.find((s) => s.id === studentId);

  const submit = async (e) => {
    e.preventDefault();
    if (!issue.trim()) { setErr("Describe the issue"); return; }
    if (!studentId) { setErr("Pick a student"); return; }
    setErr("");
    setBusy(true);
    try {
      const cat = type === "general" ? CATEGORY_BY_KEY[category] : null;
      await onSubmit({
        studentId, type,
        category: type === "general" ? category : null,
        issue: issue.trim(),
        parent: parent.trim() || (stu ? `Parent of ${stu.name}` : "Walk-in"),
        assigned: assigned.trim() || (type === "leave_request"
          ? "Class Teacher"
          : (cat?.defaultAssignee || "Admin Desk")),
      });
    } catch (ex) { setErr(ex.message || String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 560, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Log complaint</div>
            <div className="card-sub">Walk-in or phone-call complaint · routed to the assignee</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Type">
            <div className="segmented">
              <button type="button" className={type === "general" ? "active" : ""} onClick={() => setType("general")}>
                <Icon name="complaint" size={11} />Complaint / issue
              </button>
              <button type="button" className={type === "leave_request" ? "active" : ""} onClick={() => setType("leave_request")}>
                <Icon name="calendar" size={11} />Leave request
              </button>
            </div>
          </Field>
          {type === "general" && (
            <Field label="Category *">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {COMPLAINT_CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => setCategory(cat.key)}
                    className={`chip ${category === cat.key ? "accent" : ""}`}
                    style={{ cursor: "pointer", padding: "6px 12px" }}
                  >
                    <Icon name={cat.icon} size={11} />{cat.label}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Student *">
            {students.length === 0 ? (
              <div className="empty" style={{ padding: 12, fontSize: 12 }}>
                No students on the roster yet. Add students from the Students screen first.
              </div>
            ) : (
              <select className="select" value={studentId} onChange={(e) => setStudentId(e.target.value)} autoFocus>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {formatClassLabel(s.cls)} · {s.id}</option>
                ))}
              </select>
            )}
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Parent name (optional)">
              <input className="input" value={parent} onChange={(e) => setParent(e.target.value)} placeholder={stu ? `Parent of ${stu.name}` : "Parent"} />
            </Field>
            <Field label="Assign to">
              <input
                className="input"
                value={assigned}
                onChange={(e) => setAssigned(e.target.value)}
                placeholder={type === "leave_request"
                  ? "Class Teacher"
                  : (CATEGORY_BY_KEY[category]?.defaultAssignee || "Admin Desk")}
              />
            </Field>
          </div>
          <Field label={type === "leave_request" ? "Reason and dates" : "Describe the issue"}>
            <textarea
              className="input"
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              style={{ width: "100%", height: 96, padding: "8px 10px", lineHeight: 1.5, resize: "vertical", fontFamily: "var(--font-sans)" }}
              placeholder={type === "leave_request"
                ? "e.g. Family wedding 24-26 May, please grant 3 days leave"
                : "What happened? When? Any details that help us act."}
            />
          </Field>

          {err && (
            <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !issue.trim() || !studentId}>
              <Icon name="check" size={13} />{busy ? "Logging…" : "Log complaint"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- new ticket modal (parent) ----------
function NewTicketModal({ child, onClose, onSubmit }) {
  const [type, setType] = useState("general");
  // Category only applies to general complaints — leave requests skip it
  // and go straight to the class teacher.
  const [category, setCategory] = useState("academic");
  const [issue, setIssue] = useState("");
  const [parentName, setParentName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (!issue.trim()) return;
    setBusy(true);
    try {
      await onSubmit({
        type,
        category: type === "general" ? category : null,
        issue: issue.trim(),
        parent: parentName.trim() || (child.name ? `Parent of ${child.name}` : "Parent"),
      });
    } finally { setBusy(false); }
  };

  const routedTo = type === "leave_request" ? "Class Teacher" : (CATEGORY_BY_KEY[category]?.defaultAssignee || "Admin Desk");

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 520 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{type === "leave_request" ? "Submit a leave request" : "Raise a query"}</div>
            <div className="card-sub">{child.name ? `${child.name} · ${formatClassLabel(child.cls)}` : "For your child"}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Type">
            <div className="segmented">
              <button type="button" className={type === "general" ? "active" : ""} onClick={() => setType("general")}>
                <Icon name="complaint" size={11} />Complaint / issue
              </button>
              <button type="button" className={type === "leave_request" ? "active" : ""} onClick={() => setType("leave_request")}>
                <Icon name="calendar" size={11} />Leave request
              </button>
            </div>
          </Field>
          {type === "general" && (
            <Field label="Category *">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {COMPLAINT_CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => setCategory(cat.key)}
                    className={`chip ${category === cat.key ? "accent" : ""}`}
                    style={{ cursor: "pointer", padding: "6px 12px" }}
                  >
                    <Icon name={cat.icon} size={11} />{cat.label}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Your name (optional)">
            <input className="input" value={parentName} onChange={(e) => setParentName(e.target.value)} placeholder={child.name ? `Parent of ${child.name}` : "Your name"} />
          </Field>
          <Field label={type === "leave_request" ? "Reason and dates" : "Describe the issue"}>
            <textarea
              className="input"
              autoFocus
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              style={{ width: "100%", height: 96, padding: "8px 10px", lineHeight: 1.5, resize: "vertical", fontFamily: "var(--font-sans)" }}
              placeholder={type === "leave_request"
                ? "e.g. Family wedding 24-26 May, please grant 3 days leave"
                : "What happened? When? Any details that help the school act."}
            />
          </Field>
          <div style={{ background: "var(--card-2)", border: "1px solid var(--rule-2)", borderRadius: 9, padding: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
            This will be routed to <b>{routedTo}</b>. You'll see status updates (Open → In Progress → Resolved) on this page.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !issue.trim()}>
              <Icon name="send" size={13} />{busy ? "Submitting…" : "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{label}</span>
      {children}
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  const bg = toast.tone === "bad" ? "var(--bad)" : toast.tone === "warn" ? "var(--warn)" : "var(--ok)";
  return (
    <div style={{
      position: "fixed", top: 76, left: "50%", transform: "translateX(-50%)",
      zIndex: 300, background: bg, color: "#fff", padding: "10px 18px",
      borderRadius: 999, fontSize: 12.5, fontWeight: 500, boxShadow: "var(--shadow-lg)",
    }}>{toast.msg}</div>
  );
}
