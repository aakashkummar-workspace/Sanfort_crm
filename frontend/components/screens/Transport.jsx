"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatClassLabel } from "@/lib/format";
import Icon from "../Icon";
import { KPI, AvatarChip, StatusChip } from "../ui";
import { resolveSchool, downloadPdf } from "@/lib/export";

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

export default function ScreenTransport({ E, refresh, role, session }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const canEdit = role === "principal" || role === "admin" || role === "transport_manager";
  const isParent = role === "parent";
  const isTeacher = role === "teacher";
  // True when the signed-in user is allowed to drive the bus-progress
  // controls (Start / Next stop / Reset) on this specific route.
  // Admin/principal can run any route; a teacher can only run the route
  // they're listed as attendant on. Server enforces the same rule —
  // /api/transport/advance rejects mismatched callers — so this is a UI
  // gate, not a security boundary.
  const meLower = (session?.name || "").trim().toLowerCase();
  const canRunRoute = (r) => {
    if (canEdit) return true;
    if (!isTeacher || !r) return false;
    const att = (r.attendant || "").trim().toLowerCase();
    return att && att !== "—" && att === meLower;
  };
  const [view, setView] = useState("live"); // 'live' | 'history'
  const [routeIdx, setRouteIdx] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null); // route object being edited, or null
  const [assigning, setAssigning] = useState(null); // route object being staff-assigned, or null
  const [maintFor, setMaintFor]   = useState(null); // route whose maintenance log is open, or null
  // Route being considered for deletion. Opens a type-to-confirm modal so
  // a single accidental click on the ✕ icon can never wipe a route
  // (and unlink dozens of students with it). Bug that bit the school
  // multiple times before this guard was added.
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [showAbsent, setShowAbsent] = useState(false);
  const [showMap, setShowMap] = useState(false);
  // Bulk transport-assignment importer — separate from the Students CSV
  // importer because admission usually happens once + transport gets
  // re-shuffled mid-term. This modal updates existing students only.
  const [showAssignImport, setShowAssignImport] = useState(false);
  const [toast, setToast] = useState(null);
  const [busyAction, setBusyAction] = useState(null);

  // Routes feed: when the signed-in user is a teacher, scope to routes
  // where they're the named attendant. Server-side /api/data already does
  // this scoping for teachers — this is the matching client guard so the
  // UI stays honest even if a stale cached payload sneaks through, and so
  // the route picker on the left only shows what the teacher can act on.
  const routes = useMemo(() => {
    const all = E.ROUTES || [];
    if (!isTeacher) return all;
    if (!meLower) return [];
    return all.filter((r) => {
      const att = (r.attendant || "").trim().toLowerCase();
      return att && att !== "—" && att === meLower;
    });
  }, [E.ROUTES, isTeacher, meLower]);
  const route = routes[routeIdx];

  // Reset selection when the active route disappears.
  useEffect(() => {
    if (routeIdx >= routes.length) setRouteIdx(0);
  }, [routes.length, routeIdx]);

  // Map: for the active route, group students by their pickup stop.
  // Students are linked to a route via `student.transport === route.code`
  // for morning routes, or `student.transportEvening === route.code` for
  // evening routes. Per-stop assignment uses pickupStop / pickupStopEvening
  // accordingly. Direction comes off the route ('morning' | 'evening' |
  // 'both') — 'both' is treated as morning so single-direction schools that
  // never set the field keep working.
  const routeDir = route?.direction === "evening" ? "evening" : "morning";
  const studentRouteCode = (stu) => routeDir === "evening" ? stu.transportEvening : stu.transport;
  const studentPickupStop = (stu) => routeDir === "evening" ? stu.pickupStopEvening : stu.pickupStop;

  // Transport roster: the general student list is class-scoped for teachers,
  // but a bus teacher needs every student on their route (many classes). The
  // server/AppShell supplies E.TRANSPORT_STUDENTS with the route roster for
  // teachers; union it with ADDED_STUDENTS (deduped) so admins/principals
  // (who already have the full list) and teachers both work.
  const transportRoster = useMemo(() => {
    const byId = new Map();
    for (const s of (E.ADDED_STUDENTS || [])) byId.set(s.id, s);
    for (const s of (E.TRANSPORT_STUDENTS || [])) if (!byId.has(s.id)) byId.set(s.id, s);
    return [...byId.values()];
  }, [E.ADDED_STUDENTS, E.TRANSPORT_STUDENTS]);

  const studentsByStop = useMemo(() => {
    if (!route) return {};
    const stops = route.stops || [];
    const firstStopName = stops[0]?.name;
    const out = {};
    for (const s of stops) out[s.name] = [];
    for (const stu of transportRoster) {
      if (studentRouteCode(stu) !== route.code) continue;
      const stop = studentPickupStop(stu);
      const matchStop = stops.find((s) => s.name === stop)?.name || firstStopName;
      if (matchStop && out[matchStop]) out[matchStop].push(stu);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, transportRoster, routeDir]);

  // Per-student attendance, persisted to /api/transport/attendance and
  // surfaced via E.TRANSPORT_ATTENDANCE on every refresh. We keep an
  // optimistic local overlay (`pendingMarks`) so the chip flips instantly
  // even before the refresh round-trips back. Composite key is
  // (date|direction|route|studentId).
  const todayKey = new Date().toISOString().slice(0, 10);
  const [direction, setDirection] = useState("morning"); // 'morning' | 'evening'
  // Keep the marking direction in sync with the selected route: a dedicated
  // morning/evening route always marks that trip (so evening attendance is
  // recorded as evening, and the morning-absent auto-mark kicks in). "Both"
  // routes leave the toggle under the user's control.
  useEffect(() => {
    if (route && (route.direction === "morning" || route.direction === "evening")) {
      setDirection(route.direction);
    }
  }, [route?.code, route?.direction]);
  const [pendingMarks, setPendingMarks] = useState({});  // optimistic overlay
  const markKey = (routeCode, studentId, date, dir) => `${routeCode}|${studentId}|${date}|${dir}`;

  // Build a fast lookup of persisted marks for the active route + today.
  const persistedMarks = useMemo(() => {
    const out = {};
    for (const r of (E.TRANSPORT_ATTENDANCE || [])) {
      out[markKey(r.routeCode, r.studentId, r.date, r.direction || "morning")] = r.status;
    }
    return out;
  }, [E.TRANSPORT_ATTENDANCE]);

  const studentMark = (student) => {
    if (!route) return null;
    const k = markKey(route.code, student.id, todayKey, direction);
    return pendingMarks[k] ?? persistedMarks[k] ?? null;
  };

  // Today's MORNING boarding status per student (route-independent — keyed by
  // studentId). Evening drop is blocked only for true bus-absent; if the
  // class teacher later marks "Dropped by parent", status becomes "parent"
  // and evening drop is allowed again.
  const morningStatusByStudent = useMemo(() => {
    const out = {};
    for (const r of (E.TRANSPORT_ATTENDANCE || [])) {
      if ((r.direction || "morning") === "morning" && r.date === todayKey) out[r.studentId] = r.status;
    }
    return out;
  }, [E.TRANSPORT_ATTENDANCE, todayKey]);

  const markStudent = async (stop, student, action) => {
    if (!route) return;
    const status = action === "board" ? "boarded" : action === "drop" ? "dropped" : "absent";
    const k = markKey(route.code, student.id, todayKey, direction);
    // Optimistic flip first.
    setPendingMarks((m) => ({ ...m, [k]: status }));
    let ok = false;
    try {
      const r = await fetch("/api/transport/attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          studentId: student.id, date: todayKey, direction, status,
          routeCode: route.code, stopName: stop.name,
          studentName: student.name, cls: student.cls,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Could not save");
      ok = true;
    } catch (e) {
      // Roll back the optimistic flip if the server rejected the write.
      setPendingMarks((m) => { const n = { ...m }; delete n[k]; return n; });
      showToast(e.message, "err");
    }
    // A drop is a delivery event (parent gets an in-app alert), not a boarding
    // count — so we skip the aggregate stop counter for it.
    if (action === "drop") {
      if (ok) showToast(`${student.name} dropped · parent notified`, "ok");
      return;
    }
    // Also bump the aggregate stop counter (existing flow).
    await mark(stop.name, action);
  };

  // Add / remove students from a stop. Updates student.transport +
  // student.pickupStop via PATCH /api/students.
  const [addStopOpen, setAddStopOpen] = useState(null); // stop object being filled, or null
  const [rosterOpen, setRosterOpen] = useState(false);  // route-level "Assign students" modal
  // Off-stop boarding flow: a student boards at a stop they're NOT
  // assigned to (came from a friend's house, parent dropped them at a
  // closer stop, etc). Records the actual stop on the attendance row;
  // the student's `pickupStop` assignment stays unchanged.
  const [offStopOpen, setOffStopOpen] = useState(null);
  const markOffStop = async (stop, student) => {
    if (!route) return;
    const k = markKey(route.code, student.id, todayKey, direction);
    setPendingMarks((m) => ({ ...m, [k]: "boarded" }));
    try {
      const r = await fetch("/api/transport/attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          studentId: student.id, date: todayKey, direction, status: "boarded",
          routeCode: route.code, stopName: stop.name,
          studentName: student.name, cls: student.cls,
        }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Could not save");
      // Bump the aggregate stop counter so the live KPI reflects reality.
      await mark(stop.name, "board");
      const assigned = student.pickupStop && student.pickupStop !== stop.name
        ? ` (assigned to ${student.pickupStop})` : "";
      showToast(`${student.name} boarded at ${stop.name}${assigned}`, "ok");
      setOffStopOpen(null);
    } catch (e) {
      setPendingMarks((m) => { const n = { ...m }; delete n[k]; return n; });
      showToast(e.message, "err");
    }
  };
  const linkStudent = async (studentId, stopName) => {
    try {
      // Direction-aware patch: an evening route writes only the evening
      // slot, so the student's morning route (a different bus) stays
      // intact. Same in reverse for morning routes.
      const patch = routeDir === "evening"
        ? { id: studentId, transportEvening: route.code, pickupStopEvening: stopName }
        : { id: studentId, transport:        route.code, pickupStop:        stopName };
      const r = await fetch("/api/students", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`${json.student.name} → ${route.code} · ${stopName} (${routeDir})`, "ok");
      setAddStopOpen(null);
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  };
  const unlinkStudent = async (student) => {
    const stopLabel = studentPickupStop(student) || "this stop";
    if (!confirm(`Remove ${student.name} from ${route.code} · ${stopLabel} (${routeDir})?`)) return;
    try {
      // Only clear the slot matching this route's direction — leaves the
      // other direction's assignment untouched.
      const patch = routeDir === "evening"
        ? { id: student.id, transportEvening: "—", pickupStopEvening: null }
        : { id: student.id, transport:        "—", pickupStop:        null };
      const r = await fetch("/api/students", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`${student.name} unlinked from ${routeDir} transport`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  };

  const allStops = routes.flatMap((r) => r.stops || []);
  const totalBoarded = allStops.reduce((a, s) => a + (s.boarded || 0), 0);
  // Use the per-student attendance log as the source of truth — the old
  // sum-of-stop-counters lagged behind when the bus was at full cap.
  const totalAbsent = ((E.TRANSPORT_ATTENDANCE || [])
    .filter((r) => r.date === new Date().toISOString().slice(0, 10) && r.status === "absent")
    .length);
  const totalCap     = allStops.reduce((a, s) => a + (s.cap     || 0), 0);

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  const mark = async (stopName, action) => {
    try {
      const r = await fetch("/api/transport/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: route.code, stopName, action }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      await refresh?.();
    } catch (e) {
      showToast(e.message, "err");
    }
  };

  async function handleAddRoute(payload) {
    const r = await fetch("/api/transport/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to add route");
    setShowAdd(false);
    showToast(`Route ${json.route.code} added`, "ok");
    await refresh?.();
  }

  async function handleAssignStaff(code, attendant) {
    const r = await fetch("/api/transport/route", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, attendant }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to assign teacher");
    setAssigning(null);
    showToast(`${json.route.code} → ${attendant || "(unassigned)"}`, "ok");
    await refresh?.();
  }

  async function handleEditRoute(payload) {
    const r = await fetch("/api/transport/route", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
    setEditing(null);
    showToast(`Route ${json.route.code} updated`, "ok");
    await refresh?.();
  }

  // Drive the bus through the route — start, next stop, prev, finish, reset.
  async function advance(action) {
    if (!route) return;
    setBusyAction(action);
    try {
      const r = await fetch("/api/transport/advance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: route.code, action }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(json.summary || "Updated", "ok");
      await refresh?.();
    } catch (e) {
      showToast(e.message, "err");
    } finally {
      setBusyAction(null);
    }
  }

  // The actual delete — only called after the user has confirmed via the
  // type-to-confirm modal (state: confirmRemove). Never invoke this
  // directly from an icon-button onClick; route deletion is destructive
  // and has bitten the admin multiple times via a single accidental click.
  async function performRemoveRoute(code) {
    try {
      const r = await fetch("/api/transport/route", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`Route ${code} removed`, "ok");
      await refresh?.();
    } catch (e) {
      showToast(e.message, "err");
    }
  }

  // Absentees today — one row per absent student, sourced from the
  // per-student transport_attendance table (the authoritative log).
  // The earlier stop-counter approach lost detail and missed rows when
  // the counter cap was already reached.
  const absentees = useMemo(() => {
    const rowsToday = (E.TRANSPORT_ATTENDANCE || []).filter(
      (r) => r.date === todayKey && r.status === "absent"
    );
    return rowsToday.map((r) => {
      const route = routes.find((x) => x.code === r.routeCode);
      const stop  = route?.stops?.find((s) => s.name === r.stopName);
      return {
        route: r.routeCode || "—",
        routeName: route?.name || "",
        stop: r.stopName || "—",
        time: stop?.t || "—",
        direction: r.direction || "morning",
        studentName: r.studentName || r.studentId,
        studentId: r.studentId,
        cls: r.cls || "—",
      };
    });
  }, [E.TRANSPORT_ATTENDANCE, routes, todayKey]);

  function downloadAbsenteeList() {
    if (absentees.length === 0) {
      showToast("No absentees marked yet today", "err");
      return;
    }
    const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    downloadPdf({
      title: "Transport Absentee List",
      subtitle: `${absentees.length} absent student${absentees.length === 1 ? "" : "s"} today`,
      school, actor,
      dateRange: today,
      orientation: "landscape",
      summary: [
        { label: "Total absent", value: absentees.length },
        { label: "Routes affected", value: new Set(absentees.map((a) => a.route)).size },
        { label: "Morning trip", value: absentees.filter((a) => a.direction === "morning").length },
        { label: "Evening trip", value: absentees.filter((a) => a.direction === "evening").length },
      ],
      columns: [
        { key: "route",       label: "Route",        align: "center", width: "70px" },
        { key: "routeName",   label: "Route name" },
        { key: "stop",        label: "Stop" },
        { key: "time",        label: "Pickup",       align: "right",  width: "80px" },
        { key: "direction",   label: "Trip",         align: "center", width: "80px" },
        { key: "studentName", label: "Student" },
        { key: "studentId",   label: "ID",           width: "100px" },
        { key: "cls",         label: "Class",        align: "center", width: "60px" },
      ],
      rows: absentees.map((a) => ({
        route: a.route, routeName: a.routeName || "—", stop: a.stop || "—",
        time: a.time || "—", direction: a.direction || "morning",
        studentName: a.studentName || "—", studentId: a.studentId, cls: a.cls || "—",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-transport-absent-${today.replace(/\s+/g, "-").toLowerCase()}`,
    });
    showToast(`Opened PDF preview (${absentees.length} absent)`, "ok");
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Operations · Transport</div>
          <div className="page-title">Transport <span className="amber">live boarding</span></div>
          <div style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(() => {
              const runningCount = routes.filter((r) => r.status === "running").length;
              if (runningCount > 0) {
                return (
                  <span className="live-pill"><span className="pulse-dot" />Live GPS · {runningCount} bus{runningCount === 1 ? "" : "es"} running</span>
                );
              }
              return (
                <span className="live-pill" style={{ background: "var(--bg-2)" }}>
                  <span className="dot" />No buses running · {routes.length} route{routes.length === 1 ? "" : "s"} on file
                </span>
              );
            })()}
            <span>Morning run · 07:00 – 08:00</span>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setShowMap(true)}>
            <Icon name="mapPin" size={13} />Map view
          </button>
          <button className="btn" onClick={() => setShowAbsent(true)}>
            <Icon name="download" size={13} />Absentee list
          </button>
          {canEdit && (
            <button className="btn" onClick={() => setShowAssignImport(true)} title="Bulk-assign morning and evening routes to existing students from CSV / Excel">
              <Icon name="upload" size={13} />Import assignments
            </button>
          )}
          {canEdit && (
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />Add route
            </button>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI
          label="Students boarded" value={totalCap ? `${totalBoarded}` : "—"} unit={totalCap ? `/${totalCap}` : ""}
          sub="morning run" puck="mint" puckIcon="check"
          details={{
            title: `Boarded · ${totalBoarded} of ${totalCap}`,
            sub: "Per-route boarding count",
            items: routes.map((r) => {
              const boarded = (r.stops || []).reduce((a, s) => a + (s.boarded || 0), 0);
              const cap     = (r.stops || []).reduce((a, s) => a + (s.cap     || 0), 0);
              return { label: `${r.code} · ${r.name}`, value: `${boarded}/${cap}`, tone: "ok" };
            }),
          }}
        />
        <KPI
          label="Absent today" value={totalAbsent} sub="across all routes"
          puck="rose" puckIcon="warning"
          details={{
            title: `Absent today · ${totalAbsent} student${totalAbsent === 1 ? "" : "s"}`,
            sub: "Marked absent on the bus run today",
            items: absentees.map((a) => ({
              label: a.studentName, value: a.cls, sub: `${a.route} · ${a.stop} · ${a.direction}`, tone: "bad",
            })),
          }}
        />
        {(() => {
          // Real "running" count = routes whose teacher hit Start and hasn't
          // hit Finish/Reset yet. Idle and Completed don't count, otherwise
          // the indicator never resets between morning and afternoon runs
          // and the parent thinks tracking is still live.
          const runningRoutes = routes.filter((r) => r.status === "running");
          const completedToday = routes.filter((r) => r.status === "completed").length;
          const delayedCount = runningRoutes.filter((r) => r.status === "delayed").length;
          return (
            <>
              <KPI
                label="Buses running" value={runningRoutes.length}
                sub={
                  runningRoutes.length === 0 && completedToday > 0
                    ? `${completedToday} completed today`
                    : runningRoutes.length === 0
                      ? "no live runs"
                      : delayedCount
                        ? `${delayedCount} delayed`
                        : `${runningRoutes.length} on the road`
                }
                puck="peach" puckIcon="bus"
                details={{
                  title: `Buses · ${runningRoutes.length} running · ${completedToday} completed today`,
                  items: routes.map((r) => ({
                    label: `${r.code} · ${r.name}`, value: r.status || "idle",
                    sub: `${r.bus} · ${r.driver}`,
                  })),
                }}
              />
              <KPI
                label="Avg on-time %"
                value={runningRoutes.length
                  ? `${Math.round(((runningRoutes.length - delayedCount) / runningRoutes.length) * 100)}%`
                  : "—"}
                sub={runningRoutes.length ? "based on running buses" : "needs an active run"}
                puck="cream" puckIcon="trending"
              />
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div className="segmented">
          <button className={view === "live" ? "active" : ""} onClick={() => setView("live")}>
            Live boarding
          </button>
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
            Attendance history
          </button>
          {canEdit && (
            <button className={view === "templates" ? "active" : ""} onClick={() => setView("templates")}>
              Master timetable
            </button>
          )}
        </div>
        {view === "live" && !isParent && (
          <div className="segmented" title="Which trip you're marking right now">
            <button className={direction === "morning" ? "active" : ""} onClick={() => setDirection("morning")}>
              <Icon name="sun" size={11} />Morning
            </button>
            <button className={direction === "evening" ? "active" : ""} onClick={() => setDirection("evening")}>
              <Icon name="moon" size={11} />Evening
            </button>
          </div>
        )}
      </div>

      {view === "history" && (
        <TransportHistoryView
          rows={E.TRANSPORT_ATTENDANCE || []}
          students={E.ADDED_STUDENTS || []}
          routes={routes}
          isParent={isParent}
          school={school}
          actor={actor}
        />
      )}

      {view === "templates" && canEdit && (
        <MasterTimetablePanel
          templates={E.ROUTE_TEMPLATES || []}
          routes={routes}
          role={role}
          showToast={showToast}
          refresh={refresh}
        />
      )}

      {view === "live" && (
      <div className="grid g-12">
        <div className="card col-4">
          <div className="card-head">
            <div><div className="card-title">Routes</div><div className="card-sub">{routes.length} active · morning run</div></div>
          </div>
          <div>
            {routes.length === 0 && (
              <div className="empty">{
                isTeacher
                  ? "You haven't been assigned to any bus route yet. Ask the principal to assign you as the attendant on a route — it will then appear here with the Start / Next stop controls."
                  : canEdit
                    ? "No transport routes yet. Click “Add route” to set one up."
                    : "The principal hasn’t added any routes."
              }</div>
            )}
            {routes.map((r, i) => {
              const boarded = (r.stops || []).reduce((a, s) => a + (s.boarded || 0), 0);
              const cap = (r.stops || []).reduce((a, s) => a + (s.cap || 0), 0);
              const active = i === routeIdx;
              const maintAlert = computeMaintAlert((E.MAINTENANCE_LOGS || []).filter((m) => m.busNumber === r.bus));
              return (
                <div
                  key={r.code}
                  onClick={() => setRouteIdx(i)}
                  className="lrow"
                  style={{ cursor: "pointer", background: active ? "var(--accent-soft)" : undefined, borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent" }}
                >
                  <div style={{ width: 44, height: 44, borderRadius: 10, background: "var(--card-2)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <Icon name="bus" size={20} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{r.code}</span>
                      <RunStatusChip status={r.status} />
                      <DirectionChip direction={r.direction} />
                    </div>
                    <div className="s" style={{ marginTop: 1 }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                      <Icon name="staff" size={10} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.attendant && r.attendant !== "—" ? `Teacher: ${r.attendant}` : <em style={{ color: "var(--ink-4)" }}>No teacher assigned</em>}
                      </span>
                    </div>
                    {maintAlert && (
                      <div style={{ marginTop: 4 }}>
                        <span className={`chip ${maintAlert.tone}`} style={{ fontSize: 10 }}>
                          <span className="dot" />{maintAlert.label}
                        </span>
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <div className="bar" style={{ flex: 1 }}><span style={{ width: `${cap ? (boarded / cap) * 100 : 0}%` }} /></div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", minWidth: 36, textAlign: "right" }}>{boarded}/{cap}</div>
                    </div>
                  </div>
                  {canEdit && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <button
                        className="icon-btn"
                        onClick={(e) => { e.stopPropagation(); setAssigning(r); }}
                        title="Assign teacher to this bus"
                      >
                        <Icon name="staff" size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={(e) => { e.stopPropagation(); setMaintFor(r); }}
                        title="Vehicle maintenance log"
                      >
                        <Icon name="wrench" size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={(e) => { e.stopPropagation(); setEditing(r); }}
                        title="Edit route"
                      >
                        <Icon name="pencil" size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={(e) => { e.stopPropagation(); setConfirmRemove(r); }}
                        title="Remove route"
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {!route ? (
          <div className="col-8">
            <div className="card"><div className="empty" style={{ padding: 60 }}>Add a route to see live boarding here.</div></div>
          </div>
        ) : (
        <div className="col-8" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, borderBottom: "1px solid var(--rule)", flexWrap: "wrap" }}>
              <div style={{ width: 44, height: 44, borderRadius: 11, background: "var(--accent-soft)", color: "var(--accent-2)", display: "grid", placeItems: "center" }}>
                <Icon name="bus" size={22} />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{route.code} · {route.name}</span>
                  <DirectionChip direction={route.direction} />
                  <RunStatusChip status={route.status} />
                </div>
                <div style={{ color: "var(--ink-3)", fontSize: 12, display: "flex", gap: 10, marginTop: 2, flexWrap: "wrap" }}>
                  <span>{route.bus}</span><span className="meta-dot">·</span>
                  <span>Driver: {route.driver}</span><span className="meta-dot">·</span>
                  <span>Teacher: {route.attendant && route.attendant !== "—" ? route.attendant : <em style={{ color: "var(--ink-4)" }}>unassigned</em>}</span><span className="meta-dot">·</span>
                  <span>{route.eta}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {canEdit && (
                  <button
                    className="btn sm"
                    onClick={() => setRosterOpen(true)}
                    title="Assign or remove students for any stop on this route"
                  >
                    <Icon name="users" size={12} />Assign students
                  </button>
                )}
                <button className="btn sm" onClick={() => showToast(`Calling ${route.driver}…`, "ok")}><Icon name="phone" size={12} />Call</button>
                <button className="btn sm" onClick={() => setShowMap(true)}><Icon name="mapPin" size={12} />Track</button>
                <button className="btn sm accent" onClick={() => showToast(`Broadcast sent to ${route.code} parents`, "ok")}><Icon name="send" size={12} />Broadcast</button>
              </div>
            </div>

            {/* Run controls — drive the bus through its route. Visible to
                admins on any route, and to the teacher named as attendant
                on this specific route (so they can mark each stop done
                from their own login). */}
            {canRunRoute(route) && (() => {
              const stops = route.stops || [];
              const status = route.status || "idle";
              const curIdx = stops.findIndex((s) => s.status === "current");
              const cur = curIdx >= 0 ? stops[curIdx] : null;
              const isLast = curIdx === stops.length - 1;
              const notStarted = status === "idle" || (curIdx === -1 && stops.every((s) => s.status !== "done"));
              const isCompleted = status === "completed";
              return (
                <div style={{
                  padding: "12px 18px", borderBottom: "1px solid var(--rule)",
                  background: "var(--bg-2)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                }}>
                  <div style={{ flex: 1, minWidth: 200, fontSize: 12 }}>
                    {isCompleted ? (
                      <><span style={{ color: "var(--ok)", fontWeight: 500 }}>✓ Run completed</span> · all stops marked done · ready for next trip</>
                    ) : notStarted ? (
                      <><span style={{ color: "var(--ink-3)" }}>Not started yet ·</span> {stops.length} stop{stops.length === 1 ? "" : "s"} planned · click <b>Start run</b> when the bus rolls out</>
                    ) : cur ? (
                      <><span style={{ color: "var(--accent)", fontWeight: 500 }}>● At stop {curIdx + 1}/{stops.length}: {cur.name}</span> · scheduled {cur.t}</>
                    ) : (
                      <span style={{ color: "var(--ink-3)" }}>Run in progress</span>
                    )}
                  </div>
                  {notStarted && (
                    <button className="btn sm accent" disabled={busyAction === "start"} onClick={() => advance("start")}>
                      <Icon name="play" size={12} />{busyAction === "start" ? "Starting…" : "Start run"}
                    </button>
                  )}
                  {!notStarted && !isCompleted && (
                    <>
                      <button className="btn sm" disabled={busyAction === "prev" || curIdx <= 0} onClick={() => advance("prev")}>
                        <Icon name="arrowRight" size={12} style={{ transform: "scaleX(-1)" }} />Previous
                      </button>
                      <button className="btn sm accent" disabled={!!busyAction} onClick={() => advance("next")}>
                        <Icon name="check" size={12} />{busyAction === "next" ? "Saving…" : isLast ? "Mark this stop done & finish" : "Mark this stop done & advance"}
                      </button>
                      <button className="btn sm" disabled={!!busyAction} onClick={() => advance("finish")} title="Mark all remaining stops as done">
                        <Icon name="flag" size={12} />Finish
                      </button>
                    </>
                  )}
                  {isCompleted && (
                    <button className="btn sm" disabled={busyAction === "reset"} onClick={() => advance("reset")}>
                      <Icon name="refresh" size={12} />{busyAction === "reset" ? "Resetting…" : "Reset for next run"}
                    </button>
                  )}
                </div>
              );
            })()}

            <div style={{ padding: "20px 18px" }}>
              <div style={{ position: "relative" }}>
                <div style={{ position: "absolute", left: 22, top: 10, bottom: 10, width: 2, background: "var(--rule)" }} />
                {(route.stops || []).map((s, i) => {
                  const done = s.status === "done";
                  const cur = s.status === "current";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "46px 1fr auto",
                        gap: 14,
                        padding: "12px 0",
                        borderBottom: i < (route.stops.length - 1) ? "1px solid var(--rule-2)" : "none",
                      }}
                    >
                      <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
                        <div
                          className={cur ? "stop-radar" : ""}
                          style={{
                            width: cur ? 24 : 18,
                            height: cur ? 24 : 18,
                            borderRadius: "50%",
                            background: done ? "var(--ok)" : cur ? "var(--accent)" : "var(--card)",
                            border: done ? "3px solid var(--card)" : cur ? "3px solid var(--accent-soft)" : "2px solid var(--rule)",
                            zIndex: 2,
                            display: "grid",
                            placeItems: "center",
                          }}
                        >
                          {done && <Icon name="check" size={11} stroke={2.5} style={{ color: "var(--card)" }} />}
                        </div>
                      </div>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13.5, fontWeight: 500 }}>{s.name}</span>
                          {cur && <span className="chip accent"><span className="dot" />Current stop</span>}
                          {s.status === "pending" && <span className="chip"><span className="dot" />Upcoming</span>}
                          {done && <span className="chip ok"><span className="dot" />Done</span>}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                          {s.t} · {(studentsByStop[s.name] || []).length || s.cap} student{((studentsByStop[s.name] || []).length || s.cap) === 1 ? "" : "s"} expected
                        </div>

                        {/* Per-student attendance roster for this stop */}
                        {(studentsByStop[s.name] || []).length > 0 ? (
                          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                            {(studentsByStop[s.name] || []).map((stu) => {
                              const explicit = studentMark(stu);
                              const amStatus = morningStatusByStudent[stu.id]; // boarded | absent | parent | undefined
                              const isEvening = direction === "evening";
                              // Evening: only a true morning bus-absent (not came-by-parent)
                              // is blocked from drop-off — they weren't at school.
                              const amAbsent = amStatus === "absent";
                              const isDropped = explicit === "dropped";
                              const isBoarded = explicit === "boarded";
                              const isAbsent  = explicit === "absent";
                              const isParentDrop = explicit === "parent";
                              const amLabel = amStatus === "boarded" ? "AM present"
                                : amStatus === "parent" ? "AM by parent"
                                : "AM —";
                              const amOk = amStatus === "boarded" || amStatus === "parent";
                              return (
                                <div key={stu.id} style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  padding: "6px 8px",
                                  background: "var(--bg-2)", border: "1px solid var(--rule-2)",
                                  borderRadius: 7,
                                }}>
                                  <span style={{
                                    width: 22, height: 22, borderRadius: "50%",
                                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                                    color: "#fff", display: "grid", placeItems: "center",
                                    fontSize: 9.5, fontWeight: 600, flexShrink: 0,
                                  }}>{(stu.name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{stu.name}</div>
                                    <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{formatClassLabel(stu.cls)} · {stu.id}</div>
                                  </div>
                                  {isEvening ? (
                                    amAbsent ? (
                                      // Morning absent → not on the evening bus. Only the badge.
                                      <span className="chip bad" style={{ fontSize: 9.5 }} title="Absent in the morning — not on the evening bus">
                                        <Icon name="x" size={9} stroke={2.5} />AM absent
                                      </span>
                                    ) : (
                                      // Morning present / by-parent / unmarked → droppable.
                                      <>
                                        <span
                                          className="chip"
                                          title="Morning boarding status"
                                          style={{
                                            fontSize: 9,
                                            color: amOk ? "var(--ok)" : "var(--ink-4)",
                                            borderColor: amOk ? "var(--ok)" : "var(--rule)",
                                          }}
                                        >
                                          {amLabel}
                                        </span>
                                        {isDropped ? (
                                          <span className="chip ok" style={{ fontSize: 9.5 }}><Icon name="check" size={9} stroke={2.5} />Dropped</span>
                                        ) : cur ? (
                                          <button className="btn sm accent" style={{ height: 24, padding: "0 10px", fontSize: 11 }} onClick={() => markStudent(s, stu, "drop")} title="Mark dropped off — the parent gets an in-app alert">
                                            <Icon name="check" size={10} stroke={2.5} />Dropped
                                          </button>
                                        ) : null}
                                      </>
                                    )
                                  ) : (
                                    // Morning view — Present / Absent only.
                                    // "By parent" is set later by the class teacher.
                                    <>
                                      {isBoarded && <span className="chip ok" style={{ fontSize: 9.5 }}><Icon name="check" size={9} stroke={2.5} />Present</span>}
                                      {isParentDrop && <span className="chip warn" style={{ fontSize: 9.5 }} title="Class teacher marked dropped by parent">By parent</span>}
                                      {isAbsent && <span className="chip bad" style={{ fontSize: 9.5 }}><Icon name="x" size={9} stroke={2.5} />Absent</span>}
                                      {cur && !isBoarded && !isAbsent && !isParentDrop && (
                                        <>
                                          <button className="btn sm ghost" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => markStudent(s, stu, "board")}>
                                            <Icon name="check" size={10} stroke={2.5} />Present
                                          </button>
                                          <button className="btn sm ghost" style={{ height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => markStudent(s, stu, "absent")}>
                                            <Icon name="x" size={10} stroke={2.5} />Absent
                                          </button>
                                        </>
                                      )}
                                    </>
                                  )}
                                  {canEdit && (
                                    <button
                                      className="icon-btn"
                                      style={{ width: 22, height: 22 }}
                                      onClick={() => unlinkStudent(stu)}
                                      title={`Remove ${stu.name} from this stop`}
                                    >
                                      <Icon name="x" size={11} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}

                        {/* Off-stop boarding — runtime only, keeps the live
                            view focused on the boarding flow. Roster management
                            (assigning students to stops) lives in the
                            "Assign students" modal at the route header. */}
                        {canEdit && cur && (
                          <button
                            className="btn sm"
                            style={{ marginTop: 8, height: 26, padding: "0 10px", fontSize: 11 }}
                            onClick={() => setOffStopOpen(s)}
                            title="Mark a student boarded here who's assigned to a different stop"
                          >
                            <Icon name="check" size={11} />Off-stop boarding
                          </button>
                        )}
                        {(studentsByStop[s.name] || []).length === 0 && (done || cur) && (
                          <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-4)" }}>
                            No students linked to this stop yet.{canEdit ? " Use Assign students at the route header to add some." : ""}
                          </div>
                        )}

                        {(done || cur) && (s.boarded > 0 || s.absent > 0) && (
                          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                            <span className="chip ok"><Icon name="check" size={10} stroke={2.5} />{s.boarded} boarded</span>
                            {s.absent > 0 && <span className="chip bad"><Icon name="x" size={10} stroke={2.5} />{s.absent} absent</span>}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 12, color: done ? "var(--ink-2)" : "var(--ink-4)" }}>
                        {done ? s.t : cur ? "now" : s.t}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div><div className="card-title">Absentees · today</div><div className="card-sub">{absentees.length === 0 ? "No absentees marked yet" : `${absentees.length} student${absentees.length === 1 ? "" : "s"} absent today`}</div></div>
              <div className="card-actions">
                <button className="btn sm" onClick={downloadAbsenteeList} title="Open a printable, branded PDF report"><Icon name="download" size={12} />Export PDF</button>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead><tr><th>Student</th><th>Class</th><th>Route · Stop</th><th>Trip</th><th>Pickup</th></tr></thead>
                <tbody>
                  {absentees.length === 0 && (
                    <tr><td colSpan={5} className="empty">No absentees logged today.</td></tr>
                  )}
                  {absentees.map((a, i) => (
                    <tr key={`${a.studentId}-${a.direction}-${i}`}>
                      <td>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{a.studentName}</div>
                        <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{a.studentId}</div>
                      </td>
                      <td><span className="chip">{formatClassLabel(a.cls)}</span></td>
                      <td style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        <span className="chip" style={{ marginRight: 6 }}>{a.route}</span>
                        {a.stop}
                      </td>
                      <td>
                        <span className="chip" style={{ fontSize: 10.5 }}>
                          <Icon name={a.direction === "evening" ? "moon" : "sun"} size={10} />
                          {a.direction}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>{a.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        )}
      </div>
      )}

      {showAdd && canEdit && (
        <AddRouteModal
          onClose={() => setShowAdd(false)}
          onSubmit={handleAddRoute}
          existingCodes={routes.map((r) => r.code)}
          staff={E.STAFF || []}
        />
      )}
      {showAssignImport && canEdit && (
        <ImportAssignmentsModal
          routes={routes}
          onClose={() => setShowAssignImport(false)}
          onSubmitCsv={async (csv) => {
            const r = await fetch("/api/transport/assign-bulk", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ csv }),
            });
            const json = await r.json().catch(() => ({}));
            if (!r.ok || !json.ok) throw new Error(json.error || "Import failed");
            await refresh?.();
            return json;
          }}
        />
      )}
      {/* Render order matters: when both are open, the picker must render
          AFTER the roster so it stacks on top (both share zIndex 250). */}
      {rosterOpen && canEdit && route && (
        <RouteRosterModal
          route={route}
          studentsByStop={studentsByStop}
          onClose={() => setRosterOpen(false)}
          onAdd={(stop) => setAddStopOpen(stop)}
          onRemove={(student) => unlinkStudent(student)}
        />
      )}
      {addStopOpen && canEdit && route && (
        <AddStudentToStopModal
          route={route}
          stop={addStopOpen}
          students={E.ADDED_STUDENTS || []}
          onClose={() => setAddStopOpen(null)}
          onPick={(studentId) => linkStudent(studentId, addStopOpen.name)}
        />
      )}
      {offStopOpen && canEdit && route && (
        <OffStopBoardingModal
          route={route}
          stop={offStopOpen}
          students={E.ADDED_STUDENTS || []}
          onClose={() => setOffStopOpen(null)}
          onPick={(student) => markOffStop(offStopOpen, student)}
        />
      )}
      {editing && canEdit && (
        <EditRouteModal
          route={editing}
          onClose={() => setEditing(null)}
          onSubmit={handleEditRoute}
          staff={E.STAFF || []}
        />
      )}
      {assigning && canEdit && (
        <AssignStaffModal
          route={assigning}
          staff={E.STAFF || []}
          onClose={() => setAssigning(null)}
          onAssign={(driver) => handleAssignStaff(assigning.code, driver)}
        />
      )}
      {maintFor && (
        <MaintenanceModal
          route={maintFor}
          canEdit={canEdit}
          allLogs={E.MAINTENANCE_LOGS || []}
          onClose={() => setMaintFor(null)}
          onChanged={refresh}
        />
      )}
      {showAbsent && (
        <AbsenteeModal absentees={absentees} onClose={() => setShowAbsent(false)} onDownload={downloadAbsenteeList} />
      )}
      {showMap && (
        <MapModal routes={routes} onClose={() => setShowMap(false)} />
      )}
      {confirmRemove && (
        <ConfirmRemoveRouteModal
          route={confirmRemove}
          studentCount={(E.ADDED_STUDENTS || []).filter(
            (s) => s.transport === confirmRemove.code || s.transportEvening === confirmRemove.code
          ).length}
          onClose={() => setConfirmRemove(null)}
          onConfirm={async () => {
            await performRemoveRoute(confirmRemove.code);
            setConfirmRemove(null);
          }}
        />
      )}

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}


// Type-to-confirm delete modal for transport routes. A single accidental
// click on the ✕ icon used to wipe a route + unlink dozens of students;
// this guard makes that impossible — the Delete button stays disabled
// until the admin types the route code exactly. Pattern modelled after
// GitHub's "type the repo name to delete repo".
function ConfirmRemoveRouteModal({ route, studentCount, onClose, onConfirm }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const matches = typed.trim().toUpperCase() === String(route.code || "").trim().toUpperCase();

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e) {
    e?.preventDefault();
    if (!matches || busy) return;
    setBusy(true); setErr("");
    try { await onConfirm(); }
    catch (ex) { setErr(ex.message || "Delete failed"); setBusy(false); }
  }

  return (
    <ModalShell
      title={`Delete route ${route.code}?`}
      sub="This cannot be undone. Type the route code to confirm."
      onClose={onClose}
      width={460}
    >
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{
          background: "var(--err-soft, #fbe1d8)",
          border: "1px solid var(--err, #b13c1c)",
          color: "var(--ink-2)",
          borderRadius: 8,
          padding: "10px 12px",
          fontSize: 12.5,
          lineHeight: 1.55,
        }}>
          You're about to delete <b>{route.code}{route.name && route.name !== route.code ? ` · ${route.name}` : ""}</b>.
          {studentCount > 0 ? (
            <> This route is currently used by <b>{studentCount} student{studentCount === 1 ? "" : "s"}</b> — their transport assignment will be lost.</>
          ) : (
            <> No students are currently assigned to this route.</>
          )}
          {Array.isArray(route.stops) && route.stops.length > 0 && (
            <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
              {route.stops.length} stop{route.stops.length === 1 ? "" : "s"}: {route.stops.slice(0, 4).map((s) => s.name).join(", ")}{route.stops.length > 4 ? "…" : ""}
            </div>
          )}
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>
            Type <b style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{route.code}</b> to confirm
          </span>
          <input
            className="input"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={route.code}
            style={typed && !matches ? { borderColor: "var(--err, #b13c1c)" } : undefined}
          />
          <span style={{ fontSize: 11, color: matches ? "var(--ok)" : "var(--ink-4)" }}>
            {matches ? "✓ Match — delete is now enabled" : "The Delete button stays disabled until the code matches exactly."}
          </span>
        </label>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="submit"
            className="btn"
            disabled={!matches || busy}
            style={{
              background: matches ? "var(--err, #b13c1c)" : "var(--bg-2)",
              color: matches ? "#fff" : "var(--ink-4)",
              borderColor: matches ? "var(--err, #b13c1c)" : "var(--rule)",
            }}
          >
            <Icon name="x" size={13} />{busy ? "Deleting…" : "Delete route"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Status chip for the route — covers idle/running/completed/delayed.
function RunStatusChip({ status }) {
  if (status === "completed") return <span className="chip ok"><span className="dot" />Completed</span>;
  if (status === "running")   return <span className="chip"><span className="dot" />Running</span>;
  if (status === "delayed")   return <span className="chip warn"><span className="dot" />Delayed</span>;
  return <span className="chip"><span className="dot" />Not started</span>;
}

// Visual tag for a route's direction. Morning routes are amber-tinted,
// evening routes are slate / blue, and "both" stays neutral so it reads
// as the default. Used on the route card header and inferable from the
// dropdown filtering on the Admission screen.
function DirectionChip({ direction = "both" }) {
  const styles = {
    morning: { bg: "var(--warn-soft, #fff4e2)", fg: "var(--warn, #d4944e)", label: "Morning" },
    evening: { bg: "var(--accent-soft)", fg: "var(--accent-2)", label: "Evening" },
    both:    { bg: "var(--bg-2)", fg: "var(--ink-3)", label: "AM + PM" },
  };
  const s = styles[direction] || styles.both;
  return (
    <span style={{
      height: 18, padding: "0 8px",
      display: "inline-flex", alignItems: "center",
      fontSize: 10.5, fontWeight: 500,
      background: s.bg, color: s.fg,
      borderRadius: 999,
      textTransform: "uppercase", letterSpacing: 0.4,
    }}>{s.label}</span>
  );
}

function ModalShell({ title, sub, onClose, children, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
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

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
    </label>
  );
}

// Free-text input with a quick "pick from staff" dropdown beside it.
// Lets the principal pick an Ops/Intern staff member as the route's
// attendant, or just type a name (e.g. external driver). Stores the
// resolved name string on the route's `driver` field for back-compat.
function StaffPickerInput({ value, onChange, staff = [], placeholder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  // Anyone whose role isn't classroom-facing is fair game for a bus assignment —
  // drivers, attendants, conductors, security, ops/intern. Teachers/faculty are excluded
  // so a class teacher doesn't accidentally end up listed as a driver.
  const candidates = (staff || []).filter((s) => {
    const role = String(s.role || "").toLowerCase();
    if (/teacher|faculty|principal|coordinator|hod/.test(role)) return false;
    return true;
  });
  return (
    <div ref={ref} style={{ position: "relative", display: "flex", gap: 4 }}>
      <input
        className="input"
        style={{ flex: 1 }}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {candidates.length > 0 && (
        <button
          type="button"
          className="btn"
          style={{ padding: "0 8px", height: 34 }}
          onClick={() => setOpen((s) => !s)}
          title="Pick from staff"
        >
          <Icon name="staff" size={13} />
        </button>
      )}
      {open && candidates.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          minWidth: 220, maxHeight: 220, overflowY: "auto",
          background: "var(--card)", border: "1px solid var(--rule)",
          borderRadius: 8, padding: 4, zIndex: 60,
          boxShadow: "var(--shadow-lg)",
        }}>
          <div style={{ fontSize: 10.5, color: "var(--ink-4)", padding: "6px 10px 4px", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>
            Pick from staff
          </div>
          {candidates.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { onChange(s.name); setOpen(false); }}
              style={{
                width: "100%", textAlign: "left",
                padding: "7px 10px", background: "transparent",
                border: 0, borderRadius: 6, cursor: "pointer",
                color: "var(--ink-2)", fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ fontWeight: 500, color: "var(--ink)" }}>{s.name}</div>
              <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{s.role} · {s.dept}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Bulk-assign morning + evening transport routes to students already in
// the roster. Reads a CSV / Excel file, matches each row to a student by
// name (case + dot insensitive), validates that each route exists and is
// tagged with the correct direction, then patches the student's
// transport / pickupStop / transportEvening / pickupStopEvening fields.
// Re-running the import is safe — it overwrites prior assignments rather
// than stacking, so corrections live in the same Excel.
function ImportAssignmentsModal({ routes = [], onClose, onSubmitCsv }) {
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState("idle");  // idle | importing | done
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  // Sample CSV — the admin downloads, fills in the routes column per
  // student, and re-uploads. Uses realistic route codes from the user's
  // own roster when available; falls back to RT-1 / RT-2 if none defined
  // yet.
  const sampleCsv = (() => {
    const morningRoutes = routes.filter((r) => (r.direction || "both") !== "evening");
    const eveningRoutes = routes.filter((r) => (r.direction || "both") !== "morning");
    const mr = morningRoutes[0]?.code || "R1";
    const er = eveningRoutes[0]?.code || mr;
    return (
      "Student Name,Morning Route,Morning Stop,Evening Route,Evening Stop\n" +
      `Aakash Kumar,${mr},Stop 1,${er},Stop 1\n` +
      `Priya Sharma,${mr},Stop 2,—,—\n` +
      `KIRAN DEVI T,—,—,${er},Stop 3\n`
    );
  })();

  const downloadSample = () => {
    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "transport-assignments-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // Same client-side .xlsx → .csv conversion as the Students importer.
  // Pulls in `xlsx` dynamically so the bundle stays small for users who
  // never open this modal.
  const xlsxToCsv = async (f) => {
    const XLSX = await import("xlsx");
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    if (!firstSheet) throw new Error("Workbook has no sheets");
    return XLSX.utils.sheet_to_csv(firstSheet);
  };

  const onClick = async () => {
    if (!file || phase === "importing") return;
    setPhase("importing");
    try {
      const name = String(file.name || "").toLowerCase();
      const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls");
      const csv = isExcel ? await xlsxToCsv(file) : await file.text();
      const json = await onSubmitCsv(csv);
      setResult(json);
      setPhase("done");
    } catch (e) {
      setResult({ ok: false, error: e?.message || "Import failed", errors: [] });
      setPhase("done");
    }
  };

  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const updated = Number(result?.count || 0);

  return (
    <ModalShell
      title={phase === "done" ? (result?.ok === false ? "Import failed" : "Assignments imported") : "Import transport assignments"}
      sub={
        phase === "done"
          ? "The routes on screen reflect the new assignments — close to continue."
          : "CSV / Excel · columns: Student Name, Morning Route, Morning Stop, Evening Route, Evening Stop"
      }
      onClose={phase === "importing" ? () => {} : onClose}
      width={560}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {phase === "done" && result ? (
          result?.ok === false ? (
            <div style={{
              padding: "14px 16px",
              background: "var(--err-soft, #fbe1d8)",
              border: "1px solid var(--err, #b13c1c)",
              borderRadius: 10, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5,
            }}>
              <strong>Import couldn't run:</strong> {result.error || "Unknown error"}
            </div>
          ) : (
            <div style={{
              display: "flex", flexDirection: "column", gap: 10,
              padding: "14px 16px",
              background: "var(--ok-soft, #e6f4ec)",
              border: "1px solid var(--ok, #2f8854)",
              borderRadius: 10,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: "var(--ok, #2f8854)", color: "#fff",
                  display: "grid", placeItems: "center", flexShrink: 0,
                }}>
                  <Icon name="check" size={14} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>Assignments imported</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                    {updated} student{updated === 1 ? "" : "s"} updated · routes refreshed in the background.
                    {errors.length ? ` · ${errors.length} row${errors.length === 1 ? "" : "s"} skipped — see below.` : ""}
                  </div>
                </div>
              </div>
              {errors.length > 0 && (
                <div style={{
                  background: "var(--warn-soft, #fff4e2)",
                  border: "1px solid var(--warn, #d4944e)",
                  borderRadius: 7, padding: "8px 10px",
                  fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5,
                  maxHeight: 160, overflowY: "auto",
                }}>
                  {errors.slice(0, 12).map((e, i) => (
                    <div key={i}><strong>{e.name || `Row ${e.row}`}:</strong> {e.reason}</div>
                  ))}
                  {errors.length > 12 && (
                    <div style={{ color: "var(--ink-4)", marginTop: 4 }}>…and {errors.length - 12} more</div>
                  )}
                </div>
              )}
            </div>
          )
        ) : (
          <>
            <div
              onClick={() => inputRef.current?.click()}
              style={{
                border: "2px dashed var(--rule)", borderRadius: 12, padding: 26,
                textAlign: "center", cursor: "pointer", background: "var(--card-2)",
              }}
            >
              <Icon name="upload" size={22} />
              <div style={{ marginTop: 8, fontSize: 13, fontWeight: 500 }}>
                {file ? file.name : "Click to select a CSV or Excel file"}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>
                {file ? `${(file.size / 1024).toFixed(1)} KB` : ".csv / .xlsx — matches students by name"}
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                style={{ display: "none" }}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
              Need a starting point? <a onClick={downloadSample} style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}>Download a sample template</a>. Use the same route codes you've created on this screen. Leave a side blank or type <code>—</code> if a student has no transport on that trip.
            </div>
            {phase === "importing" && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px", borderRadius: 8,
                background: "var(--accent-soft)", color: "var(--accent-2)",
                fontSize: 12.5, fontWeight: 500,
              }}>
                <span className="spinner" style={{
                  width: 14, height: 14, borderRadius: "50%",
                  border: "2px solid var(--accent)", borderTopColor: "transparent",
                  animation: "spin 0.8s linear infinite",
                }} />
                Matching students and updating routes…
                <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {phase === "done" ? (
            <button className="btn accent" onClick={onClose}>
              <Icon name="check" size={13} />Done
            </button>
          ) : (
            <>
              <button className="btn ghost" onClick={onClose} disabled={phase === "importing"}>
                {phase === "importing" ? "Please wait…" : "Cancel"}
              </button>
              <button className="btn accent" disabled={!file || phase === "importing"} onClick={onClick}>
                {phase === "importing" ? (
                  <>
                    <span style={{
                      width: 12, height: 12, borderRadius: "50%",
                      border: "2px solid currentColor", borderTopColor: "transparent",
                      display: "inline-block", animation: "spin 0.8s linear infinite", marginRight: 6,
                    }} />
                    Importing…
                  </>
                ) : (
                  <><Icon name="upload" size={13} />Import {file ? "" : "(pick a file)"}</>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function AddRouteModal({ onClose, onSubmit, existingCodes, staff = [] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const codeRef = useRef(null);
  useEffect(() => { codeRef.current?.focus(); }, []);

  const nextCode = (() => {
    const nums = existingCodes.map((c) => Number(String(c).replace(/\D/g, "")) || 0);
    return `R${(Math.max(0, ...nums) + 1)}`;
  })();

  const [form, setForm] = useState({
    code: nextCode, name: "", driver: "", bus: "", eta: "07:00 – 08:00",
    // 'morning' | 'evening' | 'both'. Drives which student picker
    // (AM / PM) surfaces this route. 'both' = same vehicle does the
    // same loop for AM and PM — picked from both dropdowns.
    direction: "morning",
  });
  const [stops, setStops] = useState([
    { name: "", t: "07:10", cap: "" },
  ]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setStop = (i, k, v) => setStops((arr) => arr.map((s, j) => j === i ? { ...s, [k]: v } : s));
  const addStop = () => setStops((arr) => [...arr, { name: "", t: "", cap: "" }]);
  const rmStop  = (i) => setStops((arr) => arr.length > 1 ? arr.filter((_, j) => j !== i) : arr);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const code = String(form.code || "").trim().toUpperCase();
      if (!code) throw new Error("Route code is required");
      if (existingCodes.includes(code)) throw new Error(`Route ${code} already exists`);
      const cleanStops = stops
        .filter((s) => s.name.trim())
        .map((s) => ({ name: s.name.trim(), t: s.t || "—", cap: Number(s.cap) || 0 }));
      if (cleanStops.length === 0) throw new Error("Add at least one stop with a name");
      await onSubmit({
        code, name: form.name.trim() || code,
        driver: form.driver.trim() || "—",
        bus: form.bus.trim() || "—",
        eta: form.eta || "07:00 – 08:00",
        direction: form.direction,
        stops: cleanStops,
      });
    } catch (ex) {
      setErr(ex.message || String(ex));
      setBusy(false);
    }
  }

  return (
    <ModalShell title="New transport route" sub="Stops are added in pickup order" onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10 }}>
          <Field label="Code">
            <input ref={codeRef} className="input" value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase())} maxLength={6} />
          </Field>
          <Field label="Route name">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Sarjapur loop" />
          </Field>
        </div>
        <Field label="Direction" hint="Morning routes appear only in the AM picker for students; evening in the PM. ‘Both’ surfaces in both.">
          <div role="radiogroup" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {[
              { k: "morning", label: "Morning", sub: "AM trip" },
              { k: "evening", label: "Evening", sub: "PM trip" },
              { k: "both",    label: "Both",    sub: "Same loop, AM + PM" },
            ].map((opt) => {
              const active = form.direction === opt.k;
              return (
                <button
                  key={opt.k}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => set("direction", opt.k)}
                  style={{
                    padding: "8px 10px", borderRadius: 8,
                    border: `1px solid ${active ? "var(--accent)" : "var(--rule)"}`,
                    background: active ? "var(--accent-soft)" : "var(--card)",
                    color: active ? "var(--accent-2)" : "var(--ink-2)",
                    cursor: "pointer", textAlign: "left",
                    display: "flex", flexDirection: "column", gap: 2,
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500 }}>{opt.label}</span>
                  <span style={{ fontSize: 10.5, color: active ? "var(--accent-2)" : "var(--ink-4)" }}>{opt.sub}</span>
                </button>
              );
            })}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Field label="Driver / attendant" hint={staff.length ? "Pick from staff or type a name" : ""}>
            <StaffPickerInput value={form.driver} onChange={(v) => set("driver", v)} staff={staff} placeholder="Driver name" />
          </Field>
          <Field label="Bus number">
            <input className="input" value={form.bus} onChange={(e) => set("bus", e.target.value)} placeholder="KA-05-XX-1234" />
          </Field>
          <Field label="ETA window">
            <input className="input" value={form.eta} onChange={(e) => set("eta", e.target.value)} placeholder="07:00 – 08:00" />
          </Field>
        </div>

        <div style={{ marginTop: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Stops (in pickup order)</span>
            <button type="button" className="btn sm" onClick={addStop}><Icon name="plus" size={11} />Add stop</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {stops.map((s, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px 32px", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  value={s.name} onChange={(e) => setStop(i, "name", e.target.value)}
                  placeholder={`Stop ${i + 1} name`}
                />
                <input
                  className="input"
                  value={s.t} onChange={(e) => setStop(i, "t", e.target.value)}
                  placeholder="07:15"
                />
                <input
                  className="input"
                  value={s.cap} onChange={(e) => setStop(i, "cap", e.target.value.replace(/\D/g, ""))}
                  placeholder="cap"
                  inputMode="numeric"
                />
                <button type="button" className="icon-btn" onClick={() => rmStop(i)} disabled={stops.length === 1} title="Remove stop">
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            {busy ? "Adding…" : <><Icon name="check" size={13} />Add route</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Edit modal — pre-filled with the current route. Code is shown read-only
// (changing the PK is messy; ask the user to delete & recreate if needed).
// Sends a PATCH that only touches fields the user actually changed in the
// form. Boarded/absent counters on existing stops are preserved server-side
// when stop names match; new stops start at 0/0/pending.
function EditRouteModal({ route, onClose, onSubmit, staff = [] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: route.name || "",
    driver: route.driver || "",
    bus: route.bus || "",
    eta: route.eta || "",
  });
  const [stops, setStops] = useState(
    (route.stops || []).map((s) => ({ name: s.name || "", t: s.t || "", cap: s.cap ?? 0 }))
  );

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setStop = (i, k, v) => setStops((arr) => arr.map((s, j) => j === i ? { ...s, [k]: v } : s));
  const addStop = () => setStops((arr) => [...arr, { name: "", t: "", cap: "" }]);
  const rmStop  = (i) => setStops((arr) => arr.length > 1 ? arr.filter((_, j) => j !== i) : arr);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const cleanStops = stops
        .filter((s) => String(s.name).trim())
        .map((s) => ({ name: s.name.trim(), t: s.t || "—", cap: Number(s.cap) || 0 }));
      if (cleanStops.length === 0) throw new Error("Add at least one stop with a name");
      await onSubmit({
        code: route.code,
        name: form.name.trim() || route.code,
        driver: form.driver.trim() || "—",
        bus: form.bus.trim() || "—",
        eta: form.eta || "07:00 – 08:00",
        stops: cleanStops,
      });
    } catch (ex) {
      setErr(ex.message || String(ex));
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`Edit route ${route.code}`} sub="Boarded / absent counters on existing stops are preserved" onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10 }}>
          <Field label="Code">
            <input className="input" value={route.code} disabled style={{ opacity: 0.7, cursor: "not-allowed" }} />
          </Field>
          <Field label="Route name">
            <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Field label="Driver / attendant" hint={staff.length ? "Pick from staff or type a name" : ""}>
            <StaffPickerInput value={form.driver} onChange={(v) => set("driver", v)} staff={staff} />
          </Field>
          <Field label="Bus number">
            <input className="input" value={form.bus} onChange={(e) => set("bus", e.target.value)} />
          </Field>
          <Field label="ETA window">
            <input className="input" value={form.eta} onChange={(e) => set("eta", e.target.value)} />
          </Field>
        </div>

        <div style={{ marginTop: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Stops (in pickup order)</span>
            <button type="button" className="btn sm" onClick={addStop}><Icon name="plus" size={11} />Add stop</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {stops.map((s, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px 32px", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  value={s.name} onChange={(e) => setStop(i, "name", e.target.value)}
                  placeholder={`Stop ${i + 1} name`}
                />
                <input
                  className="input"
                  value={s.t} onChange={(e) => setStop(i, "t", e.target.value)}
                  placeholder="07:15"
                />
                <input
                  className="input"
                  value={s.cap} onChange={(e) => setStop(i, "cap", String(e.target.value).replace(/\D/g, ""))}
                  placeholder="cap"
                  inputMode="numeric"
                />
                <button type="button" className="icon-btn" onClick={() => rmStop(i)} disabled={stops.length === 1} title="Remove stop">
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            {busy ? "Saving…" : <><Icon name="check" size={13} />Save changes</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Dedicated picker to assign a TEACHER to ride a bus (separate from the driver).
// The teacher acts as the bus monitor / staff-on-duty. List is filtered to staff
// whose role is teacher/faculty. Picking a name PATCHes route.attendant.
function AssignStaffModal({ route, staff = [], onClose, onAssign }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const candidates = useMemo(() => {
    const eligible = (staff || []).filter((s) => {
      const role = String(s.role || "").toLowerCase();
      return /teacher|faculty/.test(role);
    });
    if (!q.trim()) return eligible;
    const ql = q.trim().toLowerCase();
    return eligible.filter((s) =>
      [s.name, s.role, s.dept, s.id].filter(Boolean).some((v) => String(v).toLowerCase().includes(ql))
    );
  }, [staff, q]);

  async function pick(name) {
    setBusy(true);
    setErr("");
    try {
      await onAssign(name);
    } catch (e) {
      setErr(e.message || "Failed to assign");
      setBusy(false);
    }
  }

  const initials = (n) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const current = route.attendant && route.attendant !== "—" ? route.attendant : null;

  return (
    <ModalShell
      title={`Assign teacher to ${route.code}`}
      sub={`${route.name} · driver: ${route.driver || "—"}`}
      onClose={onClose}
      width={520}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{
          background: "var(--bg-2)", border: "1px solid var(--rule)", borderRadius: 8,
          padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}>
          <div style={{ fontSize: 12 }}>
            <div style={{ color: "var(--ink-4)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5 }}>Bus teacher</div>
            <div style={{ marginTop: 2, fontWeight: 500, color: current ? "var(--ink)" : "var(--ink-4)" }}>
              {current || "No teacher assigned yet"}
            </div>
          </div>
          {current && (
            <button type="button" className="btn sm" onClick={() => pick("")} disabled={busy} title="Clear assignment">
              <Icon name="x" size={11} />Unassign
            </button>
          )}
        </div>

        <input
          className="input"
          autoFocus
          placeholder="Search teachers by name or department…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <div style={{
          maxHeight: 320, overflowY: "auto", border: "1px solid var(--rule)",
          borderRadius: 8, background: "var(--card)",
        }}>
          {candidates.length === 0 && (
            <div className="empty" style={{ padding: 24 }}>
              {(staff || []).filter((s) => /teacher|faculty/i.test(s.role || "")).length === 0
                ? "No teachers in the system yet. Go to Staff → + Add staff and add a Teacher first."
                : "No matching teacher. Try a different search."}
            </div>
          )}
          {candidates.map((s) => {
            const isCurrent = current === s.name;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => !isCurrent && pick(s.name)}
                disabled={busy || isCurrent}
                style={{
                  width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px", background: isCurrent ? "var(--accent-soft)" : "transparent",
                  border: 0, borderBottom: "1px solid var(--rule)", cursor: isCurrent ? "default" : "pointer",
                }}
                onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "var(--bg-2)"; }}
                onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", background: "var(--card-2)",
                  display: "grid", placeItems: "center", fontSize: 11, fontWeight: 600, color: "var(--ink-2)", flexShrink: 0,
                }}>
                  {initials(s.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
                    {s.role}{s.dept ? ` · ${s.dept}` : ""}{s.id ? ` · ${s.id}` : ""}
                  </div>
                </div>
                {isCurrent ? (
                  <span className="chip ok" style={{ fontSize: 10 }}>Assigned</span>
                ) : (
                  <Icon name="check" size={13} />
                )}
              </button>
            );
          })}
        </div>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalShell>
  );
}

// Picker for assigning an existing student to a stop. Direction-aware —
// only flags conflicts inside the same direction. A student on R1 (morning)
// being added to R6 (evening) is a brand-new assignment, NOT a "Switch":
// they ride R1 in the morning AND R6 in the evening; both fields can hold
// different route codes independently.
//
// States surfaced:
//   - no transport at all in this direction        → "New"
//   - already on this route + this stop           → hidden (filtered out)
//   - on this route but a different stop          → "Move"
//   - on a different route in this direction      → "Switch"  (real collision)
//   - assigned in the OTHER direction only        → "Add"     (no collision)
function AddStudentToStopModal({ route, stop, students, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState(null);

  const initials = (n) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const dir = route.direction === "evening" ? "evening" : "morning";
  const dirLabel = dir === "evening" ? "evening" : "morning";
  // The student field that THIS direction would write to.
  const sameDirRoute = (s) => dir === "evening" ? s.transportEvening : s.transport;
  const sameDirStop  = (s) => dir === "evening" ? s.pickupStopEvening : s.pickupStop;
  const otherDirRoute = (s) => dir === "evening" ? s.transport : s.transportEvening;

  // Hide students who are already on this exact route + stop in THIS direction.
  // Everyone else is a candidate — including students on a different bus in
  // the OTHER direction (no collision; they're just travelling both ways).
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return students
      .filter((s) => !(sameDirRoute(s) === route.code && sameDirStop(s) === stop.name))
      .filter((s) => !needle || `${s.name} ${s.cls} ${s.id}`.toLowerCase().includes(needle))
      .slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, route.code, stop.name, q, dir]);

  return (
    <ModalShell
      title={`Add student to ${stop.name}`}
      sub={`${route.code} · ${dirLabel} · pickup ${stop.t}`}
      onClose={onClose}
      width={520}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          className="input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, class, or ID…"
        />
        {candidates.length === 0 ? (
          <div className="empty">No students match. Either every student is already on this stop, or there's no roster yet.</div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {candidates.map((s) => {
              const here = sameDirRoute(s);
              const otherDir = otherDirRoute(s);
              const onSameDirOtherRoute = here && here !== "—" && here !== route.code;
              const onThisRouteOtherStop = here === route.code && sameDirStop(s) && sameDirStop(s) !== stop.name;
              const noTransportThisDir   = !here || here === "—";
              const onlyOtherDirSet      = noTransportThisDir && otherDir && otherDir !== "—";
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={busyId === s.id}
                  onClick={async () => {
                    setBusyId(s.id);
                    try { await onPick(s.id); } finally { setBusyId(null); }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px", textAlign: "left",
                    background: "var(--card-2)", border: "1px solid var(--rule-2)",
                    borderRadius: 8, cursor: busyId === s.id ? "wait" : "pointer",
                    opacity: busyId === s.id ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => busyId !== s.id && (e.currentTarget.style.borderColor = "var(--accent)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--rule-2)")}
                >
                  <span style={{
                    width: 26, height: 26, borderRadius: "50%",
                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                    color: "#fff", display: "grid", placeItems: "center",
                    fontSize: 10, fontWeight: 600, flexShrink: 0,
                  }}>{initials(s.name)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{s.name}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                      {formatClassLabel(s.cls)} · {s.id}
                      {noTransportThisDir && !onlyOtherDirSet && ` · no ${dirLabel} bus yet`}
                      {onlyOtherDirSet && ` · ${dir === "evening" ? "morning" : "evening"} bus: ${otherDir}`}
                      {onSameDirOtherRoute && ` · ${dirLabel}: currently on ${here}`}
                      {onThisRouteOtherStop && ` · currently at ${sameDirStop(s)}`}
                    </div>
                  </div>
                  {onSameDirOtherRoute && <span className="chip warn" style={{ fontSize: 10 }}>Switch</span>}
                  {noTransportThisDir && !onlyOtherDirSet && <span className="chip ok" style={{ fontSize: 10 }}>New</span>}
                  {onlyOtherDirSet && <span className="chip ok" style={{ fontSize: 10 }}>Add</span>}
                  {onThisRouteOtherStop && <span className="chip" style={{ fontSize: 10 }}>Move</span>}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
          Picking a student here sets their <b>{dirLabel}</b> bus to <b>{route.code}</b> and pickup to <b>{stop.name}</b>.
          {dir === "morning"
            ? " Their evening route (if any) is not affected."
            : " Their morning route (if any) is not affected."}
        </div>
      </div>
    </ModalShell>
  );
}

// Route-level roster manager. One screen to see/add/remove students for
// every stop on a route, so the live boarding view stays focused on the
// run itself. "+ Add student" delegates to the existing per-stop picker
// (AddStudentToStopModal) so we don't duplicate the search/assignment logic.
function RouteRosterModal({ route, studentsByStop, onClose, onAdd, onRemove }) {
  const initials = (n) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const stops = route.stops || [];
  const totalAssigned = stops.reduce((a, s) => a + ((studentsByStop[s.name] || []).length), 0);

  return (
    <ModalShell
      title={`Assign students · ${route.code}`}
      sub={`${route.name} · ${stops.length} stop${stops.length === 1 ? "" : "s"} · ${totalAssigned} student${totalAssigned === 1 ? "" : "s"} on roster`}
      onClose={onClose}
      width={600}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "70vh", overflowY: "auto" }}>
        {stops.length === 0 && (
          <div className="empty">This route has no stops yet — add some via Edit route first.</div>
        )}
        {stops.map((s) => {
          const assigned = studentsByStop[s.name] || [];
          const cap = Number(s.cap) || 0;
          return (
            <div key={s.name} style={{
              background: "var(--card-2)", border: "1px solid var(--rule)",
              borderRadius: 10, padding: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: "var(--bg-2)", border: "1px solid var(--rule)",
                  display: "grid", placeItems: "center",
                  fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-3)",
                }}>{(stops.indexOf(s) + 1)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>
                    {s.t} · {assigned.length}{cap > 0 ? `/${cap}` : ""} assigned
                  </div>
                </div>
                <button
                  className="btn sm"
                  style={{ height: 26, padding: "0 10px", fontSize: 11 }}
                  onClick={() => onAdd(s)}
                  disabled={cap > 0 && assigned.length >= cap}
                  title={cap > 0 && assigned.length >= cap ? "Stop is at capacity" : "Add a student to this stop"}
                >
                  <Icon name="plus" size={11} />Add student
                </button>
              </div>
              {assigned.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--ink-4)", fontStyle: "italic" }}>
                  No students assigned yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {assigned.map((stu) => (
                    <div key={stu.id} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 8px",
                      background: "var(--bg-2)", border: "1px solid var(--rule-2)",
                      borderRadius: 7,
                    }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: "50%",
                        background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                        color: "#fff", display: "grid", placeItems: "center",
                        fontSize: 9.5, fontWeight: 600, flexShrink: 0,
                      }}>{initials(stu.name)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{stu.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{formatClassLabel(stu.cls)} · {stu.id}</div>
                      </div>
                      <button
                        className="icon-btn"
                        style={{ width: 24, height: 24 }}
                        onClick={() => onRemove(stu)}
                        title={`Remove ${stu.name} from ${s.name}`}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
          Removing a student here unlinks them from transport entirely. Their attendance history stays preserved.
        </div>
      </div>
    </ModalShell>
  );
}

// Off-stop boarding picker. Lists students assigned to THIS route but at a
// DIFFERENT stop (so the conductor can mark them boarded at the current
// stop). Picking does NOT change `student.pickupStop` — only writes a
// transport_attendance row stamped with the current stop's name.
function OffStopBoardingModal({ route, stop, students, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState(null);
  const initials = (n) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  // Candidates: students assigned to this route, but NOT to this stop.
  // (Students already on this stop's roster are markable through the
  // regular "Present" button — they don't need this off-stop flow.)
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return students
      .filter((s) => s.transport === route.code && s.pickupStop !== stop.name)
      .filter((s) => !needle || `${s.name} ${s.cls} ${s.id} ${s.pickupStop || ""}`.toLowerCase().includes(needle))
      .slice(0, 60);
  }, [students, route.code, stop.name, q]);

  return (
    <ModalShell
      title={`Off-stop boarding at ${stop.name}`}
      sub={`${route.code} · pickup ${stop.t} · doesn't change the student's assigned stop`}
      onClose={onClose}
      width={520}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          className="input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, class, ID, or assigned stop…"
        />
        {candidates.length === 0 ? (
          <div className="empty">
            No off-stop candidates. Either every student on {route.code} is already assigned to {stop.name},
            or this route has no other students.
          </div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {candidates.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busyId === s.id}
                onClick={async () => {
                  setBusyId(s.id);
                  try { await onPick(s); } finally { setBusyId(null); }
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", textAlign: "left",
                  background: "var(--card-2)", border: "1px solid var(--rule-2)",
                  borderRadius: 8, cursor: busyId === s.id ? "wait" : "pointer",
                  opacity: busyId === s.id ? 0.6 : 1,
                }}
                onMouseEnter={(e) => busyId !== s.id && (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--rule-2)")}
              >
                <span style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                  color: "#fff", display: "grid", placeItems: "center",
                  fontSize: 10, fontWeight: 600, flexShrink: 0,
                }}>{initials(s.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{s.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                    {formatClassLabel(s.cls)} · {s.id} · assigned to <b>{s.pickupStop || "—"}</b>
                  </div>
                </div>
                <span className="chip warn" style={{ fontSize: 10 }}>Off-stop</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
          Records a boarding at <b>{stop.name}</b> for today's <b>{stop.t}</b> trip. The student's
          assigned pickup stop stays unchanged — use <i>Add student to this stop</i> if you want to
          permanently move them.
        </div>
      </div>
    </ModalShell>
  );
}

function AbsenteeModal({ absentees, onClose, onDownload }) {
  return (
    <ModalShell title="Absentees · today" sub={`${absentees.length} student${absentees.length === 1 ? "" : "s"} absent · auto-SMS sent on detection`} onClose={onClose} width={680}>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {absentees.length === 0 ? (
          <div className="empty">No absentees marked yet today. As drivers tap “Mark absent” on the stops page, they appear here.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Student</th><th>Class</th><th>Route · Stop</th><th>Trip</th></tr></thead>
            <tbody>
              {absentees.map((a, i) => (
                <tr key={`${a.studentId}-${a.direction}-${i}`}>
                  <td>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{a.studentName}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{a.studentId}</div>
                  </td>
                  <td><span className="chip">{formatClassLabel(a.cls)}</span></td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    <span className="chip" style={{ marginRight: 6 }}>{a.route}</span>
                    {a.stop}
                  </td>
                  <td>
                    <span className="chip" style={{ fontSize: 10.5 }}>
                      <Icon name={a.direction === "evening" ? "moon" : "sun"} size={10} />
                      {a.direction}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn accent" onClick={onDownload} disabled={absentees.length === 0}>
            <Icon name="download" size={13} />Download CSV
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function MapModal({ routes, onClose }) {
  // Stylised "map" — colour-coded route lanes with stops as pins.
  // No real geo here; the sidebar list of routes feeds a vertical lane each
  // so the principal can see all routes' progress at a glance.
  const palette = ["#c8510a", "#4a7a54", "#2f6048", "#b07c28", "#7a5cb0", "#1a8e8e"];
  return (
    <ModalShell title="Map view" sub="Live route lanes — each line is one bus" onClose={onClose} width={760}>
      <div className="card-body">
        {routes.length === 0 ? (
          <div className="empty">No routes to display. Add one first.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {routes.map((r, ri) => {
              const stops = r.stops || [];
              const total = stops.length;
              const doneIdx = stops.findIndex((s) => s.status === "current");
              const progress = doneIdx === -1 ? 100 : (doneIdx / Math.max(1, total - 1)) * 100;
              const colour = palette[ri % palette.length];
              return (
                <div key={r.code}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ width: 10, height: 10, background: colour, borderRadius: "50%" }} />
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{r.code}</span>
                    <span style={{ color: "var(--ink-3)", fontSize: 12 }}>{r.name}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>
                      {r.bus} · {r.driver} · {r.eta}
                    </span>
                  </div>
                  <div style={{
                    position: "relative", height: 50,
                    background: "linear-gradient(to right, var(--bg-2) 0%, var(--bg-2) 100%)",
                    borderRadius: 8, padding: "0 8px",
                  }}>
                    {/* base lane */}
                    <div style={{
                      position: "absolute", left: 18, right: 18, top: "50%",
                      height: 3, background: "var(--rule, #e5dfd1)", borderRadius: 2,
                      transform: "translateY(-50%)",
                    }} />
                    {/* progress lane */}
                    <div style={{
                      position: "absolute", left: 18, top: "50%",
                      width: `calc((100% - 36px) * ${progress / 100})`,
                      height: 3, background: colour, borderRadius: 2,
                      transform: "translateY(-50%)",
                    }} />
                    {/* stops */}
                    {stops.map((s, i) => {
                      const x = total === 1 ? 50 : (i / (total - 1)) * 100;
                      const done = s.status === "done";
                      const cur = s.status === "current";
                      return (
                        <div
                          key={i}
                          title={`${s.name} · ${s.t} · ${s.boarded || 0}/${s.cap || 0} boarded${(s.absent || 0) > 0 ? ` · ${s.absent} absent` : ""}`}
                          style={{
                            position: "absolute",
                            left: `calc(${x}% * ((100% - 36px) / 100%) + 18px)`,
                            top: "50%",
                            width: cur ? 16 : 12, height: cur ? 16 : 12,
                            borderRadius: "50%",
                            background: done ? colour : cur ? "#fff" : "var(--card)",
                            border: `2px solid ${cur ? colour : "var(--rule, #e5dfd1)"}`,
                            transform: "translate(-50%, -50%)",
                            boxShadow: cur ? `0 0 0 4px ${colour}33` : undefined,
                            cursor: "help",
                          }}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10.5, color: "var(--ink-4)" }}>
                    <span>{stops[0]?.name || "—"}</span>
                    <span>{stops[stops.length - 1]?.name || "—"}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: 8, paddingTop: 10, borderTop: "1px dashed var(--rule, #e5dfd1)", fontSize: 10.5, color: "var(--ink-3)", display: "flex", gap: 14, flexWrap: "wrap" }}>
              <span><b style={{ color: "var(--ink)" }}>Filled</b> = stop visited · <b style={{ color: "var(--ink)" }}>Outlined ring</b> = current stop · <b style={{ color: "var(--ink)" }}>Empty</b> = upcoming. Hover any pin for details.</span>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// ---- Maintenance helpers + modal ----
const MAINTENANCE_TYPES = ["service", "fuel", "insurance", "FC", "PUC", "repair", "tyre", "battery"];

// Returns { tone, label } describing the soonest renewal for the given logs,
// or null if nothing's due in the next 30 days.
function computeMaintAlert(busLogs) {
  if (!busLogs || busLogs.length === 0) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = busLogs
    .filter((l) => l.nextDueDate)
    .map((l) => ({ ...l, due: new Date(l.nextDueDate) }))
    .filter((l) => !isNaN(l.due));
  if (upcoming.length === 0) return null;
  upcoming.sort((a, b) => a.due - b.due);
  const soonest = upcoming[0];
  const days = Math.ceil((soonest.due - today) / 86400000);
  if (days < 0)  return { tone: "bad",  label: `${labelFor(soonest.type)} overdue by ${-days}d` };
  if (days === 0) return { tone: "bad", label: `${labelFor(soonest.type)} due today` };
  if (days <= 30) return { tone: "warn", label: `${labelFor(soonest.type)} due in ${days}d` };
  return null;
}
function labelFor(t) {
  return ({ service: "Service", fuel: "Fuel", insurance: "Insurance", FC: "FC", PUC: "PUC", repair: "Repair", tyre: "Tyre", battery: "Battery" }[t] || t);
}

function MaintenanceModal({ route, canEdit, allLogs, onClose, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null); // log id being deleted
  const [err, setErr] = useState("");

  const logs = (allLogs || []).filter((l) => l.busNumber === route.bus);
  const totalCost = logs.reduce((a, l) => a + (l.cost || 0), 0);
  const upcoming = computeMaintAlert(logs);

  async function add(payload) {
    const r = await fetch("/api/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, busNumber: route.bus, routeCode: route.code }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setAdding(false);
    await onChanged?.();
  }

  async function remove(log) {
    if (!confirm(`Remove ${labelFor(log.type)} log from ${log.date}?`)) return;
    setBusy(log.id);
    try {
      const r = await fetch("/api/maintenance", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: log.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      await onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }

  return (
    <ModalShell
      title={`Maintenance · ${route.code}`}
      sub={`${route.bus || "no bus number"} · ${route.name}`}
      onClose={onClose}
      width={680}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Top-line summary */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <SummaryTile label="Logs on file" value={logs.length} />
          <SummaryTile label="Total spend" value={`₹${totalCost.toLocaleString("en-IN")}`} />
          <SummaryTile
            label="Next renewal"
            value={upcoming ? upcoming.label : "—"}
            tone={upcoming?.tone}
          />
        </div>

        {canEdit && !adding && (
          <button className="btn accent" onClick={() => setAdding(true)} style={{ alignSelf: "flex-start" }}>
            <Icon name="plus" size={13} />Log maintenance event
          </button>
        )}

        {adding && (
          <AddMaintenanceForm
            onCancel={() => setAdding(false)}
            onSubmit={add}
          />
        )}

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 10px", borderRadius: 7, fontSize: 11.5 }}>{err}</div>
        )}

        <div style={{ overflowX: "auto", border: "1px solid var(--rule)", borderRadius: 8 }}>
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr><th>Date</th><th>Type</th><th>Vendor</th><th className="num">Odometer</th><th className="num">Cost</th><th>Next due</th><th></th></tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={7} className="empty">No maintenance logged for this bus yet.</td></tr>
              )}
              {logs.map((l) => {
                const overdue = l.nextDueDate && new Date(l.nextDueDate) < new Date(new Date().toISOString().slice(0,10));
                return (
                  <tr key={l.id}>
                    <td style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{l.date}</td>
                    <td><span className="chip" style={{ fontSize: 10.5 }}>{labelFor(l.type)}</span></td>
                    <td style={{ fontSize: 12 }}>{l.vendor || "—"}</td>
                    <td className="num" style={{ fontSize: 11.5 }}>{l.odometer ? `${l.odometer.toLocaleString("en-IN")} km` : "—"}</td>
                    <td className="num">{l.cost ? `₹${l.cost.toLocaleString("en-IN")}` : "—"}</td>
                    <td style={{ fontSize: 11.5, color: overdue ? "var(--err, #b13c1c)" : "var(--ink-3)", whiteSpace: "nowrap" }}>
                      {l.nextDueDate || "—"}{overdue ? " · overdue" : ""}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {canEdit && (
                        <button className="icon-btn" onClick={() => remove(l)} disabled={busy === l.id} title="Remove">
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {logs.some((l) => l.notes) && (
          <details>
            <summary style={{ fontSize: 11.5, color: "var(--ink-3)", cursor: "pointer" }}>Show notes</summary>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {logs.filter((l) => l.notes).map((l) => (
                <div key={l.id} style={{ background: "var(--bg-2)", borderRadius: 7, padding: 8, fontSize: 11.5 }}>
                  <b style={{ color: "var(--ink)" }}>{labelFor(l.type)} · {l.date}</b><br />{l.notes}
                </div>
              ))}
            </div>
          </details>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalShell>
  );
}

function SummaryTile({ label, value, tone }) {
  const color = tone === "bad" ? "var(--err, #b13c1c)" : tone === "warn" ? "var(--warn)" : "var(--ink)";
  return (
    <div style={{ background: "var(--bg-2)", padding: "10px 12px", borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function AddMaintenanceForm({ onCancel, onSubmit }) {
  const today = new Date().toISOString().slice(0, 10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    type: "service", date: today, odometer: "", vendor: "", cost: "", notes: "", nextDueDate: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await onSubmit({
        type: form.type, date: form.date,
        odometer: form.odometer || null,
        vendor: form.vendor.trim() || null,
        cost: form.cost || 0,
        notes: form.notes.trim() || null,
        nextDueDate: form.nextDueDate || null,
      });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ background: "var(--bg-2)", border: "1px dashed var(--rule)", padding: 12, borderRadius: 8, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <Field label="Type *">
          <select className="select" value={form.type} onChange={(e) => set("type", e.target.value)}>
            {MAINTENANCE_TYPES.map((t) => <option key={t} value={t}>{labelFor(t)}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input className="input" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
        <Field label="Next due (renewal)">
          <input className="input" type="date" value={form.nextDueDate} onChange={(e) => set("nextDueDate", e.target.value)} />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <Field label="Odometer (km)">
          <input className="input" inputMode="numeric" value={form.odometer} onChange={(e) => set("odometer", e.target.value.replace(/\D/g, ""))} placeholder="48250" />
        </Field>
        <Field label="Vendor">
          <input className="input" value={form.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="e.g. Sunrise Motors" />
        </Field>
        <Field label="Cost (₹)">
          <input className="input" inputMode="numeric" value={form.cost} onChange={(e) => set("cost", e.target.value.replace(/\D/g, ""))} placeholder="3500" />
        </Field>
      </div>
      <Field label="Notes">
        <input className="input" value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Brake pads + oil change" />
      </Field>
      {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 10px", borderRadius: 7, fontSize: 11.5 }}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn accent" disabled={busy}><Icon name="check" size={13} />{busy ? "Saving…" : "Save log"}</button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------
// Transport attendance history
// Shows persisted per-student bus boarding rows. Filters: date range,
// route, student. Two layouts: a flat audit-style table (for staff) and a
// per-student summary card. Parents always see only their child (the data
// is already pre-scoped by AppShell).
// ----------------------------------------------------------------------------
function TransportHistoryView({ rows, students, routes, isParent, school, actor }) {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(sevenDaysAgo);
  const [to, setTo] = useState(today);
  const [routeCode, setRouteCode] = useState("All");
  const [studentId, setStudentId] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [offStopOnly, setOffStopOnly] = useState(false);

  // Restrict student dropdown to those who actually use transport.
  const transportStudents = useMemo(
    () => (students || []).filter((s) => s.transport && s.transport !== "—"),
    [students]
  );
  // studentId -> currently-assigned pickup stop. Used by the table to flag
  // attendance rows where the actual `stopName` differs from the student's
  // assignment ("off-stop" boarding).
  const assignedStopById = useMemo(() => {
    const out = {};
    for (const s of (students || [])) {
      if (s.transport && s.transport !== "—") out[s.id] = s.pickupStop || null;
    }
    return out;
  }, [students]);

  const filtered = useMemo(() => {
    return (rows || []).filter((r) => {
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      if (routeCode !== "All" && r.routeCode !== routeCode) return false;
      if (studentId !== "All" && r.studentId !== studentId) return false;
      if (statusFilter !== "All" && r.status !== statusFilter.toLowerCase()) return false;
      if (offStopOnly) {
        const assigned = assignedStopById[r.studentId];
        if (r.status !== "boarded" || !assigned || !r.stopName || assigned === r.stopName) return false;
      }
      return true;
    }).sort((a, b) => {
      // newest date first; within a date, morning before evening
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (a.direction || "morning") < (b.direction || "morning") ? -1 : 1;
    });
  }, [rows, from, to, routeCode, studentId, statusFilter, offStopOnly, assignedStopById]);

  // Per-student rollup for the summary cards: counts of boarded/absent/skipped
  // across the active filter window.
  const perStudent = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const key = r.studentId;
      if (!map.has(key)) {
        map.set(key, {
          studentId: r.studentId,
          name: r.studentName || (transportStudents.find((s) => s.id === r.studentId)?.name) || r.studentId,
          cls: r.cls || "",
          boarded: 0, absent: 0, skipped: 0, parent: 0, total: 0,
          last: r,
        });
      }
      const agg = map.get(key);
      agg[r.status] = (agg[r.status] || 0) + 1;
      agg.total += 1;
      if (r.date > (agg.last?.date || "")) agg.last = r;
    }
    // Add students with NO rows in window so staff can spot "never marked".
    if (!isParent) {
      for (const s of transportStudents) {
        if (studentId !== "All" && s.id !== studentId) continue;
        if (routeCode !== "All" && s.transport !== routeCode) continue;
        if (!map.has(s.id)) {
          map.set(s.id, {
            studentId: s.id, name: s.name, cls: s.cls,
            boarded: 0, absent: 0, skipped: 0, parent: 0, total: 0, last: null,
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered, transportStudents, isParent, studentId, routeCode]);

  const totals = filtered.reduce(
    (a, r) => {
      a[r.status] = (a[r.status] || 0) + 1;
      a.total += 1;
      return a;
    },
    { boarded: 0, absent: 0, skipped: 0, parent: 0, total: 0 }
  );

  const exportPdf = () => {
    downloadPdf({
      title: "Transport Attendance History",
      subtitle: `${filtered.length} record${filtered.length === 1 ? "" : "s"} from ${from} to ${to}`,
      school, actor,
      dateRange: `${from} → ${to}`,
      orientation: "landscape",
      summary: [
        { label: "Records",  value: filtered.length },
        { label: "Boarded",  value: totals.boarded || 0 },
        { label: "Absent",   value: totals.absent || 0 },
        { label: "By parent", value: totals.parent || 0 },
        { label: "Skipped",  value: totals.skipped || 0 },
      ],
      columns: [
        { key: "date",        label: "Date",         align: "right",  width: "90px" },
        { key: "direction",   label: "Trip",         align: "center", width: "70px" },
        { key: "route",       label: "Route",        align: "center", width: "70px" },
        { key: "stopName",    label: "Stop" },
        { key: "assigned",    label: "Assigned stop" },
        { key: "offStop",     label: "Off-stop",     align: "center", width: "70px" },
        { key: "studentName", label: "Student" },
        { key: "studentId",   label: "ID",           width: "100px" },
        { key: "cls",         label: "Class",        align: "center", width: "60px" },
        { key: "status",      label: "Status",       align: "center", width: "80px" },
        { key: "markedBy",    label: "Marked by" },
      ],
      rows: filtered.map((r) => {
        const assigned = assignedStopById[r.studentId] || "—";
        const offStop = r.status === "boarded" && assigned !== "—" && r.stopName && assigned !== r.stopName ? "Yes" : "—";
        return {
          date: r.date, direction: r.direction || "morning",
          route: r.routeCode || "—", stopName: r.stopName || "—",
          assigned, offStop,
          studentName: r.studentName || "—", studentId: r.studentId,
          cls: r.cls || "—",
          status: r.status === "parent" ? "By parent" : r.status,
          markedBy: r.markedBy || "—",
        };
      }),
      filename: `${(school?.name || "school").replace(/\s+/g, "-").toLowerCase()}-transport-attendance-${from}-to-${to}`,
    });
  };

  return (
    <div className="grid g-12">
      <div className="card col-12">
        <div className="card-head" style={{ flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="card-title">Transport attendance history</div>
            <div className="card-sub">
              {totals.total} record{totals.total === 1 ? "" : "s"} ·
              {" "}{totals.boarded} boarded · {totals.absent} absent
              {totals.parent ? ` · ${totals.parent} by parent` : ""}
              {totals.skipped ? ` · ${totals.skipped} skipped` : ""}
            </div>
          </div>
          <div className="card-actions" style={{ flexWrap: "wrap", gap: 8 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
              From
              <input type="date" className="input" value={from} max={to}
                onChange={(e) => setFrom(e.target.value)}
                style={{ height: 28, padding: "0 8px" }} />
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
              To
              <input type="date" className="input" value={to} min={from}
                onChange={(e) => setTo(e.target.value)}
                style={{ height: 28, padding: "0 8px" }} />
            </label>
            {!isParent && (
              <select className="select" value={routeCode}
                onChange={(e) => setRouteCode(e.target.value)}
                style={{ height: 28 }}>
                <option value="All">All routes</option>
                {routes.map((r) => <option key={r.code} value={r.code}>{r.code} · {r.name}</option>)}
              </select>
            )}
            {!isParent && (
              <select className="select" value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                style={{ height: 28 }}>
                <option value="All">All students</option>
                {transportStudents.map((s) => <option key={s.id} value={s.id}>{s.name} · {formatClassLabel(s.cls)}</option>)}
              </select>
            )}
            <div className="segmented">
              {["All", "Boarded", "Absent", "Parent", "Skipped"].map((s) => (
                <button key={s} className={statusFilter === s ? "active" : ""} onClick={() => setStatusFilter(s)}>
                  {s}
                </button>
              ))}
            </div>
            <button
              className={`btn sm ${offStopOnly ? "accent" : ""}`}
              onClick={() => setOffStopOnly((v) => !v)}
              title="Show only boardings where the student rode the bus at a stop other than their assigned one"
            >
              <Icon name="warning" size={12} />Off-stop only
            </button>
            <button className="btn sm" onClick={exportPdf} disabled={filtered.length === 0} title="Open a printable, branded PDF report">
              <Icon name="download" size={12} />Export PDF
            </button>
          </div>
        </div>

        {/* Per-student summary — quick read of who's been riding */}
        {perStudent.length > 0 && (
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule-2)" }}>
            <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
              Per student in this window
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
              {perStudent.map((p) => {
                const tone = p.total === 0 ? "ink-4"
                           : p.absent > p.boarded ? "bad"
                           : p.absent > 0 ? "warn"
                           : "ok";
                return (
                  <div key={p.studentId} style={{
                    background: "var(--card-2)", border: "1px solid var(--rule)",
                    borderRadius: 9, padding: 10, display: "flex", flexDirection: "column", gap: 4,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <AvatarChip initials={(p.name || "?").split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase()} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{p.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{formatClassLabel(p.cls)} · {p.studentId}</div>
                      </div>
                      <span className={`chip ${tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "bad" ? "bad" : ""}`} style={{ fontSize: 10 }}>
                        {p.total === 0 ? "no records" : `${p.boarded}/${p.total} boarded`}
                      </span>
                    </div>
                    {p.total > 0 && (
                      <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                        {p.absent > 0 && <>· {p.absent} absent </>}
                        {p.parent > 0 && <>· {p.parent} by parent </>}
                        {p.skipped > 0 && <>· {p.skipped} skipped </>}
                        {p.last && <>· last {p.last.date} {p.last.direction}</>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Trip</th>
                <th>Student</th>
                <th>Class</th>
                <th>Route · Stop</th>
                <th>Status</th>
                {!isParent && <th>Marked by</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={isParent ? 6 : 7} className="empty">No transport attendance records in this window.</td></tr>
              )}
              {filtered.map((r, i) => (
                <tr key={`${r.studentId}-${r.date}-${r.direction}-${i}`}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.date}</td>
                  <td>
                    <span className="chip" style={{ fontSize: 10.5 }}>
                      <Icon name={r.direction === "evening" ? "sunset" : "sunrise"} size={10} />
                      {r.direction || "morning"}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.studentName || r.studentId}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{r.studentId}</div>
                  </td>
                  <td><span className="chip">{r.cls || "—"}</span></td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {r.routeCode || "—"}{r.stopName ? ` · ${r.stopName}` : ""}
                    {(() => {
                      // Flag off-stop boardings: the student's currently
                      // assigned pickup is X but they were marked at Y.
                      // Only meaningful when both sides are known.
                      const assigned = assignedStopById[r.studentId];
                      if (r.status !== "boarded") return null;
                      if (!assigned || !r.stopName) return null;
                      if (assigned === r.stopName) return null;
                      return (
                        <span
                          className="chip warn"
                          title={`Assigned to ${assigned}`}
                          style={{ marginLeft: 6, fontSize: 10 }}
                        >
                          off-stop
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    <span className={`chip ${r.status === "boarded" ? "ok" : r.status === "absent" ? "bad" : "warn"}`}>
                      <span className="dot" />
                      {r.status === "parent" ? "By parent" : (r.status.charAt(0).toUpperCase() + r.status.slice(1))}
                    </span>
                  </td>
                  {!isParent && (
                    <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.markedBy || "—"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ===================================================================
// Master timetable — admin/principal manages the school's static
// schedule (R1-R6 from the master PDF). Edits propagate to the live
// `routes` row with the same code. "Apply" replaces the live route
// with a fresh row spawned from the template (preserves attendant).
// ===================================================================
function MasterTimetablePanel({ templates, routes, role, showToast, refresh }) {
  const [editing, setEditing] = useState(null);   // template object or "new"
  const [busyCode, setBusyCode] = useState(null);
  const [seeding, setSeeding] = useState(false);

  // Sort: morning first, then evening; within each, by tripNo then code.
  const sorted = useMemo(() => {
    return [...(templates || [])].sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "morning" ? -1 : 1;
      if ((a.tripNo || 1) !== (b.tripNo || 1)) return (a.tripNo || 1) - (b.tripNo || 1);
      return String(a.code).localeCompare(String(b.code));
    });
  }, [templates]);

  // Index live routes by code so we can show "Active" / "Idle" / "Running"
  // alongside each template card.
  const liveByCode = useMemo(() => {
    const m = new Map();
    for (const r of routes || []) m.set(r.code, r);
    return m;
  }, [routes]);

  async function handleApply(t) {
    const live = liveByCode.get(t.code);
    const runningWarning = live && live.status === "running";
    const ok = window.confirm(
      runningWarning
        ? `${t.code} is currently RUNNING — applying the template will reset today's run state. Continue?`
        : `Apply template ${t.code} to today's live route? Any existing route with this code will be replaced (teacher/driver assignments are preserved).`
    );
    if (!ok) return;
    setBusyCode(t.code);
    try {
      const r = await fetch("/api/transport/templates/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: t.code }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed to apply");
      showToast(`Applied ${t.code} · attendant: ${json.preserved?.attendant || "—"}`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusyCode(null); }
  }

  async function handleArchive(t) {
    if (!window.confirm(`Archive template ${t.code}? It will be hidden from the list but can be restored later. The live route is not affected.`)) return;
    setBusyCode(t.code);
    try {
      const r = await fetch("/api/transport/templates", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: t.code }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`Archived ${t.code}`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusyCode(null); }
  }

  async function handleSeed() {
    if (!window.confirm("Seed R1-R6 from the school's master PDF? This skips templates that already exist.")) return;
    setSeeding(true);
    try {
      const r = await fetch("/api/transport/templates/seed", { method: "POST" });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`Seeded · created ${json.created.length}, skipped ${json.skipped.length}`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setSeeding(false); }
  }

  async function handleSave(payload) {
    const isNew = !payload._origCode;
    const url = "/api/transport/templates";
    const method = isNew ? "POST" : "PATCH";
    const body = isNew ? payload : { ...payload, code: payload._origCode };
    delete body._origCode;
    const r = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
    setEditing(null);
    showToast(`${isNew ? "Created" : "Updated"} template ${json.template.code}`, "ok");
    await refresh?.();
  }

  const empty = sorted.length === 0;

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Master timetable</div>
            <div className="card-sub">
              The school's permanent route schedule. Edits here flow down to today's live route. Click <b>Apply to today</b> to spawn / reset the live route from this template.
            </div>
          </div>
          <div className="card-actions" style={{ display: "flex", gap: 6 }}>
            {role === "admin" && empty && (
              <button className="btn sm accent" onClick={handleSeed} disabled={seeding}>
                <Icon name="download" size={12} />{seeding ? "Seeding…" : "Seed from school PDF (R1–R6)"}
              </button>
            )}
            <button className="btn sm accent" onClick={() => setEditing("new")}>
              <Icon name="plus" size={12} />Add template
            </button>
          </div>
        </div>
      </div>

      {empty && (
        <div className="card empty" style={{ padding: 24, textAlign: "center" }}>
          No templates yet. {role === "admin" ? "Click \"Seed from school PDF\" to import R1-R6 from the master timetable, or \"Add template\" to create one by hand." : "Ask the admin to seed the master timetable."}
        </div>
      )}

      {!empty && (
        <div className="grid g-3" style={{ gap: 12 }}>
          {sorted.map((t) => {
            const live = liveByCode.get(t.code);
            const dirChip = t.direction === "morning"
              ? { label: "MORNING", bg: "var(--accent-soft, #fde6d6)", fg: "var(--accent-2, #b13c1c)" }
              : { label: "EVENING", bg: "var(--info-soft, #e6ebf5)",   fg: "var(--info, #1f3f8b)" };
            const liveChip = !live
              ? { label: "no live route", bg: "var(--bg-2)", fg: "var(--ink-4)" }
              : live.status === "running"
                ? { label: "RUNNING NOW",  bg: "var(--ok-soft, #e7f3e8)",  fg: "var(--ok, #1f7a3a)" }
                : live.status === "completed"
                  ? { label: "completed today", bg: "var(--bg-2)",       fg: "var(--ink-3)" }
                  : { label: "idle",            bg: "var(--bg-2)",       fg: "var(--ink-3)" };
            return (
              <div key={t.code} className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 600, color: "var(--ink)" }}>{t.code}</span>
                    <span style={{
                      padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 600,
                      background: dirChip.bg, color: dirChip.fg, letterSpacing: 0.5,
                    }}>{dirChip.label}{t.tripNo > 1 ? ` · TRIP ${t.tripNo}` : ""}</span>
                  </div>
                  <span style={{
                    padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 500,
                    background: liveChip.bg, color: liveChip.fg,
                  }}>{liveChip.label}</span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-2)" }}>{t.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  Bus: <b style={{ color: "var(--ink-2)" }}>{t.bus || "—"}</b>
                  {" · "}{t.stops.length} stop{t.stops.length === 1 ? "" : "s"}
                  {t.stops[0]?.t && t.stops[t.stops.length - 1]?.t ? (
                    <> · {formatTplTime(t.stops[0].t, t.direction)} → {formatTplTime(t.stops[t.stops.length - 1].t, t.direction)}</>
                  ) : null}
                </div>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--ink-3)", lineHeight: 1.6, maxHeight: 120, overflowY: "auto" }}>
                  {t.stops.map((s, i) => (
                    <li key={`${s.name}-${i}`}>
                      <span style={{ fontWeight: 500, color: "var(--ink-2)" }}>{s.name}</span>
                      {s.t ? <span style={{ color: "var(--ink-4)" }}> · {formatTplTime(s.t, t.direction)}</span> : null}
                    </li>
                  ))}
                </ol>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
                  <button className="btn sm" onClick={() => setEditing(t)} disabled={busyCode === t.code}>
                    <Icon name="pencil" size={11} />Edit
                  </button>
                  <button className="btn sm accent" onClick={() => handleApply(t)} disabled={busyCode === t.code}>
                    <Icon name="check" size={11} />{busyCode === t.code ? "Applying…" : "Apply to today"}
                  </button>
                  <button className="btn sm" onClick={() => handleArchive(t)} disabled={busyCode === t.code} title="Soft delete">
                    <Icon name="x" size={11} />Archive
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <TemplateEditModal
          template={editing === "new" ? null : editing}
          existingCodes={sorted.map((t) => t.code)}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </>
  );
}

// "03:30" with a direction-derived suffix. Morning routes are already
// 24-hour-readable as AM; evening routes are written PM-implied per
// school convention (03:30 means 15:30). Internal storage stays "03:30".
function formatTplTime(t, direction) {
  if (!t || t === "—") return "—";
  return direction === "evening" ? `${t} PM` : `${t} AM`;
}

function TemplateEditModal({ template, existingCodes, onClose, onSave }) {
  const isNew = !template;
  const [form, setForm] = useState({
    code: template?.code || "",
    name: template?.name || "",
    bus:  template?.bus || "SML",
    direction: template?.direction || "morning",
    tripNo: template?.tripNo || 1,
  });
  const [stops, setStops] = useState(
    template?.stops?.length
      ? template.stops.map((s) => ({ name: s.name, t: s.t }))
      : [{ name: "SCHOOL", t: "" }]
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setStop = (i, k, v) => setStops((arr) => arr.map((s, j) => j === i ? { ...s, [k]: v } : s));
  const addStop = () => setStops((arr) => [...arr, { name: "", t: "" }]);
  const rmStop  = (i) => setStops((arr) => arr.length > 1 ? arr.filter((_, j) => j !== i) : arr);
  const moveStop = (i, dir) => setStops((arr) => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = arr.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const code = String(form.code || "").trim().toUpperCase();
      if (!code) throw new Error("Template code is required");
      if (isNew && existingCodes.includes(code)) {
        throw new Error(`Template ${code} already exists`);
      }
      const cleanStops = stops
        .filter((s) => s.name.trim())
        .map((s) => ({ name: s.name.trim().toUpperCase(), t: s.t || "—" }));
      if (cleanStops.length === 0) throw new Error("Add at least one stop with a name");
      const payload = {
        code,
        name: form.name.trim() || code,
        bus: form.bus.trim() || "—",
        direction: form.direction,
        tripNo: Number(form.tripNo) || 1,
        stops: cleanStops,
      };
      if (!isNew) payload._origCode = template.code;
      await onSave(payload);
    } catch (ex) {
      setErr(ex.message || String(ex));
      setBusy(false);
    }
  }

  const windowLabel = form.direction === "morning" ? "7 – 10 AM" : "3 – 6 PM";

  return (
    <ModalShell
      title={isNew ? "Add template" : `Edit template · ${template.code}`}
      sub="Master timetable entry. Stop names and times are the school's permanent schedule."
      onClose={onClose}
      width={720}
    >
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 10 }}>
            <Field label="Code">
              <input className="input" value={form.code} disabled={!isNew}
                onChange={(e) => set("code", e.target.value.toUpperCase())}
                placeholder="R1" />
            </Field>
            <Field label="Name">
              <input className="input" value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="MORNING - SML" />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Field label="Direction" hint={`Window: ${windowLabel}`}>
              <select className="input" value={form.direction} onChange={(e) => set("direction", e.target.value)}>
                <option value="morning">Morning</option>
                <option value="evening">Evening</option>
              </select>
            </Field>
            <Field label="Bus">
              <input className="input" value={form.bus}
                onChange={(e) => set("bus", e.target.value)}
                placeholder="SML / FORCE" />
            </Field>
            <Field label="Trip no." hint="2 if this bus does a second trip in the same direction">
              <input className="input" type="number" min={1} max={5}
                value={form.tripNo} onChange={(e) => set("tripNo", e.target.value)} />
            </Field>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.5 }}>Stops</span>
              <button type="button" className="btn sm" onClick={addStop}><Icon name="plus" size={11} />Add stop</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto", padding: 2 }}>
              {stops.map((s, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "26px 1fr 90px 96px", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{i + 1}.</span>
                  <input className="input" value={s.name}
                    onChange={(e) => setStop(i, "name", e.target.value)}
                    placeholder="Stop name" />
                  <input className="input" value={s.t}
                    onChange={(e) => setStop(i, "t", e.target.value)}
                    placeholder="07:30" />
                  <div style={{ display: "flex", gap: 4 }}>
                    <button type="button" className="icon-btn" title="Move up" onClick={() => moveStop(i, -1)} disabled={i === 0}>
                      <Icon name="arrowUp" size={11} />
                    </button>
                    <button type="button" className="icon-btn" title="Move down" onClick={() => moveStop(i, 1)} disabled={i === stops.length - 1}>
                      <Icon name="arrowDown" size={11} />
                    </button>
                    <button type="button" className="icon-btn" title="Remove" onClick={() => rmStop(i)} disabled={stops.length === 1}>
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {err && <div className="lp-err" style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy}>{busy ? "Saving…" : isNew ? "Create template" : "Save changes"}</button>
          </div>
        </form>
      </ModalShell>
  );
}

