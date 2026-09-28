"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import Sidebar, { NAV_BY_ROLE, getAllowedNavIds } from "./Sidebar";
import MobileShell from "./MobileShell";
import Tweaks from "./Tweaks";
import GlobalSearch from "./GlobalSearch";
import NotificationsPanel, { buildAlerts } from "./NotificationsPanel";
import dynamic from "next/dynamic";
// Client-only mount — bypasses Next.js's default SSR pass for client
// components. Hydration mismatches elsewhere on the page (date/time
// formatters in the parent dashboard, etc.) corrupt the React tree in
// production-minified mode; mounting the popup outside the SSR pipeline
// guarantees it boots cleanly regardless.
const TransportEventPopup = dynamic(() => import("./TransportEventPopup"), { ssr: false });

import ScreenDashboard from "./screens/Dashboard";
import ScreenTrust from "./screens/Trust";
import ScreenSchools from "./screens/Schools";
import ScreenMoney from "./screens/Money";
import ScreenFees from "./screens/Fees";
import ScreenStudents from "./screens/Students";
import ScreenAcademic from "./screens/Academic";
import ScreenStaff from "./screens/Staff";
import ScreenTransport from "./screens/Transport";
import ScreenInventory from "./screens/Inventory";
import ScreenCommunication from "./screens/Communication";
import ScreenEnquiries from "./screens/Enquiries";
import ScreenComplaints from "./screens/Complaints";
import ScreenDonors from "./screens/Donors";
import ScreenUsers from "./screens/Users";
import ScreenAudit from "./screens/Audit";
import ScreenSettings from "./screens/Settings";
import ScreenClasses from "./screens/Classes";
import ScreenAttendance from "./screens/Attendance";
import ScreenAccessControl from "./screens/AccessControl";
import ScreenTasks from "./screens/Tasks";
import ScreenReports from "./screens/Reports";
import ScreenExams from "./screens/Exams";
import ScreenMyAttendance from "./screens/MyAttendance";
import ScreenTc from "./screens/Tc";
import ScreenChat from "./screens/Chat";
import ScreenMeetings from "./screens/Meetings";
import ScreenVolunteers from "./screens/Volunteers";
import ScreenLibrary from "./screens/Library";
import ScreenTimetable from "./screens/Timetable";
import ScreenSyllabus from "./screens/Syllabus";
import ScreenAccount from "./screens/Account";
import ScreenLeave from "./screens/Leave";
import ScreenRemarksRewards from "./screens/RemarksRewards";
import ScreenGovernmentDocuments from "./screens/GovernmentDocuments";
import ScreenStudentActivities from "./screens/StudentActivities";
import ScreenCustomRoles from "./screens/CustomRoles";
import ScreenMessages from "./screens/Messages";
import ScreenScale from "./screens/Scale";
import ScreenScaleReport from "./screens/ScaleReport";
import ScreenScaleAdmin from "./screens/ScaleAdmin";
import ScreenScaleAdvisory from "./screens/ScaleAdvisory";
import ScreenScaleRitual from "./screens/ScaleRitual";

const SCREENS = {
  dashboard: ScreenDashboard,
  trust: ScreenTrust,
  schools: ScreenSchools,
  money: ScreenMoney,
  fees: ScreenFees,
  students: ScreenStudents,
  academic: ScreenAcademic,
  staff: ScreenStaff,
  transport: ScreenTransport,
  inventory: ScreenInventory,
  communication: ScreenCommunication,
  enquiries: ScreenEnquiries,
  complaints: ScreenComplaints,
  donors: ScreenDonors,
  users: ScreenUsers,
  audit: ScreenAudit,
  settings: ScreenSettings,
  classes: ScreenClasses,
  attendance: ScreenAttendance,
  access: ScreenAccessControl,
  tasks: ScreenTasks,
  reports: ScreenReports,
  exams: ScreenExams,
  my_attendance: ScreenMyAttendance,
  tc: ScreenTc,
  chat: ScreenChat,
  meetings: ScreenMeetings,
  volunteers: ScreenVolunteers,
  library: ScreenLibrary,
  timetable: ScreenTimetable,
  syllabus: ScreenSyllabus,
  account: ScreenAccount,
  leave: ScreenLeave,
  remarks_rewards: ScreenRemarksRewards,
  government_documents: ScreenGovernmentDocuments,
  student_activities: ScreenStudentActivities,
  custom_roles: ScreenCustomRoles,
  messages: ScreenMessages,
  scale: ScreenScale,
  scale_report: ScreenScaleReport,
  scale_admin: ScreenScaleAdmin,
  scale_advisory: ScreenScaleAdvisory,
  scale_ritual: ScreenScaleRitual,
};

const DEFAULT_SCREEN_BY_ROLE = {
  admin: "trust",
  academic_director: "dashboard",
  principal: "dashboard",
  teacher: "academic",
  parent: "dashboard",
  school_accountant: "dashboard",
  trust_accountant: "trust",
  transport_manager: "transport",
  fees_manager: "fees",
};

const ROLE_LABEL = {
  admin: "Admin",
  academic_director: "Academic Director",
  principal: "Principal",
  teacher: "Teacher",
  parent: "Parent",
  school_accountant: "School Accountant",
  trust_accountant: "Trust Accountant",
};

