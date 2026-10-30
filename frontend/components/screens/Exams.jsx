"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

// The periodic tests + term exams get a dedicated class-teacher grid (below);
// they're also listed here so their type labels render across the exam
// roster/reports.
const PERIODIC_TESTS = [
  { k: "periodic_1", label: "Periodic Test I" },
  { k: "periodic_2", label: "Periodic Test II" },
  { k: "periodic_3", label: "Periodic Test III" },
  { k: "periodic_4", label: "Periodic Test IV" },
];
const TERM_EXAMS = [
  { k: "term_1", label: "Term I" },
  { k: "term_2", label: "Term II" },
];
const EXAM_TYPES = [
  ...PERIODIC_TESTS,
  ...TERM_EXAMS,
  { k: "unit_test",  label: "Unit test" },
  { k: "mid_term",   label: "Mid-term" },
  { k: "final",      label: "Final" },
  { k: "assignment", label: "Assignment" },
  { k: "practical",  label: "Practical" },
  { k: "project",    label: "Project" },
];
const TEACHER_ATT_STATUSES = [
  { k: "present", label: "Present", tone: "ok" },
  { k: "absent",  label: "Absent",  tone: "bad" },
  { k: "leave",   label: "Leave",   tone: "warn" },
];

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

function ModalShell({ title, sub, onClose, children, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: width, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">{title}</div>
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
    </label>
  );
}

