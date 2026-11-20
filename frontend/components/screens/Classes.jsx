"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/backend/lib/format.js";

// The school runs one stream per grade (no Section A / Section B split),
// so this screen renders ONE class card per grade with a single class
// teacher picker. The on-disk cls field is still "N-A" — the "A" is
// invisible plumbing carried for compatibility with the dozens of
// places that parse cls.split("-").
const ONLY_SECTION = "A";

const FALLBACK_SUBJECTS = ["English", "Tamil", "Science", "Social Science", "Maths", "Hindi", "PT"];

export default function ScreenClasses({ E, refresh, role }) {
  const canAssign = role === "principal" || role === "admin" || role === "academic_director";
  const classes = E.CLASSES || [];
  const addedStudents = E.ADDED_STUDENTS || [];
  const subjectCatalog = (E.SUBJECTS || []).map((s) => s.name).filter(Boolean);
  const subjectOptions = subjectCatalog.length ? subjectCatalog : FALLBACK_SUBJECTS;

  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const toastTimer = useRef(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  // Fetch the teacher roster once on mount (and after every assignment) so
  // the picker is up to date.
  const loadTeachers = async () => {
    try {
      const r = await fetch("/api/users?role=teacher", { cache: "no-store" });
      const json = await r.json().catch(() => ({}));
      if (json.ok) setTeachers(json.teachers || []);
    } catch {}
  };
  useEffect(() => { loadTeachers(); }, []);

  // Lookup: section key "2-A" → list of teachers assigned to it. A section
  // typically has one class teacher but the data model now allows several
  // (subject teachers etc.), so we return an array.
  const teachersFor = (key) => teachers.filter((t) =>
    Array.isArray(t.linkedClasses) ? t.linkedClasses.includes(key) : t.linkedId === key
  );
  // Back-compat: first teacher for the section (used as the "primary" chip).
  const teacherFor = (key) => teachersFor(key)[0] || null;

  // Atomic add — picking a teacher for section X adds X to their list,
  // it does NOT move them away from any other section they teach.
  const handleAssignTeacher = async (sectionKey, teacherId) => {
    try {
      const r = await fetch("/api/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: teacherId, addClass: sectionKey }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      const list = json.user.linkedClasses || [];
      flash(`${json.user.name || "Teacher"} now teaches ${list.join(", ") || "—"}`);
      await loadTeachers();
    } catch (e) { flash(e.message || "Failed", "bad"); }
  };

  // Atomic remove — only this section is dropped from the teacher's list.
  const handleUnassignTeacher = async (teacherId, sectionKey) => {
    try {
      const r = await fetch("/api/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: teacherId, removeClass: sectionKey }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      const left = (json.user.linkedClasses || []);
      flash(left.length
        ? `${json.user.name} no longer teaches ${sectionKey} (still: ${left.join(", ")})`
        : `${json.user.name} unassigned from all classes`);
      await loadTeachers();
    } catch (e) { flash(e.message || "Failed", "bad"); }
  };

  // Count students per class for the card header. We match by the leading
  // class number (the part before the "-") so legacy rows with "N-B" or
  // "N-C" section letters still roll up to the right card.
  const countByCls = (cls) => {
    const head = String(cls).split("-")[0];
    return addedStudents.filter((s) => String(s.cls).split("-")[0] === head).length;
  };

  // ---------- handlers ----------
  const call = async (method, body) => {
    try {
      const r = await fetch("/api/classes", {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return await r.json().catch(() => ({ ok: false, error: "Bad response" }));
    } catch (e) {
      return { ok: false, error: "Network error — " + e.message };
    }
  };

  // Edit modal + confirm-dialog state. We use a custom in-app confirm instead
  // of window.confirm so the dialog matches the rest of the UI.
  const [editing, setEditing] = useState(null);  // class object being edited
  const [confirmAsk, setConfirmAsk] = useState(null); // { title, body, danger, onConfirm }

  const handleAdd = async (form) => {
    const res = await call("POST", { n: Number(form.n), label: form.label, sections: form.sections });
    if (res.ok) { flash(`Added ${res.class.label}`); await refresh?.(); setShowAdd(false); }
    else flash(res.error || "Failed to add", "bad");
  };

  const handleEdit = async (cls, form) => {
    const res = await call("PATCH", {
      n: cls.n,
      label: form.label,
      sections: form.sections,
      subjects: form.subjects,
    });
    if (res.ok) { flash(`Updated ${cls.label}`); await refresh?.(); setEditing(null); }
    else flash(res.error || "Failed to update", "bad");
  };

  // Always confirm before deleting a whole class.
  const handleRemoveClass = (cls) => {
    const count = addedStudents.filter((s) => s.cls.startsWith(`${cls.n}-`)).length;
    setConfirmAsk({
      title: `Delete ${cls.label}?`,
      body: count > 0
        ? `${cls.label} has ${count} student${count === 1 ? "" : "s"} assigned across its sections. Their records stay but the class disappears from dropdowns. This is irreversible.`
        : "This class is empty — safe to delete.",
      danger: true,
      confirmLabel: "Delete class",
      onConfirm: async () => {
        const res = await call("DELETE", { n: cls.n });
        if (res.ok) { flash(`Removed ${cls.label}`); await refresh?.(); }
        else flash(res.error || "Failed", "bad");
      },
    });
  };

  return (
    <div className="page">
      <Toast toast={toast} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Setup</div>
          <div className="page-title">Classes</div>
          <div className="page-sub">Each grade runs as a single class. Assign one class teacher per grade — changes here flow through to admissions, the academic tracker, and every dropdown in the app.</div>
        </div>
        <div className="page-actions">
          <button className="btn accent" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={13} />Add class
          </button>
        </div>
      </div>

      <div className="grid g-3" style={{ marginBottom: 18 }}>
        {(() => {
          const enrolledByCls = {};
          for (const s of addedStudents) enrolledByCls[s.cls] = (enrolledByCls[s.cls] || 0) + 1;
          // Total = sum across every class card (storage uses "N-A" so we
          // collapse on the leading number to match how cards count below).
          const enrolledByClassNum = {};
          for (const [k, n] of Object.entries(enrolledByCls)) {
            const head = String(k).split("-")[0];
            enrolledByClassNum[head] = (enrolledByClassNum[head] || 0) + n;
          }
          const assignedTeacherCount = classes.filter((c) => teacherFor(`${c.n}-${ONLY_SECTION}`)).length;
          return (
            <>
              <KPI
                label="Classes" value={classes.length}
                sub={classes.length ? "defined" : "none yet"}
                puck="mint" puckIcon="academic"
                details={{
                  title: `Classes · ${classes.length} defined`,
                  sub: "Enrolment per class",
                  items: classes.map((c) => ({
                    label: c.label || formatClassLabel(String(c.n)),
                    value: enrolledByClassNum[String(c.n)] || 0,
                    sub: (enrolledByClassNum[String(c.n)] || 0) === 1 ? "1 student" : `${enrolledByClassNum[String(c.n)] || 0} students`,
                  })),
                }}
              />
              <KPI
                label="Students enrolled" value={addedStudents.length}
                sub={addedStudents.length === 1 ? "on roll" : "across classes"}
                puck="cream" puckIcon="students"
                details={{
                  title: `Enrolled · ${addedStudents.length} students`,
                  sub: "Click a class to see the students",
                  items: classes.map((c) => {
                    const inCls = addedStudents
                      .filter((s) => String(s.cls).split("-")[0] === String(c.n))
                      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
                    return {
                      label: c.label || formatClassLabel(String(c.n)),
                      value: inCls.length,
                      sub: inCls.length
                        ? `${inCls.length} student${inCls.length === 1 ? "" : "s"} · click to expand`
                        : "no students yet",
                      children: inCls.map((s) => ({
                        label: s.name,
                        value: s.id,
                        sub: [s.parent, s.transport].filter(Boolean).join(" · ") || null,
                      })),
                    };
                  }),
                }}
              />
              <KPI
                label="Class teachers" value={assignedTeacherCount}
                sub={`of ${classes.length} assigned`}
                puck="peach" puckIcon="users"
                details={{
                  title: `Class teacher · ${assignedTeacherCount}/${classes.length} assigned`,
                  sub: "One teacher per class",
                  items: classes.map((c) => {
                    const t = teacherFor(`${c.n}-${ONLY_SECTION}`);
                    return {
                      label: c.label || formatClassLabel(String(c.n)),
                      value: t ? t.name : "—",
                      sub: t ? t.email : "unassigned",
                      tone: t ? undefined : "bad",
                    };
                  }),
                }}
              />
            </>
          );
        })()}
      </div>

      {classes.length === 0 ? (
        <div className="card"><div className="empty" style={{ padding: 60 }}>No classes defined yet. Click “Add class” to start.</div></div>
      ) : (
        <div className="grid g-3">
          {classes.map((c) => (
            <ClassCard
              key={c.n}
              cls={c}
              studentCount={countByCls}
              teachers={teachers}
              teacherFor={teacherFor}
              canAssign={canAssign}
              onAssignTeacher={handleAssignTeacher}
              onUnassignTeacher={handleUnassignTeacher}
              onRemoveClass={() => handleRemoveClass(c)}
              onEditClass={canAssign ? (() => setEditing(c)) : undefined}
            />
          ))}
        </div>
      )}

      {showAdd && <AddClassModal existing={classes.map((c) => c.n)} onClose={() => setShowAdd(false)} onSubmit={handleAdd} />}
      {editing && (
        <EditClassModal
          cls={editing}
          subjectOptions={subjectOptions}
          onClose={() => setEditing(null)}
          onSubmit={(form) => handleEdit(editing, form)}
        />
      )}
      {confirmAsk && (
        <ConfirmDialog
          title={confirmAsk.title}
          body={confirmAsk.body}
          danger={confirmAsk.danger}
          confirmLabel={confirmAsk.confirmLabel || "Confirm"}
          onCancel={() => setConfirmAsk(null)}
          onConfirm={async () => {
            const fn = confirmAsk.onConfirm;
            setConfirmAsk(null);
            await fn?.();
          }}
        />
      )}
    </div>
  );
}

// ---------- class card ----------
// One card per grade. Storage key is "${n}-A" but the section letter is
// never shown to the user — this screen treats each grade as a single
// class with one class teacher.
function ClassCard({ cls, studentCount, teachers, teacherFor, canAssign, onAssignTeacher, onUnassignTeacher, onRemoveClass, onEditClass }) {
  const sectionKey = `${cls.n}-${ONLY_SECTION}`;
  // Some legacy student rows may still carry "N-B" / "N-C" cls keys (from
  // older imports), so count by grade number, not section, for honesty.
  const total = studentCount(sectionKey);
  const teacher = teacherFor ? teacherFor(sectionKey) : null;

  return (
    <div className="card">
      <div className="card-head" style={{ paddingBottom: 14 }}>
        <div>
          <div className="card-title">{cls.label}</div>
          <div className="card-sub">{total} student{total === 1 ? "" : "s"}</div>
        </div>
        <div className="card-actions" style={{ display: "flex", gap: 4 }}>
          {onEditClass && (
            <button className="btn sm ghost" onClick={onEditClass} title={`Edit ${cls.label}`}>
              <Icon name="pencil" size={12} />
            </button>
          )}
          <button className="btn sm ghost" onClick={onRemoveClass} title={`Delete ${cls.label}`}>
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>

      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <TeacherRow
          sectionKey={sectionKey}
          teacher={teacher}
          teachers={teachers || []}
          canAssign={canAssign}
          onAssign={(teacherId) => onAssignTeacher(sectionKey, teacherId)}
          onUnassign={() => teacher && onUnassignTeacher(teacher.id, sectionKey)}
        />
        <div>
          <div style={{
            fontSize: 10.5, color: "var(--ink-4)", textTransform: "uppercase",
            letterSpacing: "0.06em", fontWeight: 500, marginBottom: 6,
          }}>
            Subjects
          </div>
          {Array.isArray(cls.subjects) && cls.subjects.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {cls.subjects.map((s) => (
                <span key={s} className="chip" style={{ fontSize: 10.5 }}>{s}</span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
              {onEditClass ? "No subjects yet — click edit to add" : "No subjects assigned"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- class-teacher picker ----------
// Single teacher per class. Storage uses the legacy "N-A" key under the
// hood, but the row itself just says "Class teacher" — no "Section A" chip.
//
// The picker is rendered with position:fixed (anchored to the trigger's
// getBoundingClientRect) so it can escape the parent .card's overflow:hidden
// clip. Otherwise the dropdown gets cut off at the card boundary and only
// the first teacher row is visible.
function TeacherRow({ sectionKey, teacher, teachers, canAssign, onAssign, onUnassign }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onClickOutside = (e) => {
      // Close if click is outside both the trigger and the floating menu.
      // pointerdown covers touch + mouse + pen in a single event (no double
      // fire on mobile from synthetic mouse events).
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setPickerOpen(false);
    };
    const onScroll = (e) => {
      // Capture-phase scroll listener catches scroll events from ANY
      // descendant — including the menu's own overflow-y:auto pane.
      // Only close when the scroll happens OUTSIDE the menu (e.g. the
      // user scrolls the underlying classes grid); scrolling within the
      // menu is the expected way to see a long teacher list and must
      // not dismiss it.
      if (menuRef.current?.contains(e.target)) return;
      setPickerOpen(false);
    };
    const onResize = () => setPickerOpen(false);
    document.addEventListener("pointerdown", onClickOutside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onClickOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [pickerOpen]);

  const initials = (n) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const togglePicker = () => {
    if (pickerOpen) { setPickerOpen(false); return; }
    if (triggerRef.current) {
      setAnchorRect(triggerRef.current.getBoundingClientRect());
    }
    setPickerOpen(true);
  };

  // Compute a sensible position for the floating menu. Anchored to the
  // trigger's left edge, falling back to right-align if it would overflow
  // the viewport. If it would extend past the bottom, flip it above.
  const menuStyle = (() => {
    if (!anchorRect) return null;
    const MENU_W = 280;
    const MENU_H_MAX = 320;
    let left = anchorRect.left;
    if (typeof window !== "undefined") {
      left = Math.min(left, window.innerWidth - MENU_W - 8);
      left = Math.max(8, left);
    }
    let top = anchorRect.bottom + 4;
    let flip = false;
    if (typeof window !== "undefined" && top + MENU_H_MAX + 8 > window.innerHeight) {
      flip = anchorRect.top - 4 - MENU_H_MAX > 8;
      if (flip) top = anchorRect.top - 4 - MENU_H_MAX;
    }
    return {
      position: "fixed", top, left, minWidth: MENU_W,
      maxHeight: MENU_H_MAX, overflowY: "auto",
      background: "var(--card)", border: "1px solid var(--rule)",
      borderRadius: 8, padding: 4, zIndex: 9000,
      boxShadow: "var(--shadow-lg)",
    };
  })();

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 12px",
      background: "var(--bg-2)", border: "1px solid var(--rule-2)", borderRadius: 8,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {teacher ? (
          (() => {
            const list = Array.isArray(teacher.linkedClasses) ? teacher.linkedClasses : (teacher.linkedId ? [teacher.linkedId] : []);
            const others = list.filter((k) => k !== sectionKey);
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: "50%",
                  background: "linear-gradient(135deg, var(--ok), #2f6048)",
                  color: "#fff", display: "grid", placeItems: "center",
                  fontSize: 10, fontWeight: 600, flexShrink: 0,
                }}>{initials(teacher.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teacher.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    Class teacher{others.length ? ` · also teaches ${others.join(", ")}` : ""}
                  </div>
                </div>
                {canAssign && (
                  <button className="icon-btn" onClick={onUnassign} title="Unassign teacher" style={{ width: 24, height: 24 }}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </div>
            );
          })()
        ) : canAssign ? (
          <button ref={triggerRef} className="btn sm" onClick={togglePicker} style={{ height: 28 }}>
            <Icon name="plus" size={11} />Assign class teacher
          </button>
        ) : (
          <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>No class teacher assigned</span>
        )}
      </div>

      {pickerOpen && canAssign && menuStyle && (
        <div ref={menuRef} style={menuStyle}>
          <div style={{ fontSize: 10.5, color: "var(--ink-4)", padding: "6px 10px 4px", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>
            Pick a teacher
          </div>
          {teachers.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--ink-3)" }}>
              No teachers yet. Add a Teacher account first.
            </div>
          ) : (
            teachers.map((t) => {
              const list = Array.isArray(t.linkedClasses) ? t.linkedClasses : (t.linkedId ? [t.linkedId] : []);
              const here = list.includes(sectionKey);
              const otherClasses = list.filter((c) => c !== sectionKey);
              return (
                <button
                  key={t.id}
                  onClick={() => { onAssign(t.id); setPickerOpen(false); }}
                  disabled={here}
                  style={{
                    width: "100%", textAlign: "left",
                    padding: "8px 10px", background: here ? "var(--bg-2)" : "transparent",
                    border: 0, borderRadius: 6, cursor: here ? "default" : "pointer",
                    color: "var(--ink-2)", fontSize: 12,
                    display: "flex", alignItems: "center", gap: 8,
                  }}
                  onMouseEnter={(e) => !here && (e.currentTarget.style.background = "var(--bg-2)")}
                  onMouseLeave={(e) => !here && (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{
                    width: 20, height: 20, borderRadius: "50%",
                    background: "linear-gradient(135deg, var(--ok), #2f6048)",
                    color: "#fff", display: "grid", placeItems: "center",
                    fontSize: 9, fontWeight: 600, flexShrink: 0,
                  }}>{initials(t.name)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--ink)" }}>{t.name}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                      {t.email}{otherClasses.length ? ` · also teaches ${otherClasses.join(", ")}` : ""}
                    </div>
                  </div>
                  {here && <span className="chip ok" style={{ fontSize: 9.5 }}><span className="dot" />Already here</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------- add-class modal ----------
// One class per grade — the section is fixed to "A" under the hood and not
// surfaced in the UI.
function AddClassModal({ existing, onClose, onSubmit }) {
  const [form, setForm] = useState({ n: "", label: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const numError = (() => {
    if (!form.n) return null;
    const n = Number(form.n);
    if (Number.isNaN(n) || n < 1) return "Must be a positive integer";
    if (existing.includes(n)) return `${formatClassLabel(String(n))} already exists`;
    return null;
  })();
  const valid = form.n && !numError;
  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const defaultLabel = formatClassLabel(String(form.n));
      await onSubmit({ n: Number(form.n), label: form.label.trim() || defaultLabel, sections: [ONLY_SECTION] });
    } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 460 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Add a class</div>
            <div className="card-sub">Class number and an optional display label</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Class number *">
            <input
              className="input"
              autoFocus
              value={form.n}
              onChange={(e) => setForm((f) => ({ ...f, n: e.target.value.replace(/[^0-9]/g, "") }))}
              placeholder="9"
              style={numError ? { borderColor: "var(--bad)" } : undefined}
            />
            {numError && <span style={{ fontSize: 11, color: "var(--bad)" }}>{numError}</span>}
          </Field>
          <Field label="Label (optional)">
            <input
              className="input"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder={form.n ? `${formatClassLabel(String(form.n))} — defaults to this if blank` : "Class IX — defaults to this if blank"}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !valid}>
              <Icon name="check" size={13} />{busy ? "Adding…" : "Add class"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- edit-class modal ----------
function EditClassModal({ cls, subjectOptions = [], onClose, onSubmit }) {
  const [form, setForm] = useState({
    label: cls.label || formatClassLabel(String(cls.n)),
    subjects: Array.isArray(cls.subjects) ? [...cls.subjects] : [],
  });
  const [customSubject, setCustomSubject] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleSubject = (name) => {
    setForm((f) => {
      const has = f.subjects.some((s) => s.toLowerCase() === name.toLowerCase());
      return {
        ...f,
        subjects: has
          ? f.subjects.filter((s) => s.toLowerCase() !== name.toLowerCase())
          : [...f.subjects, name],
      };
    });
  };

  const addCustom = () => {
    const name = customSubject.trim();
    if (!name) return;
    setForm((f) => {
      if (f.subjects.some((s) => s.toLowerCase() === name.toLowerCase())) return f;
      return { ...f, subjects: [...f.subjects, name] };
    });
    setCustomSubject("");
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Preserve the existing section list (always ["A"] under the hood)
      // so we don't accidentally drop the invisible plumbing.
      const existingSections = (cls.sections && cls.sections.length) ? cls.sections : [ONLY_SECTION];
      await onSubmit({
        label: form.label.trim() || formatClassLabel(String(cls.n)),
        sections: existingSections,
        subjects: form.subjects,
      });
    } finally { setBusy(false); }
  };

  // Options = catalog + any already-selected custom names not in catalog.
  const allOptions = (() => {
    const seen = new Set(subjectOptions.map((s) => s.toLowerCase()));
    const extras = form.subjects.filter((s) => !seen.has(s.toLowerCase()));
    return [...subjectOptions, ...extras];
  })();

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 520, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Edit {cls.label}</div>
            <div className="card-sub">Rename the class and set the subjects taught here</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Label">
            <input className="input" autoFocus value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder={formatClassLabel(String(cls.n))} />
          </Field>
          <Field label="Subjects">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
              {allOptions.map((name) => {
                const on = form.subjects.some((s) => s.toLowerCase() === name.toLowerCase());
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleSubject(name)}
                    className="chip"
                    style={{
                      cursor: "pointer",
                      border: on ? "1px solid var(--accent)" : "1px solid var(--rule-2)",
                      background: on ? "var(--accent-soft)" : "var(--bg-2)",
                      color: on ? "var(--accent-2)" : "var(--ink-2)",
                      fontWeight: on ? 600 : 500,
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                className="input"
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                placeholder="Add another subject…"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
              />
              <button type="button" className="btn" onClick={addCustom} disabled={!customSubject.trim()}>
                <Icon name="plus" size={13} />Add
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
              {form.subjects.length
                ? `${form.subjects.length} subject${form.subjects.length === 1 ? "" : "s"} selected`
                : "No subjects selected"}
            </div>
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy}>
              <Icon name="check" size={13} />{busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- in-app confirm dialog ----------
function ConfirmDialog({ title, body, danger, confirmLabel = "Confirm", onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.55)",
      display: "grid", placeItems: "center", zIndex: 300, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ padding: "18px 18px 6px", display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span style={{
            width: 36, height: 36, borderRadius: 9,
            background: danger ? "var(--bad-soft)" : "var(--accent-soft)",
            color:      danger ? "var(--bad)"      : "var(--accent)",
            display: "grid", placeItems: "center", flexShrink: 0,
          }}>
            <Icon name={danger ? "warning" : "check"} size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)", lineHeight: 1.3 }}>{title}</div>
            {body && <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>{body}</div>}
          </div>
        </div>
        <div style={{ padding: "12px 18px 18px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn"
            onClick={onConfirm}
            style={danger ? {
              background: "var(--bad)",
              color: "#fff",
              borderColor: "var(--bad)",
            } : {
              background: "var(--accent)",
              color: "var(--accent-ink, #fff)",
              borderColor: "var(--accent)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- shared helpers ----------
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
