"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

// Standard Indian school week — 6 working days. The number of periods and
// their start/end times are a single whole-school setting (default 9 periods)
// that only the admin can change, served by /api/settings/periods. The grid
// renders whatever that setting returns.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Subjects come from the managed list at /api/subjects (E.SUBJECTS).
// Fallback list is only used while data is loading or the API is empty.
const FALLBACK_SUBJECTS = ["English", "Tamil", "Science", "Social Science", "Maths", "Hindi", "PT"];
// Default 9-period day, used while the setting loads (or before it's ever
// saved). Mirrors DEFAULT_PERIOD_TIMES in backend/lib/db.js.
const DEFAULT_PERIOD_LIST = [
  { period: 1, start: "08:00", end: "08:45" },
  { period: 2, start: "08:45", end: "09:30" },
  { period: 3, start: "09:30", end: "10:15" },
  { period: 4, start: "10:30", end: "11:15" },
  { period: 5, start: "11:15", end: "12:00" },
  { period: 6, start: "12:45", end: "13:30" },
  { period: 7, start: "13:30", end: "14:15" },
  { period: 8, start: "14:15", end: "15:00" },
  { period: 9, start: "15:00", end: "15:45" },
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

function ModalShell({ title, sub, onClose, children, width = 460 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: width, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
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

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
    </label>
  );
}

// All class-section keys ("1-A", "5-A"…) derived from the live class roster.
// School is single-stream so each class is "<n>-A" exactly once.
function buildClassKeys(classes) {
  const out = [];
  (classes || []).forEach((c) => {
    (c.sections || ["A"]).forEach((sec) => out.push(`${c.n}-${sec}`));
  });
  return out;
}

// Friendly label for a class key like "1-A". Prefers the live label on
// the class record ("Class 1", "PRE-MONT") since that's what the rest of
// the school already uses. Falls back to the raw key for keys whose class
// number isn't in the supplied list (defensive — shouldn't happen).
function labelForKey(key, classes) {
  const [head] = String(key).split("-");
  const n = Number(head);
  const found = (classes || []).find((c) => Number(c.n) === n);
  return found?.label || formatClassLabel(key);
}

// Resolve a student class ("1", "1-A") to the key used on timetable rows.
function resolveTimetableCls(childCls, entries, classKeys) {
  const raw = String(childCls || "").trim();
  if (!raw) return null;
  const list = Array.isArray(entries) ? entries : [];
  const keys = Array.isArray(classKeys) ? classKeys : [];
  if (list.some((e) => e.cls === raw) || keys.includes(raw)) return raw;
  const head = raw.split("-")[0];
  const withA = `${head}-A`;
  if (list.some((e) => e.cls === withA) || keys.includes(withA)) return withA;
  const hit = list.find((e) => String(e.cls || "").split("-")[0] === head);
  return hit?.cls || withA || raw;
}

// --------------------------------------------------------------------------
// Main screen
// --------------------------------------------------------------------------
export default function ScreenTimetable({ E, refresh, role, session }) {
  const isManager = role === "admin" || role === "principal" || role === "academic_director";
  const isTeacher = role === "teacher";
  const isParent  = role === "parent";
  // Only the super admin may customize period timings (per spec).
  const canEditPeriods = role === "admin";

  // Whole-school period timings (count + start/end). Loaded once from the
  // admin-owned setting; falls back to the 9-period default while loading.
  const [periodList, setPeriodList] = useState(DEFAULT_PERIOD_LIST);
  const [periodEditorOpen, setPeriodEditorOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/settings/periods")
      .then((r) => r.json())
      .then((j) => { if (alive && j?.ok && Array.isArray(j.periods) && j.periods.length) setPeriodList(j.periods); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const PERIODS = useMemo(() => periodList.map((p) => p.period), [periodList]);
  const periodTimes = useMemo(() => {
    const m = {};
    for (const p of periodList) m[p.period] = `${p.start} – ${p.end}`;
    return m;
  }, [periodList]);

  const allClasses = E.CLASSES || [];
  const classKeys  = useMemo(() => buildClassKeys(allClasses), [allClasses]);
  const allEntries = E.TIMETABLE || [];
  const staff      = (E.STAFF || []).filter((s) => !s.archivedAt);
  const students   = E.ADDED_STUDENTS || [];

  // Resolve the focal class for each role:
  //   parent  → child's class (single)
  //   teacher → first class in linkedClasses (used as the "default" tab; the
  //             screen can also show a "teacher's own grid" without a class)
  //   manager → user-pickable from a dropdown
  const myChildCls = useMemo(() => {
    if (!isParent || !students[0]?.cls) return null;
    return resolveTimetableCls(students[0].cls, allEntries, classKeys);
  }, [isParent, students, allEntries, classKeys]);
  const teacherClassSet = useMemo(() => {
    if (!isTeacher) return null;
    const arr = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
      ? session.linkedClasses
      : (session?.linkedId ? [session.linkedId] : []);
    return new Set(arr);
  }, [isTeacher, session]);
  // Resolve the teacher's staff id. linkedId on the auth user is sometimes a
  // staff id ("STF-XXXX") and sometimes a comma-separated class list (e.g.
  // "2-A,1-A") — so we only trust it when it actually starts with "STF-".
  // Fall back to matching the staff record by email, which works for any
  // teacher whose login email matches their staff record.
  // Authoritative staff id resolved server-side (in app/page.jsx) by matching
  // the signed-in user's email to the staff roster. Falls back to email-match
  // against any staff records the client happens to have, then to linkedId.
  const myStaffId = useMemo(() => {
    if (!isTeacher) return null;
    if (session?.staffId) return session.staffId;
    const lid = session?.linkedId || "";
    if (typeof lid === "string" && lid.startsWith("STF-")) return lid;
    if (session?.email) {
      const match = staff.find((s) => (s.email || "").toLowerCase() === session.email.toLowerCase());
      if (match) return match.id;
    }
    return session?.id || null;
  }, [isTeacher, session, staff]);

  // Teacher view defaults to "my schedule" but lets them flip to a class view
  // for any class they teach. Parent and manager only ever see a class grid.
  const initialClass = isParent
    ? myChildCls
    : isTeacher
      ? null    // null → "My teaching schedule" mode
      : (classKeys[0] || null);
  const [pickedClass, setPickedClass] = useState(initialClass);

  // Parent child data loads async — keep the grid pinned to the child's class.
  useEffect(() => {
    if (isParent && myChildCls) setPickedClass(myChildCls);
  }, [isParent, myChildCls]);

  // Editor modal state — manager only.
  const [editingSlot, setEditingSlot] = useState(null); // { day, period, current? }
  const [toast, setToast] = useState(null);
  const showToast = (msg, tone) => { setToast({ msg, tone }); setTimeout(() => setToast(null), 2800); };

  // Index entries by `${cls}-${day}-${period}` so cell lookup is O(1).
  // Also index by class-head so "1" / "1-A" both resolve for parents.
  const entryByKey = useMemo(() => {
    const m = new Map();
    for (const e of allEntries) {
      m.set(`${e.cls}-${e.day}-${e.period}`, e);
      const head = String(e.cls || "").split("-")[0];
      if (head) m.set(`${head}-${e.day}-${e.period}`, e);
      if (head) m.set(`${head}-A-${e.day}-${e.period}`, e);
    }
    return m;
  }, [allEntries]);

  // Teacher's own schedule: every entry where they're the teacher, indexed
  // the same way. Used when pickedClass === null on a teacher view.
  const teacherSchedule = useMemo(() => {
    if (!isTeacher) return null;
    const m = new Map();
    for (const e of allEntries) if (e.teacherId === myStaffId) m.set(`${e.day}-${e.period}`, e);
    return m;
  }, [allEntries, isTeacher, myStaffId]);

  // --------------- handlers --------------------------------------------
  async function handleSave(payload) {
    const r = await fetch("/api/timetable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`${payload.day} P${payload.period} → ${payload.subject}`, "ok");
    setEditingSlot(null);
    await refresh?.();
  }

  async function handleClear(entry) {
    if (!confirm(`Clear ${entry.day} period ${entry.period} (${entry.subject}) from ${labelForKey(entry.cls, allClasses)}?`)) return;
    try {
      const r = await fetch("/api/timetable", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast("Slot cleared", "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  // --------------- header --------------------------------------------
  // Build the page title + sub differently per role so the screen reads
  // sensibly even before they pick a class.
  const headerEyebrow =
    isManager ? "Academic · Timetable" :
    isTeacher ? "My classroom · Timetable" :
                "My family · Timetable";
  const headerTitle =
    isManager ? <>Class <span className="amber">timetable</span></> :
    isTeacher ? <>My weekly <span className="amber">schedule</span></> :
                <>{(students[0]?.name || "Child")}'s <span className="amber">timetable</span></>;
  const headerSub =
    isManager ? "Set the weekly grid per class · click any cell to assign a subject + teacher." :
    isTeacher ? "Periods you're scheduled to teach this week." :
    myChildCls ? `${labelForKey(myChildCls, allClasses)} · standard 6-day week.` :
                 "No child linked to this account yet.";

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">{headerEyebrow}</div>
          <div className="page-title">{headerTitle}</div>
          <div className="page-sub">{headerSub}</div>
        </div>
        {(isManager || isTeacher) && (
          <div className="page-actions">
            {canEditPeriods && (
              <button
                className="btn"
                onClick={() => setPeriodEditorOpen(true)}
                title="Set the whole-school period start/end times (admin only)"
              >
                <Icon name="clock" size={13} />Period times
              </button>
            )}
            <ClassPicker
              classKeys={isTeacher
                ? [...new Set(allEntries.filter((e) => e.teacherId === myStaffId).map((e) => e.cls))]
                : classKeys}
              value={pickedClass}
              isTeacher={isTeacher}
              onChange={setPickedClass}
              allClasses={allClasses}
            />
          </div>
        )}
      </div>

      {/* KPIs — manager only (parents/teachers don't need stats). */}
      {isManager && (
        <div className="grid g-4" style={{ marginBottom: 14 }}>
          {(() => {
            const coveredCls = [...new Set(allEntries.map((e) => e.cls))].sort();
            const slotsByCls = {};
            for (const e of allEntries) slotsByCls[e.cls] = (slotsByCls[e.cls] || 0) + 1;
            const teacherEntries = allEntries.filter((e) => e.teacherId);
            const teacherSlots = {};
            for (const e of teacherEntries) {
              const k = e.teacherName || e.teacherId;
              teacherSlots[k] = (teacherSlots[k] || 0) + 1;
            }
            const subjectSlots = {};
            for (const e of allEntries) {
              const s = (e.subject || "").trim();
              if (!s) continue;
              subjectSlots[s] = (subjectSlots[s] || 0) + 1;
            }
            // Sort entries chronologically (Mon→Sat, P1→P7) so each
            // expanded list reads naturally top-to-bottom.
            const dayIdx = (d) => DAYS.indexOf(d);
            const sortByTime = (a, b) => (dayIdx(a.day) - dayIdx(b.day)) || ((a.period || 0) - (b.period || 0));
            const fmtSlot = (e) => `${e.day || "—"} · P${e.period || "?"} · ${periodTimes[e.period] || ""}`;
            return (
              <>
                <KPI
                  label="Classes covered" value={coveredCls.length} sub={`${classKeys.length} on roster`}
                  puck="mint" puckIcon="book"
                  details={{
                    title: `Classes covered · ${coveredCls.length}`,
                    sub: `${classKeys.length} class${classKeys.length === 1 ? "" : "es"} on roster · click a class to see its periods`,
                    items: coveredCls.map((cls) => {
                      const inCls = allEntries.filter((e) => e.cls === cls).sort(sortByTime);
                      return {
                        label: labelForKey(cls, allClasses),
                        value: slotsByCls[cls] || 0,
                        sub: `${slotsByCls[cls] || 0} slot${(slotsByCls[cls] || 0) === 1 ? "" : "s"} · click to expand`,
                        children: inCls.map((e) => ({
                          label: fmtSlot(e),
                          value: e.subject || "—",
                          sub: e.teacherName || "Unassigned teacher",
                        })),
                      };
                    }),
                  }}
                />
                <KPI
                  label="Slots assigned" value={allEntries.length}
                  sub={`${DAYS.length * PERIODS.length} per class`}
                  puck="cream" puckIcon="academic"
                  details={{
                    title: `Slots assigned · ${allEntries.length}`,
                    sub: `${DAYS.length * PERIODS.length} possible slots per class · click to see what's filled`,
                    items: coveredCls.map((cls) => {
                      const filled = slotsByCls[cls] || 0;
                      const total  = DAYS.length * PERIODS.length;
                      const inCls = allEntries.filter((e) => e.cls === cls).sort(sortByTime);
                      return {
                        label: labelForKey(cls, allClasses),
                        value: `${filled}/${total}`,
                        sub: `${Math.round((filled / total) * 100)}% filled · click to expand`,
                        children: inCls.map((e) => ({
                          label: fmtSlot(e),
                          value: e.subject || "—",
                          sub: e.teacherName || "Unassigned teacher",
                        })),
                      };
                    }),
                  }}
                />
                <KPI
                  label="Teachers on duty"
                  value={new Set(teacherEntries.map((e) => e.teacherId)).size}
                  sub="have at least one slot"
                  puck="peach" puckIcon="staff"
                  details={{
                    title: `Teachers on duty · ${Object.keys(teacherSlots).length}`,
                    sub: "Click a teacher to see their periods",
                    items: Object.entries(teacherSlots)
                      .sort((a, b) => b[1] - a[1])
                      .map(([name, n]) => {
                        const mine = teacherEntries
                          .filter((e) => (e.teacherName || e.teacherId) === name)
                          .sort(sortByTime);
                        return {
                          label: name,
                          value: n,
                          sub: `${n} period${n === 1 ? "" : "s"} · click to expand`,
                          children: mine.map((e) => ({
                            label: fmtSlot(e),
                            value: e.subject || "—",
                            sub: labelForKey(e.cls, allClasses),
                          })),
                        };
                      }),
                  }}
                />
                <KPI
                  label="Subjects" value={Object.keys(subjectSlots).length} sub="distinct"
                  puck="sky" puckIcon="reports"
                  details={{
                    title: `Subjects · ${Object.keys(subjectSlots).length} distinct`,
                    sub: "Click a subject to see where it's taught",
                    items: Object.entries(subjectSlots)
                      .sort((a, b) => b[1] - a[1])
                      .map(([s, n]) => {
                        const mine = allEntries
                          .filter((e) => (e.subject || "").trim() === s)
                          .sort(sortByTime);
                        return {
                          label: s,
                          value: n,
                          sub: `${n} period${n === 1 ? "" : "s"} · click to expand`,
                          children: mine.map((e) => ({
                            label: fmtSlot(e),
                            value: labelForKey(e.cls, allClasses),
                            sub: e.teacherName || "Unassigned teacher",
                          })),
                        };
                      }),
                  }}
                />
              </>
            );
          })()}
        </div>
      )}

      {/* Grid */}
      {isTeacher && pickedClass === null ? (
        <TeacherGrid schedule={teacherSchedule} allClasses={allClasses} periods={PERIODS} periodTimes={periodTimes} />
      ) : pickedClass ? (
        <ClassGrid
          cls={pickedClass}
          entryByKey={entryByKey}
          canEdit={isManager}
          isTeacher={isTeacher}
          myStaffId={myStaffId}
          allClasses={allClasses}
          periods={PERIODS}
          periodTimes={periodTimes}
          onCellClick={(day, period) => {
            if (!isManager) return;
            const current = entryByKey.get(`${pickedClass}-${day}-${period}`);
            setEditingSlot({ day, period, current });
          }}
        />
      ) : (
        <div className="card" style={{ padding: 24 }}>
          <div className="empty">
            {isParent ? "No child linked to this account yet — speak to the school office." :
                        "Pick a class from the dropdown above."}
          </div>
        </div>
      )}

      {editingSlot && isManager && (
        <SlotEditorModal
          cls={pickedClass}
          day={editingSlot.day}
          period={editingSlot.period}
          current={editingSlot.current}
          staff={staff}
          subjects={E.SUBJECTS || []}
          canManageSubjects={isManager}
          onSubjectsChanged={refresh}
          allClasses={allClasses}
          onClose={() => setEditingSlot(null)}
          onSubmit={handleSave}
          onClear={editingSlot.current ? () => { handleClear(editingSlot.current); setEditingSlot(null); } : null}
          onToast={showToast}
        />
      )}

      {periodEditorOpen && canEditPeriods && (
        <PeriodEditorModal
          initial={periodList}
          onClose={() => setPeriodEditorOpen(false)}
          onSaved={(saved) => { setPeriodList(saved); setPeriodEditorOpen(false); showToast(`Saved ${saved.length} period timings`, "ok"); }}
          onError={(msg) => showToast(msg, "err")}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Class picker — segmented control of classes (or "My schedule" for teachers)
// --------------------------------------------------------------------------
function ClassPicker({ classKeys, value, isTeacher, onChange, allClasses }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>View</span>
      <select
        className="select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ minWidth: 160 }}
      >
        {isTeacher && <option value="">My schedule</option>}
        {classKeys.length === 0 && !isTeacher && <option value="">No classes yet</option>}
        {classKeys.map((k) => (
          <option key={k} value={k}>{labelForKey(k, allClasses)}</option>
        ))}
      </select>
    </div>
  );
}

// --------------------------------------------------------------------------
// Class grid — shows a full week × 7 periods for one class.
// --------------------------------------------------------------------------
function ClassGrid({ cls, entryByKey, canEdit, isTeacher, myStaffId, onCellClick, allClasses, periods = [], periodTimes = {} }) {
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div className="card-head">
        <div>
          <div className="card-title">{labelForKey(cls, allClasses)}</div>
          <div className="card-sub">{canEdit ? "Click any cell to assign a subject + teacher" : "Read-only weekly schedule"}</div>
        </div>
      </div>
      <div style={{ padding: "8px 14px 14px" }}>
        <div style={{ minWidth: 760 }}>
          {/* Header row */}
          <div style={{ display: "grid", gridTemplateColumns: `90px repeat(${DAYS.length}, 1fr)`, gap: 6, marginBottom: 6 }}>
            <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, alignSelf: "end" }}>Period</div>
            {DAYS.map((d) => (
              <div key={d} style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: "var(--ink)", padding: "6px 4px", background: "var(--bg-2)", borderRadius: 6 }}>
                {d}
              </div>
            ))}
          </div>
          {/* Body rows */}
          {periods.map((p) => (
            <div key={p} style={{ display: "grid", gridTemplateColumns: `90px repeat(${DAYS.length}, 1fr)`, gap: 6, marginBottom: 6 }}>
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "6px 8px", background: "var(--bg-2)", borderRadius: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>P{p}</div>
                <div style={{ fontSize: 10, color: "var(--ink-4)", whiteSpace: "nowrap" }}>{periodTimes[p]}</div>
              </div>
              {DAYS.map((d) => {
                const entry = entryByKey.get(`${cls}-${d}-${p}`);
                const mine = isTeacher && entry?.teacherId === myStaffId;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => onCellClick?.(d, p)}
                    disabled={!canEdit}
                    title={canEdit
                      ? (entry ? "Click to edit or clear" : "Click to assign")
                      : (entry ? `${entry.subject}${entry.teacherName ? ` · ${entry.teacherName}` : ""}` : "Free")}
                    style={{
                      minHeight: 64, padding: "8px 10px", borderRadius: 8,
                      border: mine ? "1.5px solid var(--accent)" : "1px solid var(--rule-2)",
                      background: entry
                        ? (mine ? "var(--accent-soft)" : "var(--card-2)")
                        : (canEdit ? "var(--bg)" : "var(--card-2)"),
                      color: "var(--ink)",
                      cursor: canEdit ? "pointer" : "default",
                      textAlign: "left",
                      transition: "border-color .12s, background .12s",
                      display: "flex", flexDirection: "column", justifyContent: "center", gap: 2,
                    }}
                  >
                    {entry ? (
                      <>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: mine ? "var(--accent-2)" : "var(--ink)" }}>
                          {entry.subject}
                        </span>
                        {entry.teacherName && (
                          <span style={{ fontSize: 10.5, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {entry.teacherName}
                          </span>
                        )}
                        {entry.room && (
                          <span style={{ fontSize: 10, color: "var(--ink-4)" }}>Room {entry.room}</span>
                        )}
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--ink-4)", textAlign: "center", width: "100%" }}>
                        {canEdit ? "+ assign" : "—"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Teacher's "my schedule" grid — same layout as ClassGrid but each cell shows
// the class instead of the teacher (since the teacher is always *me*).
// --------------------------------------------------------------------------
function TeacherGrid({ schedule, allClasses, periods = [], periodTimes = {} }) {
  const slotsToday = schedule ? schedule.size : 0;
  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div className="card-head">
        <div>
          <div className="card-title">My weekly schedule</div>
          <div className="card-sub">{slotsToday} period{slotsToday === 1 ? "" : "s"} assigned across the week</div>
        </div>
      </div>
      <div style={{ padding: "8px 14px 14px" }}>
        <div style={{ minWidth: 760 }}>
          <div style={{ display: "grid", gridTemplateColumns: `90px repeat(${DAYS.length}, 1fr)`, gap: 6, marginBottom: 6 }}>
            <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, alignSelf: "end" }}>Period</div>
            {DAYS.map((d) => (
              <div key={d} style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: "var(--ink)", padding: "6px 4px", background: "var(--bg-2)", borderRadius: 6 }}>
                {d}
              </div>
            ))}
          </div>
          {periods.map((p) => (
            <div key={p} style={{ display: "grid", gridTemplateColumns: `90px repeat(${DAYS.length}, 1fr)`, gap: 6, marginBottom: 6 }}>
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "6px 8px", background: "var(--bg-2)", borderRadius: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>P{p}</div>
                <div style={{ fontSize: 10, color: "var(--ink-4)", whiteSpace: "nowrap" }}>{periodTimes[p]}</div>
              </div>
              {DAYS.map((d) => {
                const entry = schedule?.get(`${d}-${p}`);
                return (
                  <div key={d} style={{
                    minHeight: 64, padding: "8px 10px", borderRadius: 8,
                    border: entry ? "1.5px solid var(--accent)" : "1px dashed var(--rule-2)",
                    background: entry ? "var(--accent-soft)" : "transparent",
                    display: "flex", flexDirection: "column", justifyContent: "center", gap: 2,
                  }}>
                    {entry ? (
                      <>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent-2)" }}>{entry.subject}</span>
                        <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{labelForKey(entry.cls, allClasses)}</span>
                        {entry.room && <span style={{ fontSize: 10, color: "var(--ink-4)" }}>Room {entry.room}</span>}
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--ink-4)", textAlign: "center", width: "100%" }}>—</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Slot editor — manager-only modal to assign / re-assign / clear one cell.
// --------------------------------------------------------------------------
function SlotEditorModal({
  cls, day, period, current, staff,
  subjects = [], canManageSubjects = false, onSubjectsChanged, onToast,
  onClose, onSubmit, onClear, allClasses = [],
}) {
  // The dropdown options come from the managed list at /api/subjects
  // (`subjects` prop). Fall back to the bundled list if it's still empty
  // (first load, or someone wiped the table). Either way the value stored
  // on the timetable row is the subject NAME — matching is by string.
  const subjectNames = useMemo(() => {
    const fromList = (subjects || []).map((s) => s.name).filter(Boolean);
    return fromList.length > 0 ? fromList : FALLBACK_SUBJECTS;
  }, [subjects]);
  // If we're editing an existing slot whose subject isn't in the list
  // (e.g. typed before being added), start in "other" mode pre-filled.
  const startsCustom = current?.subject && !subjectNames.includes(current.subject);
  const [pickedSubject, setPickedSubject] = useState(startsCustom ? "__other__" : (current?.subject || ""));
  const [customSubject, setCustomSubject] = useState(startsCustom ? current.subject : "");
  const [teacherId, setTeacherId] = useState(current?.teacherId || "");
  const [room, setRoom]           = useState(current?.room || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");

  // Inline "Add new subject" form — managers only. Adding writes the
  // subject globally (POST /api/subjects) AND auto-selects it for this
  // slot.
  const [showAddSubject, setShowAddSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [newSubjectCategory, setNewSubjectCategory] = useState("core");
  const [savingSubject, setSavingSubject] = useState(false);

  const teacher = staff.find((s) => s.id === teacherId);
  const finalSubject = pickedSubject === "__other__" ? customSubject.trim() : pickedSubject;

  async function saveNewSubject(e) {
    e.preventDefault();
    if (savingSubject) return;
    const name = newSubjectName.trim();
    if (!name) { setErr("Subject name is required"); return; }
    setSavingSubject(true); setErr("");
    try {
      const r = await fetch("/api/subjects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, category: newSubjectCategory }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      onToast?.(`"${j.subject.name}" added to subjects`, "ok");
      // Auto-select the new subject in the dropdown.
      setPickedSubject(j.subject.name);
      setShowAddSubject(false);
      setNewSubjectName("");
      await onSubjectsChanged?.();
    } catch (ex) { setErr(ex.message); }
    finally { setSavingSubject(false); }
  }

  async function submit(e) {
    e.preventDefault();
    if (!finalSubject) { setErr("Subject is required"); return; }
    setBusy(true); setErr("");
    try {
      await onSubmit({
        cls, day, period,
        subject: finalSubject,
        teacherId: teacher?.id || null,
        teacherName: teacher?.name || null,
        room: room.trim() || null,
      });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  return (
    <ModalShell
      title={`${labelForKey(cls, allClasses)} · ${day} · Period ${period}`}
      sub={current ? "Edit this slot or clear it" : "Assign a subject + teacher"}
      onClose={onClose}
      width={460}
    >
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field
          label="Subject *"
          hint={
            pickedSubject === "__other__"
              ? "Type a one-off subject — won't be saved to the master list."
              : (canManageSubjects ? "Don't see it? Use + Add new subject below to save it for everyone." : undefined)
          }
        >
          <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
            <select
              className="select"
              autoFocus
              value={pickedSubject}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__add_new__") {
                  setShowAddSubject(true);
                  return; // leave pickedSubject unchanged
                }
                setPickedSubject(v);
                if (v !== "__other__") setShowAddSubject(false);
              }}
              style={{ flex: 1 }}
            >
              <option value="">— select subject —</option>
              {subjectNames.map((s) => <option key={s} value={s}>{s}</option>)}
              <option value="__other__">↗ One-off (don't save)…</option>
              {canManageSubjects && (
                <option value="__add_new__">+ Add new subject…</option>
              )}
            </select>
            {canManageSubjects && !showAddSubject && (
              <button
                type="button"
                className="btn sm"
                onClick={() => setShowAddSubject(true)}
                title="Add a new subject to the master list"
              >
                <Icon name="plus" size={11} />Add
              </button>
            )}
          </div>

          {pickedSubject === "__other__" && (
            <input
              className="input"
              value={customSubject}
              onChange={(e) => setCustomSubject(e.target.value)}
              placeholder="e.g. Library period"
              style={{ marginTop: 6 }}
            />
          )}

          {canManageSubjects && showAddSubject && (
            <div style={{
              marginTop: 8, padding: 10,
              background: "var(--accent-soft, #fff4dc)",
              border: "1px solid var(--accent, #c8510a)",
              borderRadius: 9,
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Add new subject to master list
              </div>
              <input
                className="input"
                autoFocus
                value={newSubjectName}
                onChange={(e) => setNewSubjectName(e.target.value)}
                placeholder="e.g. Computer Science"
              />
              <select
                className="select"
                value={newSubjectCategory}
                onChange={(e) => setNewSubjectCategory(e.target.value)}
              >
                <option value="core">Core</option>
                <option value="language">Language</option>
                <option value="activity">Activity</option>
                <option value="optional">Optional / Elective</option>
              </select>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => { setShowAddSubject(false); setNewSubjectName(""); }}
                  disabled={savingSubject}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn accent"
                  onClick={saveNewSubject}
                  disabled={savingSubject || !newSubjectName.trim()}
                >
                  <Icon name="check" size={11} />{savingSubject ? "Saving…" : "Save & use"}
                </button>
              </div>
            </div>
          )}
        </Field>
        <Field label="Teacher" hint={`${staff.length} on staff · pick the one taking this period`}>
          <select className="select" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">— unassigned —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.dept ? ` · ${s.dept}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Room (optional)">
          <input
            className="input"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="e.g. 5A, Lab-2"
          />
        </Field>

        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
          <div>
            {onClear && (
              <button type="button" className="btn ghost" onClick={onClear} style={{ color: "var(--err, #b13c1c)" }}>
                <Icon name="x" size={12} />Clear slot
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !finalSubject}>
              <Icon name="check" size={13} />{busy ? "Saving…" : (current ? "Update" : "Assign")}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

// --------------------------------------------------------------------------
// Period editor — admin-only modal to set the whole-school period timings.
// Add/remove rows to change the number of periods; each needs an HH:MM
// start + end. Saved via PUT /api/settings/periods (admin-gated server-side).
// --------------------------------------------------------------------------
function PeriodEditorModal({ initial, onClose, onSaved, onError }) {
  const [rows, setRows] = useState(
    (initial && initial.length ? initial : DEFAULT_PERIOD_LIST).map((p) => ({ start: p.start, end: p.end }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const setRow = (i, key, val) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const addRow = () => setRows((rs) => [...rs, { start: "", end: "" }]);
  const removeRow = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  async function save() {
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const cleaned = rows
      .map((r) => ({ start: String(r.start || "").trim(), end: String(r.end || "").trim() }))
      .filter((r) => r.start && r.end);
    if (!cleaned.length) { setErr("Add at least one period with a start and end time."); return; }
    for (const r of cleaned) {
      if (!HHMM.test(r.start) || !HHMM.test(r.end)) {
        setErr(`"${r.start || "?"} – ${r.end || "?"}" isn't a valid HH:MM time.`); return;
      }
    }
    const periods = cleaned.map((r, i) => ({ period: i + 1, start: r.start, end: r.end }));
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/settings/periods", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ periods }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || "Failed to save");
      onSaved?.(j.periods);
    } catch (e) { setErr(e.message); onError?.(e.message); }
    finally { setBusy(false); }
  }

  return (
    <ModalShell
      title="Period timings"
      sub="Whole-school · applies to every class. Only the admin can change these."
      onClose={onClose}
      width={460}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 1fr 32px", gap: 8, alignItems: "center" }}>
          <div />
          <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>Start</div>
          <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>End</div>
          <div />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "44px 1fr 1fr 32px", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>P{i + 1}</div>
              <input className="input" type="time" value={r.start} onChange={(e) => setRow(i, "start", e.target.value)} />
              <input className="input" type="time" value={r.end} onChange={(e) => setRow(i, "end", e.target.value)} />
              <button type="button" className="icon-btn" title="Remove this period" onClick={() => removeRow(i)} disabled={rows.length <= 1}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn sm" onClick={addRow} style={{ alignSelf: "flex-start" }}>
          <Icon name="plus" size={11} />Add period
        </button>

        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn accent" onClick={save} disabled={busy}>
            <Icon name="check" size={13} />{busy ? "Saving…" : "Save timings"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
