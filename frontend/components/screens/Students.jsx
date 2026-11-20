"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, AvatarChip, StatusChip } from "../ui";
import DocumentsPanel from "../DocumentsPanel";
import CredentialsModal from "../CredentialsModal";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { formatClassLabel, feeTypeLabel } from "@/backend/lib/format.js";

// Section is fixed to "A" under the hood — storage keeps "N-A" so the
// dozens of split("-") readers across the app stay valid, but no UI
// element ever shows or asks for a section letter.
const ONLY_SECTION = "A";

export default function ScreenStudents({ E, refresh, role, session, searchFocus, clearSearchFocus }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  // Teachers, principals and admin can edit student details. Parents cannot —
  // they can't even see this screen on the current nav, but the gate is
  // defensive.
  const canEdit = role === "principal" || role === "admin" || role === "teacher";
  // Teachers don't get to see (or export) parent contact numbers — those are
  // hidden from the teacher login for privacy.
  const isTeacher = role === "teacher";

  // ---------- state ----------
  const [classFilter, setClassFilter] = useState("All");
  const [filterOpen, setFilterOpen] = useState(false);
  // Free-text search — matches name OR parent phone digits. Empty string
  // disables the filter. Combined with classFilter below so admins can
  // narrow to "Class 5-A" AND "ends in 1234" in one go.
  const [search, setSearch] = useState("");
  const [showAdmission, setShowAdmission] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // After a bulk import succeeds, hold the array of generated parent
  // credentials here so we can render a "download CSV" modal — gives the
  // admin one shareable file with every parent's email + password.
  const [importLogins, setImportLogins] = useState(null);
  const [profileOf, setProfileOf] = useState(null);
  const [editingOf, setEditingOf] = useState(null); // student being edited, or null
  const [phoneEditingOf, setPhoneEditingOf] = useState(null); // student whose phone is being edited inline
  const [picked, setPicked] = useState(new Set());
  const [openMenuFor, setOpenMenuFor] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [view, setView] = useState("active"); // 'active' | 'archived'
  const [confirmArchive, setConfirmArchive] = useState(null); // student awaiting confirmation
  const [issuedLogin, setIssuedLogin] = useState(null); // parent login just provisioned
  const [messageStudent, setMessageStudent] = useState(null); // student whose parent we're messaging
  const [tcReasonFor, setTcReasonFor] = useState(null); // student we're raising a TC for
  const [feeEditFor, setFeeEditFor] = useState(null); // student whose annual fee total is being edited
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  // ---------- data ----------
  // The roster is populated entirely from real DB rows (no mock baseline).
  const activeRoster   = (E.ADDED_STUDENTS    || []).map((s) => ({ ...s, __added: true, __status: "active" }));
  const archivedRoster = (E.ARCHIVED_STUDENTS || []).map((s) => ({ ...s, __added: true, __status: "archived" }));
  const roster = view === "archived" ? archivedRoster : activeRoster;

  // Global search deep-link: when a user clicks a student in the topbar
  // search dropdown, AppShell sets searchFocus={type:"student", id, ...}.
  // We find that student (checking archived too in case they've been
  // withdrawn) and pop the profile modal, then clear the focus so a
  // later navigation back to this screen doesn't re-open it.
  useEffect(() => {
    if (!searchFocus || searchFocus.type !== "student" || !searchFocus.id) return;
    const all = [...activeRoster, ...archivedRoster];
    const target = all.find((s) => s.id === searchFocus.id);
    if (target) {
      if (target.__status === "archived") setView("archived");
      setProfileOf(target);
    }
    clearSearchFocus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocus]);

  // Undoable fee edits — map of studentId → snapshot. Populated by
  // /api/data; the API serves only the unexpired ones (entries TTL at
  // 1 hour). Used by FeeCell to decide whether to render the Undo button.
  const feeEditSnapshots = E.FEE_EDIT_SNAPSHOTS || {};
  const undoFeeEdit = async (s) => {
    const { ok, json } = await safeFetch("/api/fees/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s.id }),
    });
    if (ok) {
      flash(`Reverted ${s.name}'s fees · total ₹${(json.restoredTotal || 0).toLocaleString("en-IN")}`);
      await refresh?.();
    } else {
      flash(json.error || "Undo failed", "bad");
    }
  };

  // Per-student fee summary split into academic + transport buckets.
  // Each bucket carries outstanding (from pending_fees) + paid (from
  // recent_fees). The annual fee row's id === student id (created at
  // import); the transport fee row's id === `${studentId}__transport`
  // and has fee_type === "transport". Receipts link back via student_id
  // and feeType. The Students FeeCell renders the two buckets as two
  // separate lines so admins see what they owe per category.
  const pendingFees = E.PENDING_FEES || [];
  const recentFees  = E.RECENT_FEES  || [];
  // Per-student fee summary split into the five editable components — Term I,
  // Term II, Term III, Application (admission) and Transport — plus an
  // `academic` rollup (the three terms + application), an `other` catch-all
  // for any extra fee types (Kit, ECA…), and the overall outstanding/paid.
  // Each bucket carries outstanding (pending_fees) + paid (recent_fees).
  // Legacy single-fee rows (id === studentId, type "annual"/"term1") fold
  // into Term I so existing students still render until their breakdown is set.
  const blankFee = () => ({ outstanding: 0, paid: 0 });
  const KNOWN_BUCKET = { term1: "term1", term2: "term2", term3: "term3", application: "application", transport: "transport", annual: "term1", "": "term1" };
  const bucketOf = (ft) => KNOWN_BUCKET[(ft || "").toLowerCase()] || "other";
  const feeSummary = useMemo(() => {
    const m = new Map();
    const getEntry = (sid) => {
      let e = m.get(sid);
      if (!e) {
        e = {
          term1: blankFee(), term2: blankFee(), term3: blankFee(),
          application: blankFee(), transport: blankFee(), other: blankFee(),
          academic: blankFee(),    // term1+term2+term3+application
          outstanding: 0, paid: 0, // overall across every component
        };
        m.set(sid, e);
      }
      return e;
    };
    for (const f of pendingFees) {
      const sid = f.studentId || (f.id ? String(f.id).split("__")[0] : null);
      if (!sid) continue;
      const entry = getEntry(sid);
      const amt = Number(f.amount) || 0;
      const b = bucketOf(f.feeType || f.fee_type);
      entry[b].outstanding += amt;
      if (b !== "transport" && b !== "other") entry.academic.outstanding += amt;
      entry.outstanding += amt;
    }
    for (const r of recentFees) {
      const sid = r.studentId || r.student_id;
      if (!sid) continue;
      const entry = getEntry(sid);
      const amt = Number(r.amount) || 0;
      const b = bucketOf(r.feeType || r.fee_type);
      entry[b].paid += amt;
      if (b !== "transport" && b !== "other") entry.academic.paid += amt;
      entry.paid += amt;
    }
    return m;
  }, [pendingFees, recentFees]);
  const summaryFor = (studentId) => feeSummary.get(studentId) || {
    term1: blankFee(), term2: blankFee(), term3: blankFee(),
    application: blankFee(), transport: blankFee(), other: blankFee(),
    academic: blankFee(), outstanding: 0, paid: 0,
  };

  // Map of studentId → TC status, so we can stamp a "TC" chip next to
  // any student whose transfer certificate has been approved or issued.
  // 'rejected' and 'requested' don't qualify — those are not yet "given".
  const tcByStudent = useMemo(() => {
    const m = {};
    for (const r of (E.TC_REQUESTS || [])) {
      if (!r?.studentId) continue;
      if (r.status === "issued" || r.status === "approved") {
        // Issued beats approved if both exist for the same student.
        if (m[r.studentId] !== "issued") m[r.studentId] = r.status;
      }
    }
    return m;
  }, [E.TC_REQUESTS]);

  // The class filter holds either "All" or a class-number string like "5"
  // (no "Class " prefix, no section letter) — we compare by the leading
  // digit of the student's cls field. Display labels come from
  // formatClassLabel so chips and dropdowns show "Class V" / "PRE-MONT".
  const visible = roster.filter((s) => {
    if (classFilter !== "All" && String(s.cls).split("-")[0] !== classFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    // Numeric-only query → match the parent phone digits + the student id.
    // Otherwise → match the student name (substring, case-insensitive).
    const numericQuery = /^\d+$/.test(q);
    if (numericQuery) {
      const parentDigits = String(s.parent || "").replace(/\D/g, "");
      const idDigits     = String(s.id || "").replace(/\D/g, "");
      return parentDigits.includes(q) || idDigits.includes(q);
    }
    return String(s.name || "").toLowerCase().includes(q);
  });

  const eligibleIds = visible.map((s) => s.id);
  const allChecked = eligibleIds.length > 0 && eligibleIds.every((id) => picked.has(id));

  // Drop selections that no longer exist
  useEffect(() => {
    setPicked((prev) => {
      const valid = new Set(roster.map((s) => s.id));
      let changed = false;
      const next = new Set();
      prev.forEach((id) => { if (valid.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [roster.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- handlers ----------
  const togglePick = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const togglePickAll = () => {
    if (allChecked) setPicked(new Set());
    else setPicked(new Set(eligibleIds));
  };

  const exportPdf = () => {
    const filterLabel = classFilter === "All" ? "All classes" : formatClassLabel(classFilter);
    const opened = downloadPdf({
      title: "Students Roster",
      subtitle: `${visible.length} student${visible.length === 1 ? "" : "s"}${classFilter !== "All" ? ` · ${filterLabel}` : ""}`,
      school, actor,
      dateRange: filterLabel,
      orientation: "landscape",
      summary: [
        { label: "Students",     value: visible.length },
        { label: "Classes",      value: new Set(visible.map((s) => s.cls).filter(Boolean)).size },
        { label: "On transport", value: visible.filter((s) => s.transport && s.transport !== "—").length },
        { label: "Avg attendance", value: visible.length
            ? `${Math.round(visible.reduce((a, s) => a + (Number(s.attendance) || 0), 0) / visible.length)}%`
            : "—" },
      ],
      columns: [
        { key: "i",          label: "#",          align: "right",  width: "32px" },
        { key: "id",         label: "Admission",  width: "100px" },
        { key: "name",       label: "Name" },
        { key: "cls",        label: "Class",      align: "center", width: "60px" },
        // Parent contact is hidden from the teacher login.
        ...(!isTeacher ? [{ key: "parent", label: "Parent contact" }] : []),
        { key: "transport",  label: "Transport",  align: "center", width: "80px" },
        { key: "fee",        label: "Fee",        align: "center", width: "70px" },
        { key: "attendance", label: "Attendance", align: "right",  width: "80px" },
        { key: "joined",     label: "Joined",     align: "right",  width: "80px" },
      ],
      rows: visible.map((s, i) => ({
        i: i + 1, id: s.id, name: s.name || "—",
        cls: s.cls ? formatClassLabel(s.cls) : "—",
        parent: s.parent || "—", transport: s.transport || "—",
        fee: s.fee || "—",
        attendance: s.attendance != null ? `${s.attendance}%` : "—",
        joined: s.joined || "—",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-students-${filterLabel.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}`,
    });
    if (opened === false) flash("Pop-up blocked — please allow pop-ups for this site", "bad");
    else flash(`Opened PDF preview · ${visible.length} students`);
  };

  // Wrap fetch so a network failure (server restart, dev hot-reload mid-click,
  // offline) becomes a toast instead of an unhandled "Failed to fetch" overlay.
  const safeFetch = async (url, init) => {
    try {
      const r = await fetch(url, init);
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok && json.ok !== false, status: r.status, json };
    } catch (e) {
      return { ok: false, status: 0, json: { error: "Network error — couldn't reach the server. Is the dev server still running?" } };
    }
  };

  // Convert an .xlsx / .xls file to a CSV string using the already-
  // bundled `xlsx` library. Reads the first sheet and emits comma-
  // delimited rows that the existing /api/students/import endpoint
  // already understands — server stays unchanged.
  const xlsxToCsv = async (file) => {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    if (!firstSheet) throw new Error("Workbook has no sheets");
    return XLSX.utils.sheet_to_csv(firstSheet);
  };

  // Returns the import result so the ImportModal can render its own
  // success card (counts, errors, "Done" button). The modal stays open
  // until the admin dismisses it — that way they can read the summary
  // and download the parent-logins CSV without the toast disappearing.
  // Throws on failure so the modal can flip back to "idle".
  const handleImportFile = async (file) => {
    const name = String(file.name || "").toLowerCase();
    const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls");
    const csv = isExcel
      ? await xlsxToCsv(file)
      : await file.text();
    const { ok, json } = await safeFetch("/api/students/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    if (!ok) {
      const err = new Error(json.error || "Import failed");
      flash(err.message, "bad");
      throw err;
    }
    const loginCount = (json.logins || []).length;
    const errorCount = Array.isArray(json.errors) ? json.errors.length : 0;
    if (errorCount > 0) console.warn("[import] skipped rows", json.errors);
    // Surface the generated credentials in a separate modal once the
    // import-success modal is dismissed — but stash them now so we
    // don't lose them if the user closes too quickly.
    if (loginCount > 0) setImportLogins(json.logins);
    // Refresh the page data so the new rows are visible the moment
    // the admin closes the modal.
    await refresh?.();
    return json;
  };

  const submitAdmission = async (form) => {
    const { ok, json } = await safeFetch("/api/students", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (ok) {
      flash(`Admitted ${json.student.name} · ${json.student.id}`);
      await refresh?.();
      setShowAdmission(false);
      // If a fresh parent account was minted, surface the credentials so the
      // staff can hand them to the parent. Skipped on duplicate / error.
      if (json.createdLogin) {
        setIssuedLogin({ ...json.createdLogin, studentName: json.student.name, studentId: json.student.id });
      }
    } else {
      flash(json.error || "Admission failed", "bad");
    }
  };

  // Soft-delete: archives the student. All their fee receipts and daily logs
  // are preserved. The pending fee (if any) is dropped because we no longer
  // expect to collect it.
  const archiveStudent = async (s) => {
    const { ok, json } = await safeFetch("/api/students", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s.id }),
    });
    if (ok) { flash(`Withdrew ${s.name} · history preserved`); await refresh?.(); }
    else flash(json.error || "Withdraw failed", "bad");
    setOpenMenuFor(null);
    setConfirmArchive(null);
  };

  const restoreStudent = async (s) => {
    const { ok, json } = await safeFetch("/api/students/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s.id }),
    });
    if (ok) { flash(`Restored ${s.name}`); await refresh?.(); }
    else flash(json.error || "Restore failed", "bad");
    setOpenMenuFor(null);
  };

  const submitEdit = async (payload) => {
    const { ok, json } = await safeFetch("/api/students", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (ok) {
      flash(`Updated ${json.student.name}`);
      await refresh?.();
      setEditingOf(null);
    } else {
      flash(json.error || "Update failed", "bad");
    }
  };

  // ---------- render ----------
  return (
    <div className="page">
      <Toast toast={toast} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Roster</div>
          <div className="page-title">Students <span className="amber">at school</span></div>
          <div className="page-sub">{roster.length} {roster.length === 1 ? "child" : "children"} on roll · {(E.CLASSES || []).length} classes</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setShowImport(true)}><Icon name="upload" size={13} />Import</button>
          <button className="btn" onClick={exportPdf} title="Open a printable, branded PDF report"><Icon name="download" size={13} />Export PDF</button>
          <button className="btn accent" onClick={() => setShowAdmission(true)}><Icon name="plus" size={13} />New admission</button>
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI
          label="Enrolled" value={roster.length} sub={`across ${(E.CLASSES || []).length} classes`}
          puck="mint" puckIcon="students"
          details={{
            title: `Enrolled · ${roster.length} students`,
            sub: "Click a student in the table to open their profile",
            items: roster.slice(0, 12).map((s) => ({
              label: s.name,
              value: formatClassLabel(s.cls),
              sub: isTeacher ? s.id : `${s.id} · ${s.parent}`,
            })),
          }}
        />
        <KPI
          label="New admissions" value={roster.length} sub="this session"
          puck="peach" puckIcon="enquiry"
          details={{
            title: `Admissions · ${roster.length} this session`,
            sub: "Recent admissions, newest first",
            items: roster.slice(0, 10).map((s) => ({
              label: s.name,
              value: s.joined,
              sub: `${formatClassLabel(s.cls)} · ${s.id}`,
            })),
          }}
        />
        {(() => {
          const avgAtt = roster.length ? Math.round(roster.reduce((a, s) => a + (s.attendance || 0), 0) / roster.length) : 0;
          const sortedAtt = roster.slice().sort((a, b) => (a.attendance || 0) - (b.attendance || 0));
          const tcs = E.TC_REQUESTS || [];
          const issuedThisMonth = tcs.filter((t) => {
            const d = String(t.issuedAt || "").slice(0, 7);
            const m = new Date().toISOString().slice(0, 7);
            return d === m;
          });
          return (
            <>
              <KPI
                label="Average attendance"
                value={roster.length ? `${avgAtt}%` : "—"}
                sub="across all students"
                puck="cream" puckIcon="check"
                details={{
                  title: `Attendance · ${avgAtt}% average`,
                  sub: "Lowest first — flag for follow-up",
                  items: sortedAtt.slice(0, 12).map((s) => ({
                    label: s.name,
                    value: `${s.attendance || 0}%`,
                    sub: `${formatClassLabel(s.cls)} · ${s.id}`,
                    tone: (s.attendance || 0) < 75 ? "bad" : (s.attendance || 0) < 85 ? "warn" : "ok",
                  })),
                }}
              />
              <KPI
                label="Transfer certificates"
                value={issuedThisMonth.length}
                sub={`${tcs.length} total · ${issuedThisMonth.length} this month`}
                puck="rose" puckIcon="reports"
                details={{
                  title: `Transfer certificates · ${tcs.length} on file`,
                  sub: `${issuedThisMonth.length} processed this month · newest first`,
                  items: tcs.length === 0 ? [] : tcs.slice(0, 12).map((t) => ({
                    label: t.studentName || t.student || t.studentId,
                    value: t.status || "requested",
                    sub: `${t.cls ? formatClassLabel(t.cls) : "—"} · ${t.requestedAt ? String(t.requestedAt).slice(0, 10) : ""}`,
                    tone: t.status === "issued" ? "ok" : t.status === "rejected" ? "bad" : "warn",
                  })),
                }}
              />
            </>
          );
        })()}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{view === "archived" ? "Archived students" : "All students"}</div>
            <div className="card-sub">
              {view === "archived"
                ? `${archivedRoster.length} withdrawn · records preserved`
                : "Auto-assigned IDs · auto fee schedule"}
            </div>
          </div>
          <div className="card-actions">
            {/* Search by name or phone digits. Sticks to the left of the
                view toggle so it reads like a primary filter. The clear
                button appears once there's text so admins can reset
                without selecting the text first. */}
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <Icon
                name="search"
                size={12}
                style={{ position: "absolute", left: 9, color: "var(--ink-4)", pointerEvents: "none" }}
              />
              <input
                className="input"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or phone"
                style={{
                  height: 30,
                  padding: "0 28px 0 26px",
                  fontSize: 12.5,
                  width: 200,
                }}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  style={{
                    position: "absolute", right: 6,
                    background: "none", border: 0, padding: 2,
                    cursor: "pointer", color: "var(--ink-3)", lineHeight: 0,
                  }}
                >
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
            <div className="segmented">
              <button className={view === "active" ? "active" : ""} onClick={() => setView("active")}>
                Active · {activeRoster.length}
              </button>
              <button className={view === "archived" ? "active" : ""} onClick={() => setView("archived")}>
                Archived · {archivedRoster.length}
              </button>
            </div>
            <div className="segmented" style={{ flexWrap: "wrap" }}>
              <button className={classFilter === "All" ? "active" : ""} onClick={() => setClassFilter("All")}>All</button>
              {(E.CLASSES || []).map((c) => (
                <button
                  key={c.n}
                  className={classFilter === String(c.n) ? "active" : ""}
                  onClick={() => setClassFilter(String(c.n))}
                  title={c.label || formatClassLabel(String(c.n))}
                >
                  {c.label || formatClassLabel(String(c.n))}
                </button>
              ))}
            </div>
            <div style={{ position: "relative" }}>
              <button className={`btn sm ${classFilter !== "All" ? "accent" : ""}`} onClick={() => setFilterOpen((v) => !v)}>
                <Icon name="filter" size={12} />
                {classFilter === "All" ? "Filter" : formatClassLabel(classFilter)}
              </button>
              {filterOpen && (
                <FilterMenu
                  classes={E.CLASSES || []}
                  value={classFilter}
                  onClose={() => setFilterOpen(false)}
                  onPick={(v) => { setClassFilter(v); setFilterOpen(false); }}
                />
              )}
            </div>
          </div>
        </div>

        {picked.size > 0 && (
          <div style={{
            padding: "10px 18px", display: "flex", alignItems: "center", gap: 12,
            background: "var(--accent-soft)", borderBottom: "1px solid var(--rule-2)",
            fontSize: 12.5,
          }}>
            <span style={{ fontWeight: 500, color: "var(--accent-2)" }}>{picked.size} selected</span>
            <button className="btn sm accent" onClick={() => flash(`WhatsApp template queued for ${picked.size} parents`)}>
              <Icon name="whatsapp" size={11} />Message parents
            </button>
            <button className="btn sm" onClick={() => flash(`SMS queued for ${picked.size} parents`)}>
              <Icon name="sms" size={11} />SMS parents
            </button>
            <button className="btn sm ghost" onClick={() => setPicked(new Set())} style={{ marginLeft: "auto" }}>Clear</button>
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 24 }}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={togglePickAll}
                    disabled={eligibleIds.length === 0}
                  />
                </th>
                <th>Student</th>
                <th>ID</th>
                <th>Class</th>
                {!isTeacher && <th>Parent</th>}
                <th>Attendance</th>
                <th>Fee</th>
                <th>Transport</th>
                <th>Joined</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={isTeacher ? 9 : 10} className="empty">No students match this filter.</td></tr>
              )}
              {visible.map((s) => (
                <tr
                  key={s.id}
                  style={tcByStudent[s.id] === "issued" ? {
                    // Dim the whole row when the TC has been issued — the
                    // student has formally left, so they read as inactive
                    // even if they're still on the active list (e.g. a
                    // legacy row from before the auto-archive landed).
                    opacity: 0.55,
                    background: "var(--card-2)",
                  } : undefined}
                  title={tcByStudent[s.id] === "issued" ? "Deactivated — TC issued" : undefined}
                >
                  <td><input type="checkbox" checked={picked.has(s.id)} onChange={() => togglePick(s.id)} /></td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <AvatarChip initials={s.name.split(" ").map((n) => n[0]).join("")} />
                      <span style={{ fontSize: 12.5, fontWeight: 500, textDecoration: tcByStudent[s.id] === "issued" ? "line-through" : "none" }}>
                        {s.name}
                        {s.__added && tcByStudent[s.id] !== "issued" && (
                          <span className="chip ok" style={{ marginLeft: 6, fontSize: 10, height: 18, padding: "0 6px" }}>
                            <span className="dot" />new
                          </span>
                        )}
                        {tcByStudent[s.id] === "issued" && (
                          <span
                            className="chip bad"
                            style={{ marginLeft: 6, fontSize: 10, height: 18, padding: "0 6px" }}
                            title="Transfer certificate issued — student has left, account deactivated"
                          >
                            <span className="dot" />Deactivated · TC issued
                          </span>
                        )}
                        {tcByStudent[s.id] === "approved" && (
                          <span
                            className="chip warn"
                            style={{ marginLeft: 6, fontSize: 10, height: 18, padding: "0 6px" }}
                            title="Transfer certificate approved — awaiting issue"
                          >
                            <span className="dot" />TC approved
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>{s.id}</td>
                  <td><span className="chip">{formatClassLabel(s.cls)}</span></td>
                  {!isTeacher && (
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span>{s.parent}</span>
                        {canEdit && (
                          <button
                            className="icon-btn"
                            style={{ width: 22, height: 22 }}
                            onClick={() => setPhoneEditingOf(s)}
                            title="Edit parent phone number"
                          >
                            <Icon name="pencil" size={11} />
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div className="bar" style={{ width: 60 }}>
                        <span style={{ width: `${s.attendance}%`, background: s.attendance < 85 ? "var(--warn)" : "var(--ok)" }} />
                      </div>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{s.attendance}%</span>
                    </div>
                  </td>
                  <td>
                    <FeeCell
                      student={s}
                      summary={summaryFor(s.id)}
                      canEdit={canEdit && s.__status !== "archived"}
                      onEdit={() => setFeeEditFor(s)}
                      undoable={Boolean(feeEditSnapshots[s.id])}
                      onUndo={() => undoFeeEdit(s)}
                    />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    <TransportCell student={s} />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{s.joined}</td>
                  <td>
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        if (openMenuFor === s.id) { setOpenMenuFor(null); return; }
                        const rect = e.currentTarget.getBoundingClientRect();
                        setOpenMenuFor(s.id);
                        setMenuAnchor({ x: rect.right, y: rect.bottom });
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                    {openMenuFor === s.id && menuAnchor && (
                      <RowMenu
                        student={s}
                        anchor={menuAnchor}
                        canEdit={canEdit}
                        onClose={() => setOpenMenuFor(null)}
                        onView={() => { setProfileOf(s); setOpenMenuFor(null); }}
                        onEdit={() => { setEditingOf(s); setOpenMenuFor(null); }}
                        onTC={() => { setTcReasonFor(s); setOpenMenuFor(null); }}
                        onMessage={() => { setMessageStudent(s); setOpenMenuFor(null); }}
                        onWithdraw={() => { setConfirmArchive(s); setOpenMenuFor(null); }}
                        onRestore={() => restoreStudent(s)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmArchive && (
        <ConfirmArchive
          student={confirmArchive}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => archiveStudent(confirmArchive)}
        />
      )}
      {showAdmission && <AdmissionModal classes={E.CLASSES || []} routes={E.ROUTES || []} students={E.ADDED_STUDENTS || []} onClose={() => setShowAdmission(false)} onSubmit={submitAdmission} />}
      {issuedLogin && (
        <CredentialsModal
          title="Parent login created"
          subtitle={`For ${issuedLogin.studentName} (${issuedLogin.studentId}) — share these with the parent`}
          email={issuedLogin.email}
          password={issuedLogin.defaultPassword}
          extras={[{ label: "Role", value: "Parent" }]}
          note={
            <>
              The parent can sign in at the login screen and pick the <b>Parent</b> role.
              Their dashboard will be scoped to {issuedLogin.studentName} only.
            </>
          }
          onClose={() => setIssuedLogin(null)}
          flash={flash}
        />
      )}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onFile={handleImportFile} />}
      {importLogins && (
        <BulkLoginsModal
          logins={importLogins}
          onClose={() => setImportLogins(null)}
          flash={flash}
        />
      )}
      {profileOf && (
        <ProfileModal
          student={profileOf}
          hideContact={isTeacher}
          school={school}
          onClose={() => setProfileOf(null)}
          onMessage={() => { setMessageStudent(profileOf); setProfileOf(null); }}
          onTC={() => { setTcReasonFor(profileOf); setProfileOf(null); }}
        />
      )}
      {messageStudent && (
        <MessageParentModal
          student={messageStudent}
          onClose={() => setMessageStudent(null)}
          flash={flash}
        />
      )}
      {tcReasonFor && (
        <IssueTcModal
          student={tcReasonFor}
          onClose={() => setTcReasonFor(null)}
          onIssued={async () => { await refresh?.(); }}
          flash={flash}
        />
      )}
      {feeEditFor && canEdit && (
        <EditFeeModal
          student={feeEditFor}
          summary={summaryFor(feeEditFor.id)}
          onClose={() => setFeeEditFor(null)}
          onSubmit={async (components) => {
            const payload = { id: feeEditFor.id, ...components };
            const { ok, json } = await safeFetch("/api/fees/components", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (ok) {
              flash(`Updated ${feeEditFor.name}'s fees · overall ₹${Number(json.overall || 0).toLocaleString("en-IN")}`);
              await refresh?.();
              setFeeEditFor(null);
            } else {
              flash(json.error || "Could not update fees", "bad");
            }
          }}
        />
      )}
      {editingOf && canEdit && (
        <EditStudentModal
          student={editingOf}
          classes={E.CLASSES || []}
          routes={E.ROUTES || []}
          students={E.ADDED_STUDENTS || []}
          onClose={() => setEditingOf(null)}
          onSubmit={submitEdit}
        />
      )}
      {phoneEditingOf && canEdit && (
        <EditPhoneModal
          student={phoneEditingOf}
          onClose={() => setPhoneEditingOf(null)}
          onSubmit={async (parent) => {
            await submitEdit({ id: phoneEditingOf.id, parent });
            setPhoneEditingOf(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- helpers ----------
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

// Render the fee cell in the Students table. Two stacked lines — one
// for the academic fee, one for the transport fee. Each line shows the
// outstanding amount, a Due/Partial/Paid pill, and (for academic) a
// breakdown subtext when payments have landed. Click anywhere on the
// cell to edit (both buckets live in the same modal). When a recent
// (unexpired) snapshot exists for this student, an Undo affordance
// renders to the right — clicking reverses the last fee edit. Both the
// modal and the API enforce increase-only so the Undo button is the only
// way to legitimately shrink fees, and only within the 1-hour window.
function FeeCell({ student, summary, canEdit, onEdit, undoable, onUndo }) {
  const overallOut  = summary.outstanding || 0;
  const overallPaid = summary.paid || 0;
  const overallTotal = overallOut + overallPaid;
  const hasTransport = student.transport && student.transport !== "—";

  if (overallTotal === 0 && !undoable && !hasTransport) {
    return <span style={{ fontSize: 12, color: "var(--ink-4)" }}>—</span>;
  }

  const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
  // Per-component outstanding breakdown (only the non-zero ones), shown as a
  // compact line under the overall so admins see what makes up the total.
  const breakdown = [
    ["T1", summary.term1?.outstanding || 0],
    ["T2", summary.term2?.outstanding || 0],
    ["T3", summary.term3?.outstanding || 0],
    ["Adm", summary.application?.outstanding || 0],
    ["Trn", summary.transport?.outstanding || 0],
  ].filter(([, v]) => v > 0);

  return (
    <div style={{ display: "inline-flex", alignItems: "flex-start", gap: 8 }}>
      <button
        type="button"
        onClick={canEdit ? onEdit : undefined}
        disabled={!canEdit}
        title={canEdit ? "Click to edit the fee breakdown" : undefined}
        style={{
          background: "transparent", border: 0, padding: 0,
          cursor: canEdit ? "pointer" : "default",
          textAlign: "left", display: "inline-flex", flexDirection: "column", gap: 3,
          color: "var(--ink)",
        }}
      >
        {overallTotal > 0 ? (
          <FeeLine label="Overall" outstanding={overallOut} paid={overallPaid} canEdit={canEdit} showPencil />
        ) : (
          <FeeLine label="Overall" outstanding={0} paid={0} placeholder="not set" canEdit={canEdit} showPencil />
        )}
        {breakdown.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--ink-4)", marginLeft: 66, fontFamily: "var(--font-mono)" }}>
            {breakdown.map(([lbl, v]) => `${lbl} ${fmt(v)}`).join(" · ")}
          </span>
        )}
      </button>
      {undoable && canEdit && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onUndo?.(); }}
          title="Undo the last fee edit · available for 1 hour after the change"
          style={{
            height: 22, padding: "0 8px",
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: 10.5, fontWeight: 500,
            color: "var(--accent-2)", background: "var(--accent-soft)",
            border: "1px solid var(--accent)", borderRadius: 6,
            cursor: "pointer",
          }}
        >
          <Icon name="refresh" size={10} />Undo
        </button>
      )}
    </div>
  );
}

// One row inside FeeCell — label + amount + status pill. Used twice per
// student: once for academic, once for transport. Keeps FeeCell readable.
function FeeLine({ label, outstanding, paid, placeholder = null, canEdit = false, showPencil = false }) {
  const total = outstanding + paid;
  const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
  const status = placeholder
    ? "placeholder"
    : total === 0 ? "—" : outstanding === 0 ? "paid" : paid > 0 ? "partial" : "pending";
  const tone =
    status === "paid"    ? "var(--ok)"
    : status === "partial" ? "var(--warn)"
    : status === "pending" ? "var(--warn)"
    : "var(--ink-4)";

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1, lineHeight: 1.2 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{
          fontSize: 9.5, fontWeight: 600, color: "var(--ink-4)",
          textTransform: "uppercase", letterSpacing: "0.05em", minWidth: 60,
        }}>
          {label}
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, fontFamily: "var(--font-mono)" }}>
          {placeholder || fmt(outstanding)}
        </span>
        {!placeholder && (
          <span style={{
            height: 15, padding: "0 5px",
            display: "inline-flex", alignItems: "center",
            fontSize: 9, fontWeight: 500,
            color: tone, background: "transparent",
            border: `1px solid ${tone}`,
            borderRadius: 999,
            textTransform: "uppercase", letterSpacing: 0.4,
          }}>
            {status === "paid" ? "Paid" : status === "partial" ? "Partial" : "Due"}
          </span>
        )}
        {showPencil && canEdit && (
          <Icon name="pencil" size={9.5} style={{ color: "var(--ink-4)" }} />
        )}
      </span>
      {!placeholder && paid > 0 && (
        <span style={{ fontSize: 10, color: "var(--ink-4)", fontFamily: "var(--font-mono)", marginLeft: 66 }}>
          {fmt(paid)} paid of {fmt(total)}
        </span>
      )}
    </span>
  );
}

// Edit a student's fee breakdown — five components: Term I/II/III, Admission
// and Transport. Each input is that component's OUTSTANDING amount; the overall
// fee is their live sum. Saving writes each via /api/fees/components (0 clears
// it) and absorbs any legacy single-fee row so the total never double-counts.
function EditFeeModal({ student, summary, onClose, onSubmit }) {
  const COMPONENTS = [
    { key: "term1", label: "Term I" },
    { key: "term2", label: "Term II" },
    { key: "term3", label: "Term III" },
    { key: "application", label: "Admission" },
    { key: "transport", label: "Transport" },
  ];
  const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
  const cur = (k) => (summary[k]?.outstanding) || 0;
  const routeLabel = student.transport && student.transport !== "—" ? student.transport : null;

  const [vals, setVals] = useState(() => {
    const o = {};
    for (const c of COMPONENTS) o[c.key] = String(cur(c.key));
    return o;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setVal = (k, v) => setVals((s) => ({ ...s, [k]: String(v).replace(/[^\d]/g, "") }));
  const num = (k) => { const n = parseInt(vals[k] || "0", 10); return Number.isFinite(n) && n >= 0 ? n : 0; };

  const overall = COMPONENTS.reduce((s, c) => s + num(c.key), 0);
  const otherOutstanding = (summary.other?.outstanding) || 0;
  const paidSoFar = (summary.paid) || 0;
  const changed = COMPONENTS.some((c) => num(c.key) !== cur(c.key));
  const canSubmit = changed && !busy;

  const submit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setErr("");
    try {
      const payload = {};
      for (const c of COMPONENTS) payload[c.key] = num(c.key);
      await onSubmit(payload);
    } catch (ex) {
      setErr(ex?.message || "Update failed");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
        display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 460, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Edit fees · {student.name}</div>
            <div className="card-sub">{student.id} · set each component — the overall is their sum</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {COMPONENTS.map((c) => (
            <label key={c.key} style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 10, alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
                {c.label}
                {c.key === "transport" && routeLabel ? <span style={{ fontWeight: 400, color: "var(--ink-4)" }}> · {routeLabel}</span> : null}
                <span style={{ color: "var(--ink-4)", fontWeight: 400 }}> (₹)</span>
              </span>
              <input
                className="input"
                inputMode="numeric"
                value={vals[c.key]}
                onChange={(e) => setVal(c.key, e.target.value)}
                placeholder="0"
              />
            </label>
          ))}

          <div style={{
            background: "var(--accent-soft)", border: "1px solid var(--accent)",
            borderRadius: 8, padding: "11px 13px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ color: "var(--ink-2)", fontWeight: 600, fontSize: 13 }}>Overall fees</span>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{fmt(overall)}</span>
          </div>

          {otherOutstanding > 0 && (
            <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
              + {fmt(otherOutstanding)} in other fee items (Kit, ECA…) not editable here — still counted in this student's total due.
            </div>
          )}
          {paidSoFar > 0 && (
            <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
              {fmt(paidSoFar)} already collected (recorded on the Fees screen). Enter the amounts still outstanding above.
            </div>
          )}

          {err && (
            <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={!canSubmit}>
              <Icon name="check" size={13} />{busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FilterMenu({ classes = [], value, onPick, onClose }) {
  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest(".filter-menu") && !e.target.closest(".btn")) onClose();
    };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);
  // Value space matches classFilter — "All" or a stringified class number.
  const opts = [{ key: "All", label: "All" }, ...classes.map((c) => ({
    key: String(c.n), label: c.label || formatClassLabel(String(c.n)),
  }))];
  return (
    <div className="filter-menu" style={{
      position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50,
      background: "var(--card)", border: "1px solid var(--rule)", borderRadius: 10,
      boxShadow: "var(--shadow-lg)", padding: 6, minWidth: 160,
    }}>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "6px 10px 4px" }}>
        Filter by class
      </div>
      {opts.map((o) => (
        <button key={o.key} onClick={() => onPick(o.key)} className="btn ghost"
          style={{
            width: "100%", justifyContent: "flex-start", height: 30, padding: "0 10px",
            fontSize: 12.5, background: value === o.key ? "var(--accent-soft)" : "transparent",
            color: value === o.key ? "var(--accent-2)" : "var(--ink)", fontWeight: value === o.key ? 500 : 400,
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RowMenu({ student, anchor, canEdit, onClose, onView, onEdit, onTC, onMessage, onWithdraw, onRestore }) {
  // Close on outside click + on scroll/resize (the menu is fixed-positioned
  // relative to the trigger, so anything that moves the trigger should close it).
  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest(".row-menu") && !e.target.closest(".icon-btn")) onClose();
    };
    const onScrollOrResize = () => onClose();
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("click", onDoc);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [onClose]);

  const isArchived = student.__status === "archived";
  const items = [
    { label: "View profile", icon: "user", action: onView },
    ...(canEdit && !isArchived
      ? [{ label: "Edit details", icon: "pencil", action: onEdit }]
      : []),
    { label: "Message parent", icon: "whatsapp", action: onMessage, disabled: isArchived },
    { label: "Issue TC", icon: "book", action: onTC },
    isArchived
      ? { label: "Restore admission", icon: "refresh", action: onRestore }
      : { label: "Withdraw…", icon: "x", action: onWithdraw, danger: true },
  ];

  // Position the menu so its right edge aligns with the trigger's right edge
  // and it sits 6px below. If it would fall off the bottom of the viewport,
  // flip it above the trigger.
  const MENU_W = 200;
  const MENU_H = items.length * 32 + 8; // approx
  const wantsFlip = anchor.y + MENU_H + 16 > window.innerHeight;
  const top = wantsFlip ? Math.max(8, anchor.y - MENU_H - 24) : anchor.y + 6;
  const left = Math.max(8, anchor.x - MENU_W);

  return (
    <div className="row-menu" style={{
      position: "fixed", top, left, zIndex: 200, width: MENU_W,
      background: "var(--card)", border: "1px solid var(--rule)", borderRadius: 9,
      boxShadow: "var(--shadow-lg)", padding: 4,
    }}>
      {items.map((it) => (
        <button
          key={it.label}
          onClick={it.disabled ? undefined : it.action}
          className="btn ghost"
          disabled={it.disabled}
          style={{
            width: "100%", justifyContent: "flex-start", height: 30, padding: "0 10px",
            fontSize: 12.5, color: it.danger && !it.disabled ? "var(--bad)" : it.disabled ? "var(--ink-4)" : "var(--ink)",
            cursor: it.disabled ? "not-allowed" : "pointer",
          }}
        >
          <Icon name={it.icon} size={12} />{it.label}
        </button>
      ))}
    </div>
  );
}

function ModalShell({ title, sub, onClose, children, width = 460 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
        display: "grid", placeItems: "center", zIndex: 250, padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: width }}>
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

// Edit an existing student's core details. Mirrors the validation used by the
// admission form so back-and-forth edits don't smuggle in bad phone numbers.
function EditStudentModal({ student, classes = [], routes = [], students = [], onClose, onSubmit }) {
  const classList = classes.length ? classes : [{ n: 1, label: formatClassLabel("1"), sections: [ONLY_SECTION] }];
  const [initialClsN] = (() => {
    const [a] = String(student.cls || "1-A").split("-");
    return [a || "1"];
  })();
  const initialPhoneDigits = (student.parent || "").replace(/\D/g, "").slice(-10);

  // The school runs one stream per grade. Section stays "A" under the hood
  // so the cls field can keep its "N-A" shape, but we no longer ask the
  // admin to pick a section.
  const [form, setForm] = useState({
    name: student.name || "",
    cls: initialClsN,
    section: ONLY_SECTION,
    phoneDigits: initialPhoneDigits.length === 10 && /^[6-9]/.test(initialPhoneDigits) ? initialPhoneDigits : "",
    transport: student.transport || "—",
    pickupStop: student.pickupStop || "",
    transportEvening: student.transportEvening || "—",
    pickupStopEvening: student.pickupStopEvening || "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [touched, setTouched] = useState({});
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onPhoneChange = (e) => {
    const d = e.target.value.replace(/\D/g, "").slice(0, 10);
    set("phoneDigits", d);
  };
  const phoneError = (() => {
    if (!form.phoneDigits) return null; // optional — allowed to clear
    if (form.phoneDigits.length !== 10) return "Phone must be exactly 10 digits";
    if (!/^[6-9]/.test(form.phoneDigits)) return "Indian mobile numbers start with 6, 7, 8 or 9";
    return null;
  })();
  const phoneOk = !form.phoneDigits || (form.phoneDigits.length === 10 && /^[6-9]/.test(form.phoneDigits));
  const formValid = form.name.trim() && phoneOk;

  const submit = async (e) => {
    e.preventDefault();
    setTouched({ name: true, phone: true });
    if (!formValid) return;
    setBusy(true); setErr("");
    try {
      await onSubmit({
        id: student.id,
        name: form.name.trim(),
        cls: form.cls,
        section: form.section,
        parent: form.phoneDigits
          ? `+91 ${form.phoneDigits.slice(0, 5)} ${form.phoneDigits.slice(5)}`
          : "—",
        transport: form.transport,
        pickupStop: form.transport && form.transport !== "—" ? form.pickupStop || "" : "",
        transportEvening: form.transportEvening,
        pickupStopEvening: form.transportEvening && form.transportEvening !== "—" ? form.pickupStopEvening || "" : "",
      });
    } catch (ex) { setErr(ex.message || String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="Edit student" sub={`${student.id} · joined ${student.joined}`} onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Student full name *">
          <input
            className="input"
            autoFocus
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            style={touched.name && !form.name.trim() ? { borderColor: "var(--bad)" } : undefined}
          />
          {touched.name && !form.name.trim() && (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>Name is required</span>
          )}
        </Field>

        <Field label="Class">
          <select className="select" value={form.cls} onChange={(e) => set("cls", e.target.value)}>
            {classList.map((c) => <option key={c.n} value={c.n}>{c.label || formatClassLabel(String(c.n))}</option>)}
          </select>
        </Field>

        <Field label="Parent mobile (10 digits, Indian)">
          <div style={{
            display: "flex",
            border: "1px solid",
            borderColor: phoneError ? "var(--bad)" : "var(--rule)",
            borderRadius: 9, background: "var(--card)", overflow: "hidden", height: 34,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", padding: "0 10px",
              background: "var(--card-2)", borderRight: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink-3)",
            }}>+91</span>
            <input
              type="tel" inputMode="numeric" maxLength={10}
              value={form.phoneDigits}
              onChange={onPhoneChange}
              onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
              placeholder="98765 43210"
              style={{
                flex: 1, border: 0, background: "transparent", outline: "none",
                padding: "0 10px", fontSize: 13,
                fontFamily: "var(--font-mono)", letterSpacing: "0.05em",
              }}
            />
            <span style={{
              display: "inline-flex", alignItems: "center", padding: "0 10px",
              fontSize: 11, fontFamily: "var(--font-mono)",
              color: form.phoneDigits.length === 10 ? "var(--ok)" : "var(--ink-4)",
            }}>{form.phoneDigits.length}/10</span>
          </div>
          {touched.phone && phoneError && (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>{phoneError}</span>
          )}
          {!phoneError && !form.phoneDigits && (
            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Leave blank to clear the contact.</span>
          )}
        </Field>

        <TransportPicker
          label="Morning route"
          direction="morning"
          routes={routes}
          students={students}
          routeValue={form.transport}
          stopValue={form.pickupStop}
          onRouteChange={(v) => { set("transport", v); set("pickupStop", ""); }}
          onStopChange={(v) => set("pickupStop", v)}
        />
        <TransportPicker
          label="Evening route"
          direction="evening"
          routes={routes}
          students={students}
          routeValue={form.transportEvening}
          stopValue={form.pickupStopEvening}
          onRouteChange={(v) => { set("transportEvening", v); set("pickupStopEvening", ""); }}
          onStopChange={(v) => set("pickupStopEvening", v)}
          hint="If the evening van is the same as morning, just pick the same route here."
        />

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !formValid}>
            <Icon name="check" size={13} />{busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Mirrors termFeeFor() in app/api/students/route.js — kept in sync so the
// admission form can preview the suggested term fee per class.
const suggestedTermFee = (clsN) => 14000 + (Number(clsN) || 1) * 1000;

function AdmissionModal({ classes = [], routes = [], students = [], onClose, onSubmit }) {
  // Fall back to class 1 if the configured list is empty.
  const classList = classes.length ? classes : [{ n: 1, label: formatClassLabel("1"), sections: [ONLY_SECTION] }];
  const initialCls = String(classList[0].n);
  // Section is fixed to "A" — the school doesn't split grades into sections.
  const [form, setForm] = useState({
    name: "", cls: initialCls, section: ONLY_SECTION,
    phoneDigits: "",
    // Morning + evening transport are independent — the school runs different
    // buses for the two trips. Default both to "—" (no transport); the admin
    // assigns each separately. setting evening = "—" is a valid state.
    transport: "—", pickupStop: "",
    transportEvening: "—", pickupStopEvening: "",
    // Fee starts blank → uses the auto-suggested per-class amount on submit.
    // The admin can type a value to override (scholarship, sibling discount, etc).
    feeAmount: "",
  });
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState({});
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // ---- Indian phone helpers ----
  const onPhoneChange = (e) => {
    const onlyDigits = e.target.value.replace(/\D/g, "").slice(0, 10);
    set("phoneDigits", onlyDigits);
  };
  const phoneError = (() => {
    if (!form.phoneDigits) return null; // optional until user types
    if (form.phoneDigits.length !== 10) return "Phone must be exactly 10 digits";
    if (!/^[6-9]/.test(form.phoneDigits)) return "Indian mobile numbers start with 6, 7, 8 or 9";
    return null;
  })();
  const formattedPhone = form.phoneDigits.length === 10
    ? `+91 ${form.phoneDigits.slice(0, 5)} ${form.phoneDigits.slice(5)}`
    : "";
  const phoneOk = !form.phoneDigits || (form.phoneDigits.length === 10 && /^[6-9]/.test(form.phoneDigits));
  const suggestedFee = suggestedTermFee(form.cls);
  const feeNum = form.feeAmount === "" ? null : Math.floor(Number(form.feeAmount));
  const feeOk = feeNum === null || (Number.isFinite(feeNum) && feeNum >= 0);
  const formValid = form.name.trim() && phoneOk && feeOk;

  const submit = async (e) => {
    e.preventDefault();
    setTouched({ name: true, phone: true, fee: true });
    if (!formValid) return;
    setBusy(true);
    try {
      await onSubmit({
        name: form.name,
        cls: form.cls,
        section: form.section,
        parent: form.phoneDigits ? formattedPhone : "",
        transport: form.transport,
        pickupStop: form.transport && form.transport !== "—" ? form.pickupStop || "" : "",
        transportEvening: form.transportEvening,
        pickupStopEvening: form.transportEvening && form.transportEvening !== "—" ? form.pickupStopEvening || "" : "",
        // Omit when blank so the API uses the auto-derived per-class fee.
        feeAmount: feeNum === null ? undefined : feeNum,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="New admission" sub="Auto-assigned ID · auto fee schedule" onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Student full name *">
          <input
            className="input"
            autoFocus
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            placeholder="e.g. Anaika Sharma"
            style={touched.name && !form.name.trim() ? { borderColor: "var(--bad)" } : undefined}
          />
          {touched.name && !form.name.trim() && (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>Name is required</span>
          )}
        </Field>

        <Field label="Class">
          <select className="select" value={form.cls} onChange={(e) => set("cls", e.target.value)}>
            {classList.map((c) => <option key={c.n} value={c.n}>{c.label || formatClassLabel(String(c.n))}</option>)}
          </select>
        </Field>

        <Field label="Term fee (₹)">
          <div style={{
            display: "flex", alignItems: "center", height: 34,
            border: "1px solid", borderColor: feeOk ? "var(--rule)" : "var(--bad)",
            borderRadius: 9, background: "var(--card)", overflow: "hidden",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", padding: "0 10px",
              background: "var(--card-2)", borderRight: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink-3)",
            }}>₹</span>
            <input
              type="text"
              inputMode="numeric"
              value={form.feeAmount}
              onChange={(e) => set("feeAmount", e.target.value.replace(/\D/g, ""))}
              onBlur={() => setTouched((t) => ({ ...t, fee: true }))}
              placeholder={String(suggestedFee)}
              style={{
                flex: 1, border: 0, background: "transparent", outline: "none",
                padding: "0 10px", fontSize: 13,
                fontFamily: "var(--font-mono)", letterSpacing: "0.05em",
              }}
            />
            <button
              type="button"
              onClick={() => set("feeAmount", "")}
              title="Use suggested term fee for this class"
              style={{
                background: "none", border: 0, color: "var(--accent)",
                fontSize: 11, fontWeight: 500, cursor: "pointer",
                padding: "0 10px", height: "100%",
              }}
            >
              Reset
            </button>
          </div>
          <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
            {form.feeAmount === ""
              ? <>Suggested ₹{suggestedFee.toLocaleString("en-IN")} for {formatClassLabel(form.cls)}. Type to override (scholarship, sibling discount, etc).</>
              : feeNum === 0
                ? <>No pending fee will be raised for this admission.</>
                : <>Outstanding will be set to ₹{feeNum.toLocaleString("en-IN")}.</>}
          </span>
        </Field>

        <Field label="Parent mobile (10 digits, Indian)">
          <div style={{
            display: "flex",
            border: "1px solid",
            borderColor: phoneError ? "var(--bad)" : "var(--rule)",
            borderRadius: 9,
            background: "var(--card)",
            overflow: "hidden",
            height: 34,
          }}>
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0 10px",
              background: "var(--card-2)",
              borderRight: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              color: "var(--ink-3)",
            }}>+91</span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              value={form.phoneDigits}
              onChange={onPhoneChange}
              onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
              placeholder="98765 43210"
              style={{
                flex: 1,
                border: 0,
                background: "transparent",
                outline: "none",
                padding: "0 10px",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.05em",
              }}
            />
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0 10px",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: form.phoneDigits.length === 10 ? "var(--ok)" : "var(--ink-4)",
            }}>{form.phoneDigits.length}/10</span>
          </div>
          {touched.phone && phoneError && (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>{phoneError}</span>
          )}
          {!phoneError && formattedPhone && (
            <span style={{ fontSize: 11, color: "var(--ok)" }}>Saved as {formattedPhone}</span>
          )}
        </Field>

        <TransportPicker
          label="Morning route"
          direction="morning"
          routes={routes}
          students={students}
          routeValue={form.transport}
          stopValue={form.pickupStop}
          onRouteChange={(v) => { set("transport", v); set("pickupStop", ""); }}
          onStopChange={(v) => set("pickupStop", v)}
        />
        <TransportPicker
          label="Evening route"
          direction="evening"
          routes={routes}
          students={students}
          routeValue={form.transportEvening}
          stopValue={form.pickupStopEvening}
          onRouteChange={(v) => { set("transportEvening", v); set("pickupStopEvening", ""); }}
          onStopChange={(v) => set("pickupStopEvening", v)}
          hint="If the evening van is the same as morning, just pick the same route here."
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !formValid}>
            <Icon name="check" size={13} />{busy ? "Admitting…" : "Admit student"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Render the Transport column in the Students table. Collapses to a
// single line when morning == evening (or evening is unset); shows
// "AM RT-1 · PM RT-2" when the two trips use different routes — the
// common case for schools that pool buses across the catchment.
function TransportCell({ student }) {
  const am = student.transport && student.transport !== "—" ? student.transport : null;
  const pm = student.transportEvening && student.transportEvening !== "—" ? student.transportEvening : null;

  if (!am && !pm) return "—";
  if (am && (!pm || am === pm)) return am;
  if (!am && pm) return <><span style={{ color: "var(--ink-4)" }}>PM</span> {pm}</>;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
      <span><span style={{ color: "var(--ink-4)", fontSize: 10.5, marginRight: 4 }}>AM</span>{am}</span>
      <span><span style={{ color: "var(--ink-4)", fontSize: 10.5, marginRight: 4 }}>PM</span>{pm}</span>
    </span>
  );
}

// Reusable route + stop picker. Filters the route list by direction —
// the AM picker only surfaces routes tagged morning/both, the PM picker
// only evening/both. Counts seat occupancy across the matching direction
// only (a student on RT-1-morning and RT-2-evening is one occupant on
// each). The `direction` arg drives which side of each student row to
// read for occupancy.
function TransportPicker({
  label, direction = "morning",
  routes = [], students = [],
  routeValue, stopValue,
  onRouteChange, onStopChange,
  hint,
}) {
  const routeOf  = (s) => direction === "evening" ? s.transportEvening : s.transport;
  const stopOf   = (s) => direction === "evening" ? s.pickupStopEvening : s.pickupStop;
  // Filter routes by direction. "both" routes appear in either picker.
  // A route from before the migration (no direction column) defaults to
  // "both" via the mapper, so legacy data keeps working.
  const eligibleRoutes = routes.filter((r) => {
    const d = r.direction || "both";
    return d === "both" || d === direction;
  });
  const routeStats = eligibleRoutes.map((r) => {
    const totalCap = (r.stops || []).reduce((a, s) => a + (Number(s.cap) || 0), 0);
    const taken    = students.filter((s) => routeOf(s) === r.code).length;
    const free     = Math.max(0, totalCap - taken);
    return { route: r, totalCap, taken, free };
  });
  const anyFree = routeStats.some((rs) => rs.free > 0);
  const fallbackHint = eligibleRoutes.length === 0
    ? `No ${direction === "evening" ? "evening" : "morning"} routes set up yet — add one from Transport`
    : anyFree ? "Only routes with free seats are selectable" : "All routes are full — capacity has to be increased on Transport";

  const activeRoute = eligibleRoutes.find((r) => r.code === routeValue);
  const stops = activeRoute?.stops || [];
  const stopStats = stops.map((s) => {
    const taken = students.filter((st) => routeOf(st) === activeRoute.code && stopOf(st) === s.name).length;
    const cap   = Number(s.cap) || 0;
    const free  = cap > 0 ? Math.max(0, cap - taken) : null;
    return { stop: s, taken, cap, free };
  });

  return (
    <>
      <Field label={label} hint={hint || fallbackHint}>
        <select
          className="select"
          value={routeValue}
          onChange={(e) => onRouteChange(e.target.value)}
        >
          <option value="—">No transport</option>
          {routeStats.map(({ route: r, totalCap, free }) => (
            <option
              key={r.code}
              value={r.code}
              disabled={totalCap > 0 && free === 0}
            >
              {r.code} · {r.name}
              {totalCap > 0
                ? ` · ${free === 0 ? "FULL" : `${free} seats free`} (of ${totalCap})`
                : " · capacity not set"}
            </option>
          ))}
        </select>
      </Field>
      {routeValue && routeValue !== "—" && stops.length > 0 && (
        <Field label={`Pickup stop · ${label.toLowerCase()}`} hint="Stops marked FULL have already hit their per-stop capacity">
          <select
            className="select"
            value={stopValue || ""}
            onChange={(e) => onStopChange(e.target.value)}
          >
            <option value="">— pick a stop —</option>
            {stopStats.map(({ stop: s, cap, free }) => (
              <option
                key={s.name}
                value={s.name}
                disabled={free === 0}
              >
                {s.name} · {s.t}
                {cap > 0
                  ? ` · ${free === 0 ? "FULL" : `${free} of ${cap} free`}`
                  : " · open"}
              </option>
            ))}
          </select>
        </Field>
      )}
    </>
  );
}

// Shown right after a successful bulk import. Lists every generated
// parent login (email + password) and offers a one-click CSV download
// so the admin can distribute credentials to parents via WhatsApp /
// email / printed slip. The credentials only appear here once — after
// closing, the password is no longer recoverable (it's hashed in the
// users table), so admins are encouraged to download before dismissing.
function BulkLoginsModal({ logins, onClose, flash }) {
  const count = logins.length;

  const downloadCsv = () => {
    const escape = (v) => {
      const s = String(v ?? "");
      // Quote anything that has a comma / quote / newline, double internal quotes.
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
    <ModalShell
      title={`${count} parent login${count === 1 ? "" : "s"} created`}
      subtitle="Download the CSV now — passwords are hashed after this dialog closes and can't be recovered."
      onClose={onClose}
    >
      <div style={{ padding: "16px 20px 8px", display: "flex", flexDirection: "column", gap: 12 }}>
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
          maxHeight: 320, overflowY: "auto",
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          <button className="btn ghost" onClick={onClose}>I've saved these</button>
          <button className="btn accent" onClick={downloadCsv}>
            <Icon name="download" size={13} />Download CSV
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ImportModal({ onClose, onFile }) {
  const [file, setFile] = useState(null);
  // Three-state flow so the user always knows where they are:
  //   'idle'      → showing the file picker; admin can choose / change file
  //   'importing' → submit ran, waiting on the server (large files = ~30s+)
  //   'done'      → success card with counts + "Done" button. Modal does
  //                 NOT auto-close — the admin reads the summary, closes
  //                 manually, and the parent has already refreshed the
  //                 page data in the background.
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null); // {count, logins, feesIssued, feesSkipped, errors} once 'done'
  const inputRef = useRef(null);
  // Sample CSV admins can download as a starting point. Includes every
  // column the importer actually reads, with realistic examples:
  //   - Class: Roman, numeric+section, and pre-school formats all work
  //   - Fees:  per-student amounts; leave blank to skip fee creation
  const sampleCsv =
    "Name,Class,Parent,Transport,Fees\n" +
    "Isha Sharma,3-A,+91 9876543210,R1,18000\n" +
    "Kabir Khan,V,+91 9988776655,—,22000\n" +
    "Aarav Patel,PRE-MONT,+91 9000011111,Yes,12000\n";
  const downloadSample = () => {
    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "students-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <ModalShell
      title={phase === "done" ? "Import successful" : "Import students"}
      sub={
        phase === "done"
          ? "The new rows are already on screen — close this dialog to continue."
          : "Bulk-add via CSV or Excel · columns: Name, Class, Parent, Transport, Fees (Fees optional)"
      }
      onClose={phase === "importing" ? () => {} : onClose}
      width={520}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {phase === "done" && result ? (
          <ImportSuccessCard
            result={result}
            label="student"
            extras={(() => {
              const out = [];
              const loginCount = (result.logins || []).length;
              if (loginCount > 0) out.push({ k: "Parent logins", v: loginCount });
              if (typeof result.feesIssued === "number") {
                out.push({
                  k: "Fees set",
                  v: result.feesIssued + (result.feesSkipped ? ` (${result.feesSkipped} blank)` : ""),
                });
              }
              return out;
            })()}
          />
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
                {file ? `${(file.size / 1024).toFixed(1)} KB` : ".csv / .xlsx up to a few hundred rows"}
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
              Need a starting point? <a onClick={downloadSample} style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}>Download a sample template</a>.
            </div>
            {phase === "importing" && (
              <ImportingBanner label="Importing students and creating parent logins… this may take up to a minute for large files." />
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
              <button
                className="btn accent"
                disabled={!file || phase === "importing"}
                onClick={async () => {
                  if (!file) return;
                  setPhase("importing");
                  try {
                    const json = await onFile(file);
                    setResult(json);
                    setPhase("done");
                  } catch {
                    setPhase("idle");
                  }
                }}
              >
                {phase === "importing" ? (
                  <>
                    <span className="spinner-inline" style={{
                      width: 12, height: 12, borderRadius: "50%",
                      border: "2px solid currentColor", borderTopColor: "transparent",
                      display: "inline-block", animation: "spin 0.8s linear infinite",
                    }} />
                    Importing…
                  </>
                ) : (
                  <>
                    <Icon name="upload" size={13} />Import {file ? "" : "(pick a file)"}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// Shared "Importing…" banner — same shape used by every import modal so
// progress feedback is consistent. Caller passes a screen-specific label
// so the message reads honestly ("Importing topics", "Importing books").
function ImportingBanner({ label }) {
  return (
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
      {label}
      <style jsx>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// Shared success card shown by every import modal once the server
// responds 200. The parent's data refresh has already run by the time
// we render this, so the table behind the modal is already up to date —
// the success card is the explicit "you can stop staring at the
// spinner" signal. Lists the headline count plus screen-specific
// extras (parent logins, fees set, etc.) and any skipped rows.
function ImportSuccessCard({ result, label = "row", extras = [] }) {
  const count = Number(result?.count ?? result?.imported?.length ?? 0);
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 12,
      padding: "16px 18px",
      background: "var(--ok-soft, #e6f4ec)",
      border: "1px solid var(--ok, #2f8854)",
      borderRadius: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 30, height: 30, borderRadius: "50%",
          background: "var(--ok, #2f8854)", color: "#fff",
          display: "grid", placeItems: "center", flexShrink: 0,
        }}>
          <Icon name="check" size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            Import successful
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            {count} {label}{count === 1 ? "" : "s"} imported · the table behind this dialog is already updated.
          </div>
        </div>
      </div>
      {extras.length > 0 && (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8,
          paddingTop: 6, borderTop: "1px solid var(--ok, #2f8854)",
        }}>
          {extras.map((x) => (
            <div key={x.k}>
              <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{x.k}</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{x.v}</div>
            </div>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div style={{
          fontSize: 11.5, color: "var(--ink-2)",
          background: "var(--warn-soft, #fff4e2)",
          border: "1px solid var(--warn, #d4944e)",
          padding: "8px 10px", borderRadius: 7,
          lineHeight: 1.5,
        }}>
          <strong>{errors.length} row{errors.length === 1 ? "" : "s"} skipped:</strong>{" "}
          {errors.slice(0, 5).map((e) => e.name || `row ${e.row}`).join(", ")}
          {errors.length > 5 ? ` +${errors.length - 5} more` : ""}
        </div>
      )}
    </div>
  );
}

function ConfirmArchive({ student, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 460 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Withdraw {student.name}?</div>
            <div className="card-sub">{student.id} · {formatClassLabel(student.cls)}</div>
          </div>
          <button className="icon-btn" onClick={onCancel}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.55 }}>
            They&apos;ll move to the <b>Archived</b> list and stop appearing in the active roster, Fees, and Academic.
          </div>
          <div style={{ background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 9, padding: 12, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
            <div style={{ fontWeight: 500, color: "var(--ink)", marginBottom: 4 }}>Records that stay forever:</div>
            <div>• Paid fee receipts (Money ledger)</div>
            <div>• Daily logs (academic record)</div>
            <div>• Audit log entries</div>
            <div style={{ marginTop: 8, fontWeight: 500, color: "var(--ink)" }}>Cancelled:</div>
            <div>• Any uncollected pending fee for this term</div>
            <div style={{ marginTop: 8, color: "var(--ink-3)" }}>You can restore them any time from the Archived tab.</div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="btn" style={{ background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" }} onClick={submit} disabled={busy}>
              <Icon name="x" size={13} />{busy ? "Withdrawing…" : "Withdraw student"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileModal({ student, onClose, onMessage, onTC, hideContact = false, school }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pull the full 360° report (fees, academics, extras) on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/students/${encodeURIComponent(student.id)}/report`, { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) setReport(j.ok ? j.report : null);
      } catch { if (!cancelled) setReport(null); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [student.id]);

  const phoneDigits = (student.parent || "").replace(/\D/g, "");
  const money0 = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
  const dfmt = (d) => {
    if (!d) return "—";
    const x = new Date(String(d).length <= 10 ? `${d}T00:00:00` : d);
    return isNaN(x.getTime()) ? String(d) : x.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  };

  const fees = report?.fees;
  const att = report?.attendance?.summary;
  const feeTone = fees ? (fees.pendingTotal > 0 ? "warn" : "ok") : (student.fee === "paid" ? "ok" : student.fee === "overdue" ? "bad" : "warn");
  const attPct = att?.attendancePct != null ? `${att.attendancePct}%` : `${student.attendance ?? 0}%`;
  const feeValue = fees ? (fees.pendingTotal > 0 ? `${money0(fees.pendingTotal)} due` : "Paid") : (student.fee || "—");

  function downloadReport() {
    if (!report) return;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const s = report.student || student;
    const schoolName = school?.name || "Sanfort International School";
    const cell = (v, num) => `<td style="padding:4px 6px;border-bottom:1px solid #eee;${num ? "text-align:right" : ""}">${esc(v)}</td>`;
    const th = (h) => `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid #bbb;color:#555;font-weight:600">${esc(h)}</th>`;
    const table = (headers, rowsArr) => `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:4px"><thead><tr>${headers.map(th).join("")}</tr></thead><tbody>${rowsArr.length ? rowsArr.join("") : `<tr><td colspan="${headers.length}" style="padding:6px;color:#999">None</td></tr>`}</tbody></table>`;
    const sec = (t, inner) => `<h3 style="margin:16px 0 4px;color:#1f3a8a;font-size:13px">${esc(t)}</h3>${inner}`;

    const receipts = report.fees.receipts.map((f) => `<tr>${cell(dfmt(f.paidAt || f.paid_at))}${cell(feeTypeLabel(f.feeType))}${cell(f.method || "—")}${cell(money0(f.amount), true)}</tr>`);
    const pending = report.fees.pending.map((f) => `<tr>${cell(feeTypeLabel(f.feeType))}${cell(f.due || "—")}${cell(money0(f.amount), true)}</tr>`);
    const marksRows = report.examMarks.map((m) => { const e = m.exam || {}; return `<tr>${cell(e.name || e.subject || "—")}${cell(e.subject || "—")}${cell(dfmt(e.date || m.recordedAt))}${cell(`${m.score}/${m.maxMarks || e.maxMarks || "—"}`, true)}</tr>`; });
    const remarkRows = report.remarks.map((r) => `<tr>${cell(dfmt(r.createdAt))}${cell(r.type)}${cell(r.category || "—")}${cell(r.description)}</tr>`);
    const actRows = report.activities.map((a) => `<tr>${cell(dfmt(a.activityDate))}${cell(a.activityName)}${cell(a.eventName || "—")}${cell(a.achievementLevel || "—")}</tr>`);
    const a = report.attendance.summary;

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} — Student Report</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 16px">
  <div style="text-align:center;border-bottom:2px solid #1f3a8a;padding-bottom:10px;margin-bottom:14px">
    <div style="font-size:18px;font-weight:800;color:#1f3a8a">${esc(schoolName)}</div>
    <div style="font-size:13px;margin-top:4px">Student Report</div>
  </div>
  <table style="width:100%;font-size:12px;margin-bottom:6px;border-collapse:collapse">
    <tr><td style="padding:2px 0"><b>Name:</b> ${esc(s.name)}</td><td style="padding:2px 0"><b>Admission No:</b> ${esc(s.id)}</td></tr>
    <tr><td style="padding:2px 0"><b>Class:</b> ${esc(formatClassLabel(s.cls))}</td><td style="padding:2px 0"><b>Joined:</b> ${esc(s.joined || "—")}</td></tr>
    ${hideContact ? "" : `<tr><td style="padding:2px 0"><b>Parent:</b> ${esc(s.parent || "—")}</td><td style="padding:2px 0"><b>Transport:</b> ${esc(s.transport || "—")}</td></tr>`}
  </table>
  ${sec("Attendance", `<div style="font-size:12px">Present ${a.present} · Late ${a.late} · Absent ${a.absent} · Leave ${a.leave} · Marked ${a.marked} · Attendance ${a.attendancePct ?? "—"}%</div>`)}
  ${sec(`Fees — Paid receipts (Total ${money0(report.fees.paidTotal)})`, table(["Date", "Fee type", "Method", "Amount"], receipts))}
  ${sec(`Fees — Pending (Total ${money0(report.fees.pendingTotal)})`, table(["Fee type", "Due", "Amount"], pending))}
  ${sec("Academics — Exam & test marks", table(["Assessment", "Subject", "Date", "Score"], marksRows))}
  ${sec("Remarks & rewards", table(["Date", "Type", "Category", "Note"], remarkRows))}
  ${sec("Activities & achievements", table(["Date", "Activity", "Event", "Level"], actRows))}
  <div style="margin-top:24px;font-size:10px;color:#999;text-align:center">Generated ${esc(new Date().toLocaleString("en-IN"))}</div>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) { alert("Allow pop-ups to download the report"); return; }
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch {} }, 400);
  }

  const List = ({ rows, empty }) => rows.length === 0
    ? <div style={{ fontSize: 12, color: "var(--ink-4)" }}>{empty}</div>
    : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{rows}</div>;

  return (
    <div className="modal-backdrop"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto" }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 760, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        {/* Header */}
        <div style={{ padding: "22px 24px", display: "flex", alignItems: "center", gap: 16, borderBottom: "1px solid var(--rule-2)" }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "var(--accent-ink)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 20 }}>
            {student.name.split(" ").map((n) => n[0]).join("")}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", fontFamily: "var(--font-serif)" }}>{student.name}</span>
              {student.__added && <span className="chip ok" style={{ fontSize: 10, height: 20 }}><span className="dot" />new admission</span>}
            </div>
            <div style={{ color: "var(--ink-3)", fontSize: 12.5, marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="mono">{student.id}</span>
              <span className="meta-dot">·</span>
              <span>{formatClassLabel(student.cls)}</span>
              <span className="meta-dot">·</span>
              <span>Joined {student.joined}</span>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} style={{ alignSelf: "flex-start" }}><Icon name="x" size={14} /></button>
        </div>

        {/* Stats row (real) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid var(--rule-2)" }}>
          <Stat label="Attendance" value={attPct} tone={att && att.attendancePct != null ? (att.attendancePct < 85 ? "warn" : "ok") : "ok"} />
          <Stat label="Fees" value={feeValue} tone={feeTone} />
          <Stat label="Transport" value={student.transport || "—"} />
          <Stat label="Class" value={formatClassLabel(student.cls)} />
        </div>

        {loading && <div style={{ padding: 24, textAlign: "center", color: "var(--ink-3)", fontSize: 13 }}>Loading full profile…</div>}

        {!loading && report && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            {/* Left column */}
            <div style={{ padding: "20px 22px", borderRight: "1px solid var(--rule-2)", display: "flex", flexDirection: "column", gap: 18 }}>
              <ProfileSection title="Parent contact">
                {hideContact ? (
                  <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Hidden</div>
                ) : student.parent && student.parent !== "—" ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
                      <Icon name="phone" size={14} style={{ color: "var(--ink-3)" }} />
                      <span className="mono">{student.parent}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                      <button className="btn sm" onClick={() => window.open(`tel:${student.parent.replace(/\s/g, "")}`, "_self")}><Icon name="phone" size={11} />Call</button>
                      <button className="btn sm accent" onClick={onMessage}><Icon name="whatsapp" size={11} />WhatsApp</button>
                    </div>
                  </>
                ) : <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No parent contact on file.</div>}
              </ProfileSection>

              <ProfileSection title="Attendance summary">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[["Present", att.present, "var(--ok)"], ["Late", att.late, "var(--warn, #b07a18)"], ["Absent", att.absent, "var(--err, #b13c1c)"], ["Leave", att.leave, "var(--accent-2)"]].map(([l, n, c]) => (
                    <div key={l} style={{ flex: "1 1 60px", textAlign: "center", padding: "7px 4px", borderRadius: 8, background: "var(--card-2)" }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: c }}>{n}</div>
                      <div style={{ fontSize: 9.5, color: "var(--ink-3)", textTransform: "uppercase" }}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>{att.marked} days marked · {att.attendancePct ?? "—"}% attendance</div>
              </ProfileSection>

              <ProfileSection title="Activities & achievements">
                <List empty="No activities recorded." rows={report.activities.slice(0, 8).map((a) => (
                  <div key={a.id} style={{ fontSize: 12 }}>
                    <div style={{ fontWeight: 500 }}>{a.activityName}{a.achievementLevel ? <span className="chip ok" style={{ marginLeft: 6, fontSize: 9.5 }}>{a.achievementLevel}</span> : null}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-4)" }}>{[a.eventName, dfmt(a.activityDate)].filter(Boolean).join(" · ")}</div>
                  </div>
                ))} />
              </ProfileSection>

              <ProfileSection title="Documents">
                <DocumentsPanel entityType="student" entityId={student.id} canEdit compact />
              </ProfileSection>
            </div>

            {/* Right column */}
            <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
              <ProfileSection title={`Fees · ${money0(fees.paidTotal)} paid · ${money0(fees.pendingTotal)} due`}>
                <List empty="No fee records." rows={[
                  ...report.fees.receipts.slice(0, 8).map((f) => (
                    <div key={f.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "var(--ink-3)" }}>{feeTypeLabel(f.feeType)} · {f.method || "—"} · {dfmt(f.paidAt || f.paid_at)}</span>
                      <span style={{ color: "var(--ok)", fontWeight: 600 }}>+{money0(f.amount)}</span>
                    </div>
                  )),
                  ...report.fees.pending.map((f) => (
                    <div key={f.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "var(--ink-3)" }}>{feeTypeLabel(f.feeType)} · due {f.due || "—"}</span>
                      <span style={{ color: "var(--err, #b13c1c)", fontWeight: 600 }}>{money0(f.amount)}</span>
                    </div>
                  )),
                ]} />
              </ProfileSection>

              <ProfileSection title="Exam & test marks">
                <List empty="No marks recorded yet." rows={report.examMarks.slice(0, 10).map((m) => {
                  const e = m.exam || {};
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "var(--ink-3)" }}>{e.name || e.subject || "Assessment"}{e.subject && e.name ? ` · ${e.subject}` : ""}</span>
                      <span style={{ fontWeight: 600 }}>{m.score}/{m.maxMarks || e.maxMarks || "—"}</span>
                    </div>
                  );
                })} />
              </ProfileSection>

              <ProfileSection title="Remarks & rewards">
                <List empty="No remarks or rewards." rows={report.remarks.slice(0, 8).map((r) => (
                  <div key={r.id} style={{ fontSize: 12 }}>
                    <div><span className={`chip ${r.type === "reward" ? "ok" : "warn"}`} style={{ fontSize: 9.5 }}>{r.type}</span> <span style={{ color: "var(--ink-4)", fontSize: 11 }}>{r.category || ""} · {dfmt(r.createdAt)}</span></div>
                    <div style={{ color: "var(--ink-3)" }}>{r.description}</div>
                  </div>
                ))} />
              </ProfileSection>
            </div>
          </div>
        )}

        {!loading && !report && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--err, #b13c1c)", fontSize: 13 }}>Couldn't load this student's full profile.</div>
        )}

        {/* Footer actions */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--rule-2)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn accent" onClick={downloadReport} disabled={!report} title="Open a printable full report (save as PDF)"><Icon name="download" size={12} />Download report</button>
          <button className="btn" onClick={onTC}><Icon name="book" size={12} />Issue TC</button>
          {phoneDigits && <button className="btn" onClick={onMessage}><Icon name="whatsapp" size={12} />Message parent</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--bad)" : "var(--ink)";
  return (
    <div style={{ padding: "14px 18px", borderRight: "1px solid var(--rule-2)" }}>
      <div style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>{label}</div>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginTop: 4, letterSpacing: "-0.02em", color }}>{value}</div>
    </div>
  );
}

function ProfileSection({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 500, marginBottom: 10 }}>
        {title}
      </div>
      {children}
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

// Tiny focused phone-only edit dialog. Reuses the same Indian-mobile
// validation as the full edit form so the API never sees a malformed
// number. Submitting calls submitEdit({ id, parent }) — empty input
// stores "—" (clears the contact).
function EditPhoneModal({ student, onClose, onSubmit }) {
  const initialDigits = String(student.parent || "").replace(/\D/g, "").slice(-10);
  const [digits, setDigits] = useState(
    initialDigits.length === 10 && /^[6-9]/.test(initialDigits) ? initialDigits : ""
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");

  const phoneError = (() => {
    if (!digits) return null; // optional — empty clears the contact
    if (digits.length !== 10) return "Phone must be exactly 10 digits";
    if (!/^[6-9]/.test(digits)) return "Indian mobile numbers start with 6, 7, 8 or 9";
    return null;
  })();

  const formatted = digits.length === 10
    ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`
    : "";

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (phoneError) { setErr(phoneError); return; }
    setBusy(true); setErr("");
    try {
      // Empty digits → save "—" so the API clears the contact.
      await onSubmit(digits ? formatted : "—");
    } catch (ex) {
      setErr(ex.message || String(ex));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Edit parent phone"
      sub={`${student.id} · ${student.name}`}
      onClose={onClose}
      width={420}
    >
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Parent mobile (10 digits, Indian)">
          <div style={{
            display: "flex",
            border: "1px solid",
            borderColor: phoneError ? "var(--bad)" : "var(--rule)",
            borderRadius: 9, background: "var(--card)", overflow: "hidden", height: 38,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", padding: "0 12px",
              background: "var(--card-2)", borderRight: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-3)",
            }}>+91</span>
            <input
              type="tel" inputMode="numeric" maxLength={10}
              autoFocus
              value={digits}
              onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="98765 43210"
              style={{
                flex: 1, border: 0, background: "transparent", outline: "none",
                padding: "0 12px", fontSize: 14,
                fontFamily: "var(--font-mono)", letterSpacing: "0.05em",
              }}
            />
            <span style={{
              display: "inline-flex", alignItems: "center", padding: "0 12px",
              fontSize: 11, fontFamily: "var(--font-mono)",
              color: digits.length === 10 ? "var(--ok)" : "var(--ink-4)",
            }}>{digits.length}/10</span>
          </div>
          {phoneError ? (
            <span style={{ fontSize: 11, color: "var(--bad)" }}>{phoneError}</span>
          ) : digits ? (
            <span style={{ fontSize: 11, color: "var(--ok)" }}>Saves as {formatted}</span>
          ) : (
            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Leave blank to clear the contact.</span>
          )}
        </Field>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !!phoneError}>
            <Icon name="check" size={13} />{busy ? "Saving…" : "Save phone"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Shown once after admission whenever a fresh parent account was minted by
// the API. Staff can copy email + password and hand them to the parent.
// Compose-and-send WhatsApp message to a parent. Uses Evolution API directly
// via /api/parents/message. Template suggestions can be picked or edited.
function MessageParentModal({ student, onClose, flash }) {
  const TEMPLATES = [
    {
      label: "General check-in",
      body: `Dear Parent,\n\nThis is a quick note from Sanfort International School regarding ${student.name} (${formatClassLabel(student.cls)}). Please feel free to reach out if you have any questions.\n\n— Sanfort International School`,
    },
    {
      label: "Request a meeting",
      body: `Dear Parent,\n\nWe would like to meet with you regarding ${student.name} (${formatClassLabel(student.cls)}). Please let us know a convenient time this week.\n\n— Sanfort International School`,
    },
    {
      label: "Attendance follow-up",
      body: `Dear Parent,\n\n${student.name} (${formatClassLabel(student.cls)}) was marked absent recently. Kindly let us know the reason or share an update.\n\n— Sanfort International School`,
    },
  ];
  const [body, setBody] = useState(TEMPLATES[0].body);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function send() {
    if (!body.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/parents/message", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          studentId: student.id,
          studentName: student.name,
          cls: student.cls,
          message: body.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Send failed");
      flash(`Message sent to ${student.name}'s parent dashboard`);
      onClose();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 540 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Message {student.name}'s parent</div>
            <div className="card-sub">{student.id} · {formatClassLabel(student.cls)} · delivered to the parent dashboard</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "var(--bg-2)", padding: 10, borderRadius: 7, fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
            This message will appear on the parent's dashboard in the <b>From the school</b> card. It is not sent over WhatsApp or SMS.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {TEMPLATES.map((t) => (
              <button key={t.label} type="button" className="btn sm ghost" onClick={() => setBody(t.body)}>
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            className="input"
            style={{ width: "100%", height: 180, padding: "10px 12px", lineHeight: 1.5, resize: "vertical", fontSize: 12.5 }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type your message…"
          />
          {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn accent" onClick={send} disabled={busy || !body.trim()}>
              <Icon name="megaphone" size={12} />{busy ? "Sending…" : "Send to dashboard"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Quick TC request modal — collects a reason and POSTs to /api/tc so the
// new request shows up in the Transfer Certificates screen for the
// principal to approve.
function IssueTcModal({ student, onClose, onIssued, flash }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/tc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          studentId: student.id,
          studentName: student.name,
          cls: student.cls,
          reason: reason.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      flash(`TC request ${j.request.id} created · see Transfer certificates`);
      await onIssued?.();
      onClose();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 460 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Issue TC for {student.name}?</div>
            <div className="card-sub">{student.id} · {formatClassLabel(student.cls)}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "var(--bg-2)", padding: 12, borderRadius: 8, fontSize: 12, color: "var(--ink-3)" }}>
            This creates a TC request that will appear in the <b>Transfer Certificates</b> screen for the principal to approve and issue.
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Reason (optional)</span>
            <textarea
              className="input"
              style={{ width: "100%", height: 80, padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Family relocation, change of school"
            />
          </label>
          {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn accent" onClick={submit} disabled={busy}>
              <Icon name="book" size={12} />{busy ? "Submitting…" : "Submit TC request"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
