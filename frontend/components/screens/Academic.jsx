"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { formatClassLabel, getWorkingDays, getHolidayDates, attendanceFromLogs } from "@/backend/lib/format.js";
import { KPI, AvatarChip } from "../ui";
import QuickAccessRecent from "../QuickAccessRecent";

// Build the last 8 week-start dates relative to today. Computed lazily on
// the client (see useEffect in the component) so server- and client-rendered
// markup match — otherwise we'd hit a hydration mismatch when the server
// clock crosses a day boundary vs the user's clock.
function buildWeeks() {
  const out = [];
  const today = new Date();
  const day = today.getDay() || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day - 1));
  for (let i = 0; i < 8; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() - i * 7);
    const iso = d.toISOString().slice(0, 10);
    const short = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    out.push({ iso, label: `Week of ${short}`, short });
  }
  return out;
}

// Stable placeholders rendered on first paint so SSR matches CSR.
const PLACEHOLDER_WEEKS = Array.from({ length: 8 }, (_, i) => ({
  iso: `placeholder-${i}`,
  label: i === 0 ? "Current week" : `Week -${i}`,
  short: i === 0 ? "current" : `-${i}w`,
}));

const EMPTY_LOG = {
  attendance: "present",
  leaveReason: "",
  classwork: "",
  classworkStatus: null,
  homework: "",
  homeworkStatus: null,
  subjectLogs: [],
  topics: "",
  handwritingNote: "",
  handwritingGrade: "",
  behaviour: "",
  extra: "",
};

