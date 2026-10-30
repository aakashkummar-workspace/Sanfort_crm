import { NextResponse } from "next/server";
import { readAllData, listScaleEntries, listScaleSessions, activeSponsoredStudentIds, BACKEND } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Server-side scoping. Without this, /api/data returned the full app
// dataset to every authenticated role — a parent or teacher opening
// DevTools could read donors, expenses, staff, full audit log etc.
// even though the UI hid them. The AppShell still re-scopes for
// belt-and-braces, but this is the security boundary.
// `sponsoredIds` is only used by the donor branch. It is passed in rather than
// looked up here because that lookup is async and this function is not.
function scopeForRole(data, session, sponsoredIds) {
  if (!session) return null;
  const role = session.role;
  // Admin / principal / academic_director / school_accountant see everything.
  // (Accountants are mostly scoped by which sidebar screens they can reach,
  //  but trust_accountant gets a HARD data slice below — they must not be
  //  able to read student / staff / academic / inventory data via DevTools
  //  even though their nav doesn't surface those screens.)
  if (role === "admin" || role === "principal" || role === "academic_director" ||
      role === "school_accountant") {
    return data;
  }

  // Trust Accountant — strict trust-only slice. Allowed: donors,
  // donations, trust-scope expenses, schools, compliance, donation
  // pipeline, trust KPIs, anomalies, AI brief. Blocked: every list that
  // touches students, staff, academics, school fees, inventory, library,
  // timetable, transport, broadcasts, leave, remarks, school reports.
  if (role === "trust_accountant") {
    return {
      ...data,
      // Trust-scope expenses only — drop school-scope rows.
      expenses: (data.expenses || []).filter((e) => e.scope === "trust"),
      // Same for templates — trust accountant only sees trust templates.
      expenseTemplates: (data.expenseTemplates || []).filter((t) => t.scope === "trust"),
      // Strip every school-side list. Empty arrays/objects so screens
      // that defensively read these fields don't crash.
      addedStudents: [], archivedStudents: [],
      dailyLogs: [],
      pendingFees: [], recentFees: [], feeReminders: [],
      staff: [], teacherAttendance: [], staffAwards: [],
      classes: [], classStrength: [],
      timetable: [], syllabus: [],
      exams: [], marks: [],
      inventory: [], inventoryCategories: [],
      library: [], libraryLoans: [],
      maintenanceLogs: [],
      routes: [], routeTemplates: [], transportAttendance: [],
      complaints: [], enquiries: [],
      broadcasts: [], templates: [], recipientLists: [], movements: [],
      whatsappMessages: [],
      meetings: [], volunteers: [],
      chatThreads: [],
      tcRequests: [],
      tasks: [],
      governmentDocuments: [],
      customRoles: [], users: [],
      studentActivities: [],
      payRuns: [],
      // This branch builds its own object rather than spreading `sanitised`,
      // so the blanks there do not apply and each one has to be repeated.
      donorSponsorships: [],
      programs: [],
      leaveRequests: [],
      remarksRewards: [],
      scaleSessions: [], scaleEntries: [],
      scaleSupportPlans: [], scaleDailyRituals: [],
      subjects: [],
      // Audit: keep only entries that touch finance / trust ops so they
      // can investigate donations / expenses, but they don't get a
      // window into student admissions or attendance edits.
      audit: (data.audit || []).filter((a) => {
        const blob = `${a.action || ""} ${a.entity || ""}`.toLowerCase();
        return /donor|donation|trust|expense|campaign|receipt/.test(blob);
      }),
    };
  }

  // Strip lists that are sensitive across the board for non-managers.
  // Each role gets its own positive overrides below.
  // NOTE: `programs` is deliberately NOT stripped here. A school event —
  // sports day, a workshop, an excursion — is public information inside the
  // school; teachers run them and parents need to see what their child is
  // signed up for. The permissive default is correct. Don't "fix" this.
  const sanitised = {
    ...data,
    donors: [],
    donorReceipts: [],
    donorFormSubmissions: [],
    expenses: [],
    expenseTemplates: [],
    staff: [],
    teacherAttendance: [],
    audit: [],
    // Defence in depth. readAllData never loads the WhatsApp log (it carries
    // message bodies — fee amounts, balances, phone numbers — and grows with
    // every payment), so this is normally already absent. Listed here so that
    // if anything ever puts it in the payload it still can't reach a
    // non-manager role.
    whatsappMessages: [],
    schools: [],
    governmentDocuments: [],
    customRoles: [],
    campaigns: [],
    // Payroll headers carry the school's total salary bill; the payslips
    // behind them carry every individual's pay. Admin-only, and listed in
    // each role branch below as well as here — the branches return before
    // this object is spread, so one place is not enough.
    payRuns: [],
    // Who sponsors whom. Not in the bootstrap payload today (allocations are
    // served from /api/donor-sponsorships), but blanked here so that adding it
    // later cannot quietly expose an allocation to a parent or a teacher —
    // the whole point of keeping sponsorship off the student record.
    donorSponsorships: [],
  };

  if (role === "transport_manager") {
    // Transport Manager: routes, boarding, and the student roster only.
    // sanitised already dropped donors / staff / expenses / audit; strip the
    // remaining finance + academic lists too. routes / routeTemplates /
    // transportAttendance / addedStudents / maintenanceLogs pass through.
    return {
      ...sanitised,
      pendingFees: [], recentFees: [], feeReminders: [],
      dailyLogs: [], complaints: [], enquiries: [],
      exams: [], marks: [], subjects: [], timetable: [], syllabus: [],
      inventory: [], inventoryCategories: [], library: [], libraryLoans: [],
      meetings: [], volunteers: [], tasks: [],
      scaleSessions: [], scaleEntries: [], scaleSupportPlans: [], scaleDailyRituals: [],
      studentActivities: [], leaveRequests: [], remarksRewards: [],
      tcRequests: [], governmentDocuments: [], programs: [], payRuns: [],
    };
  }

  if (role === "fees_manager") {
    // Fees Manager: fees + the SCALE session/reports + the student roster.
    // Keeps pendingFees / recentFees / feeReminders / addedStudents / classes /
    // settings / scale* (via ...sanitised); strips academics, inventory,
    // transport, teacher attendance, and the rest.
    return {
      ...sanitised,
      teacherAttendance: [],
      dailyLogs: [], complaints: [], enquiries: [],
      exams: [], marks: [], timetable: [], syllabus: [],
      inventory: [], inventoryCategories: [], library: [], libraryLoans: [],
      routes: [], routeTemplates: [], transportAttendance: [], maintenanceLogs: [],
      meetings: [], volunteers: [], tasks: [],
      studentActivities: [], leaveRequests: [], remarksRewards: [],
      tcRequests: [], governmentDocuments: [], programs: [], payRuns: [],
    };
  }

  if (role === "teacher") {
    // Teacher sees their own staff record only (so RemarksRewards can
    // tag "About you"). Their assigned-class students stay; everything
    // else from the sensitive set above stays empty.
    const myEmail = (session.email || "").toLowerCase();
    sanitised.staff = (data.staff || []).filter(
      (s) => s.email && s.email.toLowerCase() === myEmail
    );
    // Routes — show only routes where this teacher is the attendant.
    // Otherwise a teacher opening the Transport screen would see every
    // school route in the dropdown. The bus-progress controls already
    // server-check attendant on /api/transport/advance, but tightening
    // the read side here keeps the payload small and the UI honest.
    const me = (session.name || "").trim().toLowerCase();
    sanitised.routes = (data.routes || []).filter((r) => {
      const att = (r.attendant || "").trim().toLowerCase();
      return att && att !== "—" && att === me;
    });
    return sanitised;
  }

  if (role === "parent") {
    const linkedId = session.linkedId;
    const myChild = linkedId
      ? (data.addedStudents || []).find((s) => s.id === linkedId)
      : (data.addedStudents || [])[0];
    if (!myChild) {
      return {
        ...sanitised,
        addedStudents: [],
        archivedStudents: [],
        pendingFees: [], recentFees: [],
        dailyLogs: [],
        transportAttendance: [],
        routes: [],
        routeTemplates: [],
        complaints: [],
        scaleEntries: [], scaleSessions: [],
      };
    }
    return {
      ...sanitised,
      addedStudents: [myChild],
      archivedStudents: [],
      // Match by studentId first, fall back to id — newer composite-id rows
      // (e.g. transport-fee rows keyed `${studentId}__transport`) carry the
      // owning student in studentId, while legacy rows still use id directly.
      pendingFees:  (data.pendingFees  || []).filter((f) => (f.studentId || f.id) === myChild.id),
      recentFees:   (data.recentFees   || []).filter((f) => (f.studentId || f.id) === myChild.id),
      dailyLogs:    (data.dailyLogs    || []).filter((l) => l.studentId === myChild.id),
      transportAttendance: (data.transportAttendance || []).filter((t) => t.studentId === myChild.id),
      // Routes the child rides on — morning bus + evening bus (different
       // routes are common). De-duped so a "both"-direction route used for
       // both legs only appears once.
       routes:       (data.routes       || []).filter((r) =>
         r.code === myChild.transport || r.code === myChild.transportEvening
       ),
       // Parents never see the master route-template catalog.
       routeTemplates: [],
      complaints:   (data.complaints   || []).filter((c) => c.studentId === myChild.id || c.student === myChild.name),
      scaleEntries: (data.scaleEntries || []).filter((e) => e.studentId === myChild.id),
      scaleSessions: [], // sessions are teacher-side
      // Child's class timetable only (full week). Match class head so
      // "1" and "1-A" both work.
      timetable: (data.timetable || []).filter((t) => {
        const childKey = String(myChild.cls || "");
        const childHead = childKey.split("-")[0];
        const tKey = String(t.cls || "");
        return tKey === childKey || tKey.split("-")[0] === childHead;
      }),
      // Restrict the user roster to teachers only. Parents need the
      // class teacher's name on the dashboard strip — not their email.
      users: (data.users || [])
        .filter((u) => u.role === "teacher")
        .map((u) => ({
          id: u.id,
          role: u.role,
          name: u.name,
          linkedId: u.linkedId,
          linkedClasses: u.linkedClasses,
        })),
    };
  }

  // Donors see ONLY the students they sponsor, and only an allowlisted
  // projection of each. MUST stay above the `return sanitised` below: placed
  // after it this branch is dead code and a donor receives the sanitised set,
  // which carries addedStudents for the entire school.
  //
  // sponsoredIds is resolved in GET() because scopeForRole is synchronous.
  // An empty list is the correct fail-closed answer for a donor whose
  // linkedId no longer resolves — never fall back to "the first student".
  if (role === "donor") {
    const ids = new Set(Array.isArray(sponsoredIds) ? sponsoredIds : []);
    const mine = (data.addedStudents || []).filter((s) => ids.has(s.id));
    const mineIds = new Set(mine.map((s) => s.id));
    return {
      ...sanitised,
      // Built field by field, never by spreading the student row and deleting
      // keys: fromStudent() will gain a field one day and a blocklist would
      // leak it. Deliberately absent — fees and dues (which would hand a donor
      // leverage over a household), parent names and phone numbers (which
      // would let them contact a minor's family directly), transport route and
      // stop (a child's physical location at known times), complaints,
      // remarks and support plans (welfare records; a sponsor is not a
      // guardian), and daily logs (written for parents).
      addedStudents: mine.map((s) => ({
        id: s.id,
        name: s.name,
        cls: s.cls,
        attendance: s.attendance ?? 0,
        joined: s.joined ?? null,
      })),
      archivedStudents: [],
      // Academic outcome — what the sponsorship actually funded.
      exams: data.exams || [],
      marks: (data.marks || []).filter((m) => mineIds.has(m.studentId)),
      scaleEntries: (data.scaleEntries || []).filter((e) => mineIds.has(e.studentId)),
      studentActivities: (data.studentActivities || []).filter((a) => mineIds.has(a.studentId)),
      // The donor's own giving history — their data, and the dashboard looks
      // broken without it.
      donorReceipts: (data.donorReceipts || []).filter((r) => r.donorId === session.linkedId),
      // Everything student-adjacent, explicitly emptied. scopeForRole defaults
      // to permissive, so anything not named here would pass through.
      pendingFees: [], recentFees: [], feeReminders: [],
      dailyLogs: [], complaints: [], enquiries: [],
      transportAttendance: [], routes: [], routeTemplates: [],
      timetable: [], syllabus: [], classes: [], users: [], staff: [],
      tasks: [], meetings: [], volunteers: [], remarksRewards: [],
      leaveRequests: [], chatThreads: [], tcRequests: [],
      scaleSessions: [], scaleSupportPlans: [], scaleDailyRituals: [],
      library: [], libraryLoans: [], inventory: [],
      donors: [], campaigns: [], donorFormSubmissions: [], donorSponsorships: [],
      kpis: {}, trustKpis: {}, classStrength: [], incomeSeries: [],
      activities: [], anomalies: [], donationPipeline: [], compliance: [], aiBrief: [],
    };
  }

  // Unknown / custom role → safest default is the sanitised set
  // (no donors / staff / expenses / audit) plus their normal class data.
  return sanitised;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  }
  const data = await readAllData();
  // Resolve the donor's sponsored students before scoping. On any failure this
  // stays empty, so the donor sees nothing rather than somebody else's data.
  let sponsoredIds = [];
  if (session.role === "donor" && session.linkedId) {
    try { sponsoredIds = await activeSponsoredStudentIds(session.linkedId); } catch {}
  }
  const scoped = scopeForRole(data, session, sponsoredIds);
  // readAllData only carries the newest 2000 SCALE entries school-wide, so a
  // parent's child silently lost older marks. Load the child's full history
  // (plus their class sessions, for dates/subjects on the timeline).
  if (session.role === "parent" && scoped?.addedStudents?.[0]) {
    const child = scoped.addedStudents[0];
    try {
      const [entries, sessions] = await Promise.all([
        listScaleEntries({ studentId: child.id, limit: 5000 }),
        child.cls ? listScaleSessions({ cls: child.cls, limit: 500 }) : [],
      ]);
      scoped.scaleEntries = entries;
      scoped.scaleSessions = sessions.map((s) => ({
        id: s.id, cls: s.cls, subject: s.subject, sessionDate: s.sessionDate, sessionType: s.sessionType,
      }));
    } catch {}
  }
  // Donors hit the same 2000-row school-wide SCALE cap, which would silently
  // drop older entries for a sponsored student. No sessions — those carry
  // teacher names and lesson detail a donor has no business seeing.
  if (session.role === "donor" && scoped?.addedStudents?.length) {
    try {
      const lists = await Promise.all(
        scoped.addedStudents.slice(0, 20).map((s) => listScaleEntries({ studentId: s.id, limit: 2000 }))
      );
      scoped.scaleEntries = lists.flat();
    } catch {}
  }
  return NextResponse.json(scoped, { headers: { "x-data-backend": BACKEND } });
}
