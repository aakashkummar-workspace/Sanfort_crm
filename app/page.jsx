import { redirect } from "next/navigation";
import { readAllData, activeSponsoredStudentIds } from "@/lib/db";
import { getSession } from "@/lib/auth";
import AppShell from "@/components/AppShell";

export const dynamic = "force-dynamic";

// Keep this in sync with the shape AppShell.refresh() builds — every key the
// client-side refresh sets must be seeded here, otherwise screens render
// blank on first paint and only pop in after the first user-triggered
// refresh. (That's exactly the bug that hid the seeded library catalog.)
function shapeForScreens(db) {
  return {
    KPIS: db.kpis,
    CLASSES: db.classes,
    CLASS_STRENGTH: db.classStrength,
    RECENT_FEES: db.recentFees,
    PENDING_FEES: db.pendingFees,
    ACTIVITIES: db.activities,
    ROUTES: db.routes,
    COMPLAINTS: db.complaints,
    ENQUIRIES: db.enquiries,
    INVENTORY: db.inventory,
    INVENTORY_CATEGORIES: db.inventoryCategories || [],
    LIBRARY: db.library || [],
    LOANS: db.libraryLoans || [],
    TIMETABLE: db.timetable || [],
    SYLLABUS: db.syllabus || [],
    MOVEMENTS: db.movements || [],
    BROADCASTS: db.broadcasts || [],
    TEMPLATES: db.templates || [],
    RECIPIENT_LISTS: db.recipientLists || [],
    STAFF: db.staff,
    DONORS: db.donors || [],
    CAMPAIGNS: db.campaigns || [],
    DONOR_RECEIPTS: db.donorReceipts || [],
    EXPENSES: db.expenses || [],
    TASKS: db.tasks || [],
    MAINTENANCE_LOGS: db.maintenanceLogs || [],
    TEACHER_ATTENDANCE: db.teacherAttendance || [],
    TRANSPORT_ATTENDANCE: db.transportAttendance || [],
    EXAMS: db.exams || [],
    MARKS: db.marks || [],
    TC_REQUESTS: db.tcRequests || [],
    MEETINGS: db.meetings || [],
    VOLUNTEERS: db.volunteers || [],
    CHAT_THREADS: db.chatThreads || [],
    FEE_REMINDERS: db.feeReminders || [],
    INCOME_SERIES: db.incomeSeries,
    SCHOOLS: db.schools,
    TRUST_KPIS: db.trustKpis,
    ANOMALIES: db.anomalies,
    DONATION_PIPELINE: db.donationPipeline,
    COMPLIANCE: db.compliance,
    AI_BRIEF: db.aiBrief,
    ROLES: db.roles,
    USERS: db.users,
    AUDIT: db.audit,
    ADDED_STUDENTS: db.addedStudents || [],
    ARCHIVED_STUDENTS: db.archivedStudents || [],
    DAILY_LOGS: db.dailyLogs || [],
    CUSTOM_ROLES: db.customRoles || [],
    // Carry app_settings into the initial server-rendered payload so the
    // parent contact banner (and any other settings-driven UI) renders on
    // first paint instead of waiting for the first refresh() round-trip.
    SETTINGS: db.appSettings || {},
  };
}