// Build per-subject log rows from the class subject list + any saved values.
// Always keeps class subjects (so parents see every subject, even unlogged)
// and appends any extra subjects teachers already posted.
function seedSubjectLogs(classSubjects, existingLogs) {
  const prev = Array.isArray(existingLogs) ? existingLogs : [];
  const byName = new Map(
    prev.filter((s) => s?.subject).map((s) => [String(s.subject).toLowerCase(), s])
  );
  const names = [];
  const seen = new Set();
  for (const name of Array.isArray(classSubjects) ? classSubjects : []) {
    const key = String(name || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(String(name).trim());
  }
  for (const s of prev) {
    const name = String(s?.subject || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (!names.length) return [];
  return names.map((name) => {
    const hit = byName.get(String(name).toLowerCase()) || {};
    return {
      subject: name,
      classwork: hit.classwork || "",
      classworkStatus: hit.classworkStatus || null,
      homework: hit.homework || "",
      homeworkStatus: hit.homeworkStatus || null,
    };
  });
}

// Merge subject-teacher edits into the full day log without wiping other subjects.
function mergeSubjectLogs(existingLogs, editedLogs) {
  const map = new Map();
  for (const s of (existingLogs || [])) {
    if (!s?.subject) continue;
    map.set(String(s.subject).toLowerCase(), {
      subject: s.subject,
      classwork: s.classwork || "",
      classworkStatus: s.classworkStatus || null,
      homework: s.homework || "",
      homeworkStatus: s.homeworkStatus || null,
    });
  }
  for (const s of (editedLogs || [])) {
    if (!s?.subject) continue;
    map.set(String(s.subject).toLowerCase(), {
      subject: s.subject,
      classwork: s.classwork || "",
      classworkStatus: s.classworkStatus || null,
      homework: s.homework || "",
      homeworkStatus: s.homeworkStatus || null,
    });
  }
  return Array.from(map.values());
}

export default function ScreenAcademic({ E, refresh, role, session, onOpenItem }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const classes = E.CLASSES;

  // Resolve this teacher's staff id (timetable rows key off teacherId).
  const myStaffId = useMemo(() => {
    if (role !== "teacher") return null;
    if (session?.staffId) return session.staffId;
    const lid = session?.linkedId || "";
    if (typeof lid === "string" && lid.startsWith("STF-")) return lid;
    const email = (session?.email || "").toLowerCase();
    const hit = (E.STAFF || []).find((s) => s.email && s.email.toLowerCase() === email);
    return hit?.id || null;
  }, [role, session, E.STAFF]);

  const meName = (session?.name || "").trim().toLowerCase();

  // Timetable slots taught by this teacher.
  const myTimetable = useMemo(() => {
    if (role !== "teacher") return [];
    return (E.TIMETABLE || []).filter((e) => {
      if (!e?.cls) return false;
      if (myStaffId && e.teacherId && e.teacherId === myStaffId) return true;
      const tName = (e.teacherName || "").trim().toLowerCase();
      return tName && meName && tName === meName;
    });
  }, [role, E.TIMETABLE, myStaffId, meName]);

  // Classes this teacher can log for: class-teacher assignment + timetable classes.
  const teacherClassList = useMemo(() => {
    if (role !== "teacher") return [];
    const linked = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
      ? session.linkedClasses
      : (session?.linkedId && /^\d+-/i.test(String(session.linkedId)) ? [session.linkedId] : []);
    const fromTt = myTimetable.map((e) => e.cls);
    return Array.from(new Set([...linked, ...fromTt].filter(Boolean)))
      .sort((a, b) => {
        const [ah, as] = String(a).split("-");
        const [bh, bs] = String(b).split("-");
        return (Number(ah) - Number(bh)) || String(as || "").localeCompare(String(bs || ""));
      });
  }, [role, session, myTimetable]);

  const firstTeacherKey = teacherClassList[0] || null;
  const firstTeacherSplit = firstTeacherKey
    ? (() => { const [c, s] = String(firstTeacherKey).split("-"); return { c: Number(c), s: s || "A" }; })()
    : null;

  const [cls, setCls] = useState(firstTeacherSplit?.c || 5);
  const [sec, setSec] = useState(firstTeacherSplit?.s || "A");
  const [selectedStudent, setSelectedStudent] = useState(0);
  // Teachers log ONE subject at a time (English and EVS are separate logs).
  const [logSubject, setLogSubject] = useState("");

  const isClassTeacherOf = (clsKey) => {
    const linked = Array.isArray(session?.linkedClasses) ? session.linkedClasses : [];
    if (linked.includes(clsKey)) return true;
    if (session?.linkedId === clsKey) return true;
    const head = String(clsKey).split("-")[0];
    return linked.some((k) => String(k).split("-")[0] === head);
  };

  // Subjects available on a class (configured on Classes, else timetable,
  // else the school subject catalog). Parents need the full list even when
  // only one subject teacher has posted today's log.
  const subjectsAvailableForClass = (clsKey) => {
    const [head] = String(clsKey).split("-");
    const c = (classes || []).find((x) => Number(x.n) === Number(head));
    const configured = Array.isArray(c?.subjects) ? c.subjects.map((s) => String(s || "").trim()).filter(Boolean) : [];
    if (configured.length) return configured;
    const fromTt = Array.from(new Set(
      (E.TIMETABLE || [])
        .filter((e) => {
          const ek = String(e.cls || "");
          return ek === clsKey || ek.split("-")[0] === head;
        })
        .map((e) => (e.subject || "").trim())
        .filter(Boolean)
    ));
    if (fromTt.length) return fromTt;
    return (E.SUBJECTS || [])
      .map((s) => (typeof s === "string" ? s : s?.name) || "")
      .map((s) => String(s).trim())
      .filter(Boolean);
  };

  // One picker chip per class+subject this teacher is assigned on the
  // timetable only — never the full class subject list.
  const teacherLogScopes = useMemo(() => {
    if (role !== "teacher") return [];
    const out = [];
    const seen = new Set();
    for (const e of myTimetable) {
      const clsKey = String(e.cls || "").trim();
      const subject = String(e.subject || "").trim();
      if (!clsKey || !subject) continue;
      const id = `${clsKey}::${subject.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const [c, s] = clsKey.split("-");
      out.push({
        id,
        clsKey,
        c: Number(c),
        s: s || "A",
        subject,
      });
    }
    // Class teacher with no timetable rows yet → one general chip so they
    // can still post attendance / notes for that class.
    if (!out.length) {
      for (const key of teacherClassList) {
        if (!isClassTeacherOf(key)) continue;
        const [c, s] = String(key).split("-");
        out.push({
          id: `${key}::__general__`,
          clsKey: key,
          c: Number(c),
          s: s || "A",
          subject: null,
        });
      }
    }
    out.sort((a, b) => (a.c - b.c) || String(a.subject || "").localeCompare(String(b.subject || "")));
    return out;
  }, [role, myTimetable, teacherClassList, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Full class subject list — used for parent/admin viewing.
  const allClassSubjects = useMemo(
    () => subjectsAvailableForClass(`${cls}-${sec}`),
    [cls, sec, classes, E.TIMETABLE, E.SUBJECTS] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Subjects used for THIS logging session (single subject for teachers).
  const classSubjects = useMemo(() => {
    if (role === "teacher") {
      return logSubject ? [logSubject] : [];
    }
    // Admin / principal / parent: all subjects on the class.
    return allClassSubjects;
  }, [role, logSubject, allClassSubjects]);

  // When timetable/class assignments load, ensure the active scope is valid.
  useEffect(() => {
    if (role !== "teacher") return;
    if (!teacherLogScopes.length) {
      setLogSubject("");
      return;
    }
    const valid = teacherLogScopes.some(
      (sc) => sc.c === Number(cls) && sc.s === sec && (sc.subject || "") === (logSubject || "")
    );
    if (valid) return;
    const pick = teacherLogScopes[0];
    setCls(pick.c);
    setSec(pick.s);
    setLogSubject(pick.subject || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, teacherLogScopes]);

  // Parent view: pin to the child's class.
  useEffect(() => {
    if (role === "parent" && E.ADDED_STUDENTS && E.ADDED_STUDENTS[0]) {
      const child = E.ADDED_STUDENTS[0];
      const [c, s] = String(child.cls).split("-");
      const n = Number(c);
      if (!Number.isNaN(n)) setCls(n);
      if (s) setSec(s);
    }
  }, [role, E.ADDED_STUDENTS]); // eslint-disable-line react-hooks/exhaustive-deps
  // WEEKS + TODAY_ISO depend on the client clock; populate after mount.
  const [WEEKS, setWeeks] = useState(PLACEHOLDER_WEEKS);
  const [TODAY_ISO, setTodayIso] = useState("");
  const [weekIso, setWeekIso] = useState(PLACEHOLDER_WEEKS[0].iso);
  useEffect(() => {
    const fresh = buildWeeks();
    setWeeks(fresh);
    setTodayIso(new Date().toISOString().slice(0, 10));
    setWeekIso((prev) => (prev.startsWith("placeholder-") ? fresh[0].iso : prev));
  }, []);
  const [weekOpen, setWeekOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showAnnounce, setShowAnnounce] = useState(false);
  const [growthFor, setGrowthFor] = useState(null); // student row for Ht/Wt modal
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  const week = WEEKS.find((w) => w.iso === weekIso) || WEEKS[0];

  // Roster is built from real students in the DB filtered by class and section.
  // Match class head too so "3" / "3-A" both work.
  const roster = useMemo(() => {
    const want = `${cls}-${sec}`;
    const head = String(cls);
    return (E.ADDED_STUDENTS || [])
      .filter((s) => {
        const k = String(s.cls || "");
        return k === want || k.split("-")[0] === head;
      })
      .map((s, i) => ({
        id: s.id,
        name: s.name,
        roll: i + 1,
        attendance: s.attendance ?? 0,
        homework: 0,
        classwork: 0,
        handwriting: "—",
        behavior: "—",
        heightCm: s.heightCm ?? null,
        weightKg: s.weightKg ?? null,
        measuredAt: s.measuredAt ?? null,
      }));
  }, [E.ADDED_STUDENTS, cls, sec]);

  // Reset selection if the previously-selected index is out of range
  useEffect(() => {
    if (selectedStudent >= roster.length) setSelectedStudent(0);
  }, [roster.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const student = roster[selectedStudent] || null;

  // All daily logs for this student (used for the KPI roll-ups + heatmap).
  const studentLogs = student
    ? (E.DAILY_LOGS || []).filter((l) => l.studentId === student.id)
    : [];

  // 28-day attendance heatmap built from the student's real daily_logs.
  // Cell states:
  //   present | absent | weekend (Sunday) | empty (no log posted that day)
  // Grid runs Mon → Sun, ending on the most recent Sunday so the last column
  // is always Sunday and Today sits inside the bottom row.
  const heatmap = (() => {
    if (!student || !TODAY_ISO) return [];
    const today = new Date(`${TODAY_ISO}T00:00:00`);
    // Find the upcoming Sunday so the trailing column lines up cleanly.
    const dow = today.getDay(); // 0=Sun..6=Sat
    const daysToSun = dow === 0 ? 0 : 7 - dow;
    const lastSun = new Date(today);
    lastSun.setDate(today.getDate() + daysToSun);
    const isoOf = (d) => d.toISOString().slice(0, 10);
    const logsByDate = new Map(studentLogs.map((l) => [l.date, l]));
    const cells = [];
    for (let i = 27; i >= 0; i--) {
      const d = new Date(lastSun);
      d.setDate(lastSun.getDate() - i);
      const iso = isoOf(d);
      const isFuture = d > today;
      const isSunday = d.getDay() === 0;
      const log = logsByDate.get(iso);
      let state = "empty";
      if (isFuture) state = "future";
      else if (isSunday) state = "weekend";
      else if (log) state = log.attendance === "absent" ? "absent" : "present";
      cells.push({ iso, state, log });
    }
    return cells;
  })();

  const heatColors = {
    present: "var(--ok, #4a7a54)",
    absent:  "var(--err, #b13c1c)",
    weekend: "var(--rule-2, #d6cdb8)",
    empty:   "var(--bg-2, #ebe4d6)",
    future:  "transparent",
  };
  const heatBorders = {
    future: "1px dashed var(--rule, #cbc1aa)",
  };

  // Saved daily log for this student today, if any.
  const savedLog = student
    ? (E.DAILY_LOGS || []).find((l) => l.studentId === student.id && l.date === TODAY_ISO)
    : null;
  const logToShow = savedLog || { ...EMPTY_LOG, postedBy: "", postedAt: null };
  const isUserSaved = Boolean(savedLog);

  // KPI roll-ups. Attendance % uses Super Admin's per-class working days
  // minus holidays (present ÷ effective days); falls back to logged days.
  const holidayDates = getHolidayDates(E.SETTINGS);
  const workingDays = getWorkingDays(E.SETTINGS, student?.cls || `${cls}-${sec}`);
  const attStats = attendanceFromLogs(studentLogs, workingDays, { holidayDates });
  const presentCount = attStats.presentCount;
  const totalLogs = attStats.totalLogs;
  const attendancePct = attStats.pct != null ? attStats.pct : (student?.attendance ?? 0);
  const cwDone = studentLogs.filter((l) => l.classworkStatus === "completed").length;
  const hwDone = studentLogs.filter((l) => l.homeworkStatus === "completed").length;
  const homeworkPct   = totalLogs ? Math.round((hwDone / totalLogs) * 100) : 0;
  const classworkPct  = totalLogs ? Math.round((cwDone / totalLogs) * 100) : 0;
  const lastGrade     = studentLogs.find((l) => l.handwritingGrade)?.handwritingGrade || "—";

  // ---------- Handlers ----------
  const submitLog = async (form) => {
    if (!student) {
      flash("No student selected", "bad");
      return;
    }
    const existing = (E.DAILY_LOGS || []).find((l) => l.studentId === student.id && l.date === TODAY_ISO) || {};
    const subjectLogs = Array.isArray(form.subjectLogs)
      ? mergeSubjectLogs(existing.subjectLogs, form.subjectLogs)
      : existing.subjectLogs;
    const r = await fetch("/api/academic/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        subjectLogs,
        studentId: student.id,
        studentName: student.name,
        cls: `${cls}-${sec}`,
        date: TODAY_ISO,
        postedBy: session?.name || "Teacher",
      }),
    });
    const json = await r.json();
    if (json.ok) {
      flash(`Daily log posted for ${student.name}`);
      await refresh?.();
      setShowLog(false);
    } else {
      flash(json.error || "Could not save log", "bad");
    }
  };

  const canEditGrowth = role === "teacher" || role === "principal" || role === "admin" || role === "academic_director";

  const saveGrowth = async ({ studentId, heightCm, weightKg }) => {
    const r = await fetch("/api/students", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: studentId, heightCm, weightKg }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to save");
    flash(`Height/weight saved for ${json.student?.name || "student"}`);
    setGrowthFor(null);
    await refresh?.();
    return json.student;
  };

  // Quick inline patch — used by the per-row pills (CW / HW / HG). Posts a
  // partial daily log that preserves any other fields the teacher already
  // saved. When a subject chip is selected, CW/HW toggles apply to that subject only.
  const quickUpdate = async (s, patch) => {
    const existing = (E.DAILY_LOGS || []).find((l) => l.studentId === s.id && l.date === TODAY_ISO) || {};
    let editedSubjects = seedSubjectLogs(classSubjects, existing.subjectLogs);
    if (classSubjects.length) {
      if ("classworkStatus" in patch) {
        editedSubjects = editedSubjects.map((row) => ({
          ...row,
          classworkStatus: patch.classworkStatus,
          classwork: row.classwork || (patch.classworkStatus === "completed" ? "Done" : row.classwork),
        }));
      }
      if ("homeworkStatus" in patch) {
        editedSubjects = editedSubjects.map((row) => ({
          ...row,
          homeworkStatus: patch.homeworkStatus,
          homework: row.homework || (patch.homeworkStatus === "completed" ? "Done" : row.homework),
        }));
      }
    }
    const subjectLogs = classSubjects.length
      ? mergeSubjectLogs(existing.subjectLogs, editedSubjects)
      : (existing.subjectLogs || []);
    const r = await fetch("/api/academic/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        studentId: s.id,
        studentName: s.name,
        cls: `${cls}-${sec}`,
        date: TODAY_ISO,
        // Preserve everything that's already there, then layer on the patch.
        attendance: existing.attendance || "present",
        leaveReason: existing.leaveReason || null,
        classwork: existing.classwork || "",
        classworkStatus: existing.classworkStatus || null,
        homework: existing.homework || "",
        homeworkStatus: existing.homeworkStatus || null,
        subjectLogs,
        topics: existing.topics || "",
        handwritingNote: existing.handwritingNote || "",
        handwritingGrade: existing.handwritingGrade || "",
        behaviour: existing.behaviour || "",
        extra: existing.extra || "",
        postedBy: session?.name || "Teacher",
        ...patch,
        ...(classSubjects.length ? { subjectLogs } : {}),
      }),
    });
    const json = await r.json().catch(() => ({}));
    if (json.ok) {
      await refresh?.();
    } else {
      flash(json.error || "Could not save", "bad");
    }
  };

  const downloadMonthlyReport = () => {
    const monthName = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const avgAtt = roster.length ? Math.round(roster.reduce((a, r) => a + r.attendance, 0) / roster.length) : 0;
    const avgHw  = roster.length ? Math.round(roster.reduce((a, r) => a + r.homework,   0) / roster.length) : 0;
    const avgCw  = roster.length ? Math.round(roster.reduce((a, r) => a + r.classwork,  0) / roster.length) : 0;
    const logsPosted = (E.DAILY_LOGS || []).filter((l) => l.cls === `${cls}-${sec}`).length;

    downloadPdf({
      title: `Academic Monthly Report · ${formatClassLabel(`${cls}-${sec}`)}`,
      subtitle: `${roster.length} student${roster.length === 1 ? "" : "s"} · ${monthName}`,
      school, actor,
      dateRange: monthName,
      orientation: "landscape",
      summary: [
        { label: "Students",       value: roster.length },
        { label: "Avg attendance", value: `${avgAtt}%` },
        { label: "Avg homework",   value: `${avgHw}%` },
        { label: "Logs posted",    value: logsPosted },
      ],
      columns: [
        { key: "i",          label: "#",          align: "right",  width: "32px" },
        { key: "roll",       label: "Roll",       align: "center", width: "60px" },
        { key: "id",         label: "Student ID", width: "100px" },
        { key: "name",       label: "Name" },
        { key: "attendance", label: "Att %",      align: "right",  width: "60px" },
        { key: "homework",   label: "HW %",       align: "right",  width: "60px" },
        { key: "classwork",  label: "CW %",       align: "right",  width: "60px" },
        { key: "handwriting",label: "Handwriting",align: "center", width: "100px" },
        { key: "behavior",   label: "Behaviour",  align: "center", width: "100px" },
        { key: "log",        label: "Daily log",  align: "center", width: "80px" },
      ],
      rows: roster.map((s, i) => ({
        i: i + 1, roll: s.roll, id: s.id, name: s.name,
        attendance: `${s.attendance}%`, homework: `${s.homework}%`, classwork: `${s.classwork}%`,
        handwriting: s.handwriting || "—", behavior: s.behavior || "—",
        log: (E.DAILY_LOGS || []).some((l) => l.studentId === s.id) ? "Yes" : "No",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-academic-class-${cls}-${sec}-${monthName.replace(" ", "-").toLowerCase()}`,
    });
    flash(`Opened PDF preview · ${formatClassLabel(`${cls}-${sec}`)}`);
  };

  return (
    <div className="page">
      <Toast toast={toast} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Academic tracker</div>
          <div className="page-title">Academic <span className="amber">tracker</span></div>
          <div className="page-sub">Class → Student → Daily log. Teachers post daily; monthly summary auto-generates to parents.</div>
        </div>
        <div className="page-actions">
          <div style={{ position: "relative" }}>
            <button className="btn" onClick={() => setWeekOpen((v) => !v)}>
              <Icon name="calendar" size={13} />Week of {week.short}
              <Icon name="chevronDown" size={11} />
            </button>
            {weekOpen && (
              <WeekMenu
                weeks={WEEKS}
                value={weekIso}
                onPick={(iso) => {
                  setWeekIso(iso);
                  setWeekOpen(false);
                  flash(`Showing ${WEEKS.find((w) => w.iso === iso).label}`);
                }}
                onClose={() => setWeekOpen(false)}
              />
            )}
          </div>
          {role !== "parent" && (
            <>
              {role === "teacher" && (
                <button className="btn" onClick={() => setShowAnnounce(true)}>
                  <Icon name="megaphone" size={13} />Announce to class
                </button>
              )}
              <button className="btn" onClick={downloadMonthlyReport} title="Open a printable, branded PDF report">
                <Icon name="download" size={13} />Export PDF
              </button>
              <button className="btn accent" onClick={() => setShowLog(true)}>
                <Icon name="plus" size={13} />Log today
              </button>
            </>
          )}
        </div>
      </div>

      <QuickAccessRecent role={role} session={session} onOpenItem={onOpenItem} />

      {/* Teacher picker — one chip per class+subject so each subject is logged separately. */}
      {role === "teacher" && teacherLogScopes.length > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Icon name="academic" size={16} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Log for ·</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {teacherLogScopes.map((sc) => {
              const active = Number(cls) === sc.c && sec === sc.s && (logSubject || "") === (sc.subject || "");
              return (
                <button
                  key={sc.id}
                  onClick={() => {
                    setCls(sc.c);
                    setSec(sc.s);
                    setLogSubject(sc.subject || "");
                    setSelectedStudent(0);
                  }}
                  className="btn sm"
                  style={{
                    background: active ? "var(--accent-soft)" : "var(--card)",
                    color: active ? "var(--accent-2)" : "var(--ink-2)",
                    borderColor: active ? "var(--accent)" : "var(--rule)",
                    display: "inline-flex", flexDirection: "column", alignItems: "flex-start",
                    height: "auto", padding: "6px 10px", gap: 2,
                  }}
                >
                  <span>{formatClassLabel(sc.clsKey)}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 600, opacity: 0.9 }}>
                    {sc.subject || "General log"}
                  </span>
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", marginLeft: "auto" }}>
            {logSubject
              ? `Logging ${logSubject} only · pick another chip to log a different subject`
              : "Pick a subject chip, then use Edit log / CW / HW"}
          </span>
        </div>
      )}

      {role === "teacher" && teacherLogScopes.length === 0 && (
        <div className="card" style={{ marginBottom: 14, padding: 16 }}>
          <div className="empty">
            No classes assigned yet. Ask admin to set you as class teacher (Classes) or assign you on the Timetable.
          </div>
        </div>
      )}

      <div className="grid g-12">
        {role !== "parent" && role !== "teacher" && (
        <div className="col-12" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: 4 }}>Class</span>
          {classes.map((c) => (
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
              {formatClassLabel(String(c.n))}
            </button>
          ))}
          <span style={{ width: 1, height: 16, background: "var(--rule)", margin: "0 6px" }} />
          {["A", "B"].map((s) => (
            <button
              key={s}
              onClick={() => setSec(s)}
              className="btn sm"
              style={{
                background: sec === s ? "var(--accent-soft)" : "var(--card)",
                color: sec === s ? "var(--accent-2)" : "var(--ink-2)",
                borderColor: sec === s ? "var(--accent)" : "var(--rule)",
              }}
            >
              Section {s}
            </button>
          ))}
        </div>
        )}

        <div className="card col-7">
          <div className="card-head">
            <div>
              <div className="card-title">
                {formatClassLabel(`${cls}-${sec}`)}
                {logSubject ? ` · ${logSubject}` : ""}
                {" · "}{roster.length} students
              </div>
              <div className="card-sub">
                {logSubject
                  ? `CW / HW pills update ${logSubject} only · ${week.label}`
                  : `Tap the pills to mark today inline · ${week.label}`}
              </div>
            </div>
          </div>
          <div style={{ maxHeight: 620, overflowY: "auto" }}>
            {roster.length === 0 && (
              <div className="empty">No students in {formatClassLabel(`${cls}-${sec}`)} yet. Add some on the Students screen.</div>
            )}
            {roster.map((s, i) => {
              const act = i === selectedStudent;
              const log = (E.DAILY_LOGS || []).find((l) => l.studentId === s.id && l.date === TODAY_ISO) || {};
              const isAbsent = log.attendance === "absent";
              const subjectRow = logSubject
                ? (Array.isArray(log.subjectLogs) ? log.subjectLogs : []).find(
                    (r) => String(r.subject || "").toLowerCase() === String(logSubject).toLowerCase()
                  )
                : null;
              const cwStatus = logSubject ? (subjectRow?.classworkStatus || null) : log.classworkStatus;
              const hwStatus = logSubject ? (subjectRow?.homeworkStatus || null) : log.homeworkStatus;
              return (
                <div
                  key={s.id}
                  className="lrow"
                  style={{ cursor: "pointer", background: act ? "var(--accent-soft)" : undefined, gap: 10, paddingTop: 10, paddingBottom: 10 }}
                  onClick={() => setSelectedStudent(i)}
                >
                  <div style={{ width: 24, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>{String(s.roll).padStart(2, "0")}</div>
                  <AvatarChip initials={s.name.split(" ").map((n) => n[0]).join("")} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                    <div className="s">
                      {s.id} · {(() => {
                        const logs = (E.DAILY_LOGS || []).filter((l) => l.studentId === s.id);
                        const wd = getWorkingDays(E.SETTINGS, s.cls);
                        const st = attendanceFromLogs(logs, wd, { holidayDates });
                        return st.pct != null
                          ? (wd
                            ? `${st.pct}% · ${st.presentCount}/${wd} working days`
                            : `${st.pct}% · ${st.presentCount}/${st.totalLogs} days logged`)
                          : `${s.attendance ?? 0}% term attendance`;
                      })()}
                    </div>
                  </div>
                  {/* Unified quick-action bar — same height/spacing for CW, HW, HG, Ht/Wt. */}
                  <div
                    onClick={(e) => e.stopPropagation()}
                    title={role === "parent" ? "Daily log is read-only for parents — only the class teacher can update this." : (logSubject ? `${logSubject} only` : undefined)}
                    style={{
                      display: "inline-flex",
                      alignItems: "stretch",
                      flexShrink: 0,
                      height: 28,
                      borderRadius: 8,
                      border: "1px solid var(--rule-2)",
                      background: "var(--card)",
                      overflow: "hidden",
                    }}
                  >
                    <StatusToggle
                      label="CW"
                      title={logSubject ? `${logSubject} classwork` : "Classwork"}
                      value={cwStatus}
                      disabled={isAbsent || role === "parent"}
                      onMark={(next) => quickUpdate(s, { classworkStatus: next, classwork: logSubject || "Classwork" })}
                      doneVal="completed"
                      pendingVal="not_completed"
                    />
                    <StatusToggle
                      label="HW"
                      title={logSubject ? `${logSubject} homework` : "Homework"}
                      value={hwStatus}
                      disabled={isAbsent || role === "parent"}
                      onMark={(next) => quickUpdate(s, { homeworkStatus: next, homework: logSubject || "Homework" })}
                      doneVal="completed"
                      pendingVal="pending"
                    />
                    <GradePill
                      label="Handwriting"
                      title="Handwriting grade"
                      value={log.handwritingGrade}
                      disabled={isAbsent || role === "parent"}
                      onPick={(g) => quickUpdate(s, { handwritingGrade: g, handwritingNote: log.handwritingNote || "" })}
                    />
                    {canEditGrowth && (
                      <GrowthChip
                        heightCm={s.heightCm}
                        weightKg={s.weightKg}
                        onClick={() => setGrowthFor(s)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {!student && (
          <div className="col-5">
            <div className="card">
              <div className="empty" style={{ padding: 60 }}>
                Pick a class with students to see daily logs and attendance here.
              </div>
            </div>
          </div>
        )}

        {student && (
        <div className="col-5" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "var(--accent-ink)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 18 }}>
                {student.name.split(" ").map((n) => n[0]).join("")}
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>{student.name}</div>
                <div style={{ color: "var(--ink-3)", fontSize: 12.5, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span>{student.id}</span><span className="meta-dot">·</span>
                  <span>{formatClassLabel(`${cls}-${sec}`)} · Roll {student.roll}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {canEditGrowth && (
                  <button className="btn sm" onClick={() => setGrowthFor(student)} title="Update height and weight anytime">
                    <Icon name="pencil" size={12} />Ht / Wt
                  </button>
                )}
                {role !== "parent" && (
                  <button className="btn sm accent" onClick={() => setShowLog(true)}>
                    <Icon name="pencil" size={12} />{isUserSaved ? "Edit log" : "Today's log"}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid student-kpi-grid">
            <KPI
              label="Attendance"
              value={attStats.pct != null ? `${attStats.pct}%` : "—"}
              sub={attStats.denom
                ? (workingDays
                  ? `${presentCount} of ${workingDays} days`
                  : `${presentCount}/${attStats.denom} logged`)
                : "No logs yet"}
              puck="mint"
              puckIcon="check"
              details={{
                title: "Attendance",
                sub: student.name,
                items: [
                  { label: "Present days", value: String(presentCount), tone: "ok" },
                  { label: "Absent days", value: String(attStats.absentCount || 0), tone: attStats.absentCount ? "bad" : undefined },
                  { label: "Days logged", value: String(totalLogs) },
                  { label: workingDays ? "Working days (year)" : "Denominator", value: String(attStats.denom || "—") },
                  { label: "Attendance %", value: attStats.pct != null ? `${attStats.pct}%` : "—" },
                ],
              }}
            />
            <KPI
              label="Homework"
              value={totalLogs ? `${homeworkPct}%` : "—"}
              sub={totalLogs ? `${hwDone}/${totalLogs} done` : "No logs yet"}
              puck="peach"
              puckIcon="book"
              details={{
                title: "Homework",
                sub: `${hwDone} completed of ${totalLogs || 0} logged days`,
                items: studentLogs.slice().reverse().slice(0, 14).map((l) => ({
                  label: l.date,
                  value: l.homeworkStatus === "completed" ? "Done" : l.homeworkStatus === "pending" ? "Pending" : "—",
                  tone: l.homeworkStatus === "completed" ? "ok" : l.homeworkStatus === "pending" ? "warn" : undefined,
                })),
              }}
            />
            <KPI
              label="Classwork"
              value={totalLogs ? `${classworkPct}%` : "—"}
              sub={totalLogs ? `${cwDone}/${totalLogs} done` : "No logs yet"}
              puck="cream"
              puckIcon="pencil"
              details={{
                title: "Classwork",
                sub: `${cwDone} completed of ${totalLogs || 0} logged days`,
                items: studentLogs.slice().reverse().slice(0, 14).map((l) => ({
                  label: l.date,
                  value: l.classworkStatus === "completed" ? "Done" : l.classworkStatus === "not_completed" ? "Not done" : "—",
                  tone: l.classworkStatus === "completed" ? "ok" : l.classworkStatus === "not_completed" ? "bad" : undefined,
                })),
              }}
            />
            <KPI
              label="Height / Weight"
              value={student.heightCm != null || student.weightKg != null
                ? `${student.heightCm != null ? `${student.heightCm} cm` : "—"} · ${student.weightKg != null ? `${student.weightKg} kg` : "—"}`
                : "—"}
              sub={student.measuredAt
                ? `Updated ${new Date(student.measuredAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                : "Not recorded"}
              puck="sky"
              puckIcon="students"
              details={{
                title: "Height / Weight",
                sub: student.name,
                items: [
                  { label: "Height", value: student.heightCm != null ? `${student.heightCm} cm` : "Not recorded" },
                  { label: "Weight", value: student.weightKg != null ? `${student.weightKg} kg` : "Not recorded" },
                  {
                    label: "Last updated",
                    value: student.measuredAt
                      ? new Date(student.measuredAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
                      : "—",
                  },
                ],
              }}
            />
          </div>

          <div className="grid g-12">
            <div className="card col-7">
              <div className="card-head">
                <div>
                  <div className="card-title">Today · daily log</div>
                  <div className="card-sub">
                    {isUserSaved
                      ? `${TODAY_ISO} · posted by ${logToShow.postedBy} ${new Date(logToShow.postedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
                      : "No entry for today yet — click ‘Today's log’ to post one"}
                  </div>
                </div>
                <div className="card-actions">
                  {isUserSaved
                    ? <span className="chip ok"><span className="dot" />Submitted</span>
                    : <span className="chip"><span className="dot" />Empty</span>}
                </div>
              </div>
              <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {!isUserSaved && (
                  <div className="empty" style={{ padding: 24 }}>Nothing posted for {student.name} today.</div>
                )}
                {isUserSaved && (() => {
                  const absent = logToShow.attendance === "absent";
                  const subjectRows = seedSubjectLogs(
                    role === "teacher" ? classSubjects : allClassSubjects,
                    logToShow.subjectLogs
                  );
                  const statusChip = (kind, status) => {
                    if (kind === "cw") {
                      if (status === "completed") return <span className="chip ok" style={{ minWidth: 52, justifyContent: "center" }}>CW ✓</span>;
                      if (status === "not_completed") return <span className="chip bad" style={{ minWidth: 52, justifyContent: "center" }}>CW −</span>;
                      return <span className="chip" style={{ minWidth: 52, justifyContent: "center", opacity: 0.7 }}>CW</span>;
                    }
                    if (status === "completed") return <span className="chip ok" style={{ minWidth: 52, justifyContent: "center" }}>HW ✓</span>;
                    if (status === "pending") return <span className="chip warn" style={{ minWidth: 52, justifyContent: "center" }}>HW −</span>;
                    return <span className="chip" style={{ minWidth: 52, justifyContent: "center", opacity: 0.7 }}>HW</span>;
                  };
                  const metaRows = absent
                    ? [{ l: "Leave reason", v: logToShow.leaveReason || "—" }]
                    : [
                        { l: "Topics covered", v: logToShow.topics },
                        { l: "Handwriting", v: logToShow.handwritingNote, c: logToShow.handwritingGrade ? <span className="chip accent"><span className="dot" />{logToShow.handwritingGrade}</span> : null },
                        { l: "Behaviour", v: logToShow.behaviour },
                        { l: "Extra-curricular", v: logToShow.extra },
                      ];
                  if (!absent && !subjectRows.length) {
                    metaRows.unshift(
                      { l: "Classwork", v: logToShow.classwork, c: logToShow.classworkStatus === "completed" ? <span className="chip ok">Done</span> : logToShow.classworkStatus === "not_completed" ? <span className="chip bad">Not done</span> : null },
                      { l: "Homework", v: logToShow.homework, c: logToShow.homeworkStatus === "completed" ? <span className="chip ok">Done</span> : logToShow.homeworkStatus === "pending" ? <span className="chip warn">Pending</span> : null },
                    );
                  }
                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 10, borderBottom: "1px solid var(--rule-2)" }}>
                        <div style={{ fontSize: 11.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Attendance</div>
                        {absent
                          ? <span className="chip bad"><Icon name="x" size={10} stroke={2.5} />Absent</span>
                          : <span className="chip ok"><Icon name="check" size={10} stroke={2.5} />Present</span>}
                      </div>

                      {!absent && subjectRows.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 56px 56px", gap: 8, padding: "0 0 6px", borderBottom: "1px solid var(--rule-2)" }}>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Subject</div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", textAlign: "center", textTransform: "uppercase", letterSpacing: "0.05em" }}>CW</div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", textAlign: "center", textTransform: "uppercase", letterSpacing: "0.05em" }}>HW</div>
                          </div>
                          {subjectRows.map((s) => {
                            const note = [s.classwork, s.homework].filter(Boolean).join(" · ");
                            return (
                              <div key={s.subject} style={{ display: "grid", gridTemplateColumns: "1fr 56px 56px", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--rule-2)" }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 560, letterSpacing: "-0.01em" }}>{s.subject}</div>
                                  {note ? <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>{note}</div> : null}
                                </div>
                                <div style={{ display: "flex", justifyContent: "center" }}>{statusChip("cw", s.classworkStatus)}</div>
                                <div style={{ display: "flex", justifyContent: "center" }}>{statusChip("hw", s.homeworkStatus)}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {metaRows.map((r, i) => (
                        <div key={r.l} style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 12, alignItems: "flex-start", paddingTop: i === 0 && subjectRows.length ? 4 : 0, paddingBottom: 10, borderBottom: i < metaRows.length - 1 ? "1px solid var(--rule-2)" : "none" }}>
                          <div style={{ fontSize: 11.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em", paddingTop: 1 }}>{r.l}</div>
                          <div style={{ fontSize: 13 }}>{r.v || <span style={{ color: "var(--ink-4)" }}>—</span>}</div>
                          <div>{r.c || null}</div>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>
            </div>

            <div className="card col-5">
              <div className="card-head">
                <div><div className="card-title">28-day attendance</div><div className="card-sub">Recent attendance pattern</div></div>
              </div>
              <div className="card-body">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
                  {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                    <div key={i} style={{ fontSize: 10, color: "var(--ink-4)", textAlign: "center" }}>{d}</div>
                  ))}
                  {heatmap.map((c, i) => {
                    const isToday = c.iso === TODAY_ISO;
                    const titleParts = [
                      new Date(`${c.iso}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" }),
                      c.state === "present" ? "Present" :
                      c.state === "absent"  ? `Absent${c.log?.leaveReason ? " — " + c.log.leaveReason : ""}` :
                      c.state === "weekend" ? "Weekend (Sunday)" :
                      c.state === "future"  ? "Upcoming" :
                                              "No log posted",
                    ];
                    return (
                      <div
                        key={i}
                        className="hm-cell"
                        title={titleParts.join(" — ")}
                        style={{
                          background: heatColors[c.state],
                          border: heatBorders[c.state] || (isToday ? "1.5px solid var(--ink)" : undefined),
                          opacity: c.state === "weekend" ? 0.55 : 1,
                          cursor: c.state === "future" ? "default" : "help",
                        }}
                      />
                    );
                  })}
                </div>
                {/* Legend */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--rule, #e5dfd1)", fontSize: 10.5, color: "var(--ink-3)" }}>
                  <Legend swatch={heatColors.present} label="Present" />
                  <Legend swatch={heatColors.absent}  label="Absent" />
                  <Legend swatch={heatColors.empty}   label="No log" />
                  <Legend swatch={heatColors.weekend} label="Sun" />
                  <span style={{ marginLeft: "auto", color: "var(--ink-4)" }}>Hover a cell for the date</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        )}
      </div>

      {showLog && (
        <LogModal
          student={student}
          cls={`${cls}-${sec}`}
          existing={savedLog}
          today={TODAY_ISO}
          classSubjects={classSubjects}
          onClose={() => setShowLog(false)}
          onSubmit={submitLog}
        />
      )}

      {showAnnounce && role === "teacher" && (
        <AnnounceClassModal
          cls={`${cls}-${sec}`}
          recipientCount={roster.length}
          teacherName={session?.name || "Teacher"}
          onClose={() => setShowAnnounce(false)}
          onSent={(msg) => { setShowAnnounce(false); flash(msg); refresh?.(); }}
        />
      )}

      {growthFor && canEditGrowth && (
        <GrowthModal
          student={growthFor}
          onClose={() => setGrowthFor(null)}
          onSubmit={saveGrowth}
        />
      )}
    </div>
  );
}

// ---------- announce-to-class modal (teacher) ----------
// Posts a broadcast tagged to the teacher's class so parents of that class
// see it in their Communication / Messages screen.
function AnnounceClassModal({ cls, recipientCount, teacherName, onClose, onSent }) {
  const [channel, setChannel] = useState("whatsapp");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!message.trim()) { setErr("Type a message first"); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/communication/broadcast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaign: `Class ${cls} announcement · ${teacherName}`,
          audience: `class_${cls}`,
          audienceLabel: `${formatClassLabel(String(cls))} parents`,
          channel,
          message: message.trim(),
          sent: recipientCount,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      onSent(`Announced to ${recipientCount} parent${recipientCount === 1 ? "" : "s"} of ${formatClassLabel(String(cls))}`);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 520 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Announce to {formatClassLabel(String(cls))}</div>
            <div className="card-sub">Sent to {recipientCount} parent{recipientCount === 1 ? "" : "s"} via {channel}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Channel">
            <div className="segmented">
              <button type="button" className={channel === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")}>
                <Icon name="whatsapp" size={11} />WhatsApp
              </button>
              <button type="button" className={channel === "sms" ? "active" : ""} onClick={() => setChannel("sms")}>
                <Icon name="sms" size={11} />SMS
              </button>
              <button type="button" className={channel === "both" ? "active" : ""} onClick={() => setChannel("both")}>
                Both
              </button>
            </div>
          </Field>
          <Field label="Message">
            <textarea
              className="input"
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              style={{ width: "100%", height: 110, padding: "10px 12px", lineHeight: 1.5, resize: "vertical", fontFamily: "var(--font-sans)" }}
              placeholder={`e.g. Reminder: bring your art supplies for tomorrow's class. — ${teacherName}`}
            />
          </Field>
          {err && (
            <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
              {err}
            </div>
          )}
          {recipientCount === 0 && (
            <div style={{ background: "var(--warn-soft)", color: "var(--warn)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
              No students in {formatClassLabel(String(cls))} yet — announcement won't reach anyone.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !message.trim() || recipientCount === 0}>
              <Icon name="send" size={13} />{busy ? "Sending…" : `Send to ${recipientCount}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- helpers ----------
function Toast({ toast }) {
  if (!toast) return null;
  const bg = toast.tone === "bad" ? "var(--bad)" : "var(--ok)";
  return (
    <div style={{
      position: "fixed", top: 76, left: "50%", transform: "translateX(-50%)",
      zIndex: 300, background: bg, color: "#fff", padding: "10px 18px",
      borderRadius: 999, fontSize: 12.5, fontWeight: 500, boxShadow: "var(--shadow-lg)",
    }}>{toast.msg}</div>
  );
}

function GrowthModal({ student, onClose, onSubmit }) {
  const [heightCm, setHeightCm] = useState(student?.heightCm != null ? String(student.heightCm) : "");
  const [weightKg, setWeightKg] = useState(student?.weightKg != null ? String(student.weightKg) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr(""); setBusy(true);
    try {
      if (!heightCm.trim() && !weightKg.trim()) throw new Error("Enter height and/or weight");
      await onSubmit({
        studentId: student.id,
        heightCm: heightCm.trim() === "" ? null : heightCm.trim(),
        weightKg: weightKg.trim() === "" ? null : weightKg.trim(),
      });
    } catch (ex) {
      setErr(ex.message || "Failed");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 420 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Height &amp; weight</div>
            <div className="card-sub">{student?.name} · {student?.id} · update anytime</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Height (cm)</span>
              <input
                className="input"
                inputMode="decimal"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="e.g. 128"
                autoFocus
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Weight (kg)</span>
              <input
                className="input"
                inputMode="decimal"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="e.g. 26.5"
              />
            </label>
          </div>
          {student?.measuredAt && (
            <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
              Last updated {new Date(student.measuredAt).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
          {err && (
            <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
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

function WeekMenu({ weeks, value, onPick, onClose }) {
  useEffect(() => {
    const onDoc = (e) => { if (!e.target.closest(".week-menu") && !e.target.closest(".btn")) onClose(); };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);
  return (
    <div className="week-menu" style={{
      position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60,
      background: "var(--card)", border: "1px solid var(--rule)", borderRadius: 10,
      boxShadow: "var(--shadow-lg)", padding: 6, minWidth: 200,
    }}>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "6px 10px 4px" }}>
        Pick a week
      </div>
      {weeks.map((w, i) => (
        <button key={w.iso} onClick={() => onPick(w.iso)} className="btn ghost"
          style={{
            width: "100%", justifyContent: "flex-start", height: 30, padding: "0 10px",
            fontSize: 12.5, background: value === w.iso ? "var(--accent-soft)" : "transparent",
            color: value === w.iso ? "var(--accent-2)" : "var(--ink)",
            fontWeight: value === w.iso ? 500 : 400,
          }}>
          {w.label}
          {i === 0 && <span className="chip ok" style={{ marginLeft: "auto", height: 16, fontSize: 9.5, padding: "0 6px" }}>current</span>}
        </button>
      ))}
    </div>
  );
}

function LogModal({ student, cls, existing, today, classSubjects = [], onClose, onSubmit }) {
  const hasSubjects = Array.isArray(classSubjects) && classSubjects.length > 0;
  const [form, setForm] = useState({
    attendance: existing?.attendance || "present",
    leaveReason: existing?.leaveReason || "",
    classwork: existing?.classwork || "",
    classworkStatus: existing?.classworkStatus || "completed",
    homework: existing?.homework || "",
    homeworkStatus: existing?.homeworkStatus || "completed",
    subjectLogs: seedSubjectLogs(classSubjects, existing?.subjectLogs),
    topics: existing?.topics || "",
    handwritingNote: existing?.handwritingNote || "",
    handwritingGrade: existing?.handwritingGrade || "A",
    behaviour: existing?.behaviour || "",
    extra: existing?.extra || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setSubject = (idx, patch) => {
    setForm((f) => ({
      ...f,
      subjectLogs: f.subjectLogs.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    }));
  };
  const isAbsent = form.attendance === "absent";

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onSubmit(form);
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: hasSubjects ? 640 : 560, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">{existing ? "Edit today's log" : "Log today"}</div>
            <div className="card-sub">
              {student?.name || "—"} · {student?.id || ""} · {formatClassLabel(String(cls))} · {today}
              {hasSubjects
                ? (classSubjects.length === 1 ? ` · ${classSubjects[0]} only` : ` · ${classSubjects.length} subjects`)
                : ""}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Attendance">
            <div className="segmented">
              <button type="button" className={!isAbsent ? "active" : ""} onClick={() => set("attendance", "present")}>
                <Icon name="check" size={11} />Present
              </button>
              <button type="button" className={isAbsent ? "active" : ""} onClick={() => set("attendance", "absent")}>
                <Icon name="x" size={11} />Absent
              </button>
            </div>
          </Field>
          {isAbsent && (
            <Field label="Leave reason">
              <input
                className="input"
                value={form.leaveReason}
                onChange={(e) => set("leaveReason", e.target.value)}
                placeholder="Why is the student absent today?"
              />
            </Field>
          )}

          {hasSubjects ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>
                Subjects · classwork &amp; homework
              </div>
              {!isAbsent && classSubjects.length === 0 && (
                <div className="empty" style={{ padding: 12 }}>No subjects set for this class. Add them under Classes → Edit.</div>
              )}
              {form.subjectLogs.map((row, idx) => (
                <div
                  key={row.subject}
                  style={{
                    border: "1px solid var(--rule-2)", borderRadius: 10, padding: 12,
                    background: "var(--bg-2)", opacity: isAbsent ? 0.5 : 1,
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8, color: "var(--ink)" }}>{row.subject}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 8 }}>
                    <input
                      className="input"
                      value={row.classwork}
                      onChange={(e) => setSubject(idx, { classwork: e.target.value })}
                      placeholder="Classwork note"
                      disabled={isAbsent}
                    />
                    <div className="segmented">
                      <button type="button" className={row.classworkStatus === "completed" ? "active" : ""} onClick={() => setSubject(idx, { classworkStatus: "completed" })} disabled={isAbsent}>CW ✓</button>
                      <button type="button" className={row.classworkStatus === "not_completed" ? "active" : ""} onClick={() => setSubject(idx, { classworkStatus: "not_completed" })} disabled={isAbsent}>CW −</button>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                    <input
                      className="input"
                      value={row.homework}
                      onChange={(e) => setSubject(idx, { homework: e.target.value })}
                      placeholder="Homework note"
                      disabled={isAbsent}
                    />
                    <div className="segmented">
                      <button type="button" className={row.homeworkStatus === "completed" ? "active" : ""} onClick={() => setSubject(idx, { homeworkStatus: "completed" })} disabled={isAbsent}>HW ✓</button>
                      <button type="button" className={row.homeworkStatus === "pending" ? "active" : ""} onClick={() => setSubject(idx, { homeworkStatus: "pending" })} disabled={isAbsent}>HW −</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10 }}>
                <Field label="Classwork">
                  <input
                    className="input"
                    value={form.classwork}
                    onChange={(e) => set("classwork", e.target.value)}
                    placeholder="e.g. Fractions · Ex 3.2 pp. 54–56"
                    disabled={isAbsent}
                  />
                </Field>
                <Field label="Status">
                  <div className="segmented">
                    <button type="button" className={form.classworkStatus === "completed" ? "active" : ""} onClick={() => set("classworkStatus", "completed")} disabled={isAbsent}>Done</button>
                    <button type="button" className={form.classworkStatus === "not_completed" ? "active" : ""} onClick={() => set("classworkStatus", "not_completed")} disabled={isAbsent}>Pending</button>
                  </div>
                </Field>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10 }}>
                <Field label="Homework">
                  <input
                    className="input"
                    value={form.homework}
                    onChange={(e) => set("homework", e.target.value)}
                    placeholder="What's due tomorrow"
                    disabled={isAbsent}
                  />
                </Field>
                <Field label="Status">
                  <div className="segmented">
                    <button type="button" className={form.homeworkStatus === "completed" ? "active" : ""} onClick={() => set("homeworkStatus", "completed")} disabled={isAbsent}>Done</button>
                    <button type="button" className={form.homeworkStatus === "pending" ? "active" : ""} onClick={() => set("homeworkStatus", "pending")} disabled={isAbsent}>Pending</button>
                  </div>
                </Field>
              </div>
            </>
          )}

          <Field label="Topics covered today">
            <input className="input" value={form.topics} onChange={(e) => set("topics", e.target.value)} placeholder="Brief overall summary" disabled={isAbsent} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 10 }}>
            <Field label="Handwriting note">
              <input className="input" value={form.handwritingNote} onChange={(e) => set("handwritingNote", e.target.value)} disabled={isAbsent} />
            </Field>
            <Field label="Grade">
              <select className="select" value={form.handwritingGrade} onChange={(e) => set("handwritingGrade", e.target.value)} disabled={isAbsent}>
                {["A+", "A", "A-", "B+", "B", "B-", "C", "D"].map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Behaviour">
            <input className="input" value={form.behaviour} onChange={(e) => set("behaviour", e.target.value)} placeholder="One sentence on how the day went" disabled={isAbsent} />
          </Field>
          <Field label="Extra-curricular">
            <input className="input" value={form.extra} onChange={(e) => set("extra", e.target.value)} placeholder="Clubs, sports, art, etc." disabled={isAbsent} />
          </Field>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy}>
              <Icon name="check" size={13} />{busy ? "Posting…" : existing ? "Save changes" : "Post log"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const QUICK_CELL = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "0 9px",
  border: 0,
  borderLeft: "1px solid var(--rule-2)",
  background: "transparent",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "var(--ink-2)",
  height: "100%",
  whiteSpace: "nowrap",
};

// Classwork / Homework cell inside the unified quick-action bar.
function StatusToggle({ label, title, value, disabled, onMark, doneVal, pendingVal }) {
  const isDone = value === doneVal;
  const isPending = value === pendingVal;
  const tone = isDone ? "ok" : isPending ? "bad" : "idle";
  const cellBg = tone === "ok" ? "var(--ok-soft, #e6f4ec)"
    : tone === "bad" ? "var(--err-soft, #fbe1d8)"
    : "transparent";
  const labelColor = tone === "ok" ? "var(--ok, #1f7a3a)"
    : tone === "bad" ? "var(--err, #b13c1c)"
    : "var(--ink-3)";
  const btn = (active, activeBg, activeFg) => ({
    width: 18, height: 18, borderRadius: 5, border: 0,
    display: "grid", placeItems: "center",
    fontSize: 11, fontWeight: 700, lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    background: active ? activeBg : "var(--bg-2)",
    color: active ? activeFg : "var(--ink-4)",
  });
  return (
    <div
      style={{ ...QUICK_CELL, borderLeft: "none", background: cellBg }}
      title={`${title}${isDone ? " · done" : isPending ? " · pending" : ""}`}
    >
      <span style={{ color: labelColor, minWidth: 20 }}>{label}</span>
      <button
        type="button"
        disabled={disabled}
        title={`${title} · done`}
        onClick={() => onMark(isDone ? null : doneVal)}
        style={btn(isDone, "var(--ok, #2f8854)", "#fff")}
      >✓</button>
      <button
        type="button"
        disabled={disabled}
        title={`${title} · pending`}
        onClick={() => onMark(isPending ? null : pendingVal)}
        style={btn(isPending, "var(--err, #b13c1c)", "#fff")}
      >−</button>
    </div>
  );
}

// Handwriting grade — same cell height as the rest of the bar.
function GradePill({ label, title, value, disabled, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  const has = !!value;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", height: "100%" }}>
      <button
        type="button"
        title={`${title}${has ? ` — ${value}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((s) => !s)}
        style={{
          ...QUICK_CELL,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.45 : 1,
          background: has ? "var(--accent-soft)" : "transparent",
          color: has ? "var(--accent-2)" : "var(--ink-3)",
        }}
      >
        <span>{label}</span>
        <span style={{
          minWidth: 18, textAlign: "center",
          fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 600,
          color: has ? "var(--accent-2)" : "var(--ink-4)",
        }}>{value || "—"}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)",
          background: "var(--card)", border: "1px solid var(--rule)",
          borderRadius: 9, padding: 6, zIndex: 50,
          boxShadow: "0 10px 28px -18px rgba(0,0,0,0.35)",
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3,
        }}>
          {["A+", "A", "A-", "B+", "B", "B-", "C", "D"].map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => { onPick(g); setOpen(false); }}
              style={{
                height: 28, minWidth: 36, border: 0, borderRadius: 6, cursor: "pointer",
                background: value === g ? "var(--accent)" : "var(--bg-2)",
                color: value === g ? "#fff" : "var(--ink-2)",
                fontSize: 11.5, fontWeight: 600,
              }}
            >{g}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function GrowthChip({ heightCm, weightKg, onClick }) {
  const has = heightCm != null || weightKg != null;
  const label = has
    ? `${heightCm != null ? heightCm : "—"}·${weightKg != null ? weightKg : "—"}`
    : "Ht/Wt";
  return (
    <button
      type="button"
      onClick={onClick}
      title={has
        ? `Height ${heightCm ?? "—"} cm · Weight ${weightKg ?? "—"} kg — click to update`
        : "Update height & weight"}
      style={{
        ...QUICK_CELL,
        cursor: "pointer",
        background: has ? "var(--info-soft, #e8eef5)" : "transparent",
        color: has ? "var(--info, #3d5a73)" : "var(--ink-3)",
        fontFamily: has ? "var(--font-mono)" : "inherit",
        fontSize: has ? 10.5 : 11,
      }}
    >
      {label}
    </button>
  );
}

function Legend({ swatch, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        width: 9, height: 9, borderRadius: 2,
        background: swatch, border: "1px solid var(--rule, #e5dfd1)",
      }} />
      {label}
    </span>
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
