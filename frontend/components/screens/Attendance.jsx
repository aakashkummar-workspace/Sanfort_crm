"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, AvatarChip } from "../ui";
import { formatClassLabel, getWorkingDays, getHolidayDates, attendanceFromLogs } from "@/backend/lib/format.js";

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

export default function ScreenAttendance({ E, refresh, role, session }) {
  // Parents get a child-scoped read-only view — no class picker, no
  // roster, no marking controls. They see today's status + a 30-day
  // attendance history for their child only. Staff fall through to
  // the full marking flow below.
  if (role === "parent") {
    return <ParentAttendanceView E={E} />;
  }

  // Parent contact numbers are hidden from the teacher login for privacy.
  const isTeacher = role === "teacher";

  // Teachers can be assigned to several classes. Build the picker list from
  // session.linkedClasses (legacy session.linkedId still honoured).
  const teacherClassList = role === "teacher"
    ? (Array.isArray(session?.linkedClasses) && session.linkedClasses.length
        ? session.linkedClasses
        : (session?.linkedId ? [session.linkedId] : []))
    : [];
  const firstTeacherKey = teacherClassList[0] || null;
  const firstTeacherSplit = firstTeacherKey
    ? (() => { const [c, s] = String(firstTeacherKey).split("-"); return { c: Number(c), s }; })()
    : null;

  const [cls, setCls] = useState(firstTeacherSplit?.c || (E.CLASSES?.[0]?.n) || 1);
  const [sec, setSec] = useState(firstTeacherSplit?.s || "A");
  const [todayIso, setTodayIso] = useState("");
  const [todayLabel, setTodayLabel] = useState("");
  const [marks, setMarks] = useState({}); // { studentId: { state: 'present'|'absent', reason: '' } }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // Same-day grace: when true the lock is bypassed so the teacher can fix
  // a mistake they just made. Reset whenever the class or date changes so
  // it never bleeds across selections.
  const [editMode, setEditMode] = useState(false);

  // Pin "today" by the system clock and re-check every 60s so a screen left
  // open across midnight will auto-roll forward (which also releases the
  // once-per-day lock below for the next day).
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const iso = d.toISOString().slice(0, 10);
      setTodayIso((prev) => (prev === iso ? prev : iso));
      setTodayLabel(d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  // Roster for the selected class+section
  const roster = useMemo(() => {
    const want = `${cls}-${sec}`;
    return (E.ADDED_STUDENTS || [])
      .filter((s) => s.cls === want)
      .map((s, i) => ({ id: s.id, name: s.name, cls: s.cls, parent: s.parent, roll: i + 1 }));
  }, [E.ADDED_STUDENTS, cls, sec]);

  // Morning bus status hints for the class teacher.
  const morningBusByStudent = useMemo(() => {
    const out = {};
    if (!todayIso) return out;
    for (const r of (E.TRANSPORT_ATTENDANCE || [])) {
      if (r.date === todayIso && (r.direction || "morning") === "morning") {
        out[r.studentId] = r.status;
      }
    }
    return out;
  }, [E.TRANSPORT_ATTENDANCE, todayIso]);

  // Pre-populate marks from existing daily logs for today. Bus-absent
  // students are seeded as class-absent by the transport API; if that
  // write hasn't landed yet, still prefill from transport status.
  useEffect(() => {
    if (!todayIso) return;
    const next = {};
    const ATT_STATES = new Set(["present", "late", "absent", "leave", "parent_drop"]);
    for (const stu of roster) {
      const log = (E.DAILY_LOGS || []).find((l) => l.studentId === stu.id && l.date === todayIso);
      const bus = morningBusByStudent[stu.id];
      if (log) {
        next[stu.id] = {
          state: ATT_STATES.has(log.attendance) ? log.attendance : "present",
          reason: log.leaveReason || "",
          saved: true,
        };
      } else if (bus === "absent") {
        next[stu.id] = { state: "absent", reason: "Missed morning bus", saved: false };
      } else if (bus === "parent") {
        next[stu.id] = { state: "parent_drop", reason: "Dropped by parent", saved: false };
      } else {
        next[stu.id] = { state: null, reason: "", saved: false };
      }
    }
    setMarks(next);
    setEditMode(false);
  }, [todayIso, roster.length, E.DAILY_LOGS, morningBusByStudent, cls, sec]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMark = (id, state) => setMarks((m) => ({
    ...m,
    [id]: {
      ...(m[id] || {}),
      state,
      reason: state === "parent_drop" ? "Dropped by parent" : (state === "present" ? "" : (m[id]?.reason || "")),
      saved: false,
    },
  }));
  const setReason = (id, reason) => setMarks((m) => ({ ...m, [id]: { ...(m[id] || {}), reason, saved: false } }));

  const presentCount = roster.filter((s) => marks[s.id]?.state === "present").length;
  const lateCount    = roster.filter((s) => marks[s.id]?.state === "late").length;
  const absentCount  = roster.filter((s) => marks[s.id]?.state === "absent").length;
  const leaveCount   = roster.filter((s) => marks[s.id]?.state === "leave").length;
  const parentDropCount = roster.filter((s) => marks[s.id]?.state === "parent_drop").length;
  const unmarkedCount = roster.length - presentCount - lateCount - absentCount - leaveCount - parentDropCount;
  const dirty = roster.some((s) => marks[s.id] && marks[s.id].saved === false && marks[s.id].state);
  // Once attendance is recorded for everyone in the class today, the screen
  // is locked until the system date changes — staff take attendance for each
  // class once per day. The teacher can tap "Edit attendance" to flip
  // editMode on and bypass the lock for in-session corrections.
  const fullyMarked = roster.length > 0 && roster.every((s) => marks[s.id]?.saved === true && marks[s.id]?.state);
  const lockedForToday = fullyMarked && !editMode;

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  const markAll = (state) => {
    const next = {};
    for (const stu of roster) {
      next[stu.id] = { state, reason: marks[stu.id]?.reason || "", saved: false };
    }
    setMarks(next);
  };

  const save = async () => {
    if (busy) return;
    const list = roster
      .filter((s) => marks[s.id]?.state)
      .map((s) => ({
        studentId: s.id,
        studentName: s.name,
        attendance: marks[s.id].state,
        // Reason persists for any non-present bucket — absent/late/leave.
        leaveReason: marks[s.id].state === "present" ? "" : (marks[s.id].reason || ""),
      }));
    if (list.length === 0) { showToast("Mark at least one student", "err"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/academic/attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayIso,
          cls: `${cls}-${sec}`,
          marks: list,
          mode: editMode ? "edit" : "initial",
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(
        `${editMode ? "Updated" : "Saved"} · ${json.present || 0} present · ${json.late || 0} late · ${json.absent || 0} absent · ${json.leave || 0} on leave${json.parent_drop ? ` · ${json.parent_drop} by parent` : ""}`,
        "ok",
      );
      // Mark all saved=true locally, then drop back into locked view.
      setMarks((m) => {
        const next = { ...m };
        for (const k of Object.keys(next)) if (next[k].state) next[k].saved = true;
        return next;
      });
      setEditMode(false);
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(false); }
  };

  const canPickClass = role !== "teacher";
  // Principal/admin can also take staff (teacher) attendance from this screen.
  // Mode flips between the existing student roster view and a new teacher panel.
  const canMarkTeachers = role === "principal" || role === "admin";
  const [mode, setMode] = useState("students"); // "students" | "teachers" | "correct"

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Attendance</div>
          <div className="page-title">Attendance <span className="amber">today</span></div>
          <div className="page-sub">{todayLabel || " "} · marks save to today's daily log for each student</div>
        </div>
        <div className="page-actions">
          {mode === "students" && roster.length > 0 && (
            <>
              <button className="btn" onClick={() => markAll("present")} disabled={busy || lockedForToday}>
                <Icon name="check" size={13} />Mark all present
              </button>
              <button className="btn" onClick={() => markAll("absent")} disabled={busy || lockedForToday}>
                <Icon name="x" size={13} />Mark all absent
              </button>
              <button
                className="btn accent"
                onClick={save}
                disabled={busy || !dirty || lockedForToday}
                title={lockedForToday ? "Already recorded for today" : ""}
              >
                {busy ? "Saving…" : lockedForToday ? <><Icon name="check" size={13} />Recorded for today</> : <><Icon name="check" size={13} />Save attendance</>}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mode tab strip. Admin/principal get the full set; teachers get their
          own two tabs (mark today + view history). */}
      {(() => {
        const tabs = canMarkTeachers
          ? [
              { k: "students", label: "Students" },
              { k: "teachers", label: "Teachers" },
              { k: "correct",  label: "Correct past" },
              { k: "history",  label: "View history" },
            ]
          : [
              { k: "students", label: "Mark today" },
              { k: "history",  label: "View history" },
            ];
        return (
          <div className="card" style={{ marginBottom: 14, padding: "10px 14px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, marginRight: 4 }}>
              {canMarkTeachers ? "Take attendance for:" : "Attendance:"}
            </span>
            {tabs.map((t) => (
              <button
                key={t.k}
                onClick={() => setMode(t.k)}
                style={{
                  padding: "6px 14px", borderRadius: 999,
                  background: mode === t.k ? "var(--accent)" : "var(--bg-2)",
                  color: mode === t.k ? "#fff" : "var(--ink-2)",
                  border: 0, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
                }}
              >{t.label}</button>
            ))}
          </div>
        );
      })()}

      {mode === "history" && (
        <AttendanceHistoryPanel
          E={E}
          role={role}
          isTeacher={isTeacher}
          todayIso={todayIso}
          teacherClassList={teacherClassList}
          showToast={showToast}
        />
      )}

      {mode === "teachers" && canMarkTeachers ? (
        <TeacherAttendancePanel
          E={E}
          today={todayIso}
          todayLabel={todayLabel}
          refresh={refresh}
          showToast={(m, t) => setToast({ msg: m, tone: t })}
        />
      ) : null}

      {mode === "correct" && canMarkTeachers ? (
        <CorrectPastAttendancePanel
          E={E}
          todayIso={todayIso}
          refresh={refresh}
          showToast={(m, t) => setToast({ msg: m, tone: t })}
        />
      ) : null}

      {mode === "students" && (
      <></>
      )}
      {mode === "students" && (<div style={{ display: "contents" }}>

      {/* Class banner / picker */}
      {role === "teacher" ? (
        <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Icon name="academic" size={16} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            Your {teacherClassList.length === 1 ? "class" : "classes"} ·
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {teacherClassList.map((key) => {
              const [c, s] = String(key).split("-");
              const active = `${cls}-${sec}` === key;
              return (
                <button
                  key={key}
                  onClick={() => { setCls(Number(c)); setSec(s); }}
                  className="btn sm"
                  style={{
                    background: active ? "var(--accent-soft)" : "var(--card)",
                    color: active ? "var(--accent-2)" : "var(--ink-2)",
                    borderColor: active ? "var(--accent)" : "var(--rule)",
                  }}
                >
                  {formatClassLabel(key)}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", marginLeft: "auto" }}>
            {roster.length} student{roster.length === 1 ? "" : "s"} on roll · {formatClassLabel(`${cls}-${sec}`)}
          </span>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: 4 }}>Class</span>
          {(E.CLASSES || []).map((c) => (
            <button
              key={c.n}
              onClick={() => setCls(c.n)}
              className="btn sm"
              style={{
                background: cls === c.n ? "var(--ink)" : "var(--card)",
                color: cls === c.n ? "var(--bg)" : "var(--ink-2)",
                borderColor: cls === c.n ? "var(--ink)" : "var(--rule)",
              }}
            >
              {c.label || formatClassLabel(String(c.n))}
            </button>
          ))}
        </div>
      )}

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI label="On roll" value={roster.length} sub={`${formatClassLabel(`${cls}-${sec}`)} · ${unmarkedCount} not marked`} puck="mint" puckIcon="students" />
        <KPI label="Present" value={presentCount + parentDropCount} sub={roster.length ? `${Math.round(((presentCount + parentDropCount) / roster.length) * 100)}%${parentDropCount ? ` · ${parentDropCount} by parent` : ""}` : "—"} puck="cream" puckIcon="check" />
        <KPI label="Late" value={lateCount} sub={lateCount ? "with reasons" : "—"} puck="peach" puckIcon="clock" />
        <KPI label="Absent / leave" value={absentCount + leaveCount} sub={`${absentCount} absent · ${leaveCount} on leave`} puck="rose" puckIcon="x" />
      </div>

      {lockedForToday && (
        <div style={{
          background: "var(--ok-soft, #e7f3e8)", color: "var(--ok, #1f7a3a)",
          border: "1px solid var(--ok, #1f7a3a)", borderRadius: 10,
          padding: "10px 14px", marginBottom: 14,
          display: "flex", alignItems: "center", gap: 10, fontSize: 12.5,
          flexWrap: "wrap",
        }}>
          <Icon name="check" size={14} />
          <span style={{ flex: 1, minWidth: 200 }}>
            Attendance for <b>{formatClassLabel(`${cls}-${sec}`)}</b> is already recorded for today
            ({todayLabel || todayIso}).
          </span>
          <button
            type="button"
            onClick={() => setEditMode(true)}
            style={{
              padding: "6px 12px", borderRadius: 7,
              background: "#fff", color: "var(--ok, #1f7a3a)",
              border: "1px solid var(--ok, #1f7a3a)",
              fontSize: 12, fontWeight: 500, cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
            title="Re-open today's attendance to fix a mistake"
          >
            <Icon name="pencil" size={12} />Edit attendance
          </button>
        </div>
      )}
      {editMode && fullyMarked && (
        <div style={{
          background: "var(--warn-soft, #fff4e0)", color: "var(--warn, #a05a00)",
          border: "1px solid var(--warn, #d98c00)", borderRadius: 10,
          padding: "10px 14px", marginBottom: 14,
          display: "flex", alignItems: "center", gap: 10, fontSize: 12.5,
        }}>
          <Icon name="pencil" size={14} />
          <span style={{ flex: 1 }}>
            Editing today's attendance for <b>{formatClassLabel(`${cls}-${sec}`)}</b>. Change any marks below and tap <b>Save attendance</b>. Every change is logged in the audit trail.
          </span>
          <button
            type="button"
            onClick={() => setEditMode(false)}
            style={{
              padding: "4px 10px", borderRadius: 6,
              background: "transparent", color: "var(--warn, #a05a00)",
              border: "1px solid var(--warn, #d98c00)",
              fontSize: 11.5, cursor: "pointer",
            }}
          >Cancel</button>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Roster · {formatClassLabel(`${cls}-${sec}`)}</div>
            <div className="card-sub">
              {lockedForToday
                ? "Today's attendance is locked. Buttons reopen tomorrow."
                : "Tap Present or Absent for each student. Add a reason when absent."}
            </div>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Student</th>
                <th>Roll · ID</th>
                {!isTeacher && <th>Parent</th>}
                <th style={{ width: 320 }}>Status</th>
                <th>Reason (late · absent · leave)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roster.length === 0 && (
                <tr><td colSpan={isTeacher ? 6 : 7} className="empty">
                  No students in {formatClassLabel(`${cls}-${sec}`)} yet. Add students from the Students screen first.
                </td></tr>
              )}
              {roster.map((s, i) => {
                const m = marks[s.id] || { state: null, reason: "" };
                const busStatus = morningBusByStudent[s.id];
                const STATE_PILLS = [
                  { k: "present",     label: "Present",   icon: "check",    soft: "ok-soft",     fg: "ok" },
                  { k: "late",        label: "Late",      icon: "clock",    soft: "warn-soft",   fg: "warn" },
                  { k: "absent",      label: "Absent",    icon: "x",        soft: "bad-soft",    fg: "bad" },
                  { k: "leave",       label: "Leave",     icon: "calendar", soft: "accent-soft", fg: "accent" },
                  { k: "parent_drop", label: "By parent", icon: "users",    soft: "warn-soft",   fg: "warn" },
                ];
                const needsReason = m.state && m.state !== "present" && m.state !== "parent_drop";
                return (
                  <tr key={s.id}>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>{String(i + 1).padStart(2, "0")}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <AvatarChip initials={(s.name || "?").split(" ").map((n) => n[0]).join("")} />
                        <span style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</span>
                        {busStatus === "absent" && m.state !== "parent_drop" && (
                          <span className="chip bad" style={{ fontSize: 9.5 }} title="Marked absent on morning bus">
                            Bus absent
                          </span>
                        )}
                        {(busStatus === "parent" || m.state === "parent_drop") && (
                          <span className="chip warn" style={{ fontSize: 9.5 }} title="Missed morning bus · arrived by parent · evening bus unlocked">
                            By parent
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                      {String(s.roll).padStart(2, "0")} · {s.id}
                    </td>
                    {!isTeacher && <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{s.parent}</td>}
                    <td>
                      <div className="segmented" style={{ width: "fit-content", opacity: lockedForToday ? 0.7 : 1, flexWrap: "wrap" }}>
                        {STATE_PILLS.map((p) => {
                          const active = m.state === p.k;
                          return (
                            <button
                              key={p.k}
                              type="button"
                              className={active ? "active" : ""}
                              onClick={() => setMark(s.id, p.k)}
                              disabled={lockedForToday}
                              title={p.k === "parent_drop" ? "Missed bus but arrived by parent — unlocks evening transport" : undefined}
                              style={active ? { background: `var(--${p.soft})`, color: `var(--${p.fg})` } : {}}
                            >
                              <Icon name={p.icon} size={11} />{p.label}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      {needsReason ? (
                        <input
                          className="input"
                          style={{ height: 28, fontSize: 12 }}
                          value={m.reason}
                          disabled={lockedForToday}
                          onChange={(e) => setReason(s.id, e.target.value)}
                          placeholder={
                            m.state === "late"   ? "Traffic / late bus / overslept …" :
                            m.state === "leave"  ? "Pre-approved leave reason …" :
                                                   "Sick / family event …"
                          }
                        />
                      ) : m.state === "parent_drop" ? (
                        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Dropped by parent</span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--ink-4)" }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {m.saved && m.state && (
                        <span className="chip ok" style={{ fontSize: 10 }}><span className="dot" />Saved</span>
                      )}
                      {!m.saved && m.state && (
                        <span className="chip warn" style={{ fontSize: 10 }}><span className="dot" />Unsaved</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </div>
      )}

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}

// Teacher attendance panel — visible only to principal/admin via the mode tab
// at the top. Shows every teacher (from /api/users?role=teacher) with their
// today status + Present/Absent/Leave buttons + a Save All. Self-marks done by
// the teacher themselves on the Exams & Marks screen still feed the same data.
function TeacherAttendancePanel({ E, today, todayLabel, refresh, showToast }) {
  const [teachers, setTeachers] = useState([]);
  const [todays, setTodays] = useState([]); // pre-existing rows for today
  const [drafts, setDrafts] = useState({}); // teacherId -> "present"|"absent"|"leave"
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [logVersion, setLogVersion] = useState(0); // bumped after a save so the provenance card re-pulls

  // Pull list of teachers + today's attendance once.
  useEffect(() => {
    if (!today) return;
    let cancel = false;
    (async () => {
      try {
        const [tu, ta] = await Promise.all([
          fetch(`/api/users?role=teacher`,    { cache: "no-store" }).then((r) => r.json()),
          fetch(`/api/teacher-attendance?fromDate=${today}&toDate=${today}`, { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (cancel) return;
        setTeachers(tu.ok ? (tu.teachers || []) : []);
        setTodays(ta.ok  ? (ta.records  || []) : []);
        const d = {};
        for (const r of (ta.records || [])) d[r.teacherId] = r.status;
        setDrafts(d);
      } catch {}
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [today]);

  const counts = useMemo(() => {
    const out = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0 };
    for (const t of teachers) {
      const v = drafts[t.id];
      if (v === "present")      out.present++;
      else if (v === "late")    out.late++;
      else if (v === "absent")  out.absent++;
      else if (v === "leave")   out.leave++;
      else                      out.unmarked++;
    }
    return out;
  }, [drafts, teachers]);

  const dirty = useMemo(() => {
    const saved = {};
    for (const r of todays) saved[r.teacherId] = r.status;
    return Object.keys(drafts).some((id) => drafts[id] !== saved[id]);
  }, [drafts, todays]);

  const setMark = (teacherId, status) => setDrafts((d) => ({ ...d, [teacherId]: status }));
  const markAll = (status) => {
    const next = {};
    for (const t of teachers) next[t.id] = status;
    setDrafts(next);
  };

  async function saveAll() {
    setBusy(true);
    try {
      const entries = teachers
        .map((t) => drafts[t.id] ? { teacherId: t.id, status: drafts[t.id] } : null)
        .filter(Boolean);
      // No bulk endpoint — POST one by one. Volumes are small (school-scale).
      for (const e of entries) {
        const r = await fetch("/api/teacher-attendance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teacherId: e.teacherId, date: today, status: e.status, source: "admin" }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      }
      showToast(`Saved ${entries.length} teacher attendance${entries.length === 1 ? "" : "s"}`, "ok");
      // Re-pull so `dirty` becomes false again.
      const ta = await fetch(`/api/teacher-attendance?fromDate=${today}&toDate=${today}`, { cache: "no-store" }).then((r) => r.json());
      if (ta.ok) setTodays(ta.records || []);
      setLogVersion((v) => v + 1);
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="card empty">Loading teachers…</div>;
  if (teachers.length === 0) return <div className="card empty">No teachers yet — add staff with role <b>Teacher</b> from the Staff screen.</div>;

  return (
    <div>
      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI label="Present today" value={counts.present} sub={`${todayLabel || today}`} puck="mint" puckIcon="check" />
        <KPI label="Late arrivals" value={counts.late} sub={counts.late ? "with reasons" : "—"} puck="peach" puckIcon="clock" />
        <KPI label="Absent / leave" value={counts.absent + counts.leave} sub={`${counts.absent} absent · ${counts.leave} on leave`} puck="rose" puckIcon="warning" />
        <KPI label="Unmarked" value={counts.unmarked} sub={counts.unmarked ? "needs marking" : "all done"} puck="cream" puckIcon="audit" />
      </div>

      <div className="card">
        <div className="card-head">
          <div><div className="card-title">Teachers · today</div><div className="card-sub">Tap a chip to mark · click Save when done</div></div>
          <div className="card-actions" style={{ display: "flex", gap: 6 }}>
            <button className="btn sm" onClick={() => markAll("present")} disabled={busy}><Icon name="check" size={11} />All present</button>
            <button className="btn sm" onClick={() => markAll("absent")} disabled={busy}><Icon name="x" size={11} />All absent</button>
            <button className="btn sm accent" onClick={saveAll} disabled={busy || !dirty}>
              {busy ? "Saving…" : <><Icon name="check" size={13} />{dirty ? "Save attendance" : "Saved"}</>}
            </button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>#</th><th>Teacher</th><th>Email</th><th style={{ textAlign: "right" }}>Mark</th></tr>
            </thead>
            <tbody>
              {teachers.map((t, i) => (
                <tr key={t.id}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)", width: 32 }}>{String(i + 1).padStart(2, "0")}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <AvatarChip initials={(t.name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()} />
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.name}</div>
                        {t.linkedClasses?.length > 0 && (
                          <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>Classes: {t.linkedClasses.join(", ")}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{t.email}</td>
                  <td style={{ textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <MarkChip label="Present" tone="ok"   active={drafts[t.id] === "present"} onClick={() => setMark(t.id, "present")} />
                      <MarkChip label="Late"    tone="warn" active={drafts[t.id] === "late"}    onClick={() => setMark(t.id, "late")} />
                      <MarkChip label="Absent"  tone="bad"  active={drafts[t.id] === "absent"}  onClick={() => setMark(t.id, "absent")} />
                      <MarkChip label="Leave"   tone="info" active={drafts[t.id] === "leave"}   onClick={() => setMark(t.id, "leave")} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <TeacherMarkProvenance version={logVersion} showToast={showToast} />
    </div>
  );
}

const SOURCE_LABELS = {
  self: "Self · My Attendance",
  admin: "Admin · Attendance screen",
  "exams-strip": "Self · Exams quick strip",
};

const STATUS_TONE = { present: "ok", late: "warn", absent: "bad", leave: "info" };

const fmtWhen = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

// Where each staff mark came from, read from teacher_attendance_log. The log is
// append-only, so more than one entry for a (teacher, date) means the mark was
// corrected — the newest row is the mark that stands and the rest are history.
// Admin/principal only; the route refuses anyone else.
function TeacherMarkProvenance({ version, showToast }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [openKey, setOpenKey] = useState(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/teacher-attendance/log?limit=300`, { cache: "no-store" });
        const j = await r.json();
        if (cancel) return;
        if (r.status === 403) { setDenied(true); setRows([]); }
        else setRows(j.ok ? (j.rows || []) : []);
      } catch {}
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [version]);

  // Group by (teacher, date) so a corrected mark collapses into one line with
  // its own history rather than repeating in the list.
  const groups = useMemo(() => {
    const byKey = new Map();
    for (const r of rows) {
      const key = `${r.teacherId}|${r.date}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => String(b.markedAt || "").localeCompare(String(a.markedAt || "")));
    }
    return [...byKey.entries()]
      .map(([key, list]) => ({ key, latest: list[0], history: list }))
      .sort((a, b) => String(b.latest.markedAt || "").localeCompare(String(a.latest.markedAt || "")));
  }, [rows]);

  if (loading) return <div className="card empty" style={{ marginTop: 14 }}>Loading mark history…</div>;
  if (denied)  return null;

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Where marks came from</div>
          <div className="card-sub">
            Who marked it, from which screen, and when · click a changed mark for its history
          </div>
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="empty">
          No mark history yet — it starts filling from the next time attendance is marked.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Staff</th><th>For date</th><th>Status</th>
                <th>Marked by</th><th>From</th><th>Marked at</th><th></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const changed = g.history.length > 1;
                const open = openKey === g.key;
                return (
                  <Fragment key={g.key}>
                    <tr
                      onClick={() => changed && setOpenKey(open ? null : g.key)}
                      style={{ cursor: changed ? "pointer" : "default" }}
                    >
                      <td style={{ fontSize: 12.5 }}>{g.latest.teacherName || "—"}</td>
                      <td style={{ fontSize: 11.5, fontFamily: "var(--font-mono)" }}>{g.latest.date}</td>
                      <td>
                        <span className={`chip ${STATUS_TONE[g.latest.status] || ""}`}>
                          {g.latest.status || "—"}
                        </span>
                      </td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{g.latest.markedBy || "—"}</td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        {SOURCE_LABELS[g.latest.markedFrom] || g.latest.markedFrom || "—"}
                      </td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{fmtWhen(g.latest.markedAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        {changed && (
                          <span className="chip warn">changed {g.history.length - 1}×</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ background: "var(--bg-2)", padding: "8px 12px" }}>
                          {g.history.map((h) => (
                            <div key={h.id} style={{ fontSize: 11.5, color: "var(--ink-3)", padding: "3px 0" }}>
                              <b style={{ color: "var(--ink-1)" }}>{h.status || "—"}</b>
                              {h.previousStatus ? ` (was ${h.previousStatus})` : " (first mark)"}
                              {" · "}{h.markedBy || "—"}
                              {" · "}{SOURCE_LABELS[h.markedFrom] || h.markedFrom || "—"}
                              {" · "}{fmtWhen(h.markedAt)}
                              {h.leaveReason ? ` · "${h.leaveReason}"` : ""}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MarkChip({ label, tone, active, onClick }) {
  const bg = active
    ? (tone === "ok" ? "var(--ok)"
     : tone === "bad" ? "var(--err, #b13c1c)"
     : tone === "info" ? "var(--accent, #1f3f8b)"
     : "var(--warn)")
    : "var(--bg-2)";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 10px", borderRadius: 6,
        background: bg, color: active ? "#fff" : "var(--ink-2)",
        border: 0, cursor: "pointer",
        fontSize: 11, fontWeight: 500,
        transition: "background .12s",
      }}
    >{label}</button>
  );
}

// Parent-only attendance view. Read-only summary for one child.
// Server-side, /api/data parent-scope already filters dailyLogs to just
// this child's records, so we can iterate freely without leaking other
// students' attendance.
function ParentAttendanceView({ E }) {
  const child = (E.ADDED_STUDENTS || [])[0] || null;

  if (!child) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-eyebrow">PEOPLE · ATTENDANCE</div>
            <div className="page-title">Attendance</div>
            <div className="page-sub">Ask the school office to link your account to your child's record.</div>
          </div>
        </div>
      </div>
    );
  }

  const logs = (E.DAILY_LOGS || []).filter((l) => l.studentId === child.id);

  // Today's status from the latest log
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayLog = logs.find((l) => l.date === todayIso);
  const todayState = !todayLog
    ? "not_posted"
    : todayLog.attendance === "absent"
      ? "absent"
      : "present";

  // Term-level stats — % uses class working days minus holidays.
  const holidayDates = getHolidayDates(E.SETTINGS);
  const workingDays = getWorkingDays(E.SETTINGS, child.cls);
  const attStats = attendanceFromLogs(logs, workingDays, { holidayDates });
  const presentCount = attStats.presentCount;
  const absentCount  = attStats.absentCount;
  const totalLogs    = attStats.totalLogs;
  const pct = attStats.pct;

  // Build a 30-day grid: most recent day first, weekends muted, days
  // with no log shown as "—".
  const grid = (() => {
    const out = [];
    const today = new Date(`${todayIso}T00:00:00`);
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const log = logs.find((l) => l.date === iso);
      const isWeekend = d.getDay() === 0;
      out.push({
        iso,
        dateLabel: d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }),
        state: isWeekend
          ? "weekend"
          : !log ? "empty" : (log.attendance === "absent" ? "absent" : "present"),
        reason: log?.reason || null,
        postedBy: log?.postedBy || null,
      });
    }
    return out;
  })();

  const statusBadge = todayState === "present"
    ? { label: "Present", color: "var(--ok)", bg: "var(--ok-soft, #e6f4ec)" }
    : todayState === "absent"
      ? { label: "Absent", color: "var(--bad)", bg: "var(--bad-soft, #fbe1d8)" }
      : { label: "Not posted yet", color: "var(--ink-3)", bg: "var(--bg-2)" };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">PEOPLE · ATTENDANCE</div>
          <div className="page-title">Attendance <span className="amber">history</span></div>
          <div className="page-sub">
            {child.name} · {formatClassLabel(child.cls)} · {totalLogs} day{totalLogs === 1 ? "" : "s"} logged so far
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid g-4" style={{ marginBottom: 18 }}>
        <KPI
          label="Today"
          value={statusBadge.label}
          sub={todayLog ? `Marked by ${todayLog.postedBy || "teacher"}` : "Teacher hasn't posted yet"}
          puck={todayState === "absent" ? "rose" : todayState === "present" ? "mint" : "cream"}
          puckIcon={todayState === "absent" ? "x" : "check"}
        />
        <KPI
          label="This term"
          value={pct !== null ? `${pct}%` : "—"}
          sub={attStats.denom
            ? `${presentCount}/${attStats.denom}${workingDays ? " working days" : " days logged"}`
            : "no logs yet"}
          puck="peach"
          puckIcon="trending"
        />
        <KPI
          label="Days present"
          value={presentCount}
          sub={workingDays ? `of ${workingDays} working days` : `out of ${totalLogs} logged`}
          puck="mint"
          puckIcon="check"
        />
        <KPI
          label="Days absent"
          value={absentCount}
          sub={absentCount > 0 ? "see reasons below" : "no absences"}
          puck={absentCount > 0 ? "rose" : "mint"}
          puckIcon={absentCount > 0 ? "x" : "check"}
        />
      </div>

      {/* 30-day timeline list */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Last 30 days</div>
            <div className="card-sub">Most recent first · weekends marked as 'Holiday'</div>
          </div>
        </div>
        <div style={{ maxHeight: 480, overflowY: "auto" }}>
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Date</th>
                <th>Status</th>
                <th>Marked by</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {grid.length === 0 && (
                <tr><td colSpan={4} className="empty">No attendance records yet.</td></tr>
              )}
              {grid.map((row) => {
                const pill = row.state === "present"
                  ? { label: "Present", color: "var(--ok)" }
                  : row.state === "absent"
                    ? { label: "Absent",  color: "var(--bad)" }
                    : row.state === "weekend"
                      ? { label: "Holiday", color: "var(--ink-4)" }
                      : { label: "—", color: "var(--ink-4)" };
                return (
                  <tr key={row.iso} style={{ borderTop: "1px solid var(--rule-2)" }}>
                    <td style={{ padding: "10px 12px", fontSize: 12.5, color: "var(--ink-2)" }}>
                      {row.dateLabel}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        padding: "2px 10px", borderRadius: 999,
                        fontSize: 11, fontWeight: 500,
                        color: pill.color, border: `1px solid ${pill.color}`,
                        background: "transparent",
                      }}>
                        {pill.label}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--ink-3)" }}>
                      {row.postedBy || "—"}
                    </td>
                    <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--ink-3)" }}>
                      {row.reason || (row.state === "absent" ? "No reason recorded" : "—")}
                    </td>
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

// Principal/Admin "Correct past attendance" — pick any past or current date
// + class, edit any student's mark with a mandatory reason, save. Audit log
// captures who corrected what, when, and why. The same /api/academic/attendance
// endpoint handles the write (UPSERT in markAttendanceBulk preserves classwork
// and homework on the row), and `mode: "correction"` tells the audit-log
// writer to use the "Corrected class attendance" verb.
function CorrectPastAttendancePanel({ E, todayIso, refresh, showToast }) {
  const ATT_STATES = new Set(["present", "late", "absent", "leave"]);

  const firstClassKey = (() => {
    const c = (E.CLASSES || [])[0];
    if (!c) return { cls: 1, sec: "A" };
    const sec = Array.isArray(c.sections) && c.sections.length ? c.sections[0] : "A";
    return { cls: c.n, sec };
  })();

  const [date, setDate] = useState(todayIso || "");
  const [cls, setCls] = useState(firstClassKey.cls);
  const [sec, setSec] = useState(firstClassKey.sec);
  const [marks, setMarks] = useState({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const roster = useMemo(() => {
    const want = `${cls}-${sec}`;
    return (E.ADDED_STUDENTS || [])
      .filter((s) => s.cls === want)
      .map((s, i) => ({ id: s.id, name: s.name, cls: s.cls, parent: s.parent, roll: i + 1 }));
  }, [E.ADDED_STUDENTS, cls, sec]);

  // Pre-fill marks from existing daily_logs for the chosen date + class.
  // Students with no row that day come in unmarked so the principal can
  // either fill them in or leave them blank (blanks are skipped on save).
  useEffect(() => {
    if (!date) return;
    const next = {};
    for (const stu of roster) {
      const log = (E.DAILY_LOGS || []).find((l) => l.studentId === stu.id && l.date === date);
      next[stu.id] = log
        ? {
            state: ATT_STATES.has(log.attendance) ? log.attendance : "present",
            reason: log.leaveReason || "",
            original: ATT_STATES.has(log.attendance) ? log.attendance : "present",
          }
        : { state: null, reason: "", original: null };
    }
    setMarks(next);
  }, [date, roster.length, E.DAILY_LOGS, cls, sec]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMark = (id, state) => setMarks((m) => ({ ...m, [id]: { ...(m[id] || {}), state } }));
  const setStudentReason = (id, r) => setMarks((m) => ({ ...m, [id]: { ...(m[id] || {}), reason: r } }));

  // What actually changed vs the existing record. The Save action sends
  // ONLY changed rows + ones that were previously unmarked but now have a
  // state, so a partial correction doesn't accidentally re-stamp untouched
  // students' postedBy / timestamp.
  const changed = roster.filter((s) => {
    const m = marks[s.id];
    if (!m || !m.state) return false;
    return m.state !== m.original;
  });

  const dateLabel = (() => {
    if (!date) return "";
    const d = new Date(`${date}T00:00:00`);
    return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  })();
  const isFutureDate = date && date > (todayIso || "");

  async function save() {
    if (busy) return;
    if (changed.length === 0) { showToast("No changes to save", "err"); return; }
    if (!reason.trim()) { showToast("Reason for correction is required", "err"); return; }
    if (isFutureDate) { showToast("Cannot correct a future date", "err"); return; }
    setBusy(true);
    try {
      const list = changed.map((s) => ({
        studentId: s.id,
        studentName: s.name,
        attendance: marks[s.id].state,
        leaveReason: marks[s.id].state === "present" ? "" : (marks[s.id].reason || ""),
      }));
      const r = await fetch("/api/academic/attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          cls: `${cls}-${sec}`,
          marks: list,
          mode: "correction",
          correctionReason: reason.trim(),
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`Corrected ${list.length} student${list.length === 1 ? "" : "s"} for ${date}`, "ok");
      setReason("");
      setMarks((m) => {
        const next = {};
        for (const k of Object.keys(m)) next[k] = { ...m[k], original: m[k].state };
        return next;
      });
      await refresh?.();
    } catch (e) { showToast(e.message || "Failed", "err"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {/* Date + class picker */}
      <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>Date</span>
          <input
            type="date"
            value={date}
            max={todayIso || undefined}
            onChange={(e) => setDate(e.target.value)}
            className="input"
            style={{ height: 32, fontSize: 13, minWidth: 160 }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>Class</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(E.CLASSES || []).map((c) => (
              <button
                key={c.n}
                onClick={() => setCls(c.n)}
                className="btn sm"
                style={{
                  background: cls === c.n ? "var(--ink)" : "var(--card)",
                  color: cls === c.n ? "var(--bg)" : "var(--ink-2)",
                  borderColor: cls === c.n ? "var(--ink)" : "var(--rule)",
                }}
              >{c.label || formatClassLabel(String(c.n))}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>Section</span>
          <div style={{ display: "flex", gap: 6 }}>
            {(() => {
              const klass = (E.CLASSES || []).find((c) => c.n === cls);
              const secs = (klass?.sections && klass.sections.length) ? klass.sections : ["A"];
              return secs.map((s) => (
                <button
                  key={s}
                  onClick={() => setSec(s)}
                  className="btn sm"
                  style={{
                    background: sec === s ? "var(--ink)" : "var(--card)",
                    color: sec === s ? "var(--bg)" : "var(--ink-2)",
                    borderColor: sec === s ? "var(--ink)" : "var(--rule)",
                  }}
                >{s}</button>
              ));
            })()}
          </div>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-3)", textAlign: "right" }}>
          {date && <div><b>{dateLabel}</b></div>}
          <div>{roster.length} student{roster.length === 1 ? "" : "s"} · {changed.length} change{changed.length === 1 ? "" : "s"} pending</div>
        </div>
      </div>

      {/* Reason banner — required for any correction. The reason is included
          in the audit log so anyone reviewing later understands WHY a past
          day's mark was flipped. */}
      <div className="card" style={{ marginBottom: 14, padding: "12px 14px", background: "var(--warn-soft, #fff4e0)", border: "1px solid var(--warn, #d98c00)" }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--warn, #a05a00)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          Reason for correction <span style={{ color: "var(--bad, #b13c1c)" }}>*</span>
        </div>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Student attended after medical leave / teacher tapped wrong row / register was late to update"
          style={{ width: "100%", fontSize: 12.5 }}
        />
      </div>

      {/* Roster */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Roster · {formatClassLabel(`${cls}-${sec}`)} · {date || "(no date)"}</div>
            <div className="card-sub">
              {date
                ? `Edit any student below. Only changed rows are saved. ${changed.length} pending.`
                : "Pick a date above to load the roster."}
            </div>
          </div>
          <div>
            <button
              className="btn accent"
              onClick={save}
              disabled={busy || changed.length === 0 || !reason.trim() || isFutureDate || !date}
              title={!date ? "Pick a date first" : !reason.trim() ? "Reason required" : changed.length === 0 ? "No changes" : ""}
            >
              {busy ? "Saving…" : <><Icon name="check" size={13} />Save corrections{changed.length > 0 ? ` (${changed.length})` : ""}</>}
            </button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Student</th>
                <th>Roll · ID</th>
                <th>Was</th>
                <th style={{ width: 320 }}>Now</th>
                <th>Reason (late · absent · leave)</th>
              </tr>
            </thead>
            <tbody>
              {!date && (
                <tr><td colSpan={6} className="empty">Pick a date to begin.</td></tr>
              )}
              {date && roster.length === 0 && (
                <tr><td colSpan={6} className="empty">No students in {formatClassLabel(`${cls}-${sec}`)} yet.</td></tr>
              )}
              {date && roster.map((s, i) => {
                const m = marks[s.id] || { state: null, reason: "", original: null };
                const STATE_PILLS = [
                  { k: "present", label: "Present", icon: "check", soft: "ok-soft",  fg: "ok" },
                  { k: "late",    label: "Late",    icon: "clock", soft: "warn-soft", fg: "warn" },
                  { k: "absent",  label: "Absent",  icon: "x",     soft: "bad-soft",  fg: "bad" },
                  { k: "leave",   label: "Leave",   icon: "calendar", soft: "accent-soft", fg: "accent" },
                ];
                const needsReason = m.state && m.state !== "present";
                const isChanged = m.state && m.state !== m.original;
                return (
                  <tr key={s.id} style={isChanged ? { background: "var(--accent-soft, rgba(232,83,14,0.06))" } : null}>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>{String(i + 1).padStart(2, "0")}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <AvatarChip initials={(s.name || "?").split(" ").map((n) => n[0]).join("")} />
                        <span style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</span>
                      </div>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                      {String(s.roll).padStart(2, "0")} · {s.id}
                    </td>
                    <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {m.original
                        ? <span style={{ textTransform: "capitalize" }}>{m.original}</span>
                        : <span style={{ color: "var(--ink-4)" }}>not marked</span>}
                    </td>
                    <td>
                      <div className="segmented" style={{ width: "fit-content", flexWrap: "wrap" }}>
                        {STATE_PILLS.map((p) => {
                          const active = m.state === p.k;
                          return (
                            <button
                              key={p.k}
                              type="button"
                              className={active ? "active" : ""}
                              onClick={() => setMark(s.id, p.k)}
                              style={active ? { background: `var(--${p.soft})`, color: `var(--${p.fg})` } : {}}
                            >
                              <Icon name={p.icon} size={11} />{p.label}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      {needsReason ? (
                        <input
                          className="input"
                          style={{ height: 28, fontSize: 12 }}
                          value={m.reason}
                          onChange={(e) => setStudentReason(s.id, e.target.value)}
                          placeholder={
                            m.state === "late"  ? "Traffic / late bus …" :
                            m.state === "leave" ? "Pre-approved leave reason …" :
                                                  "Sick / family event …"
                          }
                        />
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--ink-4)" }}>—</span>
                      )}
                    </td>
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

// Read-only attendance viewer for teachers (and staff) — Day-wise (one date,
// per-student status) or Month-wise (a full register grid + per-student
// present/absent/% totals). Data comes from GET /api/academic/attendance,
// which paginates past the bootstrap 1000-row cap.
function AttendanceHistoryPanel({ E, role, isTeacher, todayIso, teacherClassList, showToast }) {
  const CELL = {
    present:     { t: "P",  bg: "var(--ok-soft, #dfecd8)",   fg: "var(--ok)" },
    late:        { t: "L",  bg: "var(--warn-soft, #fff4e0)", fg: "var(--warn, #a05a00)" },
    absent:      { t: "A",  bg: "var(--bad-soft, #fbe1d8)",  fg: "var(--err, #b13c1c)" },
    leave:       { t: "Lv", bg: "var(--accent-soft)",        fg: "var(--accent-2)" },
    parent_drop: { t: "P",  bg: "var(--ok-soft, #dfecd8)",   fg: "var(--ok)" },
  };
  const STATUS_LABEL = { present: "Present", late: "Late", absent: "Absent", leave: "Leave", parent_drop: "By parent" };
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];

  // Selectable classes: teachers see their linked classes; others see all
  // class-sections in the school.
  const classKeys = useMemo(() => {
    if (isTeacher) return teacherClassList || [];
    return (E.CLASSES || []).flatMap((c) =>
      ((c.sections && c.sections.length) ? c.sections : ["A"]).map((s) => `${c.n}-${s}`)
    );
  }, [E.CLASSES, isTeacher, teacherClassList]);

  const [classKey, setClassKey] = useState(classKeys[0] || "");
  const [view, setView] = useState("day");            // "day" | "month"
  const [day, setDay] = useState(todayIso || "");
  const [month, setMonth] = useState((todayIso || "").slice(0, 7)); // YYYY-MM
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (todayIso) {
      setDay((d) => d || todayIso);
      setMonth((m) => m || todayIso.slice(0, 7));
    }
  }, [todayIso]);
  useEffect(() => {
    if (!classKey && classKeys.length) setClassKey(classKeys[0]);
  }, [classKeys, classKey]);

  const range = useMemo(() => {
    if (view === "day") return { from: day, to: day };
    if (!month) return { from: "", to: "" };
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
  }, [view, day, month]);

  const roster = useMemo(() => {
    if (!classKey) return [];
    return (E.ADDED_STUDENTS || [])
      .filter((s) => s.cls === classKey)
      .map((s, i) => ({ id: s.id, name: s.name, roll: i + 1 }));
  }, [E.ADDED_STUDENTS, classKey]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!classKey || !range.from || !range.to) { setLogs([]); return; }
      setLoading(true);
      try {
        const r = await fetch(`/api/academic/attendance?cls=${encodeURIComponent(classKey)}&from=${range.from}&to=${range.to}`, { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) {
          if (j.ok) setLogs(j.logs || []);
          else { setLogs([]); showToast?.(j.error || "Couldn't load attendance", "err"); }
        }
      } catch { if (!cancelled) setLogs([]); }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [classKey, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const byStudentDate = useMemo(() => {
    const out = {};
    for (const l of logs) {
      if (!out[l.studentId]) out[l.studentId] = {};
      out[l.studentId][l.date] = l.attendance || "present";
    }
    return out;
  }, [logs]);

  const monthDays = useMemo(() => {
    if (view !== "month" || !month) return [];
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const out = [];
    for (let d = 1; d <= lastDay; d++) {
      const ds = `${month}-${String(d).padStart(2, "0")}`;
      const dow = new Date(`${ds}T00:00:00`).getDay();
      out.push({ d, ds, dow });
    }
    return out;
  }, [view, month]);

  const summarize = (sid) => {
    const days = byStudentDate[sid] || {};
    let present = 0, absent = 0, late = 0, leave = 0, parent = 0;
    for (const v of Object.values(days)) {
      if (v === "present") present++;
      else if (v === "late") late++;
      else if (v === "absent") absent++;
      else if (v === "leave") leave++;
      else if (v === "parent_drop") parent++;
    }
    const atSchool = present + late + parent;
    const marked = atSchool + absent + leave;
    return { atSchool, absent, marked, pct: marked ? Math.round((atSchool / marked) * 100) : 0 };
  };

  const dayTotals = useMemo(() => {
    if (view !== "day") return null;
    const t = { present: 0, late: 0, absent: 0, leave: 0, parent_drop: 0, unmarked: 0 };
    for (const s of roster) {
      const v = byStudentDate[s.id]?.[day];
      if (v && t[v] != null) t[v]++; else t.unmarked++;
    }
    return t;
  }, [view, roster, byStudentDate, day]);

  return (
    <div>
      {/* Controls */}
      <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>Class</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {classKeys.length === 0 && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>No class assigned</span>}
            {classKeys.map((k) => (
              <button
                key={k}
                onClick={() => setClassKey(k)}
                className="btn sm"
                style={{
                  background: classKey === k ? "var(--ink)" : "var(--card)",
                  color: classKey === k ? "var(--bg)" : "var(--ink-2)",
                  borderColor: classKey === k ? "var(--ink)" : "var(--rule)",
                }}
              >{formatClassLabel(k)}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>View</span>
          <div className="segmented">
            <button className={view === "day" ? "active" : ""} onClick={() => setView("day")}>Day-wise</button>
            <button className={view === "month" ? "active" : ""} onClick={() => setView("month")}>Month-wise</button>
          </div>
        </div>

        {view === "day" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>Date</span>
            <input type="date" className="input" value={day} max={todayIso || undefined} onChange={(e) => setDay(e.target.value)} style={{ height: 32, fontSize: 13, minWidth: 150 }} />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>Month</span>
            <input type="month" className="input" value={month} max={(todayIso || "").slice(0, 7) || undefined} onChange={(e) => setMonth(e.target.value)} style={{ height: 32, fontSize: 13, minWidth: 150 }} />
          </div>
        )}

        <div style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-3)", textAlign: "right" }}>
          {loading ? "Loading…" : `${roster.length} student${roster.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, fontSize: 11, color: "var(--ink-3)" }}>
        {["present", "late", "absent", "leave"].map((k) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: CELL[k].bg, color: CELL[k].fg, display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700 }}>{CELL[k].t}</span>
            {STATUS_LABEL[k]}
          </span>
        ))}
      </div>

      {view === "day" ? (
        <>
          {dayTotals && (
            <div className="grid g-4" style={{ marginBottom: 14 }}>
              <KPI label="Present" value={dayTotals.present + dayTotals.parent_drop} sub={dayTotals.parent_drop ? `${dayTotals.parent_drop} by parent` : "in class"} puck="mint" puckIcon="check" />
              <KPI label="Late" value={dayTotals.late} sub="—" puck="peach" puckIcon="clock" />
              <KPI label="Absent / leave" value={dayTotals.absent + dayTotals.leave} sub={`${dayTotals.absent} absent · ${dayTotals.leave} leave`} puck="rose" puckIcon="x" />
              <KPI label="Not marked" value={dayTotals.unmarked} sub={day || "—"} puck="cream" puckIcon="clock" />
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">{classKey ? formatClassLabel(classKey) : "—"} · {day || "(no date)"}</div>
                <div className="card-sub">Day-wise attendance</div>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>#</th>
                    <th>Student</th>
                    <th>Roll · ID</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.length === 0 && <tr><td colSpan={4} className="empty">No students in this class.</td></tr>}
                  {roster.map((s, i) => {
                    const v = byStudentDate[s.id]?.[day];
                    const c = v ? CELL[v] : null;
                    return (
                      <tr key={s.id}>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>{String(i + 1).padStart(2, "0")}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <AvatarChip initials={(s.name || "?").split(" ").map((n) => n[0]).join("")} />
                            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</span>
                          </div>
                        </td>
                        <td style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{String(s.roll).padStart(2, "0")} · {s.id}</td>
                        <td>
                          {v
                            ? <span className="chip" style={{ background: c.bg, color: c.fg }}><span className="dot" />{STATUS_LABEL[v]}</span>
                            : <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Not marked</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{classKey ? formatClassLabel(classKey) : "—"} · {month || "(no month)"}</div>
              <div className="card-sub">Month-wise register · P present · L late · A absent · Lv leave · P/A/% at the end</div>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, background: "var(--card)", zIndex: 1, minWidth: 150 }}>Student</th>
                  {monthDays.map((d) => (
                    <th key={d.d} style={{ textAlign: "center", padding: "4px 3px", color: d.dow === 0 ? "var(--err, #b13c1c)" : "var(--ink-3)" }}>
                      <div style={{ fontSize: 10, fontWeight: 600 }}>{d.d}</div>
                      <div style={{ fontSize: 8.5, color: "var(--ink-4)" }}>{DOW[d.dow]}</div>
                    </th>
                  ))}
                  <th style={{ textAlign: "center" }} title="Present (incl. late / by parent)">P</th>
                  <th style={{ textAlign: "center" }} title="Absent">A</th>
                  <th style={{ textAlign: "center" }}>%</th>
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 && <tr><td colSpan={monthDays.length + 4} className="empty">No students in this class.</td></tr>}
                {roster.map((s) => {
                  const sum = summarize(s.id);
                  return (
                    <tr key={s.id}>
                      <td style={{ position: "sticky", left: 0, background: "var(--card)", zIndex: 1, fontWeight: 500, fontSize: 11.5, whiteSpace: "nowrap" }}>{s.name}</td>
                      {monthDays.map((d) => {
                        const v = byStudentDate[s.id]?.[d.ds];
                        const c = v ? CELL[v] : null;
                        return (
                          <td key={d.d} style={{ textAlign: "center", padding: "2px 3px" }}>
                            {c
                              ? <span title={`${d.ds} · ${STATUS_LABEL[v]}`} style={{ display: "inline-grid", placeItems: "center", width: 18, height: 18, borderRadius: 4, background: c.bg, color: c.fg, fontSize: 9, fontWeight: 700 }}>{c.t}</span>
                              : <span style={{ color: d.dow === 0 ? "var(--rule-2)" : "var(--ink-4)" }}>·</span>}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: "center", fontWeight: 600, color: "var(--ok)" }}>{sum.atSchool}</td>
                      <td style={{ textAlign: "center", fontWeight: 600, color: "var(--err, #b13c1c)" }}>{sum.absent}</td>
                      <td style={{ textAlign: "center", fontWeight: 600 }}>{sum.marked ? `${sum.pct}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