// Combined screen: top tile lets the teacher self-mark today's attendance.
// Below: exam roster — create exams, click one to bulk-enter marks for the
// class. Principal/admin see all exams; teachers see only ones for their
// assigned classes (gated client-side, server is permissive on read).
export default function ScreenExams({ E, refresh, role, session }) {
  const isTeacher = role === "teacher";
  const isStaff   = role === "admin" || role === "principal" || role === "academic_director" || role === "teacher";
  const today = new Date().toISOString().slice(0, 10);

  const [toast, setToast] = useState(null);
  const showToast = (m, t) => { setToast({ msg: m, tone: t }); setTimeout(() => setToast(null), 3000); };
  const [showAddExam, setShowAddExam] = useState(false);
  const [marksFor, setMarksFor] = useState(null); // exam being filled
  const [todaysAttendance, setTodaysAttendance] = useState(null); // teacher's own row

  // Teachers care about their assigned classes; everyone else sees all.
  const myClasses = useMemo(() => {
    if (!isTeacher) return null;
    const arr = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
      ? session.linkedClasses
      : (session?.linkedId ? [session.linkedId] : []);
    return new Set(arr);
  }, [isTeacher, session]);

  const exams = useMemo(() => {
    const all = E.EXAMS || [];
    if (!myClasses) return all;
    return all.filter((e) => myClasses.has(e.cls));
  }, [E.EXAMS, myClasses]);

  // Fetch teacher's own attendance for today on mount (teachers only).
  useEffect(() => {
    if (!isTeacher) return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/teacher-attendance?fromDate=${today}&toDate=${today}`, { cache: "no-store" });
        const j = await r.json();
        if (!cancel && j.ok) setTodaysAttendance((j.records || [])[0] || null);
      } catch {}
    })();
    return () => { cancel = true; };
  }, [isTeacher, today]);

  async function selfMark(status) {
    try {
      const r = await fetch("/api/teacher-attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: today, status, source: "exams-strip" }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      setTodaysAttendance(j.record);
      showToast(`Marked ${status} for today`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  // Single POST. The modal calls this once per picked class and handles its
  // own close + summary toast after the loop finishes.
  async function handleCreateExam(payload) {
    const r = await fetch("/api/exams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    return j.exam;
  }

  async function handleRemoveExam(exam) {
    if (!confirm(`Remove "${exam.name}" and all its marks?`)) return;
    try {
      const r = await fetch("/api/exams", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: exam.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast("Exam removed", "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">Academics · Assessment</div>
          <div className="page-title">Exams & <span className="amber">Marks</span></div>
          <div className="page-sub">Create assessments · enter marks · auto-feeds the academic performance report</div>
        </div>
        <div className="page-actions">
          {isStaff && (
            <button className="btn accent" onClick={() => setShowAddExam(true)}>
              <Icon name="plus" size={13} />New exam
            </button>
          )}
        </div>
      </div>

      {/* Self-attendance tile for teachers */}
      {isTeacher && (
        <div className="card" style={{ marginBottom: 14, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>My attendance · {today}</div>
            <div style={{ fontSize: 16, fontWeight: 500, marginTop: 2 }}>
              {todaysAttendance
                ? <>You're marked <b style={{ color: todaysAttendance.status === "present" ? "var(--ok)" : todaysAttendance.status === "absent" ? "var(--bad)" : "var(--warn)" }}>{todaysAttendance.status}</b> today</>
                : "Not marked yet — pick one"}
            </div>
          </div>
          <div className="segmented">
            {TEACHER_ATT_STATUSES.map((s) => (
              <button
                key={s.k}
                className={todaysAttendance?.status === s.k ? "active" : ""}
                onClick={() => selfMark(s.k)}
              >{s.label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Periodic tests — class-teacher subject-wise grid */}
      {isStaff && (
        <PeriodicTests E={E} role={role} session={session} showToast={showToast} refresh={refresh} />
      )}

      {/* Exams roster */}
      <div className="card">
        <div className="card-head">
          <div><div className="card-title">Exams</div><div className="card-sub">{exams.length} on file{isTeacher && myClasses?.size ? ` · scoped to your classes (${[...myClasses].join(", ")})` : ""}</div></div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Date</th><th>Class</th><th>Subject</th><th>Exam</th><th>Type</th><th className="num">Max</th><th></th></tr></thead>
            <tbody>
              {exams.length === 0 && (
                <tr><td colSpan={7} className="empty">
                  No exams yet. {isStaff ? "Click \"New exam\" to add one." : "An assessment will appear here once a teacher creates it."}
                </td></tr>
              )}
              {exams.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{e.date}</td>
                  <td><span className="chip">{formatClassLabel(e.cls)}</span></td>
                  <td style={{ fontSize: 12 }}>{e.subject}</td>
                  <td style={{ fontSize: 12.5, fontWeight: 500 }}>{e.name}</td>
                  <td><span className="chip">{(EXAM_TYPES.find((t) => t.k === e.type) || { label: e.type }).label}</span></td>
                  <td className="num">{e.maxMarks}</td>
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      {isStaff && (
                        <button className="btn sm accent" onClick={() => setMarksFor(e)}><Icon name="pencil" size={11} />Marks</button>
                      )}
                      {isStaff && (
                        <button className="icon-btn" onClick={() => handleRemoveExam(e)} title="Remove"><Icon name="x" size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddExam && isStaff && (
        <AddExamModal
          classes={E.CLASSES || []}
          students={E.ADDED_STUDENTS || []}
          defaultClass={isTeacher && myClasses?.size ? [...myClasses][0] : ""}
          onClose={() => setShowAddExam(false)}
          onSubmit={handleCreateExam}
          onAllDone={async (n) => {
            setShowAddExam(false);
            showToast(`Created ${n} exam${n === 1 ? "" : "s"}`, "ok");
            await refresh?.();
          }}
        />
      )}
      {marksFor && isStaff && (
        <MarksEntryModal
          exam={marksFor}
          students={(E.ADDED_STUDENTS || []).filter((s) => s.cls === marksFor.cls)}
          onClose={() => setMarksFor(null)}
          onChanged={refresh}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// ---------- Periodic tests: class-teacher subject-wise grid ----------
// Pick a class + test (I–IV), then enter every student's mark for every
// subject in one grid. Backed by /api/exams/periodic (exams/exam_marks).
function PeriodicTests({ E, role, session, showToast, refresh }) {
  const isTeacher = role === "teacher";

  // Class options: teachers → their assigned classes; others → all classes.
  const classOptions = useMemo(() => {
    if (isTeacher) {
      const arr = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
        ? session.linkedClasses
        : (session?.linkedId ? [session.linkedId] : []);
      return [...new Set(arr)].filter(Boolean);
    }
    const out = [];
    (E.CLASSES || []).forEach((c) => (c.sections || ["A"]).forEach((s) => out.push(`${c.n}-${s}`)));
    return [...new Set(out)];
  }, [isTeacher, session, E.CLASSES]);

  const [cls, setCls] = useState(classOptions[0] || "");
  const [test, setTest] = useState("periodic_1");
  const [maxMarks, setMaxMarks] = useState(25);
  const [grid, setGrid] = useState(null);   // { subjects, students, marks }
  const [edits, setEdits] = useState({});   // { studentId: { subject: value } }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!cls && classOptions.length) setCls(classOptions[0]); }, [classOptions]); // eslint-disable-line

  async function loadGrid(targetCls = cls, targetTest = test) {
    if (!targetCls || !targetTest) return;
    setLoading(true); setEdits({});
    try {
      const r = await fetch(`/api/exams/periodic?cls=${encodeURIComponent(targetCls)}&test=${targetTest}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) { setGrid(j); setMaxMarks(j.maxMarks || 25); } else { setGrid(null); }
    } catch { setGrid(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadGrid(); }, [cls, test]); // eslint-disable-line

  const cellValue = (sid, subject) => {
    const e = edits[sid]?.[subject];
    if (e !== undefined) return e;
    const m = grid?.marks?.[sid]?.[subject];
    return m == null ? "" : String(m);
  };
  const setCell = (sid, subject, val) =>
    setEdits((p) => ({ ...p, [sid]: { ...(p[sid] || {}), [subject]: String(val).replace(/[^\d]/g, "") } }));

  async function save() {
    if (!grid) return;
    const entries = [];
    for (const sid of Object.keys(edits)) {
      const stu = grid.students.find((s) => s.id === sid);
      for (const sub of Object.keys(edits[sid])) {
        const v = edits[sid][sub];
        if (v === "") continue; // blank stays unrecorded
        entries.push({ studentId: sid, studentName: stu?.name, subject: sub, score: Number(v) });
      }
    }
    if (!entries.length) { showToast("No new marks to save", "err"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/exams/periodic", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cls, test, maxMarks, entries }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast(`Saved ${j.saved} mark${j.saved === 1 ? "" : "s"}`, "ok");
      await loadGrid();
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setSaving(false); }
  }

  const subjects = grid?.subjects || [];
  const students = grid?.students || [];

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Test &amp; term marks</div>
          <div className="card-sub">Class-teacher · enter Periodic Test I–IV and Term I / Term II marks subject-wise for every student</div>
        </div>
      </div>

      <div style={{ padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", borderBottom: "1px solid var(--rule)" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Class</span>
          <select className="select" value={cls} onChange={(e) => setCls(e.target.value)} style={{ minWidth: 130 }}>
            {classOptions.length === 0 && <option value="">No class assigned</option>}
            {classOptions.map((c) => <option key={c} value={c}>{formatClassLabel(c)}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Test</span>
          <select className="select" value={test} onChange={(e) => setTest(e.target.value)} style={{ minWidth: 160 }}>
            <optgroup label="Periodic tests">
              {PERIODIC_TESTS.map((p) => <option key={p.k} value={p.k}>{p.label}</option>)}
            </optgroup>
            <optgroup label="Term exams">
              {TERM_EXAMS.map((p) => <option key={p.k} value={p.k}>{p.label}</option>)}
            </optgroup>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Max marks</span>
          <input
            className="input" type="number" min="1"
            value={maxMarks}
            onChange={(e) => setMaxMarks(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            style={{ width: 90 }}
          />
        </label>
        <button className="btn accent" onClick={save} disabled={saving || loading || !cls} style={{ marginLeft: "auto" }}>
          <Icon name="check" size={13} />{saving ? "Saving…" : "Save marks"}
        </button>
      </div>

      {loading ? (
        <div className="empty" style={{ padding: 24 }}>Loading…</div>
      ) : !cls ? (
        <div className="empty" style={{ padding: 24 }}>Pick a class to start.</div>
      ) : subjects.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>No subjects set for {formatClassLabel(cls)} — add subjects to this class on the Classes screen first.</div>
      ) : students.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>No students in {formatClassLabel(cls)} yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 170 }}>Student</th>
                {subjects.map((sub) => <th key={sub} className="num" style={{ minWidth: 74 }}>{sub}</th>)}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{s.id}</div>
                  </td>
                  {subjects.map((sub) => (
                    <td key={sub} style={{ textAlign: "center" }}>
                      <input
                        className="input"
                        inputMode="numeric"
                        value={cellValue(s.id, sub)}
                        onChange={(e) => setCell(s.id, sub, e.target.value)}
                        placeholder="—"
                        style={{ width: 56, textAlign: "center", padding: "4px 4px" }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--ink-4)" }}>
        Marks out of {maxMarks}. Blank cells stay unrecorded. Saved marks feed the academic performance report.
      </div>
    </div>
  );
}

function AddExamModal({ classes, students, defaultClass, onClose, onSubmit, onAllDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  // Build the class-section list from the canonical classes table.
  const classOpts = useMemo(() => {
    const out = [];
    for (const c of classes) {
      for (const s of (c.sections || ["A"])) out.push(`${c.n}-${s}`);
    }
    // Also include any class that students live in (covers ad-hoc classes).
    for (const st of students) if (!out.includes(st.cls)) out.push(st.cls);
    // Sort numerically by class number, then by section letter — otherwise
    // a string sort puts "12-C" between "1-B" and "2-A".
    return out.sort((a, b) => {
      const [an, as] = String(a).split("-");
      const [bn, bs] = String(b).split("-");
      const dn = (Number(an) || 0) - (Number(bn) || 0);
      return dn !== 0 ? dn : String(as || "").localeCompare(String(bs || ""));
    });
  }, [classes, students]);

  const [form, setForm] = useState({
    name: "Unit Test 1",
    type: "unit_test",
    classes: defaultClass ? [defaultClass] : [], // multi-select
    subject: "Maths",
    maxMarks: "100",
    date: today,
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleClass = (c) => setForm((f) => ({
    ...f,
    classes: f.classes.includes(c) ? f.classes.filter((x) => x !== c) : [...f.classes, c],
  }));
  const setAllClasses = (on) => setForm((f) => ({ ...f, classes: on ? [...classOpts] : [] }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (form.classes.length === 0) throw new Error("Pick at least one class");
      if (!form.subject.trim()) throw new Error("Subject required");
      // Create one exam row per class so each class's marks stay separate.
      // Sequential to keep the audit log readable; the count is small (1-12).
      for (const cls of form.classes) {
        await onSubmit({
          name: form.name.trim(), type: form.type,
          cls, subject: form.subject.trim(),
          maxMarks: Number(form.maxMarks) || 100,
          date: form.date,
        });
      }
      await onAllDone?.(form.classes.length);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <ModalShell title="New exam" sub="Marks can be entered right after creating it" onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Field label="Exam name *">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Unit Test 1" />
          </Field>
          <Field label="Type">
            <select className="select" value={form.type} onChange={(e) => set("type", e.target.value)}>
              {EXAM_TYPES.map((t) => <option key={t.k} value={t.k}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
          <Field label="Subject *">
            <input className="input" value={form.subject} onChange={(e) => set("subject", e.target.value)} placeholder="e.g. Maths" />
          </Field>
          <Field label="Max marks">
            <input className="input" inputMode="numeric" value={form.maxMarks} onChange={(e) => set("maxMarks", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="Date">
            <input className="input" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
          </Field>
        </div>

        <Field
          label={`Classes * — ${form.classes.length} picked`}
          hint="One exam row will be created per class. Marks are entered per class."
        >
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--rule)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
              <button type="button" className="btn sm ghost" onClick={() => setAllClasses(true)}>Select all</button>
              <button type="button" className="btn sm ghost" onClick={() => setAllClasses(false)}>Clear</button>
              <span style={{ marginLeft: "auto", alignSelf: "center" }}>
                {form.classes.length === 0
                  ? <em style={{ color: "var(--ink-4)" }}>nothing picked</em>
                  : form.classes.join(", ")}
              </span>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
              gap: 6,
              maxHeight: 180,
              overflowY: "auto",
            }}>
              {classOpts.map((c) => {
                const on = form.classes.includes(c);
                return (
                  <button
                    key={c} type="button"
                    onClick={() => toggleClass(c)}
                    style={{
                      padding: "8px 4px", borderRadius: 6,
                      background: on ? "var(--accent)" : "var(--card)",
                      color: on ? "#fff" : "var(--ink-2)",
                      border: `1px solid ${on ? "var(--accent)" : "var(--rule)"}`,
                      cursor: "pointer", fontSize: 12, fontWeight: 500,
                      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
                      transition: "all .12s",
                    }}
                  >
                    {on && <Icon name="check" size={11} />}{c}
                  </button>
                );
              })}
              {classOpts.length === 0 && (
                <span style={{ gridColumn: "1 / -1", textAlign: "center", color: "var(--ink-4)", fontSize: 11 }}>
                  No classes set up yet. Add some on the Classes screen.
                </span>
              )}
            </div>
          </div>
        </Field>
        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 10px", borderRadius: 7, fontSize: 11.5 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}><Icon name="check" size={13} />{busy ? "Creating…" : "Create exam"}</button>
        </div>
      </form>
    </ModalShell>
  );
}

function MarksEntryModal({ exam, students, onClose, onChanged, showToast }) {
  const [marks, setMarks] = useState({});  // studentId -> { score, remarks }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Pre-load existing marks for this exam.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/exams/marks?examId=${exam.id}`, { cache: "no-store" });
        const j = await r.json();
        if (cancel || !j.ok) return;
        const m = {};
        for (const row of (j.marks || [])) m[row.studentId] = { score: String(row.score), remarks: row.remarks || "" };
        setMarks(m);
      } catch {}
    })();
    return () => { cancel = true; };
  }, [exam.id]);

  const set = (sid, k, v) => setMarks((s) => ({ ...s, [sid]: { ...(s[sid] || {}), [k]: v } }));

  async function save() {
    setBusy(true); setErr("");
    try {
      const entries = students
        .map((s) => {
          const m = marks[s.id];
          if (!m || m.score === "" || m.score == null) return null;
          return { studentId: s.id, studentName: s.name, score: Number(m.score), remarks: (m.remarks || "").trim() || null };
        })
        .filter(Boolean);
      if (entries.length === 0) throw new Error("Enter at least one score");
      const r = await fetch("/api/exams/marks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ examId: exam.id, entries }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast?.(`Saved ${entries.length} mark${entries.length === 1 ? "" : "s"}`, "ok");
      await onChanged?.();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <ModalShell
      title={`Marks · ${exam.subject} · ${exam.name}`}
      sub={`${formatClassLabel(exam.cls)} · max ${exam.maxMarks} · ${students.length} student${students.length === 1 ? "" : "s"}`}
      onClose={onClose}
      width={680}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {students.length === 0 ? (
          <div className="empty">No students in {formatClassLabel(exam.cls)}. Admit some on the Students screen first.</div>
        ) : (
          <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid var(--rule)", borderRadius: 8 }}>
            <table className="table" style={{ width: "100%" }}>
              <thead>
                <tr><th>#</th><th>Student</th><th className="num">Score (/{exam.maxMarks})</th><th className="num">%</th><th>Remarks</th></tr>
              </thead>
              <tbody>
                {students.map((s, i) => {
                  const m = marks[s.id] || {};
                  const score = Number(m.score);
                  const pct = !isNaN(score) && exam.maxMarks ? Math.round((score / exam.maxMarks) * 100) : null;
                  return (
                    <tr key={s.id}>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)", width: 28 }}>{String(i + 1).padStart(2, "0")}</td>
                      <td style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}<div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{s.id}</div></td>
                      <td className="num">
                        <input
                          className="input" inputMode="numeric"
                          style={{ width: 80, textAlign: "right" }}
                          value={m.score || ""}
                          onChange={(e) => set(s.id, "score", e.target.value.replace(/\D/g, ""))}
                          placeholder="—"
                        />
                      </td>
                      <td className="num" style={{ fontWeight: 500, color: pct === null ? "var(--ink-4)" : pct >= 60 ? "var(--ok)" : pct >= 40 ? "var(--warn)" : "var(--bad)" }}>{pct === null ? "—" : `${pct}%`}</td>
                      <td>
                        <input
                          className="input" style={{ width: "100%" }}
                          value={m.remarks || ""}
                          onChange={(e) => set(s.id, "remarks", e.target.value)}
                          placeholder="Optional"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 10px", borderRadius: 7, fontSize: 11.5 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn accent" onClick={save} disabled={busy || students.length === 0}><Icon name="check" size={13} />{busy ? "Saving…" : "Save marks"}</button>
        </div>
      </div>
    </ModalShell>
  );
}
