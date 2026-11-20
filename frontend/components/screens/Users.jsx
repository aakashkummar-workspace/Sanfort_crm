"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { AvatarChip, KPI } from "../ui";
import CredentialsModal from "../CredentialsModal";
import { formatClassLabel } from "@/lib/format";

// Short blurbs shown in the Roles side-panel (admin view only). Listed
// roughly in seniority order so the sidebar reads top-down.
const ROLE_DESC = {
  "Super Admin":        "Full trust-wide access incl. finance, users, audit.",
  "Principal":          "Full access to their school · cannot edit trust settings.",
  "Academic Director":  "Academic modules only · no finance writes.",
  "Accountant":         "Finance modules · issue receipts · read-only students.",
  "Teacher":            "Own classes + students · homework · messaging.",
  "Transport lead":     "Routes, buses, drivers, stops, live boarding.",
  "Parent":             "Their child(ren) only · fees, academics, messages.",
  "Intern":             "Limited access under a mentor.",
};

// Pretty initials for the avatar pill — falls back to "?" if name is empty.
function initialsOf(name) {
  if (!name) return "?";
  return String(name).trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

export default function ScreenUsers({ E, role, session, refresh }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const isAdmin = role === "admin";
  const [showAddUser, setShowAddUser] = useState(false);
  const [createdUser, setCreatedUser] = useState(null); // { name, email, password, role } — credential receipt
  const [toast, setToast] = useState(null);
  const flashOk = (msg) => { setToast({ msg, tone: "ok" }); setTimeout(() => setToast(null), 3000); };
  const flashErr = (msg) => { setToast({ msg, tone: "err" }); setTimeout(() => setToast(null), 4500); };

  // Backfill parent logins: wipe all parent user accounts, then re-create
  // one fresh login per current student so emails follow the canonical
  // parent.{name}@sanfort.com scheme. Used to clean up after imports
  // where stale parent rows were colliding with new student IDs.
  const [backfillBusy, setBackfillBusy]   = useState(false);
  const [backfillLogins, setBackfillLogins] = useState(null);
  const runBackfill = async () => {
    if (backfillBusy) return;
    if (!confirm(
      "This will DELETE every existing parent login and create fresh ones for all current students.\n\n" +
      "Each parent will get a new email + password. Old passwords stop working immediately.\n\n" +
      "Continue?"
    )) return;
    setBackfillBusy(true);
    try {
      const r = await fetch("/api/admin/backfill-parent-logins", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Backfill failed");
      flashOk(`Wiped ${j.wiped} old parent logins · created ${j.created} new ones`);
      if (j.logins?.length) setBackfillLogins(j.logins);
      await reloadAuthUsers();
      await refresh?.();
    } catch (e) {
      flashErr(e.message || "Backfill failed");
    } finally {
      setBackfillBusy(false);
    }
  };

  // Custom roles defined on the Custom Roles screen — surfaced here so we
  // can offer them as assignable roles when creating a new user.
  const customRoles = E.CUSTOM_ROLES || [];
  // What the signed-in user is allowed to see:
  //   admin / principal / academic_director → everyone (Staff · Students · Parents)
  //   teacher                                → Students only (their classes)
  //   anyone else                            → nothing (sidebar already gates)
  const isManager = role === "admin" || role === "principal" || role === "academic_director";
  const isTeacher = role === "teacher";

  const allStaff    = E.STAFF || [];
  const allStudents = E.ADDED_STUDENTS || [];

  // Teachers only see students in classes they're linked to. Empty set = no
  // students until office assigns classes (we still render an empty state).
  const teacherClassSet = useMemo(() => {
    if (!isTeacher) return null;
    const arr = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
      ? session.linkedClasses
      : (session?.linkedId ? [session.linkedId] : []);
    return new Set(arr);
  }, [isTeacher, session]);

  const visibleStudents = useMemo(() => {
    if (!teacherClassSet) return allStudents;
    if (teacherClassSet.size === 0) return [];
    return allStudents.filter((s) => teacherClassSet.has(s.cls));
  }, [allStudents, teacherClassSet]);

  // Live auth-user roster — admins always load it so the Parents tab
  // can show the auto-provisioned login email (joined by linkedId).
  // Other roles still see the parent list, just without the email column
  // populated (they don't need credentials anyway).
  const [authUsers, setAuthUsers] = useState([]);
  const [authBusy, setAuthBusy]   = useState(false);
  const reloadAuthUsers = async () => {
    if (!isAdmin) return;
    setAuthBusy(true);
    try {
      const r = await fetch("/api/users", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setAuthUsers(Array.isArray(j.users) ? j.users : []);
    } catch {}
    setAuthBusy(false);
  };
  useEffect(() => { reloadAuthUsers(); /* eslint-disable-next-line */ }, [isAdmin]);

  // Parents are derived 1:1 from students (auto-provisioned at admission).
  // The login email lives in the users table — find it by matching the
  // parent role + linkedId == student id. Falls back to "—" when the
  // login hasn't been provisioned yet (e.g. legacy students admitted
  // before the auto-provisioning was wired up).
  //
  // The PASSWORD is derived from the student name using the same rule
  // as backend/lib/db.js → deriveParentPassword: take the first word of
  // the name, capitalise first letter + lowercase rest, append "@123".
  // Shown alongside the email so admins can hand parents their initial
  // credentials. Only admins see this column (authUsers gated above).
  const derivePassword = (name) => {
    const first = String(name || "").trim().split(/\s+/)[0] || "Parent";
    const letters = first.replace(/[^a-zA-Z]/g, "") || "Parent";
    return `${letters.charAt(0).toUpperCase()}${letters.slice(1).toLowerCase()}@123`;
  };
  const parents = useMemo(() => {
    const parentLogins = new Map();
    for (const u of authUsers) {
      if (u.role === "parent" && u.linkedId) parentLogins.set(u.linkedId, u);
    }
    return allStudents.map((s) => {
      const login = parentLogins.get(s.id);
      return {
        id: `${s.id}-parent`,
        childId: s.id,
        childName: s.name,
        childCls: s.cls,
        // Phone column on the student record is the parent's number.
        phone: s.parent || "—",
        // Default password derived from the student name. Only meaningful
        // if a login was actually provisioned (login present below).
        password: login ? derivePassword(s.name) : "—",
        // The actual login email from the auth users table. Empty for
        // non-admin viewers because `authUsers` is only fetched for admin.
        email: login?.email || "—",
        name: login?.name || `Parent of ${s.name}`,
      };
    });
  }, [allStudents, authUsers]);

  // Tabs the current role is allowed to flip between. Logins tab is admin-only.
  const TABS = isManager
    ? [
        { k: "staff",    label: "Staff",    count: allStaff.length },
        { k: "students", label: "Students", count: allStudents.length },
        { k: "parents",  label: "Parents",  count: parents.length },
        ...(isAdmin ? [{ k: "logins", label: "Logins", count: authUsers.length }] : []),
      ]
    : [
        { k: "students", label: "Students", count: visibleStudents.length },
      ];
  const [tab, setTab] = useState(TABS[0].k);
  const [q, setQ]     = useState("");

  // Filter the current tab's rows by the search box. Each tab matches on a
  // different set of fields so e.g. a class string matches students but not
  // staff (where it's not relevant).
  const filteredStaff = useMemo(() => {
    const n = q.trim().toLowerCase(); if (!n) return allStaff;
    return allStaff.filter((s) => `${s.name} ${s.email || ""} ${s.role || ""} ${s.dept || ""} ${s.id || ""}`.toLowerCase().includes(n));
  }, [allStaff, q]);
  const filteredStudents = useMemo(() => {
    const list = isTeacher ? visibleStudents : allStudents;
    const n = q.trim().toLowerCase(); if (!n) return list;
    return list.filter((s) => `${s.name} ${s.id || ""} ${s.cls || ""} ${s.parent || ""}`.toLowerCase().includes(n));
  }, [allStudents, visibleStudents, isTeacher, q]);
  const filteredParents = useMemo(() => {
    const n = q.trim().toLowerCase(); if (!n) return parents;
    return parents.filter((p) => `${p.name} ${p.childName} ${p.childCls} ${p.phone} ${p.email}`.toLowerCase().includes(n));
  }, [parents, q]);
  // "logins" tab sub-filter — admin can slice the login list by role bucket
  // so they don't have to scroll past parents to find a teacher account etc.
  // Buckets:  all · teacher · parent · admin · other  (other = accountants
  // and any custom-role users).
  const [loginRoleFilter, setLoginRoleFilter] = useState("all");
  const ADMIN_ROLES = useMemo(() => new Set(["admin", "principal", "academic_director"]), []);
  const PRIMARY_ROLES = useMemo(() => new Set(["admin", "principal", "academic_director", "teacher", "parent"]), []);
  const loginCounts = useMemo(() => {
    const c = { all: authUsers.length, teacher: 0, parent: 0, admin: 0, other: 0 };
    for (const u of authUsers) {
      const r = String(u.role || "").toLowerCase();
      if (r === "teacher") c.teacher++;
      else if (r === "parent") c.parent++;
      else if (ADMIN_ROLES.has(r)) c.admin++;
      else c.other++;
    }
    return c;
  }, [authUsers, ADMIN_ROLES]);
  const filteredAuthUsers = useMemo(() => {
    const n = q.trim().toLowerCase();
    let pool = authUsers;
    if (loginRoleFilter !== "all") {
      pool = authUsers.filter((u) => {
        const r = String(u.role || "").toLowerCase();
        if (loginRoleFilter === "admin") return ADMIN_ROLES.has(r);
        if (loginRoleFilter === "other") return !PRIMARY_ROLES.has(r);
        return r === loginRoleFilter;
      });
    }
    if (!n) return pool;
    return pool.filter((u) => `${u.name || ""} ${u.email || ""} ${u.role || ""} ${u.id || ""}`.toLowerCase().includes(n));
  }, [authUsers, q, loginRoleFilter, ADMIN_ROLES, PRIMARY_ROLES]);

  // Tracks which login row is currently being reset, so we can disable just
  // that button (rather than the whole list) while the API call is in flight.
  const [resetBusyId, setResetBusyId] = useState(null);

  async function resetPassword(u) {
    if (!isAdmin || resetBusyId) return;
    if (!confirm(`Generate a new password for ${u.email}? The old one stops working immediately.`)) return;
    setResetBusyId(u.id);
    try {
      const r = await fetch("/api/users/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: u.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Reset failed");
      // Show the credential receipt — the plain password is in `j.password`.
      setCreatedUser({
        name: j.user?.name || u.name,
        email: j.user?.email || u.email,
        role:  j.user?.role || u.role,
        password: j.password,
        linkedId: j.user?.linkedId || null,
      });
    } catch (e) {
      setToast({ msg: e.message || "Reset failed", tone: "err" });
      setTimeout(() => setToast(null), 3500);
    }
    setResetBusyId(null);
  }

  // Counts per role for the admin's right-side Roles panel. Staff records
  // already have a `role` string; we add synthetic Student / Parent counts.
  const staffCounts = useMemo(() => {
    const m = {};
    for (const s of allStaff) m[s.role] = (m[s.role] || 0) + 1;
    m["Student"] = allStudents.length;
    m["Parent"]  = parents.length;
    return m;
  }, [allStaff, allStudents.length, parents.length]);

  // Branded PDF export — opens a print-styled report (logo, school header,
  // metadata grid, summary chips, aligned data table, footer) and triggers
  // the browser print dialog so the user can save as PDF or print directly.
  function exportPdf() {
    let title, subtitle, columns, rows, summary, name, orientation = "portrait";
    if (tab === "staff") {
      name = "users-staff";
      title = "Staff & Administrators";
      subtitle = `${filteredStaff.length} staff record${filteredStaff.length === 1 ? "" : "s"} across the school`;
      columns = [
        { key: "i",     label: "#",        align: "right", width: "32px" },
        { key: "id",    label: "ID",       width: "90px" },
        { key: "name",  label: "Name" },
        { key: "role",  label: "Role",     width: "110px" },
        { key: "dept",  label: "Department" },
        { key: "email", label: "Email" },
        { key: "phone", label: "Phone",    align: "right" },
        { key: "joined",label: "Joined",   align: "right", width: "80px" },
      ];
      rows = filteredStaff.map((s, i) => ({
        i: i + 1, id: s.id, name: s.name, role: s.role || "—",
        dept: s.dept || "—", email: s.email || "—",
        phone: s.phone || "—", joined: s.joiningDate || "—",
      }));
      const roleCounts = rows.reduce((m, r) => { m[r.role] = (m[r.role] || 0) + 1; return m; }, {});
      summary = [
        { label: "Total staff", value: rows.length },
        { label: "Distinct roles", value: Object.keys(roleCounts).length },
        { label: "Departments", value: new Set(rows.map((r) => r.dept).filter((d) => d !== "—")).size },
      ];
      orientation = "landscape";
    } else if (tab === "students") {
      name = "users-students";
      title = "Students Roster";
      subtitle = `${filteredStudents.length} active enrolment${filteredStudents.length === 1 ? "" : "s"}`;
      columns = [
        { key: "i",         label: "#",          align: "right", width: "32px" },
        { key: "id",        label: "Admission" , width: "100px" },
        { key: "name",      label: "Student" },
        { key: "cls",       label: "Class",      align: "center", width: "70px" },
        { key: "parent",    label: "Parent contact" },
        { key: "transport", label: "Transport",  align: "center", width: "90px" },
        { key: "fee",       label: "Fee",        align: "right" },
        { key: "joined",    label: "Joined",     align: "right", width: "80px" },
      ];
      rows = filteredStudents.map((s, i) => ({
        i: i + 1, id: s.id, name: s.name, cls: s.cls,
        parent: s.parent || "—", transport: s.transport || "—",
        fee: s.fee || "—", joined: s.joined || "—",
      }));
      const classes = new Set(rows.map((r) => r.cls).filter(Boolean));
      summary = [
        { label: "Students", value: rows.length },
        { label: "Classes", value: classes.size },
        { label: "On transport", value: rows.filter((r) => r.transport && r.transport !== "—").length },
      ];
      orientation = "landscape";
    } else {
      name = "users-parents";
      title = "Parents Directory";
      subtitle = `${filteredParents.length} parent contact${filteredParents.length === 1 ? "" : "s"}`;
      columns = [
        { key: "i",         label: "#",          align: "right", width: "32px" },
        { key: "childId",   label: "Child ID",   width: "100px" },
        { key: "childName", label: "Child" },
        { key: "childCls",  label: "Class",      align: "center", width: "70px" },
        { key: "phone",     label: "Phone",      align: "right" },
        { key: "email",     label: "Email" },
        { key: "password",  label: "Password" },
      ];
      rows = filteredParents.map((p, i) => ({
        i: i + 1, childId: p.childId, childName: p.childName,
        childCls: p.childCls, phone: p.phone || "—", email: p.email || "—",
        password: p.password || "—",
      }));
      summary = [
        { label: "Parent records", value: rows.length },
        { label: "With phone",     value: rows.filter((r) => r.phone !== "—").length },
        { label: "With email",     value: rows.filter((r) => r.email !== "—").length },
      ];
    }

    const opened = downloadPdf({
      title,
      subtitle,
      columns,
      rows,
      summary,
      school: school,
      actor,
      dateRange: "Current snapshot",
      orientation,
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-${name}-${new Date().toISOString().slice(0, 10)}`,
    });
    if (opened === false) {
      alert("Couldn't open the print window — please allow pop-ups for this site, then try again.");
    }
  }

  // Total accounts headline — what shows on the page sub.
  const totalPeople = isManager
    ? allStaff.length + allStudents.length + parents.length
    : visibleStudents.length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">{isManager ? "Governance · Directory" : "My classroom · Directory"}</div>
          <div className="page-title">
            {isManager
              ? <>Users <span className="amber">& accounts</span></>
              : <>My <span className="amber">students</span></>}
          </div>
          <div className="page-sub">
            {isManager
              ? `${totalPeople} account${totalPeople === 1 ? "" : "s"} across staff, students and parents.`
              : `${totalPeople} student${totalPeople === 1 ? "" : "s"} in your assigned classes.`}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportPdf} title="Open a printable, branded PDF report">
            <Icon name="download" size={13} />Export PDF
          </button>
          {isAdmin && (
            <>
              <button
                className="btn"
                onClick={runBackfill}
                disabled={backfillBusy}
                title="Wipe every parent user and create a clean login per current student (parent.{name}@sanfort.com + {Name}@123)"
              >
                {backfillBusy ? (
                  <>
                    <span style={{
                      width: 12, height: 12, borderRadius: "50%",
                      border: "2px solid currentColor", borderTopColor: "transparent",
                      display: "inline-block", animation: "spin 0.8s linear infinite",
                    }} />
                    Rebuilding…
                  </>
                ) : (
                  <><Icon name="refresh" size={13} />Rebuild parent logins</>
                )}
                <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </button>
              <button className="btn accent" onClick={() => setShowAddUser(true)} title="Create a new login (canonical or custom role)">
                <Icon name="plus" size={13} />Add user
              </button>
            </>
          )}
        </div>
      </div>

      {isManager && (
        <div className="grid g-4" style={{ marginBottom: 14 }}>
          {(() => {
            const studentsByCls = {};
            for (const s of allStudents) studentsByCls[s.cls] = (studentsByCls[s.cls] || 0) + 1;
            return (
              <>
                <KPI
                  label="Staff" value={allStaff.length}
                  sub={`${Object.keys(staffCounts).length - 2 || 0} role types`}
                  puck="mint" puckIcon="staff"
                  details={{
                    title: `Staff · ${allStaff.length}`,
                    sub: "By role",
                    items: Object.entries(staffCounts)
                      .filter(([k]) => k !== "all" && k !== "total")
                      .sort((a, b) => b[1] - a[1])
                      .map(([role, n]) => ({ label: role, value: n, sub: `${n} member${n === 1 ? "" : "s"}` })),
                  }}
                />
                <KPI
                  label="Students" value={allStudents.length} sub="active enrolment"
                  puck="cream" puckIcon="students"
                  details={{
                    title: `Students · ${allStudents.length}`,
                    sub: "Per class-section",
                    items: Object.entries(studentsByCls)
                      .sort((a, b) => a[0].localeCompare(b[0]))
                      .map(([cls, n]) => ({ label: formatClassLabel(cls), value: n, sub: `${n} student${n === 1 ? "" : "s"}` })),
                  }}
                />
                <KPI
                  label="Parents" value={parents.length} sub="auto-provisioned"
                  puck="peach" puckIcon="users"
                  details={{
                    title: `Parents · ${parents.length}`,
                    sub: "Linked parent accounts",
                    items: parents.slice(0, 12).map((p) => ({
                      label: p.name || p.email,
                      value: p.linkedStudentName || p.linkedId || "—",
                      sub: p.email,
                    })),
                  }}
                />
                <KPI
                  label="Total accounts" value={totalPeople} sub="across the trust"
                  puck="sky" puckIcon="trending"
                  details={{
                    title: `Total accounts · ${totalPeople}`,
                    sub: "Breakdown across people",
                    items: [
                      { label: "Staff",    value: allStaff.length,    sub: `${Object.keys(staffCounts).length - 2 || 0} role types` },
                      { label: "Students", value: allStudents.length, sub: "active enrolment" },
                      { label: "Parents",  value: parents.length,     sub: "auto-provisioned" },
                    ],
                  }}
                />
              </>
            );
          })()}
        </div>
      )}

      {/* Tab strip — hidden when there's only one tab (teacher view). */}
      {TABS.length > 1 && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, marginRight: 4 }}>View:</span>
          {TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              style={{
                padding: "6px 14px", borderRadius: 999,
                background: tab === t.k ? "var(--accent)" : "var(--bg-2)",
                color: tab === t.k ? "#fff" : "var(--ink-2)",
                border: 0, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
              }}
            >{t.label} · {t.count}</button>
          ))}
        </div>
      )}

      <div className={isManager ? "grid g-12" : ""}>
        <div className={`card ${isManager ? "col-8" : ""}`}>
          <div className="card-head">
            <div>
              <div className="card-title">
                {tab === "staff"    && "Staff & administrators"}
                {tab === "students" && (isTeacher ? "My students" : "Students")}
                {tab === "parents"  && "Parents"}
              </div>
              <div className="card-sub">
                {tab === "staff"    && `${filteredStaff.length} of ${allStaff.length} on file`}
                {tab === "students" && `${filteredStudents.length} of ${(isTeacher ? visibleStudents : allStudents).length} on roll`}
                {tab === "parents"  && `${filteredParents.length} of ${parents.length} parent accounts`}
              </div>
            </div>
            <div className="card-actions">
              <div className="input" style={{ display: "inline-flex", alignItems: "center", gap: 6, width: 220, padding: "0 10px" }}>
                <Icon name="search" size={13} style={{ color: "var(--ink-3)" }} />
                <input
                  style={{ border: 0, background: "transparent", outline: "none", fontSize: 12, flex: 1 }}
                  placeholder={tab === "staff" ? "Name, email, dept…" : tab === "students" ? "Name, ID, class…" : "Name, phone…"}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            </div>
          </div>

          {tab === "staff" && (
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr><th>User</th><th>Role</th><th>Department</th><th>Contact</th><th>Joined</th></tr>
                </thead>
                <tbody>
                  {filteredStaff.length === 0 && (
                    <tr><td colSpan={5} className="empty">
                      {allStaff.length === 0 ? "No staff on file yet — add the first one from the Staff screen." : "No matches."}
                    </td></tr>
                  )}
                  {filteredStaff.map((u) => (
                    <tr key={u.id || u.email}>
                      <td>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <AvatarChip initials={u.avatar || initialsOf(u.name)} />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{u.name}</div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{u.id}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className="chip">{u.role || "—"}</span></td>
                      <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{u.dept || "—"}</td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        <div>{u.email || "—"}</div>
                        {u.phone && <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{u.phone}</div>}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{u.joiningDate || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "students" && (
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr><th>Student</th><th>Class</th><th>Parent contact</th><th>Fee</th><th>Joined</th></tr>
                </thead>
                <tbody>
                  {filteredStudents.length === 0 && (
                    <tr><td colSpan={5} className="empty">
                      {(isTeacher ? visibleStudents : allStudents).length === 0
                        ? (isTeacher ? "No students assigned to your classes yet." : "No students on the roster yet.")
                        : "No matches."}
                    </td></tr>
                  )}
                  {filteredStudents.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <AvatarChip initials={initialsOf(s.name)} />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{s.id}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className="chip">{formatClassLabel(s.cls)}</span></td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{s.parent || "—"}</td>
                      <td>
                        {s.fee === "paid"    ? <span className="chip ok"><span className="dot" />Paid</span> :
                         s.fee === "partial" ? <span className="chip warn"><span className="dot" />Partial</span> :
                         s.fee === "pending" ? <span className="chip warn"><span className="dot" />Pending</span> :
                                               <span style={{ fontSize: 11, color: "var(--ink-4)" }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{s.joined || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "logins" && isAdmin && (
            <div style={{ overflowX: "auto" }}>
              <div style={{
                background: "var(--warn-soft, #fff5e0)", color: "var(--ink-2)",
                border: "1px solid var(--warn, #d99523)",
                padding: "9px 12px", borderRadius: 7, fontSize: 11.5,
                margin: "0 14px 12px",
              }}>
                <b>Why you can't see existing passwords:</b> they're stored as one-way bcrypt hashes — even the database can't reverse them. Use <b>Reset password</b> to mint a fresh one and copy it once. The user should change it on first sign-in from <b>My account</b>.
              </div>
              <div style={{
                margin: "0 14px 10px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center",
              }}>
                <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, marginRight: 4 }}>
                  Show:
                </span>
                {[
                  { k: "all",     label: "All",       count: loginCounts.all },
                  { k: "teacher", label: "Teachers",  count: loginCounts.teacher },
                  { k: "parent",  label: "Students / Parents", count: loginCounts.parent },
                  { k: "admin",   label: "Admins",    count: loginCounts.admin },
                  { k: "other",   label: "Other",     count: loginCounts.other },
                ].filter((b) => b.k === "all" || b.count > 0).map((b) => (
                  <button
                    key={b.k}
                    onClick={() => setLoginRoleFilter(b.k)}
                    style={{
                      padding: "5px 12px", borderRadius: 999,
                      background: loginRoleFilter === b.k ? "var(--accent)" : "var(--bg-2)",
                      color:      loginRoleFilter === b.k ? "#fff" : "var(--ink-2)",
                      border: 0, cursor: "pointer", fontSize: 12, fontWeight: 500,
                    }}
                  >
                    {b.label} · {b.count}
                  </button>
                ))}
              </div>
              <table className="table">
                <thead>
                  <tr><th>User</th><th>Email</th><th>Role</th><th>Linked</th><th style={{ textAlign: "right" }}>Action</th></tr>
                </thead>
                <tbody>
                  {authBusy && filteredAuthUsers.length === 0 && (
                    <tr><td colSpan={5} className="empty">Loading login accounts…</td></tr>
                  )}
                  {!authBusy && filteredAuthUsers.length === 0 && (
                    <tr><td colSpan={5} className="empty">
                      {authUsers.length === 0
                        ? "No login accounts on file."
                        : loginRoleFilter === "teacher" ? "No teacher logins on file yet."
                        : loginRoleFilter === "parent"  ? "No parent logins on file yet."
                        : loginRoleFilter === "admin"   ? "No admin logins on file."
                        : loginRoleFilter === "other"   ? "No other-role logins on file."
                        : "No matches."}
                    </td></tr>
                  )}
                  {filteredAuthUsers.map((u) => (
                    <tr key={u.id || u.email}>
                      <td>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <AvatarChip initials={initialsOf(u.name || u.email)} />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{u.name || "—"}</div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{u.id}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{u.email || "—"}</td>
                      <td><span className="chip">{u.role || "—"}</span></td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        {Array.isArray(u.linkedClasses) && u.linkedClasses.length
                          ? u.linkedClasses.join(", ")
                          : (u.linkedId || "—")}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn sm"
                          disabled={resetBusyId === u.id}
                          onClick={() => resetPassword(u)}
                          title="Generate a new password and show it once"
                        >
                          <Icon name="refresh" size={11} />
                          {resetBusyId === u.id ? "Resetting…" : "Reset password"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "parents" && (
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Parent of</th>
                    <th>Child class</th>
                    <th>Phone</th>
                    <th>Login email</th>
                    <th>Password</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredParents.length === 0 && (
                    <tr><td colSpan={5} className="empty">
                      {parents.length === 0 ? "Parents are auto-provisioned on student admission." : "No matches."}
                    </td></tr>
                  )}
                  {filteredParents.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <AvatarChip initials={initialsOf(p.childName)} />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{p.childName}</div>
                            <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{p.childId}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className="chip">{formatClassLabel(p.childCls)}</span></td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{p.phone}</td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{p.email}</td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                        {p.password !== "—" ? (
                          <span
                            title="Click to copy"
                            onClick={() => {
                              if (p.password === "—") return;
                              navigator.clipboard?.writeText(p.password).then(
                                () => flashOk(`Copied ${p.password}`),
                                () => {}
                              );
                            }}
                            style={{ cursor: "pointer" }}
                          >
                            {p.password}
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Roles side-panel — admin/principal/director only. Hidden for the
            teacher view since it'd be irrelevant noise. */}
        {isManager && (
          <div className="card col-4">
            <div className="card-head">
              <div><div className="card-title">Roles</div><div className="card-sub">Counts by role across the trust</div></div>
            </div>
            <div>
              {Object.entries(ROLE_DESC).concat([
                ["Student", "Enrolled child · uses parent's account."],
                ["Parent",  "Their child(ren) only · fees, academics, messages."],
              ]).map(([r, desc]) => (
                <div className="lrow" key={r}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {r} <span style={{ color: "var(--ink-4)", fontWeight: 400, marginLeft: 4 }}>· {staffCounts[r] || 0}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showAddUser && (
        <AddUserModal
          customRoles={customRoles}
          onClose={() => setShowAddUser(false)}
          onCreated={async (created, plainPassword) => {
            setShowAddUser(false);
            setCreatedUser({ ...created, password: plainPassword });
            await refresh?.();
          }}
        />
      )}
      {createdUser && (
        <CredentialsModal
          title="Account created"
          subtitle={`Save these — the password won't be shown again`}
          email={createdUser.email}
          password={createdUser.password}
          extras={[
            { label: "Name", value: createdUser.name },
            { label: "Role", value: createdUser.role },
            ...(createdUser.linkedId ? [{ label: "Linked ID", value: createdUser.linkedId }] : []),
          ]}
          note={
            <>
              The user can sign in at the login screen with this email and password.
              They should change their password from <b>My account</b> on first sign-in.
            </>
          }
          onClose={() => { setCreatedUser(null); flashOk(`User ${createdUser.name} created`); }}
          flash={(msg, tone) => { setToast({ msg, tone: tone === "ok" ? "ok" : "err" }); setTimeout(() => setToast(null), 3000); }}
        />
      )}
      {backfillLogins && (
        <BulkParentLoginsModal
          logins={backfillLogins}
          onClose={() => setBackfillLogins(null)}
          flash={flashOk}
        />
      )}
      {toast && (
        <div role="status" style={{
          position: "fixed", bottom: 18, right: 18, zIndex: 9000,
          background: toast.tone === "err" ? "var(--bad, #b13c1c)" : "var(--ok)",
          color: "#fff", padding: "9px 14px", borderRadius: 8,
          fontSize: 12, fontWeight: 700,
        }}>{toast.msg}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddUserModal — admin-only form to mint a fresh login. Role dropdown lists
// the 7 canonical roles plus every row from custom_roles, so any role you
// build on the Custom Roles screen is immediately assignable here.
// ---------------------------------------------------------------------------
const CANONICAL_ROLE_OPTIONS = [
  { k: "admin",             label: "Admin" },
  { k: "principal",         label: "Principal" },
  { k: "academic_director", label: "Academic Director" },
  { k: "teacher",           label: "Teacher" },
  { k: "school_accountant", label: "School Accountant" },
  { k: "trust_accountant",  label: "Trust Accountant" },
  { k: "transport_manager", label: "Transport Manager" },
  { k: "fees_manager",      label: "Fees Manager" },
  { k: "parent",            label: "Parent" },
];

function AddUserModal({ customRoles = [], onClose, onCreated }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "teacher",
    linkedId: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Suggest a 10-char password — admin can copy or replace it.
  function suggestPassword() {
    const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
    set("password", out);
    setShowPassword(true);
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: form.role,
          linkedId: form.linkedId.trim() || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to create user");
      await onCreated(j.user, form.password);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  }

  // Show context-specific helper text for the linkedId field — students
  // (parent role), classes (teacher role), or hidden for everyone else.
  const linkedHelp = (() => {
    if (form.role === "teacher") return "Comma-separated class codes (e.g. 2-A, 5-B). Optional.";
    if (form.role === "parent")  return "Student admission ID (e.g. STN-9897). Optional — auto-links on first sign-in.";
    return null;
  })();

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 480, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Add user</div>
            <div className="card-sub">Create a new login. Both built-in and custom roles are assignable.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Full name *">
            <input className="input" autoFocus required value={form.name}
              onChange={(e) => set("name", e.target.value)} placeholder="e.g. Priya Sharma" maxLength={120} />
          </Field>
          <Field label="Email *">
            <input className="input" required type="email" value={form.email}
              onChange={(e) => set("email", e.target.value)} placeholder="priya@school.com" maxLength={120} />
          </Field>
          <Field label="Password *" hint="Minimum 6 characters. Share with the user securely.">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                required
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="••••••••"
                style={{ flex: 1 }}
                minLength={6}
              />
              <button type="button" className="btn sm ghost" onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? "Hide" : "Show"}
              </button>
              <button type="button" className="btn sm" onClick={suggestPassword} title="Generate a random 10-char password">
                Suggest
              </button>
            </div>
          </Field>
          <Field label="Role *" hint={customRoles.length ? `${customRoles.length} custom role${customRoles.length === 1 ? "" : "s"} also available below` : "Define more roles on the Custom Roles screen."}>
            <select className="select" value={form.role} onChange={(e) => set("role", e.target.value)}>
              <optgroup label="Built-in roles">
                {CANONICAL_ROLE_OPTIONS.map((r) => (
                  <option key={r.k} value={r.k}>{r.label}</option>
                ))}
              </optgroup>
              {customRoles.length > 0 && (
                <optgroup label="Custom roles">
                  {customRoles.map((r) => (
                    <option key={r.id} value={r.id}>{r.roleName}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          {linkedHelp && (
            <Field label="Linked ID" hint={linkedHelp}>
              <input className="input" value={form.linkedId} onChange={(e) => set("linkedId", e.target.value)}
                placeholder={form.role === "teacher" ? "2-A, 5-B" : "STN-9897"} />
            </Field>
          )}
          {err && (
            <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
              {err}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !form.name.trim() || !form.email.trim() || form.password.length < 6}>
              {busy ? "Creating…" : <><Icon name="check" size={13} />Create user</>}
            </button>
          </div>
        </form>
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

// Shown after the "Rebuild parent logins" action wipes + re-creates the
// parent roster. Same shape as BulkLoginsModal on the Students screen
// (could be shared if it gets a third caller).
function BulkParentLoginsModal({ logins, onClose, flash }) {
  const count = logins.length;

  const downloadCsv = () => {
    const escape = (v) => {
      const s = String(v ?? "");
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = "Student ID,Student Name,Class,Parent Email,Password";
    const rows = logins.map((l) =>
      [l.studentId, l.studentName, l.cls, l.email, l.password].map(escape).join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `parent-logins-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash?.(`Downloaded ${count} parent login${count === 1 ? "" : "s"}`);
  };

  return (
    <div className="modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,16,10,0.55)",
        display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: "100%", maxWidth: 760, maxHeight: "calc(100vh - 32px)", display: "flex", flexDirection: "column" }}
      >
        <div className="card-head">
          <div>
            <div className="card-title">{count} parent login{count === 1 ? "" : "s"} created</div>
            <div className="card-sub">Download the CSV now — passwords are hashed after this dialog closes and can't be recovered.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        <div style={{ padding: "16px 20px 8px", display: "flex", flexDirection: "column", gap: 12, overflow: "hidden", flex: 1 }}>
          <div style={{
            background: "var(--warn-soft, #fff4e2)",
            border: "1px solid var(--warn, #d4944e)",
            color: "var(--ink-2)",
            fontSize: 12, lineHeight: 1.45,
            padding: "10px 12px", borderRadius: 8,
          }}>
            <strong>Security note:</strong> these passwords follow a predictable
            <code style={{ margin: "0 4px", fontSize: 11 }}>FirstName@123</code>
            pattern. Ask each parent to change their password after first sign-in.
          </div>

          <div style={{
            overflowY: "auto", flex: 1,
            border: "1px solid var(--rule)", borderRadius: 8,
          }}>
            <table className="table" style={{ width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Student</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Class</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Email</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Password</th>
                </tr>
              </thead>
              <tbody>
                {logins.map((l) => (
                  <tr key={l.studentId} style={{ borderTop: "1px solid var(--rule-2)" }}>
                    <td style={{ padding: "7px 10px" }}>
                      <div style={{ fontWeight: 500 }}>{l.studentName}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{l.studentId}</div>
                    </td>
                    <td style={{ padding: "7px 10px" }}>{formatClassLabel(l.cls)}</td>
                    <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{l.email}</td>
                    <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{l.password}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4, paddingBottom: 12 }}>
            <button className="btn ghost" onClick={onClose}>I've saved these</button>
            <button className="btn accent" onClick={downloadCsv}>
              <Icon name="download" size={13} />Download CSV
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