export default async function Page() {
  // Middleware will already have redirected anonymous users to /login. This
  // server-side check is the second line of defence + gives the page access
  // to the role/name before render.
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await readAllData();
  let E = shapeForScreens(db);

  // Trust Accountant: strip every school-side list from the initial
  // server-rendered payload so a curious admin tools / hydration peek
  // can't read student or staff data. /api/data/route.js applies the
  // same slice on subsequent fetches; AppShell adds a third layer.
  if (session.role === "trust_accountant") {
    E = {
      ...E,
      EXPENSES: (E.EXPENSES || []).filter((e) => e.scope === "trust"),
      ADDED_STUDENTS: [], ARCHIVED_STUDENTS: [],
      DAILY_LOGS: [],
      PENDING_FEES: [], RECENT_FEES: [], FEE_REMINDERS: [],
      STAFF: [], TEACHER_ATTENDANCE: [],
      CLASSES: [], CLASS_STRENGTH: [],
      TIMETABLE: [], SYLLABUS: [],
      EXAMS: [], MARKS: [],
      INVENTORY: [], INVENTORY_CATEGORIES: [],
      LIBRARY: [], LOANS: [],
      MAINTENANCE_LOGS: [],
      ROUTES: [], TRANSPORT_ATTENDANCE: [],
      COMPLAINTS: [], ENQUIRIES: [],
      BROADCASTS: [], TEMPLATES: [], RECIPIENT_LISTS: [], MOVEMENTS: [],
      MEETINGS: [], VOLUNTEERS: [],
      CHAT_THREADS: [],
      TC_REQUESTS: [],
      TASKS: [],
      USERS: [],
      // Audit trimmed to finance-related entries only.
      AUDIT: (E.AUDIT || []).filter((a) => {
        const blob = `${a.action || ""} ${a.entity || ""}`.toLowerCase();
        return /donor|donation|trust|expense|campaign|receipt/.test(blob);
      }),
    };
  }

  // Donor: the server-rendered payload must be cut to their sponsored students
  // before it reaches the browser. This page builds its own payload from
  // readAllData() and does NOT go through scopeForRole in /api/data — so a
  // role added there alone still ships the entire school in the first paint.
  // That is how a donor briefly saw all 292 students. Mirror the API's
  // allowlist exactly: build each student field by field rather than spreading
  // and deleting, so a future column cannot leak in.
  if (session.role === "donor") {
    let ids = [];
    try {
      if (session.linkedId) ids = await activeSponsoredStudentIds(session.linkedId);
    } catch {}
    const mine = new Set(ids);
    const sponsored = (db.addedStudents || []).filter((s) => mine.has(s.id));
    E = {
      ...E,
      ADDED_STUDENTS: sponsored.map((s) => ({
        id: s.id, name: s.name, cls: s.cls,
        attendance: s.attendance ?? 0, joined: s.joined ?? null,
      })),
      ARCHIVED_STUDENTS: [],
      MARKS: (E.MARKS || []).filter((m) => mine.has(m.studentId)),
      STUDENT_ACTIVITIES: (E.STUDENT_ACTIVITIES || []).filter((a) => mine.has(a.studentId)),
      SCALE_ENTRIES: (E.SCALE_ENTRIES || []).filter((e) => mine.has(e.studentId)),
      DONOR_RECEIPTS: (E.DONOR_RECEIPTS || []).filter((r) => r.donorId === session.linkedId),
      // Everything else a sponsor has no business seeing.
      PENDING_FEES: [], RECENT_FEES: [], FEE_REMINDERS: [],
      DAILY_LOGS: [], COMPLAINTS: [], ENQUIRIES: [],
      TRANSPORT_ATTENDANCE: [], ROUTES: [], ROUTE_TEMPLATES: [],
      TIMETABLE: [], SYLLABUS: [], CLASSES: [], CLASS_STRENGTH: [],
      USERS: [], STAFF: [], TEACHER_ATTENDANCE: [],
      TASKS: [], MEETINGS: [], VOLUNTEERS: [], REMARKS_REWARDS: [],
      LEAVE_REQUESTS: [], CHAT_THREADS: [], TC_REQUESTS: [],
      SCALE_SESSIONS: [], SCALE_SUPPORT_PLANS: [], SCALE_DAILY_RITUALS: [],
      LIBRARY: [], LOANS: [], INVENTORY: [], INVENTORY_CATEGORIES: [],
      MAINTENANCE_LOGS: [], MOVEMENTS: [],
      BROADCASTS: [], TEMPLATES: [], RECIPIENT_LISTS: [],
      DONORS: [], CAMPAIGNS: [], DONOR_FORM_SUBMISSIONS: [], DONOR_SPONSORSHIPS: [],
      EXPENSES: [], PAY_RUNS: [], PROGRAMS: [], WHATSAPP_MESSAGES: [],
      SCHOOLS: [], AUDIT: [], CUSTOM_ROLES: [], GOVERNMENT_DOCUMENTS: [],
      KPIS: {}, TRUST_KPIS: {}, INCOME_SERIES: [], ACTIVITIES: [],
      ANOMALIES: [], DONATION_PIPELINE: [], COMPLIANCE: [], AI_BRIEF: [],
    };
  }

  // For staff-side roles (teacher, principal, admin, etc.) try to resolve the
  // user's own staff id by matching their session email against the staff
  // roster. Done server-side so the client doesn't need the full STAFF list
  // (which is HR-private and stripped from `E.STAFF` for teachers/parents in
  // AppShell). Used by Timetable / Library / Dashboard cards to filter
  // "my schedule" / "my loans" without leaking other staff records.
  let resolvedStaffId = null;
  if (session.email && session.role !== "parent") {
    const lid = session.linkedId || "";
    if (typeof lid === "string" && lid.startsWith("STF-")) {
      resolvedStaffId = lid;
    } else {
      const match = (db.staff || []).find(
        (s) => (s.email || "").toLowerCase() === session.email.toLowerCase()
      );
      if (match) resolvedStaffId = match.id;
    }
  }

  return (
    <AppShell
      initialData={E}
      session={{
        id: session.sub,
        email: session.email,
        name: session.name,
        role: session.role,
        linkedId: session.linkedId || null,
        linkedClasses: Array.isArray(session.linkedClasses) ? session.linkedClasses : [],
        // Authoritative staff id for the signed-in user (null for parents and
        // for staff who don't have a matching roster entry). Always trust
        // this over linkedId when filtering by teacher.
        staffId: resolvedStaffId,
      }}
    />
  );
}