const DEFAULT_SETTINGS = {
  theme: "light",
  view: "desktop",
  density: "compact",
  sidebar: "expanded",
  accent: "amber",
};

export default function AppShell({ initialData, session }) {
  const [data, setData] = useState(initialData);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [current, setCurrent] = useState(DEFAULT_SCREEN_BY_ROLE[session?.role] || "dashboard");
  // Set by GlobalSearch when the user clicks a result. The destination
  // screen reads this and opens the relevant detail (e.g. Students reads
  // {type:"student", id} and pops the profile modal). Each screen is
  // responsible for clearing it via clearSearchFocus once consumed so
  // navigating back to the same screen doesn't re-open the modal.
  const [searchFocus, setSearchFocus] = useState(null);  // { screen, type, id, title } | null
  const clearSearchFocus = () => setSearchFocus(null);
  const [showTweaks, setShowTweaks] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Mobile-only: when true, the sidebar slides in as an overlay drawer.
  // The hamburger toggles it on screens ≤ 820px; tapping a nav item or
  // the backdrop closes it.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [permissions, setPermissions] = useState(null); // { role: { fid: bool } }
  const [permExplicit, setPermExplicit] = useState(null); // { role: { fid: bool } } — true == stored row, false == defaulted
  const [access, setAccess] = useState({});              // { role: { fid: { canView, canEdit, canDelete } } }
  // One-per-session reminder toast. Fires once after hydrate when there
  // are any upcoming/overdue dated items (fees, loans, tasks, meetings,
  // exams, gov-doc expiries, donor follow-ups). Dismissable; the bell
  // panel stays the source of truth.
  const [reminderToast, setReminderToast] = useState(null);
  // Manual refresh (top bar). Data is only fetched when a screen mounts, so an
  // app or tab left open overnight still shows yesterday until something
  // re-fetches — this is the one-tap way to pull the current day's numbers.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const userMenuRef = useRef(null);

  // Role comes from the server-issued session — never from localStorage.
  const role = session?.role || "parent";

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("vidyalaya360.tweaks") || "null");
      if (saved) {
        // Drop any persisted role — session is the source of truth now.
        const { role: _drop, ...rest } = saved;
        setSettings((s) => ({ ...s, ...rest }));
      }
      // Per-role last-screen so different logins don't fight over the slot.
      const screen = localStorage.getItem(`vidyalaya360.screen.${role}`);
      if (screen && SCREENS[screen]) {
        const allowed = (NAV_BY_ROLE[role] || []).filter((n) => !n.section).map((n) => n.id);
        if (allowed.includes(screen)) setCurrent(screen);
      }
    } catch {}
    setHydrated(true);
  }, [role]);

  // Fetch the role-permissions matrix once on mount and on every refresh().
  // Cheap call — used by Sidebar to filter NAV_BY_ROLE and by individual
  // screens (Money etc.) to gate Add / Edit buttons via the `access` map.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/permissions", { cache: "no-store" });
        const json = await r.json();
        if (!cancelled && json?.ok) {
          setPermissions(json.permissions || {});
          setPermExplicit(json.explicit || {});
          setAccess(json.access || {});
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("vidyalaya360.tweaks", JSON.stringify(settings));
  }, [settings, hydrated]);

  // Once-per-session reminder toast. We dedupe by user-id + day so a
  // refresh in the same browser tab doesn't keep spamming the same
  // reminder, but a new login (or a new day) re-fires it. The bell
  // panel keeps the full list — this is just the "look up here ↗" nudge.
  useEffect(() => {
    if (!hydrated) return;
    if (!session?.id) return;
    if (typeof window === "undefined") return;
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `vidyalaya360.notifToast.${session.id}.${dayKey}`;
    try { if (sessionStorage.getItem(key)) return; } catch {}
    let alerts = [];
    try { alerts = buildAlerts(data) || []; } catch { alerts = []; }
    if (alerts.length === 0) return;
    // Pick the first "bad" (overdue) alert as the headline; otherwise the
    // first warn. The full list still lives in the bell.
    const headline = alerts.find((a) => a.tone === "bad") || alerts[0];
    setReminderToast({
      count: alerts.length,
      title: headline.title,
      sub: headline.sub,
      screen: headline.screen,
    });
    try { sessionStorage.setItem(key, "1"); } catch {}
  // Run when the data first loads. If the user navigates and `data`
  // mutates we don't want a fresh toast — sessionStorage gate catches
  // that, but we still avoid putting `data` in deps so we don't recompute
  // alerts on every refresh().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, session?.id]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(`vidyalaya360.screen.${role}`, current);
  }, [current, role, hydrated]);

  // Snap to a sensible default whenever:
  //   1. the current screen isn't part of this role's allowed nav, or
  //   2. the admin just disabled it via Access control, or
  //   3. the role is a custom one — its allowed screens come purely from
  //      the permissions matrix (built server-side from role_feature_access).
  //
  // We use the same Sidebar helper that builds the visible nav so the
  // auto-snap can never disagree with what the user is looking at — e.g.
  // a feature the admin explicitly granted to Trust Accountant shows up
  // in the sidebar AND is recognised here as a valid current screen.
  useEffect(() => {
    if (!permissions) return; // wait for first /api/permissions response
    let allowedNow = getAllowedNavIds(role, permissions, permExplicit)
      .filter((id) => SCREENS[id]);
    if (allowedNow.length === 0) return; // edge: nothing allowed → leave alone
    if (!allowedNow.includes(current)) {
      const fallback = allowedNow.includes(DEFAULT_SCREEN_BY_ROLE[role]) ? DEFAULT_SCREEN_BY_ROLE[role] : allowedNow[0];
      setCurrent(fallback);
    }
  }, [role, current, permissions, permExplicit]);

  // Cmd/Ctrl+K toggles tweaks.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setShowTweaks((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-outside for the user menu.
  useEffect(() => {
    if (!showUserMenu) return;
    const onClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showUserMenu]);

  const setSetting = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  const refresh = async () => {
    try {
      const r = await fetch("/api/data", { cache: "no-store" });
      const json = await r.json();
      // Pull permissions in the same beat — Access control's save invokes
      // refresh(), and this is what makes the sidebar update without reload.
      try {
        const pr = await fetch("/api/permissions", { cache: "no-store" });
        const pj = await pr.json();
        if (pj?.ok) {
          setPermissions(pj.permissions || {});
          setPermExplicit(pj.explicit || {});
          setAccess(pj.access || {});
        }
      } catch {}
      setData({
        KPIS: json.kpis,
        CLASSES: json.classes,
        CLASS_STRENGTH: json.classStrength,
        RECENT_FEES: json.recentFees,
        PENDING_FEES: json.pendingFees,
        ACTIVITIES: json.activities,
        ROUTES: json.routes,
        ROUTE_TEMPLATES: json.routeTemplates || [],
        COMPLAINTS: json.complaints,
        ENQUIRIES: json.enquiries,
        INVENTORY: json.inventory,
        INVENTORY_CATEGORIES: json.inventoryCategories || [],
        LIBRARY: json.library || [],
        LOANS: json.libraryLoans || [],
        TIMETABLE: json.timetable || [],
        SYLLABUS: json.syllabus || [],
        MOVEMENTS: json.movements || [],
        BROADCASTS: json.broadcasts || [],
        TEMPLATES: json.templates || [],
        RECIPIENT_LISTS: json.recipientLists || [],
        STAFF: json.staff,
        DONORS: json.donors || [],
        CAMPAIGNS: json.campaigns || [],
        DONOR_RECEIPTS: json.donorReceipts || [],
        EXPENSES: json.expenses || [],
        TASKS: json.tasks || [],
        MAINTENANCE_LOGS: json.maintenanceLogs || [],
        TEACHER_ATTENDANCE: json.teacherAttendance || [],
        TRANSPORT_ATTENDANCE: json.transportAttendance || [],
        STAFF_AWARDS: json.staffAwards || [],
        SUBJECTS: json.subjects || [],
        SETTINGS: json.appSettings || {},
        EXAMS: json.exams || [],
        MARKS: json.marks || [],
        TC_REQUESTS: json.tcRequests || [],
        MEETINGS: json.meetings || [],
        VOLUNTEERS: json.volunteers || [],
        CHAT_THREADS: json.chatThreads || [],
        FEE_REMINDERS: json.feeReminders || [],
        INCOME_SERIES: json.incomeSeries,
        SCHOOLS: json.schools,
        TRUST_KPIS: json.trustKpis,
        ANOMALIES: json.anomalies,
        DONATION_PIPELINE: json.donationPipeline,
        COMPLIANCE: json.compliance,
        AI_BRIEF: json.aiBrief,
        ROLES: json.roles,
        USERS: json.users,
        AUDIT: json.audit,
        ADDED_STUDENTS: json.addedStudents || [],
        ARCHIVED_STUDENTS: json.archivedStudents || [],
        DAILY_LOGS: json.dailyLogs || [],
        EXPENSE_CATEGORIES:    json.expenseCategories || [],
        EXPENSE_TEMPLATES:     json.expenseTemplates  || [],
        DONOR_FORM_SUBMISSIONS: json.donorFormSubmissions || [],
        LEAVE_REQUESTS:        json.leaveRequests || [],
        REMARKS_REWARDS:       json.remarksRewards || [],
        GOVERNMENT_DOCUMENTS:  json.governmentDocuments || [],
        STUDENT_ACTIVITIES:    json.studentActivities || [],
        CUSTOM_ROLES:          json.customRoles || [],
        SCALE_SESSIONS:        json.scaleSessions || [],
        SCALE_ENTRIES:         json.scaleEntries || [],
        SCALE_SUPPORT_PLANS:   json.scaleSupportPlans || [],
        SCALE_DAILY_RITUALS:   json.scaleDailyRituals || [],
        FEE_EDIT_SNAPSHOTS:    json.feeEditSnapshots || {},
        FEE_EDITS:             json.feeEdits || [],
        TRANSPORT_ASSIGNMENTS: json.transportAssignments || [],
      });
    } catch {}
  };

  // Top-bar refresh. Wraps refresh() with a spinning state so the tap has
  // visible feedback, and keeps a "just now / 5m ago" stamp for the tooltip.
  const manualRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
      setRefreshedAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  };

  const view = settings.view;
  const Comp = SCREENS[current] || SCREENS.dashboard;

  // Per-role data scoping. Defence-in-depth: API/RLS should enforce too.
  const scopedData = (() => {
    if (role === "parent") {
      // Parent sees ONLY their child. Demo picks the first active student
      // when no linked_id is set; production should always have a linked_id.
      const linkedId = session?.linkedId;
      const myChild = linkedId
        ? (data.ADDED_STUDENTS || []).find((s) => s.id === linkedId)
        : (data.ADDED_STUDENTS || [])[0];
      if (!myChild) {
        return { ...data, ADDED_STUDENTS: [], PENDING_FEES: [], RECENT_FEES: [], DAILY_LOGS: [], ROUTES: [], COMPLAINTS: [] };
      }
      return {
        ...data,
        ADDED_STUDENTS:    [myChild],
        ARCHIVED_STUDENTS: [],
        // Match studentId first — composite fee ids (e.g. STN-1__transport)
        // keep the owning student on studentId, not on id.
        PENDING_FEES:      (data.PENDING_FEES || []).filter((f) => (f.studentId || f.id) === myChild.id),
        RECENT_FEES:       (data.RECENT_FEES  || []).filter((f) => (f.studentId || f.id) === myChild.id),
        DAILY_LOGS:        (data.DAILY_LOGS   || []).filter((l) => l.studentId === myChild.id),
        TRANSPORT_ATTENDANCE: (data.TRANSPORT_ATTENDANCE || []).filter((t) => t.studentId === myChild.id),
        // Keep BOTH legs the child rides on — morning bus and evening
        // bus are commonly different routes. Previously this only matched
        // child.transport (morning), so the evening card on the parent
        // dashboard disappeared the moment the evening teacher hit Start.
        ROUTES:            (data.ROUTES || []).filter((r) =>
          r.code === myChild.transport || r.code === myChild.transportEvening
        ),
        ROUTE_TEMPLATES:   [],
        COMPLAINTS:        (data.COMPLAINTS || []).filter((c) => c.studentId === myChild.id || c.student === myChild.name),
        STAFF: [], AUDIT: [], INVENTORY: [], DONORS: [],
        ENQUIRIES: [], AUTOMATIONS: [],
        SCHOOLS: [], ANOMALIES: [], DONATION_PIPELINE: [],
        COMPLIANCE: [], AI_BRIEF: [],
        // Keep USERS — /api/data already scopes parents to teacher rows
        // only (name/email/linkedClasses). Needed for "Class teacher" on
        // the parent dashboard strip.
      };
    }
    if (role === "academic_director") {
      // Academic Director: students, classes, all daily logs across teachers,
      // complaints, communication. NO fees, payroll, donations, inventory.
      return {
        ...data,
        PENDING_FEES: [], RECENT_FEES: [],
        STAFF: [], INVENTORY: [], DONORS: [],
        DONATION_PIPELINE: [], COMPLIANCE: [], AI_BRIEF: [],
        SCHOOLS: [], ANOMALIES: [],
      };
    }
    if (role === "teacher") {
      // Teachers: classroom only. Hide finance/HR/donor data.
      // Classes come from (1) class-teacher linkedClasses and (2) timetable
      // subject assignments so Maths/English teachers can log class-wise too.
      const linked = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
        ? session.linkedClasses
        : (session?.linkedId && /^\d+-/i.test(String(session.linkedId)) ? [session.linkedId] : []);
      const meName = (session?.name || "").trim().toLowerCase();
      const myStaffId = (() => {
        if (session?.staffId) return session.staffId;
        const lid = session?.linkedId || "";
        if (typeof lid === "string" && lid.startsWith("STF-")) return lid;
        const email = (session?.email || "").toLowerCase();
        const hit = (data.STAFF || []).find((s) => s.email && s.email.toLowerCase() === email);
        return hit?.id || null;
      })();
      const ttClasses = (data.TIMETABLE || [])
        .filter((e) => {
          if (!e?.cls) return false;
          if (myStaffId && e.teacherId && e.teacherId === myStaffId) return true;
          const tName = (e.teacherName || "").trim().toLowerCase();
          return tName && meName && tName === meName;
        })
        .map((e) => e.cls);
      const myClasses = new Set([...linked, ...ttClasses].filter(Boolean));
      const classHeads = new Set([...myClasses].map((k) => String(k).split("-")[0]));
      const inMyClasses = (clsKey) => {
        const k = String(clsKey || "");
        if (!k) return false;
        if (myClasses.has(k)) return true;
        return classHeads.has(k.split("-")[0]);
      };
      const hasScope = myClasses.size > 0;
      const scopedStudents = hasScope
        ? (data.ADDED_STUDENTS || []).filter((s) => inMyClasses(s.cls))
        : (data.ADDED_STUDENTS || []);
      const scopedStudentIds = new Set(scopedStudents.map((s) => s.id));
      // Bus teachers need the FULL roster for the routes they attend — those
      // students come from many classes, not just the teacher's own. Scope a
      // separate transport roster by the routes where this teacher is the
      // named attendant, WITHOUT widening the class-scoped student list the
      // rest of the classroom app relies on.
      const myRouteCodes = new Set(
        (data.ROUTES || [])
          .filter((r) => { const att = (r.attendant || "").trim().toLowerCase(); return att && att !== "—" && att === meName; })
          .map((r) => r.code)
      );
      const transportStudents = myRouteCodes.size
        ? (data.ADDED_STUDENTS || []).filter((s) => myRouteCodes.has(s.transport) || myRouteCodes.has(s.transportEvening))
        : [];
      return {
        ...data,
        ADDED_STUDENTS: scopedStudents,
        TRANSPORT_STUDENTS: transportStudents,
        DAILY_LOGS: hasScope
          ? (data.DAILY_LOGS || []).filter((l) => inMyClasses(l.cls) || scopedStudentIds.has(l.studentId))
          : (data.DAILY_LOGS || []),
        COMPLAINTS: hasScope
          ? (data.COMPLAINTS || []).filter((c) => inMyClasses(c.cls) || scopedStudentIds.has(c.studentId))
          : (data.COMPLAINTS || []),
        PENDING_FEES: [], RECENT_FEES: [],
        // Teachers see only their *own* staff record — used by
        // RemarksRewards to resolve "this entry is about me" when the
        // record was stamped with a staff row id rather than a user id.
        // Browsing other staff is still blocked.
        STAFF: (data.STAFF || []).filter(
          (s) => s.email && session?.email && s.email.toLowerCase() === session.email.toLowerCase()
        ),
        INVENTORY: [], DONORS: [],
        DONATION_PIPELINE: [], COMPLIANCE: [], AI_BRIEF: [],
        SCHOOLS: [], ANOMALIES: [], ENQUIRIES: [],
      };
    }
    if (role === "trust_accountant") {
      // Trust Accountant: trust ledger only. The server (/api/data) is
      // the security boundary and already strips student / staff /
      // academic / inventory data — this client-side scope is a second
      // layer so any list a screen reads via E.* is empty even if the
      // server slip-up returned more.
      return {
        ...data,
        EXPENSES: (data.EXPENSES || []).filter((e) => e.scope === "trust"),
        ADDED_STUDENTS: [], ARCHIVED_STUDENTS: [],
        DAILY_LOGS: [],
        PENDING_FEES: [], RECENT_FEES: [], FEE_REMINDERS: [],
        STAFF: [], TEACHER_ATTENDANCE: [], STAFF_AWARDS: [],
        CLASSES: [], CLASS_STRENGTH: [],
        TIMETABLE: [], SYLLABUS: [],
        EXAMS: [], MARKS: [],
        INVENTORY: [], INVENTORY_CATEGORIES: [],
        LIBRARY: [], LOANS: [],
        MAINTENANCE_LOGS: [],
        ROUTES: [], ROUTE_TEMPLATES: [], TRANSPORT_ATTENDANCE: [],
        COMPLAINTS: [], ENQUIRIES: [],
        BROADCASTS: [], TEMPLATES: [], RECIPIENT_LISTS: [], MOVEMENTS: [],
        MEETINGS: [], VOLUNTEERS: [],
        CHAT_THREADS: [],
        TC_REQUESTS: [],
        TASKS: [],
        GOVERNMENT_DOCUMENTS: [],
        CUSTOM_ROLES: [], USERS: [],
        STUDENT_ACTIVITIES: [],
        LEAVE_REQUESTS: [],
        REMARKS_REWARDS: [],
        SCALE_SESSIONS: [], SCALE_ENTRIES: [],
        SCALE_SUPPORT_PLANS: [], SCALE_DAILY_RITUALS: [],
        SUBJECTS: [],
      };
    }
    if (role === "transport_manager") {
      // Transport Manager: buses, routes, boarding + the student roster (to
      // see who rides which bus). Everything financial / academic / HR is
      // stripped. Keeps ROUTES, ROUTE_TEMPLATES, TRANSPORT_ATTENDANCE,
      // MAINTENANCE_LOGS and ADDED_STUDENTS from the payload.
      return {
        ...data,
        PENDING_FEES: [], RECENT_FEES: [], FEE_REMINDERS: [],
        DAILY_LOGS: [], COMPLAINTS: [], ENQUIRIES: [],
        EXAMS: [], MARKS: [], SUBJECTS: [], TIMETABLE: [], SYLLABUS: [],
        INVENTORY: [], INVENTORY_CATEGORIES: [], LIBRARY: [], LOANS: [],
        STAFF: [], TEACHER_ATTENDANCE: [], STAFF_AWARDS: [],
        EXPENSES: [], DONORS: [], DONATION_PIPELINE: [], COMPLIANCE: [],
        AI_BRIEF: [], SCHOOLS: [], ANOMALIES: [], AUDIT: [],
        GOVERNMENT_DOCUMENTS: [], MEETINGS: [], VOLUNTEERS: [], TASKS: [],
        SCALE_SESSIONS: [], SCALE_ENTRIES: [], SCALE_SUPPORT_PLANS: [], SCALE_DAILY_RITUALS: [],
        STUDENT_ACTIVITIES: [], LEAVE_REQUESTS: [], REMARKS_REWARDS: [],
        TC_REQUESTS: [], CUSTOM_ROLES: [], USERS: [],
      };
    }
    if (role === "fees_manager") {
      // Fees Manager: fee collection + the SCALE session/reports. Keeps
      // fees, the student roster (for collecting + SCALE) and SCALE data;
      // everything else (staff, academics, inventory, transport, donors…) is
      // stripped.
      return {
        ...data,
        STAFF: [], TEACHER_ATTENDANCE: [], STAFF_AWARDS: [],
        EXPENSES: [], DONORS: [], DONATION_PIPELINE: [], COMPLIANCE: [],
        AI_BRIEF: [], SCHOOLS: [], ANOMALIES: [], AUDIT: [],
        EXAMS: [], MARKS: [], TIMETABLE: [], SYLLABUS: [],
        DAILY_LOGS: [], COMPLAINTS: [], ENQUIRIES: [],
        INVENTORY: [], INVENTORY_CATEGORIES: [], LIBRARY: [], LOANS: [],
        ROUTES: [], ROUTE_TEMPLATES: [], TRANSPORT_ATTENDANCE: [], MAINTENANCE_LOGS: [],
        GOVERNMENT_DOCUMENTS: [], MEETINGS: [], VOLUNTEERS: [], TASKS: [],
        LEAVE_REQUESTS: [], REMARKS_REWARDS: [], STUDENT_ACTIVITIES: [], TC_REQUESTS: [],
        CUSTOM_ROLES: [],
      };
    }
    return data;
  })();
  // Inject the role→feature→{view,edit,delete} access map so every screen
  // can gate Add / Edit / Delete buttons via E.ACCESS without each one
  // having to fetch /api/permissions itself.
  const E = { ...scopedData, ACCESS: access };

  const userMenu = (
    <div className="user-menu-wrap" ref={userMenuRef} style={{ position: "relative" }}>
      <button
        className="user-menu-btn"
        onClick={() => setShowUserMenu((s) => !s)}
        title={session?.email}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "5px 10px 5px 5px",
          background: "var(--bg-2)", border: "1px solid var(--line, #e5dfd1)",
          borderRadius: 999, cursor: "pointer", color: "var(--ink)",
          fontSize: 12, fontWeight: 500,
        }}
      >
        <span
          style={{
            width: 24, height: 24, borderRadius: "50%",
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            color: "#fff", display: "grid", placeItems: "center",
            fontSize: 10.5, fontWeight: 600,
          }}
        >
          {(session?.name || "U").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
        </span>
        <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {session?.name}
        </span>
        <Icon name="chevronDown" size={11} />
      </button>
      {showUserMenu && (
        <div
          style={{
            position: "absolute", right: 0, top: "calc(100% + 6px)",
            minWidth: 220,
            background: "var(--card, #fff)",
            border: "1px solid var(--line, #e5dfd1)",
            borderRadius: 10, padding: 6, zIndex: 100,
            boxShadow: "0 16px 40px -20px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ padding: "8px 10px 10px", borderBottom: "1px dashed var(--line, #e5dfd1)" }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{session?.name}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{session?.email}</div>
            <div
              style={{
                marginTop: 6, display: "inline-block",
                fontSize: 10, padding: "2px 7px", borderRadius: 4,
                background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 500,
              }}
            >
              {ROLE_LABEL[role] || role}
            </div>
          </div>
          <button
            onClick={() => { setShowUserMenu(false); setCurrent("account"); }}
            style={{
              width: "100%", textAlign: "left",
              padding: "8px 10px", marginTop: 4,
              background: "transparent", border: 0, borderRadius: 6,
              cursor: "pointer", color: "var(--ink-2)", fontSize: 12.5,
              display: "flex", alignItems: "center", gap: 8,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Icon name="user" size={13} />
            My account
          </button>
          <button
            onClick={async () => {
              try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
              try {
                Object.keys(localStorage).filter((k) => k.startsWith("vidyalaya360.")).forEach((k) => localStorage.removeItem(k));
              } catch {}
              window.location.href = "/login";
            }}
            style={{
              width: "100%", textAlign: "left",
              padding: "8px 10px",
              background: "transparent", border: 0, borderRadius: 6,
              cursor: "pointer", color: "var(--ink-2)", fontSize: 12.5,
              display: "flex", alignItems: "center", gap: 8,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Icon name="x" size={13} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );

  if (view === "mobile") {
    return (
      <div
        data-theme={settings.theme}
        data-density={settings.density}
        data-sidebar="expanded"
        style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "32px 16px", background: "var(--bg-2)" }}
      >
        <MobileShell current={current} setCurrent={setCurrent} role={role}>
          <Comp E={E} refresh={refresh} role={role} session={session} setCurrent={setCurrent} searchFocus={searchFocus} clearSearchFocus={clearSearchFocus} onOpenItem={(item) => { if (item?.screen) setCurrent(item.screen); setSearchFocus(item); }} />
        </MobileShell>
        <ViewToggle view={view} setView={(v) => setSetting("view", v)} />
        <Tweaks show={showTweaks} settings={settings} setSetting={setSetting} />
        <ReminderToast
          toast={reminderToast}
          onDismiss={() => setReminderToast(null)}
          onOpen={(screen) => { setReminderToast(null); if (screen) setCurrent(screen); }}
        />
      </div>
    );
  }

  return (
    <div
      className="app"
      data-theme={settings.theme}
      data-density={settings.density}
      data-sidebar={settings.sidebar}
      data-mobile-drawer={mobileDrawerOpen ? "open" : "closed"}
    >
      <Sidebar
        current={current}
        setCurrent={(id) => { setCurrent(id); setMobileDrawerOpen(false); }}
        role={role} user={session} permissions={permissions} permExplicit={permExplicit}
      />
      {/* Backdrop is hidden on desktop via the same CSS that hides the
          drawer there. On mobile, tapping it closes the drawer. */}
      <div
        className="mobile-drawer-backdrop"
        onClick={() => setMobileDrawerOpen(false)}
        aria-hidden={!mobileDrawerOpen}
      />
      <div className="main">
        {role === "parent" && <ParentContactBanner settings={data?.SETTINGS} />}
        {/* Full-screen pop-up for transport events (bus started / approaching
            your stop / completed). Only renders for parents, polls
            /api/notifications independently, shows ONE modal at a time
            with a 20s auto-dismiss + soft chime. */}
        {role === "parent" && <TransportEventPopup />}
        <div className="topbar">
          <button
            className="icon-btn"
            onClick={() => {
              // On mobile, the hamburger toggles the drawer overlay;
              // on desktop it toggles the collapsed/expanded sidebar.
              if (typeof window !== "undefined" && window.innerWidth <= 820) {
                setMobileDrawerOpen((v) => !v);
              } else {
                setSetting("sidebar", settings.sidebar === "collapsed" ? "expanded" : "collapsed");
              }
            }}
            title="Toggle sidebar"
          >
            <Icon name="menu" size={15} />
          </button>
          <GlobalSearch
            E={scopedData}
            role={role}
            setCurrent={setCurrent}
            onPickItem={(item) => {
              if (item.screen) setCurrent(item.screen);
              setSearchFocus(item);
            }}
            placeholder={
              role === "parent"            ? "Search fees, messages, library, activities…" :
              role === "teacher"           ? "Search students, leave, remarks, library, SCALE…" :
              role === "school_accountant" ? "Search fees, expenses, students…" :
              role === "trust_accountant"  ? "Search donors, expenses, campaigns…" :
              role === "academic_director" ? "Search students, classes, exams, SCALE, leave…" :
              "Search students, fees, donors, staff, expenses, library…"
            }
          />
          <div className="topbar-right">
            <button
              type="button"
              className="icon-btn"
              onClick={manualRefresh}
              disabled={refreshing}
              aria-label="Refresh data"
              title={refreshing ? "Refreshing…" : `Refresh data${refreshedAt ? ` · updated ${agoLabel(refreshedAt)}` : ""}`}
              style={refreshing ? { animation: "vid360-spin 0.9s linear infinite" } : undefined}
            >
              <Icon name="refresh" size={15} />
            </button>
            <NotificationsPanel E={scopedData} role={role} setCurrent={setCurrent} />
            {userMenu}
          </div>
        </div>

        <Comp E={E} refresh={refresh} role={role} session={session} setCurrent={setCurrent} searchFocus={searchFocus} clearSearchFocus={clearSearchFocus} onOpenItem={(item) => { if (item?.screen) setCurrent(item.screen); setSearchFocus(item); }} />

        <BrandFooter />
      </div>

      <Tweaks show={showTweaks} settings={settings} setSetting={setSetting} />

      <ReminderToast
        toast={reminderToast}
        onDismiss={() => setReminderToast(null)}
        onOpen={(screen) => { setReminderToast(null); if (screen) setCurrent(screen); }}
      />
    </div>
  );
}

// Floating toast that surfaces upcoming/overdue dated items on app load.
// One per session per user per day (gated by sessionStorage in the parent).
// Auto-dismisses after 12s but stays clickable to jump to the relevant
// screen, or to the bell when no specific screen makes sense.
// "just now" / "5m ago" / "2h ago" — for the refresh button's tooltip.
function agoLabel(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function ReminderToast({ toast, onDismiss, onOpen }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);
  if (!toast) return null;
  return (
    <div
      role="status"
      style={{
        position: "fixed", bottom: 22, right: 22, zIndex: 8000,
        background: "var(--card, #fff)",
        border: "1px solid var(--rule, #e5dfd1)",
        borderLeft: "4px solid var(--accent, #e8530e)",
        borderRadius: 10,
        padding: "12px 14px",
        width: 340,
        boxShadow: "0 18px 40px -18px rgba(0,0,0,0.35)",
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 7,
          background: "var(--accent-soft, #fff1e6)",
          color: "var(--accent, #e8530e)",
          display: "grid", placeItems: "center", flexShrink: 0,
        }}>
          <Icon name="bell" size={13} />
        </span>
        <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
          {toast.count} reminder{toast.count === 1 ? "" : "s"} need{toast.count === 1 ? "s" : ""} attention
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: "none", border: 0, cursor: "pointer",
            color: "var(--ink-3)", padding: 2, lineHeight: 0,
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>
        {toast.title}
      </div>
      {toast.sub && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {toast.sub}
        </div>
      )}
      <button
        onClick={() => onOpen(toast.screen)}
        style={{
          alignSelf: "flex-start",
          marginTop: 2,
          background: "none", border: 0, padding: 0,
          color: "var(--accent, #e8530e)", cursor: "pointer",
          fontSize: 11.5, fontWeight: 600,
        }}
      >
        Open {toast.screen ? toast.screen.replace(/_/g, " ") : "details"} →
      </button>
    </div>
  );
}

// Sticky contact strip shown above the top bar on parent logins. Numbers
// are configured by the admin in Settings → Parent dashboard. If neither
// number is set, the banner stays hidden so the parent never sees an empty
// strip. Tapping a number on mobile opens the dialer via tel: link.
function ParentContactBanner({ settings }) {
  const p = (settings && settings.parent) || {};
  const c1 = String(p.headerContact1Number || "").trim();
  const c2 = String(p.headerContact2Number || "").trim();
  if (!c1 && !c2) return null;
  const l1 = String(p.headerContact1Label || "Office").trim() || "Office";
  const l2 = String(p.headerContact2Label || "Emergency").trim() || "Emergency";
  const Item = ({ label, number }) => {
    if (!number) return null;
    return (
      <a href={`tel:${number.replace(/\s+/g, "")}`} className="parent-contact-pill" title={`Call ${label}`}>
        <span className="parent-contact-ico" aria-hidden="true">
          <Icon name="phone" size={11} />
        </span>
        <span className="parent-contact-label">{label}</span>
        <span className="parent-contact-num">{number}</span>
      </a>
    );
  };
  return (
    <div className="parent-contact-banner">
      <Item label={l1} number={c1} />
      <Item label={l2} number={c2} />
      <style jsx>{`
        .parent-contact-banner {
          position: sticky;
          top: 0;
          z-index: 30;
          background: linear-gradient(135deg, var(--brand, #1f3f8b) 0%, var(--accent, #e8530e) 100%);
          color: #fff;
          padding: 8px 18px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          box-shadow: 0 2px 6px -2px rgba(15, 23, 42, 0.18);
        }
        .parent-contact-banner :global(.parent-contact-pill) {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px 4px 6px;
          background: rgba(255, 255, 255, 0.18);
          border-radius: 999px;
          color: #fff;
          text-decoration: none;
          font-weight: 500;
          transition: background 0.15s ease, transform 0.15s ease;
        }
        .parent-contact-banner :global(.parent-contact-pill:hover) {
          background: rgba(255, 255, 255, 0.32);
          transform: translateY(-1px);
        }
        .parent-contact-banner :global(.parent-contact-ico) {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          background: rgba(255, 255, 255, 0.92);
          color: var(--brand, #1f3f8b);
        }
        .parent-contact-banner :global(.parent-contact-label) {
          font-size: 10.5px;
          opacity: 0.9;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }
        .parent-contact-banner :global(.parent-contact-num) {
          font-variant-numeric: tabular-nums;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}

function BrandFooter() {
  return (
    <div className="brand-footer">
      <a
        href="https://sirahdigital.in/"
        target="_blank"
        rel="noopener noreferrer"
        className="brand-footer-card"
        aria-label="Developed by Sirah Digital — open website in new tab"
      >
        <span className="brand-footer-mark" aria-hidden="true">
          <Icon name="sparkles" size={14} />
        </span>
        <span className="brand-footer-text">
          <span className="brand-footer-eyebrow">Designed &amp; developed by</span>
          <span className="brand-footer-name">
            Sirah Digital
            <svg className="brand-footer-arrow" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
              <path d="M4 10l6-6M5 4h5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
        </span>
      </a>
      <style jsx>{`
        .brand-footer {
          /* margin-top: auto pushes the footer to the bottom of the
             flex column .main wrapper. So on short pages it sits at the
             viewport bottom, and on long pages it follows the content. */
          margin-top: auto;
          padding: 32px 24px 28px;
          display: flex;
          justify-content: center;
        }
        .brand-footer-card {
          display: inline-flex;
          align-items: center;
          gap: 12px;
          padding: 10px 16px 10px 12px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--card, #ffffff) 0%, var(--bg-2, #f7f5ee) 100%);
          border: 1px solid var(--rule, #e9e3d2);
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 6px 18px -10px rgba(31, 63, 139, 0.18);
          text-decoration: none;
          color: var(--ink-2, #1d2433);
          transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
        }
        .brand-footer-card:hover {
          transform: translateY(-1px);
          border-color: var(--brand, #1f3f8b);
          box-shadow: 0 2px 4px rgba(15, 23, 42, 0.05), 0 12px 28px -12px rgba(31, 63, 139, 0.32);
        }
        .brand-footer-card:hover .brand-footer-arrow {
          transform: translate(2px, -2px);
        }
        .brand-footer-mark {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          display: grid;
          place-items: center;
          color: #ffffff;
          background: linear-gradient(135deg, var(--brand, #1f3f8b) 0%, var(--accent, #e8530e) 100%);
          flex-shrink: 0;
        }
        .brand-footer-text {
          display: flex;
          flex-direction: column;
          line-height: 1.15;
        }
        .brand-footer-eyebrow {
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--ink-3, #6b6e74);
        }
        .brand-footer-name {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 13.5px;
          font-weight: 700;
          color: var(--brand, #1f3f8b);
          margin-top: 2px;
        }
        .brand-footer-arrow {
          color: var(--brand, #1f3f8b);
          transition: transform 0.18s ease;
        }
      `}</style>
    </div>
  );
}

function ViewToggle({ view, setView }) {
  return (
    <div className="view-toggle">
      <button className={view === "desktop" ? "active" : ""} onClick={() => setView("desktop")}>
        Desktop
      </button>
      <button className={view === "mobile" ? "active" : ""} onClick={() => setView("mobile")}>
        Mobile
      </button>
    </div>
  );
}
