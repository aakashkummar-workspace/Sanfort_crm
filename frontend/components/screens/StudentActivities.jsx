"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { formatClassLabel } from "@/lib/format";

const ACHIEVEMENT_LEVELS = [
  { k: "participation", label: "Participation",  tone: "info" },
  { k: "winner",        label: "Winner / 1st",   tone: "ok"   },
  { k: "runner_up",     label: "Runner up",      tone: "ok"   },
  { k: "third",         label: "3rd place",      tone: "warn" },
  { k: "honourable",    label: "Honourable mention", tone: "info" },
  { k: "selected",      label: "Selected / qualified", tone: "ok" },
];

const LEVEL_LABEL = Object.fromEntries(ACHIEVEMENT_LEVELS.map((l) => [l.k, l.label]));
const LEVEL_TONE  = Object.fromEntries(ACHIEVEMENT_LEVELS.map((l) => [l.k, l.tone]));

export default function ScreenStudentActivities({ E, role, session, refresh }) {
  const isManager = role === "admin" || role === "principal";
  const canWrite  = isManager || role === "academic_director" || role === "teacher";
  const isParent  = role === "parent";

  const [items, setItems] = useState(E.STUDENT_ACTIVITIES || []);
  const [filterStudent, setFilterStudent] = useState("all");
  const [filterLevel, setFilterLevel]     = useState("all");
  const [filterExt, setFilterExt]         = useState("all"); // all|external|internal
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2400);
  };

  async function reload() {
    try {
      const r = await fetch("/api/student-activities", { cache: "no-store" });
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
  const nameOf = (a) => studentMap.get(a.studentId)?.name || a.studentId;
  const clsOf  = (a) => studentMap.get(a.studentId)?.cls || null;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((a) => {
      if (filterStudent !== "all" && a.studentId !== filterStudent) return false;
      if (filterLevel   !== "all" && a.achievementLevel !== filterLevel) return false;
      if (filterExt === "external" && !a.externalCompetition) return false;
      if (filterExt === "internal" &&  a.externalCompetition) return false;
      if (term) {
        const blob = `${nameOf(a)} ${clsOf(a) || ""} ${a.activityName || ""} ${a.eventName || ""}`.toLowerCase();
        if (!blob.includes(term)) return false;
      }
      return true;
    });
  }, [items, filterStudent, filterLevel, filterExt, q, studentMap]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filterStudent, filterLevel, filterExt, q]);

  const counts = useMemo(() => ({
    total: items.length,
    external: items.filter((a) => a.externalCompetition).length,
    winners: items.filter((a) => ["winner", "runner_up", "third"].includes(a.achievementLevel)).length,
    students: new Set(items.map((a) => a.studentId)).size,
  }), [items]);

  async function submitNew(payload) {
    const r = await fetch("/api/student-activities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowForm(false);
    flash("Activity logged", "ok");
    await reload();
    await refresh?.();
  }

  async function remove(id) {
    if (!confirm("Remove this activity from the record?")) return;
    setBusy(id);
    try {
      const r = await fetch("/api/student-activities", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      flash("Removed", "ok");
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
      title: "Student Activities & Achievements",
      subtitle: `${filtered.length} record${filtered.length === 1 ? "" : "s"}`,
      school, actor,
      dateRange: "Current snapshot",
      orientation: "landscape",
      summary: [
        { label: "Total",          value: filtered.length },
        { label: "External events",value: filtered.filter((a) => a.externalCompetition).length },
        { label: "Distinct students", value: new Set(filtered.map((a) => nameOf(a))).size },
        { label: "Activities",     value: new Set(filtered.map((a) => a.activityName).filter(Boolean)).size },
      ],
      columns: [
        { key: "i",        label: "#",          align: "right",  width: "32px" },
        { key: "id",       label: "ID",         width: "100px" },
        { key: "student",  label: "Student" },
        { key: "cls",      label: "Class",      align: "center", width: "60px" },
        { key: "activity", label: "Activity" },
        { key: "event",    label: "Event" },
        { key: "level",    label: "Level",      align: "center", width: "100px" },
        { key: "external", label: "External",   align: "center", width: "70px" },
        { key: "date",     label: "Date",       align: "right",  width: "90px" },
      ],
      rows: filtered.map((a, i) => ({
        i: i + 1, id: a.id,
        student: nameOf(a) || "—",
        cls: clsOf(a) ? formatClassLabel(clsOf(a)) : "—",
        activity: a.activityName || "—",
        event: a.eventName || "—",
        level: LEVEL_LABEL[a.achievementLevel] || a.achievementLevel || "—",
        external: a.externalCompetition ? "Yes" : "No",
        date: a.activityDate || "—",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-student-activities-${new Date().toISOString().slice(0, 10)}`,
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
          <div className="page-eyebrow">Students · Recognition</div>
          <div className="page-title">Activities &amp; <span className="amber">achievements</span></div>
          <div className="page-sub">
            {isParent
              ? "Your child's extra-curricular log — sports, debates, science fair, external competitions."
              : "Log every student's extra-curricular work — internal events and external competitions, with achievement level and certificate links."}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportPdf} disabled={filtered.length === 0} title="Open a printable, branded PDF report">
            <Icon name="download" size={13} />Export PDF
          </button>
          {canWrite && (
            <button className="btn accent" onClick={() => setShowForm(true)}>
              <Icon name="plus" size={13} />Log activity
            </button>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 18 }}>
        <KPI label="Total activities" value={counts.total} sub="this term" puck="cream" puckIcon="academic" />
        <KPI label="External competitions" value={counts.external} sub="outside school" puck="peach" puckIcon="reports" />
        <KPI label="Winners / podium" value={counts.winners} sub="1st / 2nd / 3rd places" puck="mint" puckIcon="check" />
        <KPI label="Students recognised" value={counts.students} sub="distinct names on record" puck="sky" puckIcon="students" />
      </div>

      <div className="card" style={{ marginBottom: 14, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          placeholder="Search activity, event, student…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        {!isParent && (
          <select className="select" value={filterStudent} onChange={(e) => setFilterStudent(e.target.value)}>
            <option value="all">All students</option>
            {(E.ADDED_STUDENTS || []).map((s) => <option key={s.id} value={s.id}>{s.name} — {formatClassLabel(s.cls)}</option>)}
          </select>
        )}
        <select className="select" value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)}>
          <option value="all">All levels</option>
          {ACHIEVEMENT_LEVELS.map((l) => <option key={l.k} value={l.k}>{l.label}</option>)}
        </select>
        <select className="select" value={filterExt} onChange={(e) => setFilterExt(e.target.value)}>
          <option value="all">Internal &amp; external</option>
          <option value="external">External only</option>
          <option value="internal">Internal only</option>
        </select>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{filtered.length} record{filtered.length === 1 ? "" : "s"}</div>
            <div className="card-sub">Page {page} of {totalPages}</div>
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="empty" style={{ padding: 36 }}>No activities logged yet.</div>
        ) : (
          <div>
            {paged.map((a) => (
              <div key={a.id} className="lrow" style={{ alignItems: "flex-start", gap: 12, paddingTop: 12, paddingBottom: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name="academic" size={16} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{nameOf(a)}</span>
                    {clsOf(a) && <span className="chip">{formatClassLabel(clsOf(a))}</span>}
                    <span className={`chip ${LEVEL_TONE[a.achievementLevel] || "info"}`}>
                      <span className="dot" />{LEVEL_LABEL[a.achievementLevel] || a.achievementLevel}
                    </span>
                    {a.externalCompetition && <span className="chip warn">External</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 5, fontWeight: 700 }}>
                    {a.activityName}{a.eventName ? ` · ${a.eventName}` : ""}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 3, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {a.activityDate && <span>{a.activityDate}</span>}
                    <span>{a.id}</span>
                    {a.activityLink && (
                      <a href={a.activityLink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand, #1f3f8b)", fontWeight: 700 }}>
                        Event link →
                      </a>
                    )}
                    {a.certificateDocument && (
                      <a href={a.certificateDocument} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand, #1f3f8b)", fontWeight: 700 }}>
                        Certificate →
                      </a>
                    )}
                  </div>
                </div>
                {isManager && (
                  <button className="btn sm" onClick={() => remove(a.id)} disabled={busy === a.id} style={{ flexShrink: 0 }}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: 12, borderTop: "1px solid var(--rule)" }}>
                <button className="btn sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>← Previous</button>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px" }}>{page} / {totalPages}</span>
                <button className="btn sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next →</button>
              </div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <NewActivityModal
          students={E.ADDED_STUDENTS || []}
          onClose={() => setShowForm(false)}
          onSubmit={submitNew}
        />
      )}
    </div>
  );
}

function NewActivityModal({ students, onClose, onSubmit }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    studentId: students[0]?.id || "",
    activityName: "",
    eventName: "",
    achievementLevel: "participation",
    externalCompetition: false,
    activityLink: "",
    certificateDocument: "",
    activityDate: today,
  });
  // Pending certificate file the user has picked from disk. Uploaded
  // to /api/documents during submit; the returned doc URL is then
  // stamped onto the activity row as certificateDocument.
  const [certFile, setCertFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload  = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("Read failed"));
      fr.readAsDataURL(file);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.studentId)            { setErr("Pick a student"); return; }
    if (!form.activityName.trim())  { setErr("Activity name required"); return; }
    setBusy(true); setErr("");
    try {
      // Upload the certificate file first if one was chosen, then
      // hand the activity API the resulting URL.
      let certificateDocument = form.certificateDocument || null;
      if (certFile) {
        if (certFile.size > 2_000_000) {
          throw new Error("Certificate file must be under 2 MB");
        }
        const dataUrl = await fileToDataUrl(certFile);
        const r = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            entityType: "student",
            entityId: form.studentId,
            label: `Certificate · ${form.activityName.trim()}`,
            fileName: certFile.name,
            mimeType: certFile.type || "application/octet-stream",
            dataUrl,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || "Certificate upload failed");
        certificateDocument = `/api/documents/${j.document.id}`;
      }
      await onSubmit({ ...form, certificateDocument });
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      zIndex: 250, display: "grid", placeItems: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 540, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Log student activity</div>
            <div className="card-sub">Sports, debates, science fair, music — anything extra-curricular.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Student *">
            <select className="select" required value={form.studentId} onChange={(e) => set("studentId", e.target.value)}>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name} — {formatClassLabel(s.cls)}</option>)}
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Activity *">
              <input className="input" required maxLength={120} value={form.activityName} onChange={(e) => set("activityName", e.target.value)} placeholder="e.g. Inter-school chess" />
            </Field>
            <Field label="Event / venue">
              <input className="input" maxLength={120} value={form.eventName} onChange={(e) => set("eventName", e.target.value)} placeholder="e.g. South Zone Tournament" />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Achievement level">
              <select className="select" value={form.achievementLevel} onChange={(e) => set("achievementLevel", e.target.value)}>
                {ACHIEVEMENT_LEVELS.map((l) => <option key={l.k} value={l.k}>{l.label}</option>)}
              </select>
            </Field>
            <Field label="Date">
              <input type="date" className="input" value={form.activityDate} onChange={(e) => set("activityDate", e.target.value)} />
            </Field>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>
            <input
              type="checkbox"
              checked={form.externalCompetition}
              onChange={(e) => set("externalCompetition", e.target.checked)}
            />
            External competition (outside the school)
          </label>
          <Field label="Event link" hint="URL to the event page or news story.">
            <input className="input" value={form.activityLink} onChange={(e) => set("activityLink", e.target.value)} placeholder="https://…" />
          </Field>
          <Field label="Certificate" hint="Upload the scanned certificate (PDF or image, max 2 MB). Stored against the student's record.">
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setCertFile(e.target.files?.[0] || null)}
              style={{ fontSize: 12, fontWeight: 700, padding: "6px 0" }}
            />
            {certFile && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 11.5, color: "var(--ink-3)" }}>
                <Icon name="check" size={11} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {certFile.name} · {Math.round(certFile.size / 1024)} KB
                </span>
                <button type="button" className="btn sm ghost" onClick={() => setCertFile(null)}>Remove</button>
              </div>
            )}
          </Field>
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

