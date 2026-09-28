// Unified async data API.
// Two backends behind one interface:
//   - Supabase (when NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY/anon key are set)
//   - Local JSON file at data/db.json (zero-config fallback for dev)
//
// All exported helpers are async so callers can await them.

import fs from "fs";
import path from "path";
import { formatClassLabel } from "./format.js";
import { indicatorMax } from "./scale.js";
import {
  supabase, supabaseEnabled,
  toStudent, toPendingFee, toStaff, toInventory, toBroadcast, toTemplate,
  toDonor, toCampaign,
  fromStudent, fromPendingFee, fromRecentFee, fromDailyLog,
  fromAudit, fromActivity, fromComplaint, fromEnquiry, fromRoute, fromRouteTemplate, toRouteTemplate, fromStaff,
  fromInventory, fromMovement,
  fromBroadcast, fromTemplate, fromRecipientList,
  fromDonor, fromCampaign,
  toTask, fromTask,
  toMeeting, fromMeeting, fromMeetingRsvp,
  toVolunteer, fromVolunteer, fromVolunteerHours,
  toChatThread, fromChatThread, fromChatMessage,
  toTcRequest, fromTcRequest,
  fromTeacherAttendance,
  toTransportAttendance, fromTransportAttendance,
  toStaffAward, fromStaffAward,
  toExam, fromExam, fromExamMark,
  toMaintenance, fromMaintenance,
  toExpense, fromExpense,
  toDocument, fromDocument,
  toDonorReceipt, fromDonorReceipt,
  toSchool, fromSchool,
  // New tables wired in for full Supabase persistence.
  toTimetable, fromTimetable,
  toBook, fromBook,
  toLoan, fromLoan,
} from "./supabase.js";

// Helper: detect "missing table / unknown column" errors so we can fall back
// silently to the file store while a schema migration is pending.
function isSchemaMissError(err) {
  if (!err) return false;
  const msg = String(err.message || err.code || "").toLowerCase();
  return /relation .* does not exist|could not find the table|schema cache|column .* does not exist|undefined column/.test(msg);
}

export const BACKEND = supabaseEnabled ? "supabase" : "file";

// ----------------------------------------------------------------------------
// File-store helpers (only used when supabaseEnabled === false)
// ----------------------------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const EMPTY_DB = {
  addedStudents: [],
  pendingFees: [],
  recentFees: [],
  complaints: [],
  enquiries: [],
  dailyLogs: [],
  routes: [],
  routeTemplates: [],
  audit: [],
  activities: [],
  staff: [],
  authUsers: [],
  inventory: [],
  movements: [],
  broadcasts: [],
  templates: [],
  recipientLists: [],
  donors: [],
  campaigns: [],
};

function fileEnsure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
}
export function fileRead() {
  fileEnsure();
  const raw = fs.readFileSync(DB_PATH, "utf8");
  const data = JSON.parse(raw);
  let touched = false;
  for (const k of Object.keys(EMPTY_DB)) {
    if (!(k in data)) { data[k] = EMPTY_DB[k]; touched = true; }
  }
  if (touched) fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  return data;
}
export function fileWrite(data) {
  fileEnsure();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Empty arrays for tables not (yet) backed by Supabase.
// The school runs one stream per grade (no Section A/B split). We keep
// sections: ["A"] under the hood because dozens of screens parse cls
// via split("-"), but the UI hides the section letter via
// formatClassLabel(). 11 classes: PRE-MONT (13), MONT I (14),
// MONT II (15), then I–VIII (1–8).
const STATIC_EMPTIES = {
  classes: [
    { n: 13 }, { n: 14 }, { n: 15 },
    { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }, { n: 7 }, { n: 8 },
  ].map((c) => ({
    n: c.n, label: formatClassLabel(String(c.n)), sections: ["A"], students: 0,
  })),
  kpis: {
    students: { value: 0, delta: "", deltaDir: "", sub: "" },
    collected: { value: 0, delta: "", deltaDir: "", sub: "" },
    pending: { value: 0, delta: "", deltaDir: "", sub: "" },
    balance: { value: 0, delta: "", deltaDir: "", sub: "" },
    income: { value: 0, delta: "", deltaDir: "", sub: "" },
    expense: { value: 0, delta: "", deltaDir: "", sub: "" },
    staff: { value: 0, delta: "", deltaDir: "", sub: "" },
    interns: { value: 0, delta: "", deltaDir: "", sub: "" },
    complaints: { value: 0, delta: "", deltaDir: "", sub: "" },
    enquiries: { value: 0, delta: "", deltaDir: "", sub: "" },
    transport: { value: "—", delta: "", deltaDir: "", sub: "" },
    donors: { value: 0, delta: "", deltaDir: "", sub: "" },
  },
  trustKpis: {
    students: { value: "0", delta: "", sub: "" },
    collected: { value: "0%", delta: "", sub: "" },
    donations: { value: "₹0", delta: "", sub: "" },
    teacherNPS: { value: "—", delta: "", sub: "" },
  },
  classStrength: [], staff: [], inventory: [], donors: [], incomeSeries: [],
  schools: [], anomalies: [], donationPipeline: [],
  compliance: [], aiBrief: [], roles: [
    { k: "super", label: "Super Admin", icon: "shield" },
    { k: "principal", label: "Principal", icon: "school" },
    { k: "teacher", label: "Teacher", icon: "book" },
    { k: "parent", label: "Parent", icon: "heart" },
  ],
  users: [],
};

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

// Helper: query one Supabase table, swallow errors so a missing table or
// unrun migration doesn't crash the whole response. We log a warning so you
// can see what's missing in the server console.
async function safeSelect(table, build) {
  try {
    // Build the query then execute it. We chain .throwOnError() so any
    // PostgREST error is thrown rather than silently returning an empty
    // result, which is what was happening intermittently for some tables.
    const base = supabase.from(table).select("*");
    const built = build(base);
    const r = await built;
    if (r.error) {
      console.warn(`[db] ${table}: ${r.error.message}`);
      return [];
    }
    return r.data || [];
  } catch (e) {
    console.warn(`[db] ${table}: ${e.message}`);
    return [];
  }
}

// Like safeSelect, but pages through EVERY row. Supabase caps a single
// response at 1000 rows, so any table that can grow past 1000 (pending_fees,
// recent_fees, students…) must be fetched in 1000-row pages or the register /
// totals silently truncate. Do NOT use for queries that apply their own
// .limit() — the .range() here would override it.
async function safeSelectAll(table, build) {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  try {
    for (;;) {
      const base = supabase.from(table).select("*");
      const r = await build(base).range(from, from + PAGE - 1);
      if (r.error) { console.warn(`[db] ${table}: ${r.error.message}`); break; }
      const rows = r.data || [];
      all = all.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    return all;
  } catch (e) {
    console.warn(`[db] ${table}: ${e.message}`);
    return all;
  }
}

// Run an array of async tasks in batches of `batchSize`. The Supabase JS
// client / PostgREST silently drops some queries when too many run in
// parallel against a single project (we hit it at ~16 concurrent), so we
// chunk to a safe size and gather the results in order.
async function runBatched(tasks, batchSize = 4) {
  const out = new Array(tasks.length);
  for (let i = 0; i < tasks.length; i += batchSize) {
    const slice = tasks.slice(i, i + batchSize);
    const results = await Promise.all(slice.map((fn) => fn()));
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
  }
  return out;
}

export async function readAllData() {
  if (supabaseEnabled) {
    const [s, pf, rf, cm, eq, dl, rt, al, ac, cls, st, inv, mv, bc, tp, rl, dn, cp, txa, tt, lib, lns, invCats, ex, mk, ta] = await runBatched([
      () => safeSelectAll("students",     (q) => q.order("created_at", { ascending: false })),
      () => safeSelectAll("pending_fees", (q) => q.order("created_at", { ascending: false })),
      () => safeSelectAll("recent_fees",  (q) => q.order("paid_at",    { ascending: false })),
      () => safeSelect("complaints",   (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("enquiries",    (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("daily_logs",   (q) => q.order("posted_at",  { ascending: false })),
      () => safeSelect("routes",       (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("audit_log",    (q) => q.order("created_at", { ascending: false }).limit(100)),
      () => safeSelect("activities",   (q) => q.order("created_at", { ascending: false }).limit(50)),
      () => safeSelect("classes",      (q) => q.order("n",          { ascending: true })),
      () => safeSelect("staff",        (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("inventory",    (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("inventory_movements", (q) => q.order("at",  { ascending: false }).limit(30)),
      () => safeSelect("broadcasts",   (q) => q.order("sent_at",    { ascending: false }).limit(50)),
      () => safeSelect("message_templates", (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("recipient_lists",   (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("donors",       (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("campaigns",    (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("transport_attendance", (q) => q.order("date", { ascending: false }).limit(2000)),
      // New tables — see schema.sql additions.
      () => safeSelect("timetable",            (q) => q.order("cls",        { ascending: true })),
      () => safeSelect("library",              (q) => q.order("added_at",   { ascending: false })),
      () => safeSelect("library_loans",        (q) => q.order("borrowed_at",{ ascending: false }).limit(2000)),
      () => safeSelect("inventory_categories", (q) => q.order("created_at", { ascending: true })),
      () => safeSelect("exams",                (q) => q.order("created_at", { ascending: false })),
      () => safeSelect("exam_marks",           (q) => q.order("recorded_at",{ ascending: false }).limit(5000)),
      () => safeSelect("teacher_attendance",   (q) => q.order("date",       { ascending: false }).limit(2000)),
    ]);
    const stopMap = pickupStopsSafe();
    const eveningStopMap = pickupStopsEveningSafe();
    const growthMap = studentGrowthOverlaysSafe();
    const allStudents = s.map((row) => {
      const out = fromStudent(row);
      // Overlay any pickup-stop assignments we have in the file side-stores.
      if (out && !out.pickupStop && stopMap[out.id]) out.pickupStop = stopMap[out.id];
      if (out && !out.pickupStopEvening && eveningStopMap[out.id]) out.pickupStopEvening = eveningStopMap[out.id];
      // Height/weight overlay when Supabase columns are not migrated yet.
      if (out && growthMap[out.id]) {
        const g = growthMap[out.id];
        if (out.heightCm == null && g.heightCm != null) out.heightCm = g.heightCm;
        if (out.weightKg == null && g.weightKg != null) out.weightKg = g.weightKg;
        if (!out.measuredAt && g.measuredAt) out.measuredAt = g.measuredAt;
      }
      return out;
    });
    const mapClassRow = (c) => ({
      n: c.n, label: c.label || `Class ${c.n}`,
      sections: Array.isArray(c.sections) ? c.sections : [],
      subjects: Array.isArray(c.subjects) ? c.subjects : [],
      students: 0,
    });
    const liveClasses = cls.map(mapClassRow);
    // Union of: live Supabase classes + file fallback + STATIC defaults.
    // Deduped by class number, with later sources only filling gaps. This
    // way a class auto-created on first admission shows up alongside the
    // built-in 1-8 list instead of replacing it. Subjects merge from any
    // source that has them (file overlay when Supabase column is missing).
    const fileClasses = (fileDbSafe().classes || []).map(mapClassRow);
    const classMap = new Map();
    for (const list of [liveClasses, fileClasses, STATIC_EMPTIES.classes]) {
      for (const c of list) {
        const row = mapClassRow(c);
        const key = Number(row.n);
        if (!Number.isFinite(key)) continue;
        row.n = key;
        const prev = classMap.get(key);
        if (!prev) {
          classMap.set(key, row);
        } else if ((!prev.subjects || !prev.subjects.length) && row.subjects.length) {
          classMap.set(key, { ...prev, subjects: row.subjects });
        }
      }
    }
    const mergedClasses = Array.from(classMap.values()).sort((a, b) => Number(a.n) - Number(b.n));
    // Run the v2 list-queries in PARALLEL. Previously these were ~13 separate
    // `await`s inside the return object, which run one-after-another — on a
    // flaky VPS↔Supabase link each stall compounds and /api/data took 60s+.
    const [
      expenseCategoriesR, expenseTemplatesR, donorFormSubmissionsR, leaveRequestsR,
      remarksRewardsR, governmentDocumentsR, studentActivitiesR, customRolesR,
      scaleSessionsR, scaleEntriesR, scaleSupportPlansR, scaleDailyRitualsR, syllabusR,
    ] = await runBatched([
      () => listExpenseCategories().catch(() => safeArr("expenseCategories")),
      () => listExpenseTemplates().catch(() => safeArr("expenseTemplates")),
      () => listDonorFormSubmissions({ limit: 200 }).catch(() => safeArr("donorFormSubmissions")),
      () => listLeaveRequests({ limit: 200 }).catch(() => safeArr("leaveRequests")),
      () => listRemarksRewards({ limit: 200 }).catch(() => safeArr("remarksRewards")),
      () => listGovernmentDocuments({ limit: 200 }).catch(() => safeArr("governmentDocuments")),
      () => listStudentActivities({ limit: 500 }).catch(() => safeArr("studentActivities")),
      () => listCustomRoles().catch(() => safeArr("customRoles")),
      () => listScaleSessions({ limit: 200 }).catch(() => safeArr("scaleSessions")),
      () => listScaleEntries({ limit: 2000 }).catch(() => safeArr("scaleEntries")),
      () => listSupportPlans({ limit: 200 }).catch(() => safeArr("scaleSupportPlans")),
      () => listDailyRituals({ limit: 200 }).catch(() => safeArr("scaleDailyRituals")),
      () => listSyllabus().catch(() => safeArr("syllabus")),
    ]);
    return {
      ...STATIC_EMPTIES,
      classes: mergedClasses,
      // Active roster goes to addedStudents; archived ones available separately.
      addedStudents:    allStudents.filter((x) => x.status !== "archived"),
      archivedStudents: allStudents.filter((x) => x.status === "archived"),
      pendingFees:   pf.map(fromPendingFee),
      recentFees:    [...rf.map(fromRecentFee), ...fileRecentFeesSafe()],
      complaints:    [...cm.map(fromComplaint), ...fileComplaintsSafe()],
      enquiries:     [...(eq || []).map(fromEnquiry), ...fileEnquiriesSafe()],
      dailyLogs:     applyDailyLogOverlays(dl.map(fromDailyLog)),
      // Union with file-store routes in case writes fell back to file
      // (PostgREST cache lag or table missing). Deduped by code with
      // Supabase as source-of-truth — file-backed rows are only added if
      // their code isn't already present in the Supabase result. Prevents
      // duplicate route cards in the UI when both backends carry a row
      // for the same code (happens after a template apply if the file
      // backend has stale leftovers from earlier testing).
      routes:        (() => {
        const out = (rt || []).map(fromRoute);
        const seen = new Set(out.map((r) => String(r.code || "").toUpperCase()));
        for (const r of fileRoutesSafe()) {
          const code = String(r.code || "").toUpperCase();
          if (seen.has(code)) continue;
          seen.add(code);
          out.push(r);
        }
        return out;
      })(),
      // Master timetable templates — pulled via the dedicated helper
      // (handles the schema-miss fallback to file store internally).
      // Errors are swallowed so a missing migration can't break /api/data.
      // Belt-and-braces try/catch on top of the listRouteTemplates internal
      // schema-miss handling, so even a totally unexpected exception in the
      // helper can't take down the whole readAllData payload.
      routeTemplates: await (async () => {
        try { return await listRouteTemplates(); }
        catch (e) { console.warn(`[db] listRouteTemplates failed (returning empty): ${e.message}`); return []; }
      })(),
      audit:         al.map(fromAudit),
      activities:    ac.map(fromActivity),
      // Active staff only — soft-deleted rows stay in the row but are filtered out of the working list.
      // Union with the file-store staff list, in case writes fell back there
      // while the Supabase table was missing or PostgREST was stale.
      staff: [
        ...(st || []).filter((r) => !r.archived_at).map(fromStaff),
        ...(fileStaffSafe()),
      ],
      // Same union pattern for inventory + movements (works whether the
      // Supabase tables exist or writes fell back to the local file store).
      // Remarks are merged from a file-store override map so they persist even
      // before the `remarks` column migration is applied to Supabase.
      inventory: applyInventoryRemarkOverrides([
        ...(inv || []).filter((r) => !r.archived_at).map(fromInventory),
        ...(fileInventorySafe()),
      ]),
      movements: [
        ...(mv || []).map(fromMovement),
        ...(fileMovementsSafe()),
      ],
      broadcasts: [
        ...(bc || []).map(fromBroadcast),
        ...(fileBroadcastsSafe()),
      ],
      templates: [
        ...(tp || []).map(fromTemplate),
        ...(fileTemplatesSafe()),
      ],
      recipientLists: [
        ...(rl || []).map(fromRecipientList),
        ...(fileRecipientListsSafe()),
      ],
      donors: [
        ...(dn || []).filter((r) => !r.archived_at).map(fromDonor),
        ...(fileDonorsSafe()),
      ],
      campaigns: [
        ...(cp || []).map(fromCampaign),
        ...(fileCampaignsSafe()),
      ],
      // Union of Supabase + file. Same fix as expenses — without the
      // cloud read, donations created in Supabase never showed up in the
      // Money Control "Donation" income line. Deduped by id.
      donorReceipts: await mergeDonorReceipts(),
      rolePermissions: rolePermissionsSafe(),
      tasks: fileTasksSafe(),
      // Union of Supabase + file so Money Control sees expenses logged via
      // either backend. Without the cloud read, /api/expenses POSTed to
      // Supabase succeeded but never appeared on the KPI strip. Deduped
      // by id so a row that exists in both counts once.
      expenses: await mergeExpenses(),
      // Same merge pattern as expenses + donor_receipts — without the
      // cloud read, an "issued" TC saved to Supabase never reached the
      // Students screen, so the "TC issued" chip stayed off.
      tcRequests: await mergeTcRequests(),
      maintenanceLogs: fileMaintenanceLogsSafe(),
      transportAttendance: [
        ...((txa || []).map(fromTransportAttendance)),
        ...fileTransportAttendanceSafe(),
      ],
      staffAwards: await listStaffAwards().catch(() => []),
      subjects: await listSubjects().catch(() => DEFAULT_SUBJECTS),
      // App-wide settings (trust identity, finance, communication, security)
      // — exposed to the client so every screen's CSV / PDF export can
      // stamp the right school name on the header. Falls back to {} so
      // exports default to the bundled "Sanfort International School" if
      // settings haven't been written yet.
      appSettings: await readSettings().catch(() => ({})),
      teacherAttendance: (() => {
        // Supabase is the source of truth; union any file-store rows not present.
        const supa = (ta || []).map(fromTeacherAttendance).filter(Boolean);
        const seen = new Set(supa.map((r) => `${r.teacherId}|${r.date}`));
        const file = safeArr("teacherAttendance").filter((r) => !seen.has(`${r.teacherId}|${r.date}`));
        return [...supa, ...file];
      })(),
      // Union of Supabase exams + file-store exams. Without the Supabase
      // half, exams created on the cloud backend never appeared in
      // /api/data, which made every newly-created exam look like it had
      // "replaced" the prior one (the UI was actually showing whatever
      // stale row sat in the file store). Dedupe by id, Supabase wins.
      exams: (() => {
        const cloud = (ex || []).map(fromExam);
        const file  = safeArr("exams");
        const m = new Map();
        for (const e of file)  if (e?.id) m.set(e.id, e);
        for (const e of cloud) if (e?.id) m.set(e.id, e);
        return [...m.values()];
      })(),
      // Same union pattern for marks (the per-student scores).
      marks: (() => {
        const cloud = (mk || []).map(fromExamMark);
        const file  = safeArr("marks");
        const m = new Map();
        for (const r of file)  if (r?.id) m.set(r.id, r);
        for (const r of cloud) if (r?.id) m.set(r.id, r);
        return [...m.values()];
      })(),
      meetings: safeArr("meetings"),
      volunteers: safeArr("volunteers"),
      chatThreads: safeArr("chatThreads"),
      feeReminders: safeArr("feeReminders"),
      // Union of Supabase rows + file-store rows so the dev fallback keeps
      // working if the migration hasn't been applied yet, AND so any rows
      // written via the file-store path before the table existed still show.
      // De-dupe by id (Supabase wins) where applicable.
      inventoryCategories: (() => {
        const set = new Set([...(invCats || []).map((r) => r.key), ...safeArr("inventoryCategories")]);
        return [...set];
      })(),
      // v2 additions — expense categories, public donor-form submissions.
      // Failures are tolerated so a fresh install (where the v2 migration
      // hasn't been applied yet) still loads.
      expenseCategories: expenseCategoriesR,
      expenseTemplates:  expenseTemplatesR,
      donorFormSubmissions: donorFormSubmissionsR,
      leaveRequests: leaveRequestsR,
      remarksRewards: remarksRewardsR,
      governmentDocuments: governmentDocumentsR,
      studentActivities: studentActivitiesR,
      customRoles: customRolesR,
      scaleSessions: scaleSessionsR,
      scaleEntries:  scaleEntriesR,
      scaleSupportPlans: scaleSupportPlansR,
      scaleDailyRituals: scaleDailyRitualsR,
      library: (() => {
        const sb = (lib || []).map(fromBook);
        const seen = new Set(sb.map((b) => b.id));
        const file = safeArr("library").filter((b) => !seen.has(b.id));
        return [...sb, ...file];
      })(),
      libraryLoans: (() => {
        const sb = (lns || []).map(fromLoan);
        const seen = new Set(sb.map((l) => l.id));
        const file = safeArr("libraryLoans").filter((l) => !seen.has(l.id));
        return [...sb, ...file];
      })(),
      timetable: (() => {
        const sb = (tt || []).map(fromTimetable);
        const seen = new Set(sb.map((t) => t.id));
        const file = safeArr("timetable").filter((t) => !seen.has(t.id));
        return [...sb, ...file];
      })(),
      // Per-class syllabus rows. Read via listSyllabus which itself unions
      // Supabase + file store, so a fresh install (no migration) still works.
      syllabus: syllabusR,
      // Map studentId → snapshot of the previous fee state for any edit
      // made in the last hour. The Students FeeCell uses this to surface
      // an "Undo" button only while the snapshot is still valid.
      feeEditSnapshots: listFeeEditSnapshots(),
      // User accounts — needed by the parent dashboard to look up the
      // class teacher by name. The /api/data role-scoper trims this
      // down for parents (only teachers + their email/linkedClasses
      // make it through) so parent dashboards stay information-tight.
      users: await listUsers().catch(() => []),
      // Audit trails — full history of every fee change and every
      // transport assignment. Unioned from Supabase + file fallback so
      // a row written during a cache-miss isn't lost.
      feeEdits: await (async () => {
        try {
          const r = await safeSelect("fee_edits", (q) => q.order("created_at", { ascending: false }).limit(2000));
          const m = new Map();
          for (const x of r) if (x?.id) m.set(x.id, x);
          for (const x of fileFeeEditsSafe()) if (x?.id && !m.has(x.id)) m.set(x.id, x);
          return [...m.values()];
        } catch { return fileFeeEditsSafe(); }
      })(),
      transportAssignments: await (async () => {
        try {
          const r = await safeSelect("transport_assignments", (q) => q.order("assigned_at", { ascending: false }).limit(5000));
          const m = new Map();
          for (const x of r) if (x?.id) m.set(x.id, x);
          for (const x of fileTransportAssignmentsSafe()) if (x?.id && !m.has(x.id)) m.set(x.id, x);
          return [...m.values()];
        } catch { return fileTransportAssignmentsSafe(); }
      })(),
    };
  }
  const db = fileRead();
  const growthMap = studentGrowthOverlaysSafe();
  const all = (db.addedStudents || []).map((s) => {
    if (!s || !growthMap[s.id]) return s;
    const g = growthMap[s.id];
    const out = { ...s };
    if (out.heightCm == null && g.heightCm != null) out.heightCm = g.heightCm;
    if (out.weightKg == null && g.weightKg != null) out.weightKg = g.weightKg;
    if (!out.measuredAt && g.measuredAt) out.measuredAt = g.measuredAt;
    return out;
  });
  return {
    ...STATIC_EMPTIES,
    ...db,
    classes: (db.classes && db.classes.length) ? db.classes : STATIC_EMPTIES.classes,
    addedStudents:    all.filter((x) => (x.status ?? "active") !== "archived"),
    archivedStudents: all.filter((x) => x.status === "archived"),
    inventoryCategories: Array.isArray(db.inventoryCategories) ? db.inventoryCategories : [],
    library: Array.isArray(db.library) ? db.library : [],
    libraryLoans: Array.isArray(db.libraryLoans) ? db.libraryLoans : [],
    timetable: Array.isArray(db.timetable) ? db.timetable : [],
    syllabus: Array.isArray(db.syllabus) ? db.syllabus : [],
    appSettings: db.appSettings && typeof db.appSettings === "object" ? db.appSettings : {},
    feeEditSnapshots: listFeeEditSnapshots(),
    feeEdits: fileFeeEditsSafe(),
    transportAssignments: fileTransportAssignmentsSafe(),
  };
}

// ---------- classes ----------
function normalizeClassSubjects(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    const name = String(s || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export async function addClass(row) {
  const n = Number(row.n);
  const label = String(row.label || `Class ${n}`).trim();
  const sections = Array.isArray(row.sections) ? row.sections : [];
  const subjects = normalizeClassSubjects(row.subjects);
  if (!n || Number.isNaN(n) || n < 1) throw new Error("Class number must be a positive integer");
  if (supabaseEnabled) {
    const payload = { n, label, sections, subjects };
    let ins = await supabase.from("classes").insert(payload).select().maybeSingle();
    // Older DBs may not have subjects column yet — retry without it.
    if (ins.error && /subjects/i.test(ins.error.message)) {
      ins = await supabase.from("classes").insert({ n, label, sections }).select().maybeSingle();
    }
    if (!ins.error) {
      // Mirror to file so subjects survive before the migration is applied.
      try {
        const db = fileRead();
        if (!Array.isArray(db.classes)) db.classes = [];
        const idx = db.classes.findIndex((c) => Number(c.n) === n);
        const fileRow = { n, label, sections, subjects };
        if (idx === -1) db.classes.push(fileRow);
        else db.classes[idx] = { ...db.classes[idx], ...fileRow };
        db.classes.sort((a, b) => Number(a.n) - Number(b.n));
        fileWrite(db);
      } catch {}
      return { n, label, sections, subjects };
    }
    // PostgREST cache lag / missing classes table → fall back to file.
    if (!/classes/i.test(ins.error.message)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.classes)) db.classes = [];
  if (db.classes.find((c) => Number(c.n) === n)) throw new Error(`Class ${n} already exists`);
  db.classes.push({ n, label, sections, subjects });
  db.classes.sort((a, b) => Number(a.n) - Number(b.n));
  fileWrite(db);
  return { n, label, sections, subjects };
}

export async function updateClass(n, patch) {
  const num = Number(n);
  const subjects = "subjects" in patch ? normalizeClassSubjects(patch.subjects) : undefined;
  if (supabaseEnabled) {
    const body = {};
    if (typeof patch.label === "string") body.label = patch.label;
    if (Array.isArray(patch.sections)) body.sections = patch.sections;
    if (subjects !== undefined) body.subjects = subjects;
    let r = await supabase.from("classes").update(body).eq("n", num).select().maybeSingle();
    if (r.error && subjects !== undefined && /subjects/i.test(r.error.message)) {
      const { subjects: _drop, ...withoutSubjects } = body;
      r = Object.keys(withoutSubjects).length
        ? await supabase.from("classes").update(withoutSubjects).eq("n", num).select().maybeSingle()
        : { error: null, data: { n: num, ...withoutSubjects } };
    }
    // Always mirror subjects (and other fields) to file for durability.
    try {
      const db = fileRead();
      if (!Array.isArray(db.classes)) db.classes = [];
      let idx = db.classes.findIndex((c) => Number(c.n) === num);
      if (idx === -1) {
        const seed = (STATIC_EMPTIES.classes || []).find((c) => Number(c.n) === num);
        if (seed) {
          db.classes.push({ n: seed.n, label: seed.label, sections: [...(seed.sections || [])], subjects: [] });
          idx = db.classes.length - 1;
        }
      }
      if (idx !== -1) {
        const next = { ...db.classes[idx] };
        if (typeof patch.label === "string") next.label = patch.label;
        if (Array.isArray(patch.sections)) next.sections = patch.sections;
        if (subjects !== undefined) next.subjects = subjects;
        db.classes[idx] = next;
        fileWrite(db);
        if (!r.error) {
          const data = r.data && typeof r.data === "object" ? r.data : {};
          return {
            n: num,
            label: data.label ?? next.label,
            sections: Array.isArray(data.sections) ? data.sections : next.sections,
            subjects: Array.isArray(data.subjects) ? data.subjects : (next.subjects || []),
          };
        }
      }
    } catch {}
    if (!r.error && r.data) {
      return {
        ...r.data,
        subjects: Array.isArray(r.data.subjects) ? r.data.subjects : (subjects ?? []),
      };
    }
    // Cache lag / missing → fall through to file.
  }
  const db = fileRead();
  if (!Array.isArray(db.classes)) db.classes = [];
  let idx = db.classes.findIndex((c) => Number(c.n) === num);
  // If the class doesn't exist in the file yet, seed it from STATIC defaults
  // (so updateClass can extend a built-in class's sections without a manual
  // create step).
  if (idx === -1) {
    const seed = (STATIC_EMPTIES.classes || []).find((c) => Number(c.n) === num);
    if (seed) {
      db.classes.push({ n: seed.n, label: seed.label, sections: [...(seed.sections || [])], subjects: [] });
      idx = db.classes.length - 1;
    } else {
      return null;
    }
  }
  const nextPatch = { ...patch };
  if (subjects !== undefined) nextPatch.subjects = subjects;
  db.classes[idx] = { ...db.classes[idx], ...nextPatch };
  fileWrite(db);
  return db.classes[idx];
}

export async function removeClass(n) {
  const num = Number(n);
  if (supabaseEnabled) {
    const r = await supabase.from("classes").delete().eq("n", num);
    if (r.error) throw new Error(r.error.message);
    return true;
  }
  const db = fileRead();
  db.classes = (db.classes || []).filter((c) => Number(c.n) !== num);
  fileWrite(db);
  return true;
}

// ---------- audit + activity (used by other helpers) ----------
// IMPORTANT: every caller of logAudit / addActivity wraps the await in
// try/catch because the audit trail is best-effort — we never want a
// failed audit row to roll back the real business action. The functions
// themselves still attempt the Supabase insert and surface the error
// via console.warn so issues are visible in pm2 logs even when the
// caller's try/catch swallows them.
export async function logAudit(who, action, entity) {
  const id = "AUD-" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  const whenLabel = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (supabaseEnabled) {
    const ins = await supabase.from("audit_log").insert({
      id, who, action, entity, when_label: whenLabel, ip: null,
    });
    if (ins.error) {
      console.warn(`[db] audit_log insert failed: ${ins.error.message}`);
      throw new Error(`audit_log insert failed: ${ins.error.message}`);
    }
    return { id, who, action, entity, when: whenLabel };
  }
  const db = fileRead();
  const row = { id, who, action, entity, when: whenLabel, ip: "10.0.1.45" };
  db.audit.unshift(row);
  fileWrite(db);
  return row;
}

export async function addActivity(row) {
  if (supabaseEnabled) {
    const ins = await supabase.from("activities").insert({
      t: row.t, tone: row.tone, title: row.title, sub: row.sub, ts: row.ts || "now",
    });
    if (ins.error) {
      console.warn(`[db] activities insert failed: ${ins.error.message}`);
      throw new Error(`activities insert failed: ${ins.error.message}`);
    }
    return;
  }
  const db = fileRead();
  db.activities.unshift({ ts: "now", ...row });
  fileWrite(db);
}

// ---------- students ----------
export async function addStudent(row) {
  // Make sure the class+section the student is being admitted to actually
  // exists in the classes table. If not, auto-create it so the student
  // shows up everywhere (Academic, Attendance, Classes screen, KPIs).
  // Best-effort — if it errors we still admit the student.
  try { await ensureClassSection(row.cls); } catch {}

  if (supabaseEnabled) {
    const payload = toStudent(row);
    let ins = await supabase.from("students").insert(payload).select().single();
    // PostgREST schema cache can lag for newly-added columns. If the cache
    // doesn't know about a column, retry with the unknown fields stripped
    // so the admission still succeeds. Anything stripped goes to a file
    // side-store so the data isn't lost.
    if (ins.error && /status|archived_at|pickup_stop|transport_evening/.test(ins.error.message)) {
      const { status, archived_at, pickup_stop, transport_evening, pickup_stop_evening, ...legacy } = payload;
      ins = await supabase.from("students").insert(legacy).select().single();
    }
    if (ins.error) throw new Error(ins.error.message);
    // Persist the stripped fields locally so per-stop boarding + evening
    // route logic continues to work without the schema migration.
    if (payload.pickup_stop) savePickupStop(payload.id, payload.pickup_stop);
    if (payload.pickup_stop_evening) savePickupStopEvening(payload.id, payload.pickup_stop_evening);
    const out = fromStudent(ins.data);
    if (payload.pickup_stop && !out.pickupStop) out.pickupStop = payload.pickup_stop;
    if (payload.pickup_stop_evening && !out.pickupStopEvening) out.pickupStopEvening = payload.pickup_stop_evening;
    if (payload.transport_evening && !out.transportEvening) out.transportEvening = payload.transport_evening;
    // Mirror the transport assignment into the audit table so the row
    // exists from day-one alongside the students-table column.
    try {
      await writeTransportAssignmentsForStudent(out, "admission");
    } catch (e) {
      console.warn(`[db] transport_assignments admission audit failed (non-fatal): ${e.message}`);
    }
    return out;
  }
  const db = fileRead();
  db.addedStudents.unshift(row);
  fileWrite(db);
  try {
    await writeTransportAssignmentsForStudent(row, "admission");
  } catch (e) {
    console.warn(`[db] transport_assignments admission audit failed (non-fatal): ${e.message}`);
  }
  return row;
}

// Helper used by addStudent + updateStudent + bulk-assign — writes one
// audit row per direction (morning + evening) whenever either field
// changes. Skips the audit if the assignment didn't change.
async function writeTransportAssignmentsForStudent(student, actor) {
  if (!student?.id) return;
  if (student.transport && student.transport !== "—") {
    await appendTransportAssignment({
      studentId: student.id,
      studentName: student.name,
      cls: student.cls,
      direction: "morning",
      routeCode: student.transport,
      stopName: student.pickupStop || null,
      assignedBy: actor || null,
    });
  }
  if (student.transportEvening && student.transportEvening !== "—") {
    await appendTransportAssignment({
      studentId: student.id,
      studentName: student.name,
      cls: student.cls,
      direction: "evening",
      routeCode: student.transportEvening,
      stopName: student.pickupStopEvening || null,
      assignedBy: actor || null,
    });
  }
}

// Pretty label for a class number — delegates to the shared display
// helper. Primary classes render as "Class V" / "Class VI" etc.
// (Roman numerals), pre-school buckets as "PRE-MONT" / "MONT I" / "MONT II".
// Storage shape (cls = "N-A") is unaffected — this is presentation only.
function labelForClass(n) {
  return formatClassLabel(String(n));
}

// Ensure a class number + section letter exist in the classes table.
// Accepts "5-A" / "13-A" (PRE-MONT, section A) / etc.
// Idempotent — does nothing when both already present.
async function ensureClassSection(clsKey) {
  if (!clsKey) return;
  const [nStr, sec] = String(clsKey).split("-");
  const n = Number(nStr);
  const section = String(sec || "").toUpperCase();
  if (!n || Number.isNaN(n)) return;

  // Look across every source — Supabase live, file fallback, AND the
  // built-in STATIC defaults (Class 1-8 with A/B). The STATIC defaults
  // matter because if the user admits to "3-D", Class 3 already "exists"
  // structurally even if no row was ever written to file/Supabase.
  const all = await safeSelect("classes", (q) => q.order("n"));
  const fileDb = fileRead();
  const fileClasses = Array.isArray(fileDb.classes) ? fileDb.classes : [];
  // Union sections from EVERY source so we don't accidentally drop
  // sections that live in a different store. (STATIC has A/B; the file
  // might have D from an earlier auto-add; Supabase might have its own.)
  const sources = [all || [], fileClasses, STATIC_EMPTIES.classes || []];
  const sectionSet = new Set();
  let foundAnywhere = false;
  for (const src of sources) {
    const hit = src.find((c) => Number(c.n) === n);
    if (hit) {
      foundAnywhere = true;
      for (const s of (hit.sections || [])) sectionSet.add(String(s).toUpperCase());
    }
  }

  if (!foundAnywhere) {
    const sections = section ? [section] : ["A"];
    try { await addClass({ n, label: labelForClass(n), sections }); } catch {}
    return;
  }
  if (section && !sectionSet.has(section)) {
    sectionSet.add(section);
    const merged = Array.from(sectionSet).sort();
    try { await updateClass(n, { sections: merged }); } catch {}
  }
}

// Edit a student's mutable fields. Currently the Transport screen uses this
// to assign / change a student's bus + pickup stop without re-admitting them.
// Other fields (name, cls, parent) could be added the same way later.
//
// pickupStop falls back to the file side-store when the Supabase students
// table doesn't yet have the pickup_stop column (so the per-stop boarding
// roster works even before the schema migration).
function studentGrowthOverlaysSafe() {
  try {
    const db = fileRead();
    return (db.studentGrowthOverlays && typeof db.studentGrowthOverlays === "object")
      ? db.studentGrowthOverlays : {};
  } catch { return {}; }
}

function saveStudentGrowthOverlay(id, patch) {
  if (!id) return;
  const db = fileRead();
  if (!db.studentGrowthOverlays || typeof db.studentGrowthOverlays !== "object") db.studentGrowthOverlays = {};
  db.studentGrowthOverlays[id] = {
    ...(db.studentGrowthOverlays[id] || {}),
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  };
  fileWrite(db);
}

export async function updateStudent(id, patch) {
  if (!id) return null;
  const fields = {};
  if (typeof patch.name === "string")             fields.name      = patch.name;
  if (typeof patch.cls === "string")              fields.cls       = patch.cls;
  if (typeof patch.parent === "string")           fields.parent    = patch.parent;
  if (typeof patch.transport === "string")        fields.transport = patch.transport || "—";
  if (typeof patch.transportEvening === "string") fields.transport_evening = patch.transportEvening || null;
  // Height / weight — class teachers update anytime. Stored on the student
  // row (latest snapshot); also mirrored to a file overlay for schema lag.
  const wantsGrowth = "heightCm" in patch || "weightKg" in patch;
  if (wantsGrowth) {
    if ("heightCm" in patch) {
      const h = patch.heightCm === null || patch.heightCm === "" ? null : Number(patch.heightCm);
      fields.height_cm = (h != null && Number.isFinite(h) && h > 0) ? h : null;
    }
    if ("weightKg" in patch) {
      const w = patch.weightKg === null || patch.weightKg === "" ? null : Number(patch.weightKg);
      fields.weight_kg = (w != null && Number.isFinite(w) && w > 0) ? w : null;
    }
    fields.measured_at = patch.measuredAt || new Date().toISOString();
    saveStudentGrowthOverlay(id, {
      heightCm: fields.height_cm !== undefined ? fields.height_cm : undefined,
      weightKg: fields.weight_kg !== undefined ? fields.weight_kg : undefined,
      measuredAt: fields.measured_at,
    });
  }
  // Stops are handled separately via the side-stores so they always stick
  // even when the matching columns don't exist on the Supabase table.
  const wantsStop = "pickupStop" in patch;
  const wantsEveningStop = "pickupStopEvening" in patch;

  if (supabaseEnabled) {
    if (Object.keys(fields).length > 0) {
      let upd = await supabase.from("students").update(fields).eq("id", id);
      // Drop unknown columns (transport_evening / height_cm / …) and retry.
      let attempt = fields;
      let safety = 5;
      while (upd.error && safety-- > 0) {
        const m = /Could not find the '([a-z_]+)' column/i.exec(upd.error.message)
          || (/transport_evening/.test(upd.error.message) ? ["", "transport_evening"] : null);
        if (!m) break;
        const next = { ...attempt };
        delete next[m[1]];
        if (Object.keys(next).length === Object.keys(attempt).length) break;
        attempt = next;
        if (!Object.keys(attempt).length) { upd = { error: null }; break; }
        upd = await supabase.from("students").update(attempt).eq("id", id);
      }
      if (upd.error) {
        console.warn(`[db] student update fell back: ${upd.error.message}`);
      }
      // Keep the pending_fees snapshot in sync so the Fees screen reads the
      // new name/class without a separate migration.
      if (fields.name || fields.cls) {
        const sync = {};
        if (fields.name) sync.name = fields.name;
        if (fields.cls)  sync.cls  = fields.cls;
        await supabase.from("pending_fees").update(sync).eq("id", id);
      }
    }
    if (wantsStop) {
      const upd2 = await supabase.from("students").update({ pickup_stop: patch.pickupStop || null }).eq("id", id);
      if (upd2.error) {
        savePickupStop(id, patch.pickupStop);
      }
    }
    if (wantsEveningStop) {
      const upd3 = await supabase.from("students").update({ pickup_stop_evening: patch.pickupStopEvening || null }).eq("id", id);
      if (upd3.error) {
        savePickupStopEvening(id, patch.pickupStopEvening);
      }
    }
    // Return the merged record (read-back through the fromStudent mapper +
    // side-store overlay).
    const sel = await supabase.from("students").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const out = fromStudent(sel.data);
      if (wantsStop && !out.pickupStop) out.pickupStop = patch.pickupStop || null;
      if (wantsEveningStop && !out.pickupStopEvening) out.pickupStopEvening = patch.pickupStopEvening || null;
      if (fields.transport_evening && !out.transportEvening) out.transportEvening = fields.transport_evening;
      if (wantsGrowth) {
        const g = studentGrowthOverlaysSafe()[id] || {};
        if (out.heightCm == null && (fields.height_cm != null || g.heightCm != null)) out.heightCm = fields.height_cm ?? g.heightCm;
        if (out.weightKg == null && (fields.weight_kg != null || g.weightKg != null)) out.weightKg = fields.weight_kg ?? g.weightKg;
        if (!out.measuredAt) out.measuredAt = fields.measured_at || g.measuredAt || null;
      }
      // Audit-log the transport change in transport_assignments if either
      // the morning or evening side was touched in this update.
      if ("transport" in patch || wantsStop || "transportEvening" in patch || wantsEveningStop) {
        try { await writeTransportAssignmentsForStudent(out, "updateStudent"); } catch (e) {
          console.warn(`[db] transport_assignments update audit failed (non-fatal): ${e.message}`);
        }
      }
      return out;
    }
  }
  // File-only path
  const db = fileRead();
  const idx = (db.addedStudents || []).findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const merged = { ...db.addedStudents[idx] };
  if (fields.name !== undefined) merged.name = fields.name;
  if (fields.cls !== undefined) merged.cls = fields.cls;
  if (fields.parent !== undefined) merged.parent = fields.parent;
  if (fields.transport !== undefined) merged.transport = fields.transport;
  if (fields.transport_evening !== undefined) merged.transportEvening = fields.transport_evening;
  if (fields.height_cm !== undefined) merged.heightCm = fields.height_cm;
  if (fields.weight_kg !== undefined) merged.weightKg = fields.weight_kg;
  if (fields.measured_at !== undefined) merged.measuredAt = fields.measured_at;
  if (wantsStop) merged.pickupStop = patch.pickupStop || null;
  if (wantsEveningStop) merged.pickupStopEvening = patch.pickupStopEvening || null;
  db.addedStudents[idx] = merged;
  // Mirror name/cls onto any pending fees so list views stay consistent.
  if (fields.name || fields.cls) {
    db.pendingFees = (db.pendingFees || []).map((f) => (
      f.id === id ? { ...f, ...(fields.name ? { name: fields.name } : {}), ...(fields.cls ? { cls: fields.cls } : {}) } : f
    ));
  }
  fileWrite(db);
  if (wantsStop) savePickupStop(id, patch.pickupStop);
  if (wantsEveningStop) savePickupStopEvening(id, patch.pickupStopEvening);
  if ("transport" in patch || wantsStop || "transportEvening" in patch || wantsEveningStop) {
    try { await writeTransportAssignmentsForStudent(merged, "updateStudent"); } catch (e) {
      console.warn(`[db] transport_assignments update audit failed (non-fatal): ${e.message}`);
    }
  }
  return merged;
}

// Soft-delete (archive) a student. Production rule: never lose records.
//   - The student row is kept; status flips to 'archived' and archived_at is set.
//   - Their PAID receipts (recent_fees) and DAILY LOGS are kept forever — they
//     belong to the school's permanent record.
//   - Their PENDING fee is removed because we no longer expect to collect it.
//   - The audit-log "Archived student" row is appended by the API route.
//   - Restore via restoreStudent() simply clears the flag.
export async function archiveStudent(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("students").select("*").eq("id", id).maybeSingle();
    if (!sel.data) return null;
    if (sel.data.status === "archived") return fromStudent(sel.data);
    let upd = await supabase.from("students")
      .update({ status: "archived", archived_at: new Date().toISOString() })
      .eq("id", id);
    // PostgREST cache lag fallback: try with a single column, or as last
    // resort just delete the pending fee so it disappears from active views.
    if (upd.error && /archived_at/.test(upd.error.message)) {
      upd = await supabase.from("students").update({ status: "archived" }).eq("id", id);
    }
    if (upd.error && /status/.test(upd.error.message)) {
      // Schema cache stuck on both columns — fall back to full delete.
      await supabase.from("students").delete().eq("id", id);
    }
    await supabase.from("pending_fees").delete().eq("id", id);
    return fromStudent({ ...sel.data, status: "archived" });
  }
  const db = fileRead();
  const idx = db.addedStudents.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  if (db.addedStudents[idx].status === "archived") return db.addedStudents[idx];
  db.addedStudents[idx] = { ...db.addedStudents[idx], status: "archived", archivedAt: new Date().toISOString() };
  db.pendingFees = db.pendingFees.filter((f) => f.id !== id);
  fileWrite(db);
  return db.addedStudents[idx];
}

export async function restoreStudent(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("students").select("*").eq("id", id).maybeSingle();
    if (!sel.data) return null;
    await supabase.from("students")
      .update({ status: "active", archived_at: null })
      .eq("id", id);
    return fromStudent({ ...sel.data, status: "active" });
  }
  const db = fileRead();
  const idx = db.addedStudents.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  db.addedStudents[idx] = { ...db.addedStudents[idx], status: "active", archivedAt: null };
  fileWrite(db);
  return db.addedStudents[idx];
}

// Backwards-compat alias so any older code paths that still call removeStudent
// archive instead of cascade-deleting.
export const removeStudent = archiveStudent;

// ---------- fee edit snapshots (for single-step undo) ----------
// One-hour transient store mapping studentId → { previousPending,
// addedReceiptIds, editedAt, editedBy }. Backed by data/fee-edit-snapshots.json
// (file-only, single-VPS deployment — no Supabase round-trip needed for a
// store that auto-prunes within an hour). Only the MOST RECENT edit per
// student is undoable; a fresh edit overwrites the prior snapshot.
const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // 1 hour
const SNAPSHOT_PATH = path.join(DATA_DIR, "fee-edit-snapshots.json");

function readFeeEditSnapshotsRaw() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return {};
    const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function writeFeeEditSnapshotsRaw(obj) {
  try {
    fileEnsure();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn(`[db] fee-edit-snapshots write failed: ${e.message}`);
  }
}
function pruneExpiredSnapshots(snapshots) {
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(snapshots)) {
    const editedAt = Date.parse(snapshots[id]?.editedAt || "");
    if (!editedAt || (now - editedAt) > SNAPSHOT_TTL_MS) {
      delete snapshots[id];
      changed = true;
    }
  }
  return changed;
}
export function listFeeEditSnapshots() {
  // Used by /api/data to ship the live-undoable set to the client so the
  // FeeCell can render an Undo button only where one is actually valid.
  const snapshots = readFeeEditSnapshotsRaw();
  if (pruneExpiredSnapshots(snapshots)) writeFeeEditSnapshotsRaw(snapshots);
  return snapshots;
}
function setFeeEditSnapshot(studentId, snapshot) {
  const snapshots = readFeeEditSnapshotsRaw();
  pruneExpiredSnapshots(snapshots);
  snapshots[studentId] = snapshot;
  writeFeeEditSnapshotsRaw(snapshots);
}
function clearFeeEditSnapshot(studentId) {
  const snapshots = readFeeEditSnapshotsRaw();
  if (snapshots[studentId]) {
    delete snapshots[studentId];
    writeFeeEditSnapshotsRaw(snapshots);
  }
}

// ---------- audit-trail writers (Supabase tables, file fallback) ----------
//
// Both fee_edits and transport_assignments are append-only ledgers in
// Supabase. We try Supabase first; on any error (table missing, schema
// cache lag, network blip) we fall back to a local file so the audit
// trail isn't lost. Each fileXxxSafe() reader merges both halves when
// readAllData() runs, so the admin always sees the union of the two.

async function appendFeeEdit(row) {
  const id = row.id || `FED-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`;
  const payload = {
    id,
    student_id: row.studentId,
    student_name: row.studentName || null,
    cls: row.cls || null,
    action: row.action,
    amount_before: row.amountBefore ?? null,
    amount_after: row.amountAfter ?? null,
    paid_before: row.paidBefore ?? null,
    paid_after: row.paidAfter ?? null,
    receipt_id: row.receiptId || null,
    actor_name: row.actorName || null,
    actor_role: row.actorRole || null,
    reverted_at: row.revertedAt || null,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("fee_edits").insert(payload);
    if (!ins.error) return { id, ...payload };
    // Schema cache lag / table missing → fall through to file store.
  }
  const db = fileRead();
  if (!Array.isArray(db.feeEdits)) db.feeEdits = [];
  db.feeEdits.unshift({ ...payload, created_at: new Date().toISOString() });
  fileWrite(db);
  return { id, ...payload };
}

// Mark every still-active fee_edits row for a student as reverted. Called
// by undoLastFeeEdit so the audit trail stays consistent — the reverted
// edit shows reverted_at set, plus the new "undo" row that did the work.
async function markFeeEditReverted(studentId) {
  const at = new Date().toISOString();
  if (supabaseEnabled) {
    const upd = await supabase.from("fee_edits")
      .update({ reverted_at: at })
      .eq("student_id", studentId)
      .is("reverted_at", null);
    if (!upd.error) return;
  }
  const db = fileRead();
  if (Array.isArray(db.feeEdits)) {
    let touched = false;
    for (const r of db.feeEdits) {
      if (r.student_id === studentId && !r.reverted_at) {
        r.reverted_at = at;
        touched = true;
      }
    }
    if (touched) fileWrite(db);
  }
}

function fileFeeEditsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.feeEdits) ? data.feeEdits : [];
  } catch { return []; }
}

// Append a transport-assignment change. Old 'active' rows for the same
// (student_id, direction) get marked 'replaced' with replaced_at = now,
// and a fresh 'active' row is written. routeCode = null + status =
// 'cleared' is the "no transport on this side" sentinel.
async function appendTransportAssignment(row) {
  const id = `TA-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`;
  const studentId = row.studentId;
  const direction = row.direction === "evening" ? "evening" : "morning";
  const routeCode = row.routeCode && row.routeCode !== "—" ? String(row.routeCode).toUpperCase() : null;
  const status = routeCode ? "active" : "cleared";
  const at = new Date().toISOString();
  if (!studentId) return null;

  const payload = {
    id,
    student_id: studentId,
    student_name: row.studentName || null,
    cls: row.cls || null,
    direction,
    route_code: routeCode,
    stop_name: row.stopName || null,
    assigned_by: row.assignedBy || null,
    status,
  };

  if (supabaseEnabled) {
    // Mark prior active row(s) as replaced.
    try {
      await supabase.from("transport_assignments")
        .update({ status: "replaced", replaced_at: at })
        .eq("student_id", studentId)
        .eq("direction", direction)
        .eq("status", "active");
    } catch {}
    const ins = await supabase.from("transport_assignments").insert(payload);
    if (!ins.error) return { ...payload, assigned_at: at };
  }

  // File fallback — same lifecycle.
  const db = fileRead();
  if (!Array.isArray(db.transportAssignments)) db.transportAssignments = [];
  for (const t of db.transportAssignments) {
    if (t.student_id === studentId && t.direction === direction && t.status === "active") {
      t.status = "replaced";
      t.replaced_at = at;
    }
  }
  db.transportAssignments.unshift({ ...payload, assigned_at: at });
  fileWrite(db);
  return { ...payload, assigned_at: at };
}

function fileTransportAssignmentsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.transportAssignments) ? data.transportAssignments : [];
  } catch { return []; }
}

// ---------- fees ----------
// Default fee type assigned when callers don't specify one — keeps behavior
// of existing admission code paths unchanged.
const DEFAULT_FEE_TYPE = "term1";

export async function addPendingFee(row) {
  // Stamp a feeType (and a back-link studentId) so the row plays nicely with
  // the new multi-fee-per-student model. Existing callers that don't supply
  // these fall through with sensible defaults.
  const filled = {
    ...row,
    studentId: row.studentId || row.id,
    feeType: row.feeType || DEFAULT_FEE_TYPE,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("pending_fees").insert(toPendingFee(filled));
    // Supabase doesn't throw on DB errors — it just returns { error }. Without
    // this check, a schema mismatch (e.g. missing student_id / fee_type
    // columns on older installs) silently dropped every imported student's
    // fee row, so they vanished from the Fees screen with no warning.
    if (ins.error) throw new Error(`pending_fees insert failed: ${ins.error.message}`);
    return;
  }
  const db = fileRead();
  db.pendingFees.unshift(filled);
  fileWrite(db);
}

// Append a brand-new pending-fee row of a specific type for an existing
// student (e.g. principal adds "Kit Fees" for a child who already has a
// Term I balance). Composite id keeps multiple types coexisting in storage.
export async function addStudentFeeItem({ studentId, feeType, amount, due }) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!studentId) throw new Error("studentId required");
  if (!amt) throw new Error("amount must be positive");
  const ftype = String(feeType || DEFAULT_FEE_TYPE).trim().toLowerCase();
  // Look up the student to copy their name + class onto the row (the Fees
  // table joins on these for the picker / receipt).
  let student = null;
  if (supabaseEnabled) {
    const sSel = await supabase.from("students").select("*").eq("id", studentId).maybeSingle();
    if (sSel.data) student = fromStudent(sSel.data);
  }
  if (!student) {
    const db = fileRead();
    student = (db.addedStudents || []).find((s) => s.id === studentId);
  }
  if (!student) throw new Error("student not found");
  const row = {
    id: `${studentId}__${ftype}`,
    studentId,
    feeType: ftype,
    name: student.name,
    cls: student.cls,
    amount: amt,
    due: due || "in 7 days",
    overdue: false,
  };
  if (supabaseEnabled) {
    // Upsert by id so re-adding the same fee type just updates the amount.
    const up = await supabase.from("pending_fees").upsert(toPendingFee(row), { onConflict: "id" });
    if (up.error) throw new Error(`pending_fees upsert failed: ${up.error.message}`);
    return row;
  }
  const db = fileRead();
  if (!Array.isArray(db.pendingFees)) db.pendingFees = [];
  const idx = db.pendingFees.findIndex((f) => f.id === row.id);
  if (idx === -1) db.pendingFees.unshift(row);
  else db.pendingFees[idx] = { ...db.pendingFees[idx], ...row };
  // Keep the student's overall fee status consistent.
  const sIdx = (db.addedStudents || []).findIndex((s) => s.id === studentId);
  if (sIdx !== -1 && db.addedStudents[sIdx].fee === "paid") {
    db.addedStudents[sIdx].fee = "pending";
  }
  fileWrite(db);
  return row;
}

// Set the outstanding pending-fee amount for a student. If a pending row
// already exists it's updated in place; otherwise one is created using the
// student's name/class. Passing amount === 0 clears the pending row.
// Returns { fee, amount } where fee mirrors the new student.fee status.
export async function setPendingFeeAmount(studentId, amount) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));

  if (supabaseEnabled) {
    const sSel = await supabase.from("students").select("*").eq("id", studentId).maybeSingle();
    if (!sSel.data) return null;
    const student = fromStudent(sSel.data);

    const fSel = await supabase.from("pending_fees").select("*").eq("id", studentId).maybeSingle();
    if (amt === 0) {
      if (fSel.data) await supabase.from("pending_fees").delete().eq("id", studentId);
      // Don't touch student.fee — they may already be 'paid'.
      return { fee: student.fee, amount: 0 };
    }
    if (fSel.data) {
      const upd = await supabase.from("pending_fees").update({ amount: amt }).eq("id", studentId);
      if (upd.error) throw new Error(`pending_fees update failed: ${upd.error.message}`);
    } else {
      const ins = await supabase.from("pending_fees").insert(toPendingFee({
        id: student.id, name: student.name, cls: student.cls,
        amount: amt, due: "in 7 days", overdue: false,
      }));
      if (ins.error) throw new Error(`pending_fees insert failed: ${ins.error.message}`);
    }
    // If the student was 'paid', a fresh outstanding amount means they're
    // back to 'pending' (or 'partial' if some receipts already exist —
    // but we treat any reopened balance as 'pending' for simplicity).
    let nextStatus = student.fee;
    if (student.fee === "paid" || !student.fee) nextStatus = "pending";
    try { await supabase.from("students").update({ fee: nextStatus }).eq("id", studentId); } catch {}
    return { fee: nextStatus, amount: amt };
  }

  const db = fileRead();
  const sIdx = (db.addedStudents || []).findIndex((s) => s.id === studentId);
  if (sIdx === -1) return null;
  const student = db.addedStudents[sIdx];
  const fIdx = (db.pendingFees || []).findIndex((f) => f.id === studentId);

  if (amt === 0) {
    if (fIdx !== -1) db.pendingFees.splice(fIdx, 1);
    fileWrite(db);
    return { fee: student.fee, amount: 0 };
  }
  if (fIdx !== -1) {
    db.pendingFees[fIdx] = { ...db.pendingFees[fIdx], amount: amt };
  } else {
    db.pendingFees.unshift({
      id: student.id, name: student.name, cls: student.cls,
      amount: amt, due: "in 7 days", overdue: false,
    });
  }
  let nextStatus = student.fee;
  if (student.fee === "paid" || !student.fee) nextStatus = "pending";
  db.addedStudents[sIdx] = { ...student, fee: nextStatus };
  fileWrite(db);
  return { fee: nextStatus, amount: amt };
}

// Edit a student's annual fee — supports raising the total AND/OR
// recording that the parent has already paid some portion of it
// (offline-cash, retroactive entry, etc.). Both numbers are
// INCREASE-ONLY at the storage layer:
//
//   newTotal >= currentTotal   (currentTotal = currentPending + currentPaid)
//   newPaid  >= currentPaid
//
// A successful edit takes a snapshot (previousPending + receiptIds added)
// so the admin can undo within one hour via undoLastFeeEdit(). Any
// receipts created here use feeType="annual" and method="offline-entry"
// so they stand out from Collect-fee receipts in the ledger.
//
// Returns { previousTotal, previousPaid, newTotal, newPaid, newPending,
// addedReceiptIds, undoableUntil }.
export async function editStudentFee({ studentId, newTotal, newPaid, actor = "Staff" }) {
  if (!studentId) throw new Error("studentId required");
  const tgt = Math.max(0, Math.floor(Number(newTotal) || 0));
  const tgtPaid = Math.max(0, Math.floor(Number(newPaid) || 0));
  if (tgtPaid > tgt) {
    throw new Error(`Already-paid (₹${tgtPaid}) cannot exceed total (₹${tgt})`);
  }

  // Read current annual-fee state. The annual fee row's id === studentId
  // (set this way at import in app/api/students/import/route.js). Receipts
  // for the annual fee are matched by student_id + feeType="annual".
  let currentPending = 0;
  let currentPaid = 0;
  let receipts = []; // raw receipt rows we'll need to filter for undo math

  if (supabaseEnabled) {
    const pSel = await supabase.from("pending_fees").select("*").eq("id", studentId).maybeSingle();
    if (pSel.data) currentPending = Number(pSel.data.amount) || 0;
    const rSel = await supabase.from("recent_fees")
      .select("*")
      .or(`student_id.eq.${studentId},id.eq.${studentId}`);
    receipts = (rSel.data || []).filter((r) => (r.fee_type || r.feeType || "annual") === "annual");
    currentPaid = receipts.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  } else {
    const db = fileRead();
    const f = (db.pendingFees || []).find((x) => x.id === studentId);
    if (f) currentPending = Number(f.amount) || 0;
    receipts = (db.recentFees || []).filter((r) =>
      ((r.studentId || r.student_id) === studentId)
      && ((r.feeType || r.fee_type || "annual") === "annual")
    );
    currentPaid = receipts.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  }

  const currentTotal = currentPending + currentPaid;
  if (tgt < currentTotal) {
    throw new Error(`Cannot reduce total fees. Current total is ₹${currentTotal.toLocaleString("en-IN")}; you tried to set ₹${tgt.toLocaleString("en-IN")}.`);
  }
  if (tgtPaid < currentPaid) {
    throw new Error(`Cannot reduce already-paid. Currently paid ₹${currentPaid.toLocaleString("en-IN")}; you tried to set ₹${tgtPaid.toLocaleString("en-IN")}.`);
  }

  const paidDelta = tgtPaid - currentPaid;
  const newPending = tgt - tgtPaid;
  const addedReceiptIds = [];

  // 1) Record the extra paid amount as a receipt so it lands in the ledger
  //    and the Reports / Money screens see it. Skipped when paidDelta = 0.
  if (paidDelta > 0) {
    const receiptId = `RCP-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`;
    const paidAt = new Date().toISOString();
    const timeLabel = new Date(paidAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
    // Look up student for name + class on the receipt row.
    let student = null;
    if (supabaseEnabled) {
      const sSel = await supabase.from("students").select("*").eq("id", studentId).maybeSingle();
      if (sSel.data) student = fromStudent(sSel.data);
    }
    if (!student) {
      const db = fileRead();
      student = (db.addedStudents || []).find((s) => s.id === studentId);
    }
    if (!student) throw new Error("Student not found");

    if (supabaseEnabled) {
      const ins = await supabase.from("recent_fees").insert({
        id: receiptId, student_id: studentId,
        name: student.name, cls: student.cls, amount: paidDelta,
        method: "offline-entry", time: timeLabel, paid_at: paidAt,
        fee_type: "annual", status: "partial",
      });
      // No silent file fallback in production — surface the error so the
      // admin knows the receipt didn't reach Supabase and can retry.
      if (ins.error) {
        throw new Error(`Could not record the offline payment in Supabase: ${ins.error.message}. Please retry; nothing has been saved.`);
      }
    } else {
      const db = fileRead();
      if (!Array.isArray(db.recentFees)) db.recentFees = [];
      db.recentFees.unshift({
        id: receiptId, studentId, student_id: studentId,
        name: student.name, cls: student.cls, amount: paidDelta,
        method: "offline-entry", time: timeLabel, paidAt,
        feeType: "annual", status: "partial",
      });
      fileWrite(db);
    }
    addedReceiptIds.push(receiptId);
  }

  // 2) Set the outstanding pending row to newPending. setPendingFeeAmount
  //    handles "create when missing, delete when zero" so a fully-paid
  //    student's row disappears the same way a Collect-fee clearance does.
  await setPendingFeeAmount(studentId, newPending);

  // 3) Snapshot for one-step undo (only the most recent edit per student).
  const editedAt = new Date().toISOString();
  setFeeEditSnapshot(studentId, {
    previousPending: currentPending,
    addedReceiptIds,
    editedAt,
    editedBy: actor,
    previousTotal: currentTotal,
    previousPaid: currentPaid,
  });

  // 4) Append a permanent row to the fee_edits audit table so this change
  //    is recoverable / queryable forever, not just within the 1-hour
  //    undo window. Best-effort — never blocks the edit if the audit
  //    write fails.
  try {
    // Look up name + class for the audit row if we didn't already.
    let auditStudent = null;
    if (supabaseEnabled) {
      const sSel = await supabase.from("students").select("name,cls").eq("id", studentId).maybeSingle();
      if (sSel.data) auditStudent = sSel.data;
    } else {
      const db = fileRead();
      const s = (db.addedStudents || []).find((x) => x.id === studentId);
      if (s) auditStudent = { name: s.name, cls: s.cls };
    }
    await appendFeeEdit({
      studentId,
      studentName: auditStudent?.name || null,
      cls: auditStudent?.cls || null,
      action: "edit",
      amountBefore: currentTotal,
      amountAfter: tgt,
      paidBefore: currentPaid,
      paidAfter: tgtPaid,
      receiptId: addedReceiptIds[0] || null,
      actorName: actor,
      actorRole: null,
    });
  } catch (e) {
    console.warn(`[db] fee_edits audit write failed (non-fatal): ${e.message}`);
  }

  return {
    previousTotal: currentTotal, previousPaid: currentPaid,
    newTotal: tgt, newPaid: tgtPaid, newPending,
    addedReceiptIds,
    undoableUntil: new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString(),
  };
}

// Set (or clear) a student's transport / van fee. Lives in pending_fees
// alongside the annual row but is keyed `${studentId}__transport` so the
// two coexist on the same student. fee_type = "transport" so reports /
// receipts can split it from academic fees. Passing amount=0 deletes the
// row (student no longer charged for transport).
//
// Increase-only at the storage layer, mirroring editStudentFee: you can
// raise the transport fee or leave it equal, but you can't silently
// shrink it — the only legitimate way down is to set it to 0.
//
// Returns { previousAmount, newAmount }.
export async function setStudentTransportFee({ studentId, amount, actor = "Staff" }) {
  if (!studentId) throw new Error("studentId required");
  const tgt = Math.max(0, Math.floor(Number(amount) || 0));
  const rowId = `${studentId}__transport`;

  // Look up student for the row's name/cls columns + audit context.
  let student = null;
  if (supabaseEnabled) {
    const sSel = await supabase.from("students").select("*").eq("id", studentId).maybeSingle();
    if (sSel.data) student = fromStudent(sSel.data);
  }
  if (!student) {
    const db = fileRead();
    student = (db.addedStudents || []).find((s) => s.id === studentId);
  }
  if (!student) throw new Error("Student not found");

  // Current transport pending balance (0 if no row yet).
  let currentAmount = 0;
  if (supabaseEnabled) {
    const pSel = await supabase.from("pending_fees").select("*").eq("id", rowId).maybeSingle();
    if (pSel.data) currentAmount = Number(pSel.data.amount) || 0;
  } else {
    const db = fileRead();
    const f = (db.pendingFees || []).find((x) => x.id === rowId);
    if (f) currentAmount = Number(f.amount) || 0;
  }

  if (tgt !== 0 && tgt < currentAmount) {
    throw new Error(`Cannot reduce transport fee. Current is ₹${currentAmount.toLocaleString("en-IN")}; set it to 0 to clear, or to a higher amount to add charges.`);
  }
  if (tgt === currentAmount) {
    return { previousAmount: currentAmount, newAmount: tgt };
  }

  if (supabaseEnabled) {
    if (tgt === 0) {
      const del = await supabase.from("pending_fees").delete().eq("id", rowId);
      if (del.error) throw new Error(`pending_fees delete failed: ${del.error.message}`);
    } else {
      const pSel = await supabase.from("pending_fees").select("*").eq("id", rowId).maybeSingle();
      if (pSel.data) {
        const upd = await supabase.from("pending_fees").update({ amount: tgt }).eq("id", rowId);
        if (upd.error) throw new Error(`pending_fees update failed: ${upd.error.message}`);
      } else {
        const ins = await supabase.from("pending_fees").insert(toPendingFee({
          id: rowId, name: student.name, cls: student.cls,
          amount: tgt, due: "in 7 days", overdue: false,
          studentId, feeType: "transport",
        }));
        if (ins.error) throw new Error(`pending_fees insert failed: ${ins.error.message}`);
      }
    }
  } else {
    const db = fileRead();
    if (!Array.isArray(db.pendingFees)) db.pendingFees = [];
    const fIdx = db.pendingFees.findIndex((x) => x.id === rowId);
    if (tgt === 0) {
      if (fIdx !== -1) db.pendingFees.splice(fIdx, 1);
    } else if (fIdx !== -1) {
      db.pendingFees[fIdx] = { ...db.pendingFees[fIdx], amount: tgt };
    } else {
      db.pendingFees.unshift({
        id: rowId, studentId, name: student.name, cls: student.cls,
        amount: tgt, due: "in 7 days", overdue: false,
        feeType: "transport",
      });
    }
    fileWrite(db);
  }

  // Audit — same fee_edits table the annual edits use, with action="transport-edit"
  // so it stays queryable but distinguishable in the audit timeline.
  try {
    await appendFeeEdit({
      studentId,
      studentName: student.name,
      cls: student.cls,
      action: tgt === 0 ? "transport-clear" : "transport-edit",
      amountBefore: currentAmount,
      amountAfter: tgt,
      paidBefore: null,
      paidAfter: null,
      receiptId: null,
      actorName: actor,
      actorRole: null,
    });
  } catch (e) {
    console.warn(`[db] fee_edits transport audit failed (non-fatal): ${e.message}`);
  }

  return { previousAmount: currentAmount, newAmount: tgt };
}

// Undo the most recent editStudentFee call for a student. Only valid for
// one hour after the edit. Returns the restored state, or null if no
// snapshot exists (already undone, never edited, or TTL expired).
export async function undoLastFeeEdit({ studentId }) {
  if (!studentId) throw new Error("studentId required");
  const snapshots = readFeeEditSnapshotsRaw();
  pruneExpiredSnapshots(snapshots);
  const snap = snapshots[studentId];
  if (!snap) return null;

  // Delete any receipts the edit added. Try Supabase first, fall through
  // to file store if the receipt actually lived there (cache-lag path).
  for (const rid of (snap.addedReceiptIds || [])) {
    if (supabaseEnabled) {
      try { await supabase.from("recent_fees").delete().eq("id", rid); } catch {}
    }
    const db = fileRead();
    if (Array.isArray(db.recentFees)) {
      const before = db.recentFees.length;
      db.recentFees = db.recentFees.filter((r) => r.id !== rid);
      if (db.recentFees.length !== before) fileWrite(db);
    }
  }

  // Restore the pending_fees outstanding to whatever it was before the edit.
  await setPendingFeeAmount(studentId, snap.previousPending);

  clearFeeEditSnapshot(studentId);

  // Flip the corresponding fee_edits row(s) to reverted, AND record the
  // undo itself as its own audit row so a query like
  //   select * from fee_edits where student_id = '...' order by created_at
  // tells the full story.
  try {
    await markFeeEditReverted(studentId);
    await appendFeeEdit({
      studentId,
      studentName: null,
      cls: null,
      action: "undo",
      amountBefore: null,
      amountAfter: snap.previousTotal,
      paidBefore: null,
      paidAfter: snap.previousPaid,
      receiptId: null,
      actorName: "system",
    });
  } catch (e) {
    console.warn(`[db] fee_edits undo audit failed (non-fatal): ${e.message}`);
  }

  return {
    restoredPending: snap.previousPending,
    restoredPaid: snap.previousPaid,
    restoredTotal: snap.previousTotal,
  };
}

// Delete a receipt (a row in recent_fees) by id. Used by the Fees screen's
// "✕ Delete" button for ledger corrections — e.g. a payment was recorded
// against the wrong student, or a test entry slipped into production.
// Receipts live in BOTH Supabase AND the file fallback (when payPendingFee
// hit a PostgREST cache miss), so we try both back-ends to ensure the row
// goes wherever it physically lives. Returns the deleted row, or null if
// no such id existed in either store.
//
// IMPORTANT: this does NOT restore the matching pending_fees balance.
// The caller (the Fees screen confirm dialog) explains this to the admin
// — a mistaken entry that needs the balance back has to be re-raised
// via "Edit fees" (which is increase-only by design).
export async function deleteRecentFee(receiptId) {
  if (!receiptId) return null;
  let deleted = null;

  if (supabaseEnabled) {
    const sel = await supabase.from("recent_fees").select("*").eq("id", receiptId).maybeSingle();
    if (sel.data) {
      const del = await supabase.from("recent_fees").delete().eq("id", receiptId);
      if (!del.error) deleted = sel.data;
    }
  }

  const db = fileRead();
  if (Array.isArray(db.recentFees)) {
    const idx = db.recentFees.findIndex((r) => r.id === receiptId);
    if (idx !== -1) {
      if (!deleted) deleted = db.recentFees[idx];
      db.recentFees.splice(idx, 1);
      fileWrite(db);
    }
  }

  // Audit trail: every receipt delete leaves a row in fee_edits so the
  // school has a permanent record of "RCP-XYZ was removed by Y at Z".
  if (deleted) {
    try {
      const studentId = deleted.student_id || deleted.studentId;
      await appendFeeEdit({
        studentId,
        studentName: deleted.name || null,
        cls: deleted.cls || null,
        action: "delete_receipt",
        amountBefore: null,
        amountAfter: null,
        paidBefore: Number(deleted.amount) || 0,
        paidAfter: 0,
        receiptId,
        actorName: "Staff",
      });
    } catch (e) {
      console.warn(`[db] fee_edits delete audit failed (non-fatal): ${e.message}`);
    }
  }

  return deleted;
}

// Pay a pending fee — supports partial payments. Pass `amount` to take just
// part of the balance; omit (or pass >= balance) to clear the whole thing.
//
// Returns { paid, fee, remaining } where:
//   paid       = the receipt row that was added to recent_fees
//   fee        = "partial" or "paid" (final state)
//   remaining  = ₹ left on the pending fee after this payment (0 if fully paid)
export async function payPendingFee(id, method, amount) {
  // Resolve current pending balance + base details (try Supabase, else file).
  let f = null;
  let backend = "file";
  if (supabaseEnabled) {
    const sel = await supabase.from("pending_fees").select("*").eq("id", id).maybeSingle();
    if (sel.data) { f = sel.data; backend = "supabase"; }
  }
  if (!f) {
    const db = fileRead();
    const fileFee = (db.pendingFees || []).find((x) => x.id === id);
    if (fileFee) f = fileFee;
  }
  if (!f) return null;

  // Decide pay-amount: if caller didn't specify, pay full balance.
  const balance = Number(f.amount) || 0;
  const requested = amount == null ? balance : Math.floor(Number(amount));
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error("Amount must be greater than 0");
  }
  if (requested > balance) {
    throw new Error(`Amount ₹${requested} exceeds outstanding balance ₹${balance}`);
  }
  const isFull = requested >= balance;
  const remaining = balance - requested;

  // Build the receipt row. Each payment gets a unique receipt id so the
  // same student can have multiple receipts (e.g. partial payments).
  const receiptId = `RCP-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`;
  // ISO timestamp of payment — used by Reports for date-range filtering and,
  // now, to render the register's "When" column. `time` stores a readable
  // IST label instead of the old frozen "just now" string.
  const paidAt = new Date().toISOString();
  const timeLabel = new Date(paidAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  // Resolve the underlying student id for the receipt's back-link, in case the
  // pending row uses the new composite id ("STN-9001__kit").
  const realStudentId = f.studentId || (typeof f.id === "string" && f.id.includes("__") ? f.id.split("__")[0] : f.id);
  const paidRow = {
    id: receiptId,
    student_id: realStudentId,
    studentId: realStudentId, // file-backend convenience
    name: f.name, cls: f.cls, amount: requested,
    method, time: timeLabel, paidAt,
    feeType: f.feeType || DEFAULT_FEE_TYPE,
    status: isFull ? "paid" : "partial",
  };
  const newStudentFeeStatus = isFull ? "paid" : "partial";

  if (backend === "supabase") {
    if (isFull) {
      const del = await supabase.from("pending_fees").delete().eq("id", id);
      if (del.error) {
        throw new Error(`Payment failed — could not clear the pending fee in Supabase: ${del.error.message}. Please retry.`);
      }
    } else {
      const upd = await supabase.from("pending_fees").update({ amount: remaining }).eq("id", id);
      if (upd.error) {
        throw new Error(`Payment failed — could not update the pending balance in Supabase: ${upd.error.message}. Please retry.`);
      }
    }
    // Insert the receipt. NO SILENT FILE FALLBACK in production — any
    // error here surfaces to the user as a red toast so they know the
    // payment didn't reach Supabase. They retry; if the issue persists
    // the parent should not be told it was paid.
    const ins = await supabase.from("recent_fees").insert({
      id: receiptId, student_id: realStudentId,
      name: f.name, cls: f.cls, amount: requested,
      method, time: timeLabel, paid_at: paidAt,
      fee_type: f.feeType || DEFAULT_FEE_TYPE,
      status: isFull ? "paid" : "partial",
    });
    if (ins.error) {
      // Best-effort rollback: re-add the pending row we just zeroed so the
      // balance returns to the pre-attempt state. Otherwise admin sees
      // both "payment failed" AND "fee disappeared" — worst case.
      try {
        if (isFull) {
          await supabase.from("pending_fees").insert(toPendingFee({
            id: f.id, studentId: f.studentId || f.id, feeType: f.feeType || DEFAULT_FEE_TYPE,
            name: f.name, cls: f.cls, amount: balance,
            due: f.due || "in 7 days", overdue: !!f.overdue,
          }));
        } else {
          await supabase.from("pending_fees").update({ amount: balance }).eq("id", id);
        }
      } catch (rollbackErr) {
        console.error(`[db] payPendingFee rollback also failed: ${rollbackErr.message}`);
      }
      throw new Error(`Payment failed — could not record the receipt in Supabase: ${ins.error.message}. The pending balance has been restored. Please retry.`);
    }
    // students.fee is keyed by the real student id, not the pending row id.
    // Composite-id rows (transport, kit, etc.) would silently no-op here
    // if we used `id` directly.
    const stuUpd = await supabase.from("students").update({ fee: newStudentFeeStatus }).eq("id", realStudentId);
    if (stuUpd.error) {
      // Receipt + pending update succeeded; only the student.fee status
      // failed to update. Don't roll back the payment — log a warning
      // so the admin can fix the status manually if needed.
      console.warn(`[db] payPendingFee: receipt saved but student.fee update failed: ${stuUpd.error.message}`);
    }
    // Orderly SL No = this receipt's chronological rank. As the newest receipt,
    // its rank equals the total receipt count — which matches how the Fees
    // screen numbers receipts by payment time.
    try {
      const cnt = await supabase.from("recent_fees").select("id", { count: "exact", head: true });
      if (typeof cnt.count === "number") paidRow.serial = cnt.count;
    } catch {}
    return { paid: paidRow, fee: newStudentFeeStatus, remaining };
  }

  // File backend
  const db = fileRead();
  const idx = (db.pendingFees || []).findIndex((x) => x.id === id);
  if (idx === -1) return null;
  if (isFull) {
    db.pendingFees.splice(idx, 1);
  } else {
    db.pendingFees[idx] = { ...db.pendingFees[idx], amount: remaining };
  }
  if (!Array.isArray(db.recentFees)) db.recentFees = [];
  db.recentFees.unshift(paidRow);
  paidRow.serial = db.recentFees.length; // newest → rank == total count
  const sIdx = (db.addedStudents || []).findIndex((s) => s.id === realStudentId);
  if (sIdx !== -1) db.addedStudents[sIdx].fee = newStudentFeeStatus;
  fileWrite(db);
  return { paid: paidRow, fee: newStudentFeeStatus, remaining };
}

export async function findPendingFeesByIds(ids) {
  if (supabaseEnabled) {
    const r = await supabase.from("pending_fees").select("*").in("id", ids);
    return (r.data || []).map(fromPendingFee);
  }
  const db = fileRead();
  return db.pendingFees.filter((f) => ids.includes(f.id));
}

// ---------- complaints ----------
export async function patchComplaintStatus(id, status) {
  if (supabaseEnabled) {
    const r = await supabase.from("complaints").update({ status }).eq("id", id).select().maybeSingle();
    if (r.data) return fromComplaint(r.data);
    // Fall through so complaints stored in the file fallback can move too.
  }
  const db = fileRead();
  const idx = (db.complaints || []).findIndex((c) => c.id === id);
  if (idx === -1) return null;
  db.complaints[idx] = { ...db.complaints[idx], status };
  fileWrite(db);
  return db.complaints[idx];
}

// ---------- enquiries ----------
export async function patchEnquiryStatus(id, status) {
  if (supabaseEnabled) {
    const r = await supabase.from("enquiries").update({ status }).eq("id", id).select().maybeSingle();
    if (r.data) return fromEnquiry(r.data);
    // Fall through to file fallback so enquiries created via fallback can move too.
  }
  const db = fileRead();
  const idx = (db.enquiries || []).findIndex((e) => e.id === id);
  if (idx === -1) return null;
  db.enquiries[idx] = { ...db.enquiries[idx], status };
  fileWrite(db);
  return db.enquiries[idx];
}

// Promote an enquiry into a real admission. This is a single transactional
// "convert" step that:
//   1. creates the student row (with the same auto-fee schedule as a
//      walk-in admission)
//   2. raises an opening pending fee
//   3. provisions a parent login user (role=parent, linkedId=studentId)
//      with a generated temporary password the office can hand to the
//      parent. Email is synthetic (parent.<student-id>@school.local) so
//      we don't need a real one from the enquiry form.
//   4. flips the enquiry's status to "Converted"
//
// Idempotent: calling it again on an already-converted enquiry returns the
// same student/parent without creating duplicates. The temp password is
// only available the FIRST time — subsequent calls return null for
// `parentLogin.tempPassword` since we only store the bcrypt hash.
//
// Returns: { enquiry, student, parentLogin: { email, tempPassword|null, alreadyExisted } }
export async function convertEnquiryToAdmission(enquiryId, opts = {}) {
  // Lazy require so the file backend doesn't pull jose/bcrypt unless needed.
  const { hashPassword } = require("./auth.js");

  // Pull the enquiry first so we can copy its fields.
  let enquiry = null;
  if (supabaseEnabled) {
    const r = await supabase.from("enquiries").select("*").eq("id", enquiryId).maybeSingle();
    if (r.data) enquiry = fromEnquiry(r.data);
  }
  if (!enquiry) {
    const db = fileRead();
    enquiry = (db.enquiries || []).find((e) => e.id === enquiryId) || null;
  }
  if (!enquiry) return null;

  // Helpers — reuse the same shapes as walk-in admissions so the data is
  // indistinguishable downstream.
  const monthYear = new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  const newStudentId = `STN-${9000 + Math.floor(Math.random() * 999)}`;

  // Reuse / create the student.
  // If the enquiry already names a student id (set on a previous convert),
  // skip the student-creation step.
  let student = null;
  if (enquiry.studentId) {
    if (supabaseEnabled) {
      const r = await supabase.from("students").select("*").eq("id", enquiry.studentId).maybeSingle();
      if (r.data) student = fromStudent(r.data);
    }
    if (!student) {
      const db = fileRead();
      student = (db.addedStudents || []).find((s) => s.id === enquiry.studentId) || null;
    }
  }
  if (!student) {
    const cls = Number(enquiry.cls) || 1;
    const section = (opts.section || "A").toUpperCase();
    student = await addStudent({
      id: newStudentId,
      name: enquiry.name,
      cls: `${cls}-${section}`,
      parent: enquiry.phone || enquiry.parent || "—",
      fee: "pending",
      attendance: 0,
      transport: "—",
      pickupStop: null,
      joined: monthYear,
    });
    // Record the full term-wise fee (Term I/II/III, + Application/Van when
    // configured) so the child shows up on Fees with a complete record.
    try {
      await seedStudentTermFees(student);
    } catch {}
  }

  // Provision the parent user. Email is derived from the student id so it's
  // unique per child without needing real email collection.
  const parentEmail = `parent.${student.id.toLowerCase()}@school.local`;
  let parentExisting = await getUserByEmail(parentEmail);
  let tempPassword = null;
  if (!parentExisting) {
    // Easy-to-read 8-char password, mixed-case + digits, no ambiguous chars.
    const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    tempPassword = Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
    const passwordHash = await hashPassword(tempPassword);
    await createUser({
      id: `USR-PAR-${student.id}`,
      email: parentEmail,
      passwordHash,
      role: "parent",
      name: `${enquiry.parent && enquiry.parent !== "—" ? enquiry.parent : "Parent"} (${student.name})`,
      linkedId: student.id,
    });
    parentExisting = await getUserByEmail(parentEmail);
  }

  // Update enquiry status (and stash the new student id) so re-converts are
  // idempotent. Best-effort: if the column doesn't exist yet (older schemas)
  // we still flip the status.
  if (supabaseEnabled) {
    try {
      await supabase.from("enquiries").update({ status: "Converted" }).eq("id", enquiry.id);
    } catch {}
  }
  const fdb = fileRead();
  if (Array.isArray(fdb.enquiries)) {
    const idx = fdb.enquiries.findIndex((e) => e.id === enquiry.id);
    if (idx !== -1) {
      fdb.enquiries[idx] = { ...fdb.enquiries[idx], status: "Converted", studentId: student.id };
      fileWrite(fdb);
    }
  }

  return {
    enquiry: { ...enquiry, status: "Converted", studentId: student.id },
    student,
    parentLogin: {
      email: parentEmail,
      tempPassword,                    // null on re-convert (only first time)
      alreadyExisted: !tempPassword,
    },
  };
}

export async function addEnquiry(row) {
  if (supabaseEnabled) {
    const ins = await supabase.from("enquiries").insert(row).select().single();
    if (ins.error) {
      // Schema cache lag / missing table → file fallback so user isn't blocked.
      if (/enquir/i.test(ins.error.message)) return fileAddEnquiry(row);
      throw new Error(ins.error.message);
    }
    return fromEnquiry(ins.data);
  }
  return fileAddEnquiry(row);
}

function fileAddEnquiry(row) {
  const db = fileRead();
  if (!Array.isArray(db.enquiries)) db.enquiries = [];
  db.enquiries.unshift(row);
  fileWrite(db);
  return row;
}

// ---------- transport ----------

// File-backend safe reader for transport attendance — used by readAllData()
// to merge file-fallback rows into the Supabase response.
function fileTransportAttendanceSafe() {
  try {
    const db = fileRead();
    return Array.isArray(db.transportAttendance) ? db.transportAttendance : [];
  } catch { return []; }
}

// Record (or update) a per-student boarding entry. The composite key is
// (studentId, date, direction) so a second tap on the same trip overwrites
// the previous status (board → absent flips cleanly without dupes).
//
// Returns the persisted row.
export async function recordTransportAttendance(row) {
  const studentId = String(row?.studentId || "").trim();
  const date = String(row?.date || "").trim() || new Date().toISOString().slice(0, 10);
  const direction = (row?.direction || "morning") === "evening" ? "evening" : "morning";
  const status = ["boarded", "absent", "skipped", "dropped", "parent"].includes(row?.status) ? row.status : "boarded";
  if (!studentId) throw new Error("studentId required");

  // Merge with any existing row for this trip so a status-only flip
  // (e.g. class teacher marking Dropped by parent) keeps route/stop.
  let existing = null;
  if (supabaseEnabled) {
    const sel = await supabase
      .from("transport_attendance")
      .select("*")
      .eq("student_id", studentId)
      .eq("date", date)
      .eq("direction", direction)
      .maybeSingle();
    if (sel.data) existing = fromTransportAttendance(sel.data);
  } else {
    const db0 = fileRead();
    existing = (db0.transportAttendance || []).find(
      (x) => x.studentId === studentId && x.date === date && (x.direction || "morning") === direction
    ) || null;
  }

  const persistRow = {
    studentId, date, direction, status,
    routeCode: row.routeCode != null && row.routeCode !== "" ? row.routeCode : (existing?.routeCode || null),
    stopName: row.stopName != null && row.stopName !== "" ? row.stopName : (existing?.stopName || null),
    studentName: row.studentName || existing?.studentName || null,
    cls: row.cls || existing?.cls || null,
    markedBy: row.markedBy || null,
    markedAt: new Date().toISOString(),
  };

  if (supabaseEnabled) {
    // Upsert on the composite PK so flipping a student's status is
    // atomic. No silent file fallback in production — attendance is too
    // important to lose; surface the error to the teacher's screen.
    const ins = await supabase
      .from("transport_attendance")
      .upsert(toTransportAttendance(persistRow), { onConflict: "student_id,date,direction" })
      .select()
      .maybeSingle();
    if (ins.error) {
      throw new Error(`Could not record transport attendance in Supabase: ${ins.error.message}`);
    }
    return persistRow;
  }

  const db = fileRead();
  if (!Array.isArray(db.transportAttendance)) db.transportAttendance = [];
  const idx = db.transportAttendance.findIndex(
    (x) => x.studentId === studentId && x.date === date && (x.direction || "morning") === direction
  );
  if (idx === -1) db.transportAttendance.unshift(persistRow);
  else db.transportAttendance[idx] = persistRow;
  fileWrite(db);
  return persistRow;
}

export async function setStopBoarding(code, stopName, action) {
  if (supabaseEnabled) {
    const sel = await supabase.from("routes").select("*").eq("code", code).maybeSingle();
    if (!sel.data) return null;
    const route = sel.data;
    const stops = route.stops || [];
    const sIdx = stops.findIndex((s) => s.name === stopName);
    if (sIdx === -1) return null;
    const stop = { ...stops[sIdx] };
    if (action === "board" && stop.boarded + stop.absent < stop.cap) stop.boarded += 1;
    else if (action === "absent") {
      if (stop.boarded + stop.absent < stop.cap) stop.absent += 1;
      else if (stop.boarded > 0) { stop.boarded -= 1; stop.absent += 1; }
    }
    const newStops = [...stops];
    newStops[sIdx] = stop;
    await supabase.from("routes").update({ stops: newStops }).eq("code", code);
    return { ...fromRoute(route), stops: newStops };
  }
  const db = fileRead();
  const route = db.routes.find((r) => r.code === code);
  if (!route) return null;
  const stop = route.stops.find((s) => s.name === stopName);
  if (!stop) return null;
  if (action === "board" && stop.boarded + stop.absent < stop.cap) stop.boarded += 1;
  else if (action === "absent") {
    if (stop.boarded + stop.absent < stop.cap) stop.absent += 1;
    else if (stop.boarded > 0) { stop.boarded -= 1; stop.absent += 1; }
  }
  fileWrite(db);
  return route;
}

// ---------- routes ----------
// Each route owns a list of stops as JSONB. Stops are { name, t, cap,
// boarded, absent, status } where status is 'done' | 'current' | 'pending'.
export async function addRoute(row) {
  const code = String(row.code || "").trim().toUpperCase();
  if (!code) throw new Error("Route code is required");
  // Whitelist the direction value so an upstream typo can't write a
  // garbage column. 'both' means the same vehicle does the same loop
  // for AM and PM — both pickers will offer it.
  const direction = ["morning", "evening", "both"].includes(row.direction)
    ? row.direction
    : "both";
  const route = {
    code,
    name: row.name || code,
    driver: row.driver || "—",
    attendant: row.attendant || "—",
    bus: row.bus || "—",
    status: row.status || "running",
    eta: row.eta || "07:00 – 08:00",
    direction,
    stops: Array.isArray(row.stops) ? row.stops.map((s, i) => ({
      name: String(s.name || "").trim() || `Stop ${i + 1}`,
      t: s.t || "—",
      cap: Number(s.cap) || 0,
      boarded: 0,
      absent: 0,
      status: i === 0 ? "current" : "pending",
    })) : [],
  };
  if (!route.stops.length) throw new Error("Add at least one stop");

  if (supabaseEnabled) {
    // Belt-and-braces uniqueness check. The DB has a UNIQUE constraint
    // on routes.code (added by the route_templates migration), but a
    // friendly app-level error beats a raw "duplicate key" Postgres
    // message and keeps the code path safe pre-migration. This is the
    // fix for the prod duplicate-R5 incident.
    const existing = await supabase.from("routes").select("code").eq("code", code).maybeSingle();
    if (existing.data) {
      throw new Error(`Route ${code} already exists — pick a different code or edit the existing one`);
    }
    let ins = await supabase.from("routes").insert(route).select().single();
    // PostgREST schema cache may not yet know about `direction`. Retry
    // without it; the column defaults to 'both' on the server side once
    // the migration runs.
    if (ins.error && /direction/i.test(ins.error.message)) {
      const { direction: _drop, ...legacy } = route;
      ins = await supabase.from("routes").insert(legacy).select().single();
    }
    if (ins.error) {
      // NO SILENT FILE FALLBACK in production — every route must persist
      // in Supabase. The admin sees the error and fixes the underlying
      // cause (missing migration / network blip / RLS rule).
      throw new Error(`Could not save route to Supabase: ${ins.error.message}`);
    }
    return fromRoute({ ...ins.data, direction: ins.data.direction || direction });
  }
  return fileAddRoute(route);
}

function fileAddRoute(route) {
  const db = fileRead();
  if (!Array.isArray(db.routes)) db.routes = [];
  if (db.routes.find((r) => r.code === route.code)) {
    throw new Error(`Route ${route.code} already exists`);
  }
  db.routes.unshift(route);
  fileWrite(db);
  return route;
}

export async function removeRoute(code) {
  if (!code) return null;
  if (supabaseEnabled) {
    const sel = await supabase.from("routes").select("*").eq("code", code).maybeSingle();
    if (sel.data) {
      const del = await supabase.from("routes").delete().eq("code", code);
      if (del.error) {
        throw new Error(`Could not remove route from Supabase: ${del.error.message}`);
      }
      return fromRoute(sel.data);
    }
    // Not in Supabase — only fall through to file if it's a legacy row
    // written before Supabase came online. Don't silently delete from
    // file in production (Supabase is the source of truth).
    return null;
  }
  const db = fileRead();
  const idx = (db.routes || []).findIndex((r) => r.code === code);
  if (idx === -1) return null;
  const removed = db.routes[idx];
  db.routes.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// Read a single route from whichever backend has it.
async function readRoute(code) {
  if (supabaseEnabled) {
    const sel = await supabase.from("routes").select("*").eq("code", code).maybeSingle();
    if (sel.data) return { row: sel.data, backend: "supabase" };
  }
  const db = fileRead();
  const r = (db.routes || []).find((x) => x.code === code);
  return r ? { row: r, backend: "file" } : null;
}

// Persist a route back to whichever backend it came from. Skips fields that
// should never be re-written (`code` is the PK).
async function writeRoute({ row, backend }, patch) {
  const next = { ...row, ...patch };
  if (backend === "supabase") {
    let attempt = { ...patch };
    let upd = await supabase.from("routes").update(attempt).eq("code", row.code);
    // Retry by stripping any column Supabase doesn't know about (e.g. attendant
    // when the schema migration hasn't been run yet). The mirrored file copy
    // below will hold the field so it still survives.
    while (upd.error && /Could not find the .* column/i.test(upd.error.message)) {
      const m = upd.error.message.match(/Could not find the '?(\w+)'? column/i);
      const col = m?.[1];
      if (!col || !(col in attempt)) break;
      console.warn(`[db] routes update dropping unknown column "${col}", retrying`);
      delete attempt[col];
      if (Object.keys(attempt).length === 0) { upd = { error: null }; break; }
      upd = await supabase.from("routes").update(attempt).eq("code", row.code);
    }
    if (upd.error) throw new Error(upd.error.message);
  }
  // Always mirror the full patch (including any stripped columns) into the file
  // copy so the field survives across reloads even if Supabase can't store it.
  const db = fileRead();
  if (!Array.isArray(db.routes)) db.routes = [];
  const idx = db.routes.findIndex((r) => r.code === row.code);
  if (idx === -1) db.routes.unshift(next);
  else db.routes[idx] = next;
  fileWrite(db);
  return next;
}

// Edit an existing route — name, driver, bus, status, eta, stops list.
// Replacing the whole stops array is intentional (matches how the AddRoute
// modal builds it). Boarded/absent counters on existing stops are preserved
// when the stop name matches.
export async function updateRoute(code, patch) {
  if (!code) throw new Error("code required");
  const found = await readRoute(code);
  if (!found) return null;
  const fields = {};
  if (typeof patch.name === "string")     fields.name = patch.name;
  if (typeof patch.driver === "string")   fields.driver = patch.driver;
  if (typeof patch.attendant === "string") fields.attendant = patch.attendant;
  if (typeof patch.bus === "string")      fields.bus = patch.bus;
  if (typeof patch.status === "string")  fields.status = patch.status;
  if (typeof patch.eta === "string")     fields.eta = patch.eta;
  if (typeof patch.direction === "string" && ["morning", "evening", "both"].includes(patch.direction)) {
    fields.direction = patch.direction;
  }
  if (Array.isArray(patch.stops)) {
    const old = (found.row.stops || []);
    fields.stops = patch.stops.map((s, i) => {
      const existing = old.find((o) => o.name === s.name);
      return {
        name: String(s.name || "").trim() || `Stop ${i + 1}`,
        t: s.t || "—",
        cap: Number(s.cap) || 0,
        boarded: existing?.boarded ?? 0,
        absent:  existing?.absent  ?? 0,
        // Preserve status if the stop already had one; otherwise mark
        // upcoming until the run is started/advanced.
        status: existing?.status ?? "pending",
      };
    });
  }
  return writeRoute(found, fields);
}

// Drive the bus through its run.
//   action: "start"  → set first stop to current, status='running'
//           "next"   → mark current stop as done, advance current to next stop
//           "prev"   → step back one stop (mark current as pending, prev as current)
//           "finish" → mark all remaining stops as done, status='completed'
//           "reset"  → mark all stops as pending, clear boarded/absent, status='idle'
//
// Stops gain two timestamp fields as they progress so parent/teacher views
// can show "arrived 2 mins ago" / "departed 04:18":
//   - arrivedAt: ISO timestamp set when the stop transitions to 'current'
//   - doneAt:    ISO timestamp set when it transitions to 'done'
// Both are cleared on 'reset' so the next trip starts fresh. Stops written
// before this migration just won't have the fields — the UI treats absence
// as "unknown" rather than blowing up.
export async function advanceRoute(code, action) {
  const found = await readRoute(code);
  if (!found) return null;
  const stops = Array.isArray(found.row.stops) ? [...found.row.stops] : [];
  if (stops.length === 0) throw new Error("Route has no stops");

  const curIdx = stops.findIndex((s) => s.status === "current");
  const now = new Date().toISOString();

  // Notification event metadata — derived inline so the caller (the API
  // route) can fan out external notifications (in-app + WhatsApp) without
  // re-reading the route. Set to null for prev/reset since those are
  // admin corrections, not parent-facing changes.
  let patch = null;
  let event = null;  // { type: 'started'|'departed'|'completed', fromStopName?, toStopName?, toStop? }

  if (action === "start") {
    for (let i = 0; i < stops.length; i++) {
      stops[i] = {
        ...stops[i],
        status: i === 0 ? "current" : "pending",
        arrivedAt: i === 0 ? now : null,
        doneAt: null,
      };
    }
    patch = { stops, status: "running", startedAt: now };
    event = { type: "started", fromStopName: "School Campus", toStopName: stops[0].name, toStop: stops[0] };
  } else if (action === "next") {
    if (curIdx === -1) {
      stops[0] = { ...stops[0], status: "current", arrivedAt: now };
      patch = { stops, status: "running", startedAt: found.row.startedAt || now };
      event = { type: "started", fromStopName: "School Campus", toStopName: stops[0].name, toStop: stops[0] };
    } else {
      const prevStop = stops[curIdx];
      stops[curIdx] = { ...stops[curIdx], status: "done", doneAt: now };
      if (curIdx + 1 < stops.length) {
        stops[curIdx + 1] = { ...stops[curIdx + 1], status: "current", arrivedAt: now };
        patch = { stops, status: "running" };
        event = { type: "departed", fromStopName: prevStop.name, toStopName: stops[curIdx + 1].name, toStop: stops[curIdx + 1] };
      } else {
        // Was at the last stop → mark whole run as completed
        patch = { stops, status: "completed", completedAt: now };
        event = { type: "completed" };
      }
    }
  } else if (action === "prev") {
    if (curIdx === -1) return { route: found.row, event: null };
    stops[curIdx] = { ...stops[curIdx], status: "pending", arrivedAt: null };
    if (curIdx > 0) {
      stops[curIdx - 1] = { ...stops[curIdx - 1], status: "current", doneAt: null };
    }
    patch = { stops, status: "running" };
    // No notification — admin correction
  } else if (action === "finish") {
    for (let i = 0; i < stops.length; i++) {
      stops[i] = { ...stops[i], status: "done", doneAt: stops[i].doneAt || now };
    }
    patch = { stops, status: "completed", completedAt: now };
    event = { type: "completed" };
  } else if (action === "reset") {
    for (let i = 0; i < stops.length; i++) {
      stops[i] = { ...stops[i], status: "pending", boarded: 0, absent: 0, arrivedAt: null, doneAt: null };
    }
    patch = { stops, status: "idle", startedAt: null, completedAt: null };
    // No notification — reset is a fresh start, parents will get notified on the next "start"
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  const route = await writeRoute(found, patch);
  return { route, event };
}

// =====================================================================
// Route templates — master timetable (R1-R6 from the school's PDF)
// =====================================================================
// Templates are the static, school-managed source of truth: code, name,
// bus, direction, ordered stops with their scheduled times. They never
// carry per-trip run state — that lives on the spawned `routes` row.
//
// CRUD flow:
//   listRouteTemplates / getRouteTemplate    — read
//   addRouteTemplate / updateRouteTemplate   — write (admin/principal only)
//   removeRouteTemplate                      — soft delete (active=false)
//   applyRouteTemplate                       — replace live route from template
//   seedRouteTemplates                       — one-shot bulk import (R1-R6)
//
// Edit propagation: updateRouteTemplate() also pushes stop changes down
// onto the live `routes` row if one exists with the same code. Existing
// stop status (current/done/arrivedAt) is preserved on stops whose names
// still match the new spec; new stops slot in with status='pending'.

const ROUTE_TEMPLATES_TABLE = "route_templates";

function fileRouteTemplatesSafe() {
  try {
    const db = fileRead();
    return Array.isArray(db.routeTemplates) ? db.routeTemplates : [];
  } catch { return []; }
}

export async function listRouteTemplates({ includeArchived = false } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from(ROUTE_TEMPLATES_TABLE).select("*");
    if (!includeArchived) q = q.eq("active", true);
    const sel = await q.order("direction", { ascending: true }).order("trip_no", { ascending: true });
    if (sel.error) {
      if (isSchemaMissError(sel.error)) return fileRouteTemplatesSafe();
      throw new Error(`Could not list templates: ${sel.error.message}`);
    }
    return (sel.data || []).map(fromRouteTemplate);
  }
  const all = fileRouteTemplatesSafe();
  return includeArchived ? all : all.filter((t) => t.active !== false);
}

export async function getRouteTemplate(code) {
  if (!code) return null;
  const want = String(code).trim().toUpperCase();
  if (supabaseEnabled) {
    const sel = await supabase.from(ROUTE_TEMPLATES_TABLE).select("*").eq("code", want).maybeSingle();
    if (sel.error && !isSchemaMissError(sel.error)) throw new Error(sel.error.message);
    if (sel.data) return fromRouteTemplate(sel.data);
  }
  return fileRouteTemplatesSafe().find((t) => t.code === want) || null;
}

export async function addRouteTemplate(row) {
  const persistRow = toRouteTemplate(row);
  if (!persistRow.code) throw new Error("Template code is required");
  if (!persistRow.stops.length) throw new Error("Add at least one stop");
  if (supabaseEnabled) {
    const dup = await supabase.from(ROUTE_TEMPLATES_TABLE).select("code").eq("code", persistRow.code).maybeSingle();
    if (dup.data) throw new Error(`Template ${persistRow.code} already exists — edit it instead`);
    const ins = await supabase.from(ROUTE_TEMPLATES_TABLE).insert(persistRow).select().single();
    if (ins.error) {
      if (isSchemaMissError(ins.error)) {
        return fileAddRouteTemplate(persistRow);
      }
      throw new Error(`Could not save template: ${ins.error.message}`);
    }
    return fromRouteTemplate(ins.data);
  }
  return fileAddRouteTemplate(persistRow);
}

function fileAddRouteTemplate(row) {
  const db = fileRead();
  if (!Array.isArray(db.routeTemplates)) db.routeTemplates = [];
  if (db.routeTemplates.find((t) => t.code === row.code)) {
    throw new Error(`Template ${row.code} already exists`);
  }
  const stamped = {
    ...row,
    direction: row.direction,
    tripNo: row.trip_no || 1,
    active: row.active !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  delete stamped.trip_no;
  db.routeTemplates.unshift(stamped);
  fileWrite(db);
  return stamped;
}

export async function updateRouteTemplate(code, patch) {
  const want = String(code || "").trim().toUpperCase();
  if (!want) throw new Error("Template code required");
  const persistPatch = {};
  if (patch.name      !== undefined) persistPatch.name      = String(patch.name).trim();
  if (patch.bus       !== undefined) persistPatch.bus       = patch.bus || "—";
  if (patch.direction !== undefined) persistPatch.direction = patch.direction === "evening" ? "evening" : "morning";
  if (patch.tripNo    !== undefined) persistPatch.trip_no   = Number(patch.tripNo) || 1;
  if (patch.active    !== undefined) persistPatch.active    = !!patch.active;
  if (patch.stops     !== undefined) {
    if (!Array.isArray(patch.stops) || !patch.stops.length) throw new Error("Stops list cannot be empty");
    persistPatch.stops = patch.stops.map((s, i) => ({
      name: String(s.name || "").trim() || `Stop ${i + 1}`,
      t: s.t || "—",
    }));
  }
  persistPatch.updated_at = new Date().toISOString();

  let updated = null;
  if (supabaseEnabled) {
    const upd = await supabase.from(ROUTE_TEMPLATES_TABLE).update(persistPatch).eq("code", want).select().single();
    if (upd.error && !isSchemaMissError(upd.error)) throw new Error(upd.error.message);
    if (upd.data) updated = fromRouteTemplate(upd.data);
  }
  if (!updated) {
    // File fallback (and the path Supabase falls through to on schema miss).
    const db = fileRead();
    if (!Array.isArray(db.routeTemplates)) db.routeTemplates = [];
    const idx = db.routeTemplates.findIndex((t) => t.code === want);
    if (idx === -1) return null;
    const merged = { ...db.routeTemplates[idx] };
    if (persistPatch.name      !== undefined) merged.name      = persistPatch.name;
    if (persistPatch.bus       !== undefined) merged.bus       = persistPatch.bus;
    if (persistPatch.direction !== undefined) merged.direction = persistPatch.direction;
    if (persistPatch.trip_no   !== undefined) merged.tripNo    = persistPatch.trip_no;
    if (persistPatch.active    !== undefined) merged.active    = persistPatch.active;
    if (persistPatch.stops     !== undefined) merged.stops     = persistPatch.stops;
    merged.updatedAt = persistPatch.updated_at;
    db.routeTemplates[idx] = merged;
    fileWrite(db);
    updated = merged;
  }

  // Edit propagation — if a live route with this code exists, update its
  // stops to match the template. Existing run state (status / arrivedAt /
  // doneAt) on stops whose names still match is preserved; new stops slot
  // in with status='pending'; deleted stops are dropped (with a snap-to-
  // next if the deleted stop was 'current').
  if (persistPatch.stops || persistPatch.name || persistPatch.bus || persistPatch.direction) {
    try {
      const found = await readRoute(want);
      if (found) {
        const livePatch = {};
        if (persistPatch.name)      livePatch.name      = persistPatch.name;
        if (persistPatch.bus)       livePatch.bus       = persistPatch.bus;
        if (persistPatch.direction) livePatch.direction = persistPatch.direction;
        if (persistPatch.stops) {
          const oldStops = Array.isArray(found.row.stops) ? found.row.stops : [];
          const byName = new Map(oldStops.map((s) => [s.name, s]));
          const newStops = persistPatch.stops.map((spec, i) => {
            const existing = byName.get(spec.name);
            return existing
              ? { ...existing, name: spec.name, t: spec.t }
              : { name: spec.name, t: spec.t, cap: 0, boarded: 0, absent: 0, status: "pending", arrivedAt: null, doneAt: null };
          });
          // If the previously-'current' stop got dropped, snap to the
          // first not-done stop in the new list to keep the run sane.
          const hasCurrent = newStops.some((s) => s.status === "current");
          if (!hasCurrent && found.row.status === "running") {
            const snapIdx = newStops.findIndex((s) => s.status !== "done");
            if (snapIdx >= 0) newStops[snapIdx] = { ...newStops[snapIdx], status: "current", arrivedAt: new Date().toISOString() };
          }
          livePatch.stops = newStops;
        }
        await writeRoute(found, livePatch);
      }
    } catch (e) {
      console.warn(`[templates] live-route propagation failed (non-fatal): ${e.message}`);
    }
  }

  return updated;
}

export async function removeRouteTemplate(code) {
  // Soft delete — flip active=false. Keeps history + lets the route stay
  // pointed at it via template_id.
  return updateRouteTemplate(code, { active: false });
}

export async function applyRouteTemplate(code, { actor } = {}) {
  const want = String(code || "").trim().toUpperCase();
  if (!want) throw new Error("Template code required");
  const tpl = await getRouteTemplate(want);
  if (!tpl) throw new Error(`Template ${want} not found`);
  if (tpl.active === false) throw new Error(`Template ${want} is archived`);

  // Preserve attendant/driver/bus from the existing live route if it
  // exists, so re-applying doesn't unassign the teacher. Template bus
  // value only wins if the live row has none.
  let preserved = { attendant: "—", driver: "—", bus: tpl.bus || "—" };
  const existing = await readRoute(want);
  if (existing) {
    preserved = {
      attendant: existing.row.attendant && existing.row.attendant !== "—" ? existing.row.attendant : "—",
      driver:    existing.row.driver    && existing.row.driver    !== "—" ? existing.row.driver    : "—",
      bus:       existing.row.bus       && existing.row.bus       !== "—" ? existing.row.bus       : (tpl.bus || "—"),
    };
    await removeRoute(want);
  }

  // Build the fresh route row from the template + preserved fields.
  const newRoute = await addRoute({
    code: tpl.code,
    name: tpl.name,
    direction: tpl.direction,
    driver: preserved.driver,
    attendant: preserved.attendant,
    bus: preserved.bus,
    status: "idle",
    eta: tpl.direction === "morning" ? "07:00 – 10:00" : "15:00 – 18:00",
    stops: tpl.stops.map((s, i) => ({
      name: s.name,
      t: s.t,
      cap: 0,
    })),
  });

  // Stamp the template_id link on the new route. Best-effort: don't fail
  // the apply if the column doesn't exist yet (pre-migration).
  if (supabaseEnabled) {
    try {
      await supabase.from("routes").update({ template_id: tpl.code }).eq("code", tpl.code);
    } catch {}
  }
  return { route: newRoute, template: tpl, preserved };
}

// One-shot seed — populates R1-R6 from the school's master PDF.
// Idempotent: skips templates that already exist. Returns the created
// + skipped lists so the UI can show what happened.
export async function seedRouteTemplates() {
  const created = [];
  const skipped = [];
  for (const spec of MASTER_TIMETABLE_R1_R6) {
    try {
      const existing = await getRouteTemplate(spec.code);
      if (existing) { skipped.push(spec.code); continue; }
      const row = await addRouteTemplate(spec);
      created.push(row.code);
    } catch (e) {
      console.warn(`[templates] seed ${spec.code} failed: ${e.message}`);
    }
  }
  return { created, skipped, total: MASTER_TIMETABLE_R1_R6.length };
}

// Transcribed from the school's master timetable PDF (June 2026).
// Times kept as-written (PM implied for evening per school convention,
// 7-10am for morning runs / 3-6pm for evening runs).
const MASTER_TIMETABLE_R1_R6 = [
  {
    code: "R1", name: "MORNING - SML", bus: "SML", direction: "morning", tripNo: 1,
    stops: [
      { name: "SCHOOL",              t: "07:15" },
      { name: "KIRUMAPAKKAM",        t: "07:30" },
      { name: "TN PALAYAM",          t: "07:45" },
      { name: "KAATUPALAYAM",        t: "07:50" },
      { name: "VILLUPALAYAM",        t: "07:55" },
      { name: "SIVANARPURAM",        t: "08:00" },
      { name: "SRINIVASA APARTMENT", t: "08:05" },
      { name: "ANNA NAGAR",          t: "08:10" },
      { name: "ACHARIYA SCHOOL",     t: "08:15" },
      { name: "THANAMPALAYAM",       t: "08:20" },
      { name: "STAGE",               t: "08:25" },
      { name: "PUDHUKUPPAM OUTER",   t: "08:30" },
      { name: "PUDHUKUPPAM QUARTERS",t: "08:35" },
      { name: "SCHOOL",              t: "08:40" },
    ],
  },
  {
    code: "R2", name: "MORNING - FORCE - TRIP 1", bus: "FORCE", direction: "morning", tripNo: 1,
    stops: [
      { name: "SCHOOL",            t: "07:00" },
      { name: "NONANKUPPAM",       t: "07:20" },
      { name: "NANAMEDU",          t: "07:40" },
      { name: "NALLAVADU QUARTERS",t: "07:45" },
      { name: "SCHOOL",            t: "08:20" },
    ],
  },
  {
    code: "R3", name: "MORNING - FORCE - TRIP 2", bus: "FORCE", direction: "morning", tripNo: 2,
    stops: [
      { name: "SCHOOL",     t: "08:20" },
      { name: "WATER TANK", t: "08:30" },
      { name: "SCHOOL",     t: "08:45" },
    ],
  },
  {
    code: "R4", name: "EVENING - SML", bus: "SML", direction: "evening", tripNo: 1,
    stops: [
      { name: "SCHOOL",              t: "03:30" },
      { name: "VIP NAGAR",           t: "03:35" },
      { name: "NALLAVADU QUARTERS",  t: "03:40" },
      { name: "STAGE",               t: "04:00" },
      { name: "SIVANARPURAM",        t: "04:10" },
      { name: "KAATUPALAYAM",        t: "04:15" },
      { name: "KORUKKAMEDU",         t: "04:20" },
      { name: "SRINIVASA APARTMENT", t: "04:25" },
      { name: "KIRUMAPAKKAM",        t: "04:40" },
      { name: "SCHOOL",              t: "04:50" },
    ],
  },
  {
    code: "R5", name: "EVENING - FORCE TRIP 1", bus: "FORCE", direction: "evening", tripNo: 1,
    stops: [
      { name: "SCHOOL",          t: "03:30" },
      { name: "PUDHUKUPPAM",     t: "03:45" },
      { name: "WATER TANK",      t: "03:55" },
      { name: "THANAMPALAYAM",   t: "04:00" },
      { name: "ACHARIYA SCHOOL", t: "04:05" },
      { name: "SCHOOL",          t: "04:10" },
    ],
  },
  {
    code: "R6", name: "EVENING - FORCE TRIP 2", bus: "FORCE", direction: "evening", tripNo: 2,
    stops: [
      { name: "SCHOOL",         t: "04:10" },
      { name: "SADA NAGAR",     t: "04:12" },
      { name: "NANAMEDU",       t: "04:15" },
      { name: "NONANKUPPAM",    t: "04:25" },
      { name: "EDAIYAR PALAYAM",t: "04:30" },
      { name: "ROHINI NAGAR",   t: "04:35" },
      { name: "NATIONAL SCHOOL",t: "04:40" },
      { name: "THAVALAKUPPAM",  t: "04:42" },
      { name: "MANDABAM",       t: "04:45" },
      { name: "KAATUPALAYAM",   t: "04:55" },
      { name: "TN PALAYAM",     t: "05:05" },
      { name: "THEDUVARNATHAM", t: "05:10" },
      { name: "SCHOOL",         t: "05:20" },
    ],
  },
];

// ---------- daily logs ----------
function normalizeSubjectLogs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    const subject = String(s?.subject || "").trim();
    if (!subject) continue;
    const key = subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cwStatus = s?.classworkStatus || s?.classwork_status || null;
    const hwStatus = s?.homeworkStatus || s?.homework_status || null;
    out.push({
      subject,
      classwork: s?.classwork != null ? String(s.classwork) : "",
      classworkStatus: cwStatus === "completed" || cwStatus === "not_completed" ? cwStatus : null,
      homework: s?.homework != null ? String(s.homework) : "",
      homeworkStatus: hwStatus === "completed" || hwStatus === "pending" ? hwStatus : null,
    });
  }
  return out;
}

// Roll up per-subject statuses into the legacy whole-day fields so KPIs
// and older UIs keep working.
function aggregateFromSubjectLogs(subjectLogs) {
  const list = Array.isArray(subjectLogs) ? subjectLogs : [];
  if (!list.length) return {};
  const cw = list.map((s) => s.classworkStatus).filter(Boolean);
  const hw = list.map((s) => s.homeworkStatus).filter(Boolean);
  const classworkStatus = !cw.length
    ? null
    : cw.every((s) => s === "completed") ? "completed"
      : cw.some((s) => s === "not_completed") ? "not_completed"
        : null;
  const homeworkStatus = !hw.length
    ? null
    : hw.every((s) => s === "completed") ? "completed"
      : hw.some((s) => s === "pending") ? "pending"
        : null;
  const classwork = list
    .filter((s) => (s.classwork || "").trim())
    .map((s) => `${s.subject}: ${s.classwork.trim()}`)
    .join(" · ");
  const homework = list
    .filter((s) => (s.homework || "").trim())
    .map((s) => `${s.subject}: ${s.homework.trim()}`)
    .join(" · ");
  return { classworkStatus, homeworkStatus, classwork, homework };
}

export async function upsertDailyLog(row) {
  const ATT_BUCKETS = new Set(["present", "late", "absent", "leave", "parent_drop"]);
  const att = ATT_BUCKETS.has(row.attendance) ? row.attendance : "present";
  const hasSubjectLogs = Array.isArray(row.subjectLogs);
  const subjectLogs = hasSubjectLogs ? normalizeSubjectLogs(row.subjectLogs) : null;
  const rolled = subjectLogs && subjectLogs.length ? aggregateFromSubjectLogs(subjectLogs) : {};
  const classwork = subjectLogs ? (rolled.classwork || "") : row.classwork;
  const classworkStatus = subjectLogs ? (rolled.classworkStatus || null) : (row.classworkStatus || null);
  const homework = subjectLogs ? (rolled.homework || "") : row.homework;
  const homeworkStatus = subjectLogs ? (rolled.homeworkStatus || null) : (row.homeworkStatus || null);
  const dbRow = {
    student_id: row.studentId, student_name: row.studentName, cls: row.cls,
    date: row.date,
    attendance: att,
    // Reason persists for any non-present bucket (absent/late/leave), not
    // just absences. The leave_reason column is reused for late-reason too.
    leave_reason: att === "present" ? null : (row.leaveReason || ""),
    classwork,
    classwork_status: classworkStatus,
    homework,
    homework_status: homeworkStatus,
    topics: row.topics,
    handwriting_note: row.handwritingNote, handwriting_grade: row.handwritingGrade,
    behaviour: row.behaviour, extra: row.extra, posted_by: row.postedBy,
    posted_at: new Date().toISOString(),
  };
  if (subjectLogs) dbRow.subject_logs = subjectLogs;
  if (supabaseEnabled) {
    let r = await supabase.from("daily_logs")
      .upsert(dbRow, { onConflict: "student_id,date" })
      .select().single();
    // PostgREST cache lag: strip whichever new column is unknown and retry.
    // Track everything we had to drop so we can mirror it into a side-store
    // file overlay (so the values still survive across reads).
    let attempt = dbRow;
    const droppedKeys = [];
    let safety = 5;
    while (r.error && safety-- > 0) {
      const m = /Could not find the '([a-z_]+)' column/i.exec(r.error.message);
      if (!m) break;
      const colName = m[1];
      const nextAttempt = { ...attempt };
      delete nextAttempt[colName];
      if (Object.keys(nextAttempt).length === Object.keys(attempt).length) break;
      droppedKeys.push(colName);
      attempt = nextAttempt;
      r = await supabase.from("daily_logs")
        .upsert(attempt, { onConflict: "student_id,date" })
        .select().single();
    }
    if (r.error) throw new Error(r.error.message);
    const persisted = fromDailyLog(r.data);
    // Mirror dropped fields into a side-store keyed by (studentId, date).
    if (droppedKeys.length > 0) {
      const overlayPatch = {
        classworkStatus,
        homeworkStatus,
        attendance: row.attendance || null,
        leaveReason: row.leaveReason || null,
      };
      if (droppedKeys.includes("subject_logs") && subjectLogs) overlayPatch.subjectLogs = subjectLogs;
      saveDailyLogOverlay(row.studentId, row.date, overlayPatch);
    }
    // Merge any prior overlay so the response reflects the true state.
    const overlay = readDailyLogOverlay(row.studentId, row.date);
    const mergedSubjects = overlay?.subjectLogs || persisted.subjectLogs || subjectLogs || [];
    return {
      fresh: true,
      log: {
        ...persisted,
        ...stripNullish(overlay),
        subjectLogs: Array.isArray(mergedSubjects) ? mergedSubjects : [],
      },
    };
  }
  const db = fileRead();
  if (!Array.isArray(db.dailyLogs)) db.dailyLogs = [];
  const idx = db.dailyLogs.findIndex((l) => l.studentId === row.studentId && l.date === row.date);
  const fresh = idx === -1;
  const prev = !fresh ? db.dailyLogs[idx] : null;
  const log = {
    studentId: row.studentId, studentName: row.studentName, cls: row.cls,
    date: row.date,
    attendance: att,
    leaveReason: att === "present" ? "" : (row.leaveReason || ""),
    classwork,
    classworkStatus,
    homework,
    homeworkStatus,
    subjectLogs: subjectLogs || prev?.subjectLogs || [],
    topics: row.topics,
    handwritingNote: row.handwritingNote, handwritingGrade: row.handwritingGrade,
    behaviour: row.behaviour, extra: row.extra,
    postedBy: row.postedBy, postedAt: new Date().toISOString(),
  };
  if (fresh) db.dailyLogs.unshift(log); else db.dailyLogs[idx] = log;
  fileWrite(db);
  return { fresh, log };
}

// ---------- staff ----------
// Composite score = 40% attendance + 40% tasks + 20% activity (we don't have
// activity yet, so use the average of attendance/tasks as a proxy).
function computeStaffScore({ attendance = 0, tasks = 0 }) {
  const a = Number(attendance) || 0;
  const t = Number(tasks) || 0;
  const activity = Math.round((a + t) / 2);
  return Math.round(0.4 * a + 0.4 * t + 0.2 * activity);
}
function statusFromScore(score) {
  if (score >= 85) return "top";
  if (score < 60)  return "low";
  return "ok";
}

export async function addStaff(row) {
  const id = row.id || `STF-${1000 + Math.floor(Math.random() * 8999)}`;
  const initials = (row.name || "?")
    .split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const score = computeStaffScore(row);
  const filled = {
    id, name: String(row.name || "").trim(),
    role: row.role || "Teacher",
    dept: row.dept || "—",
    phone: row.phone || "—",
    email: row.email || null,
    joiningDate: row.joiningDate || new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" }),
    salary: Number(row.salary) || 0,
    attendance: Number(row.attendance) || 0,
    tasks: Number(row.tasks) || 0,
    score,
    status: row.status || statusFromScore(score),
    avatar: row.avatar || initials,
  };

  let saved = filled;
  if (supabaseEnabled) {
    const ins = await supabase.from("staff").insert(toStaff(filled)).select().single();
    if (ins.error) {
      if (/staff/i.test(ins.error.message)) {
        console.warn(`[db] staff insert fell back to file: ${ins.error.message}`);
        saved = fileAddStaff(filled);
      } else {
        throw new Error(ins.error.message);
      }
    } else {
      saved = fromStaff(ins.data);
    }
  } else {
    saved = fileAddStaff(filled);
  }

  // Auto-provision a login account for teachers so they (a) show up in the
  // "Class teacher" picker on the Classes screen and (b) can sign in
  // immediately. Common password — same for every teacher account so the
  // principal only ever has to share one credential. Returned in the response
  // so the UI can show it once at creation time. Callers (e.g. bulk
  // import) can pass an explicit `defaultPassword` to override the
  // shared COMMON_TEACHER_PASSWORD — used for per-teacher derived
  // passwords like "Aakash@123".
  let createdLogin = null;
  if (filled.role === "Teacher" && filled.email) {
    try {
      const existing = await getUserByEmail(filled.email);
      if (!existing) {
        const defaultPassword = row.defaultPassword || COMMON_TEACHER_PASSWORD;
        const { hashPassword } = require("./auth.js");
        const passwordHash = await hashPassword(defaultPassword);
        await createUser({
          id: `USR-${Date.now().toString(36).toUpperCase()}`,
          email: filled.email,
          passwordHash,
          role: "teacher",
          name: filled.name,
          linkedId: null,
        });
        createdLogin = { email: filled.email, defaultPassword, role: "teacher" };
      }
    } catch (e) {
      console.warn(`[db] auto-provision teacher login failed: ${e.message}`);
    }
  }

  return { ...saved, createdLogin };
}

// Common credentials used when an account is auto-created on staff/student add.
// Documented here so they're easy to find + change in one place.
const COMMON_TEACHER_PASSWORD = "teacher123";

// Strip everything except a-z 0-9 — used to turn a student's free-form name
// ("Hari Krishna S.S") into a stable email local-part ("harikrishnass").
function slugifyName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Capitalised first word of the student's name. Used as the parent password
// stem so each parent's credential is at least minimally personalised.
// "aakash" → "Aakash", "HARI KRISHNA" → "Hari", "" → "Parent".
function firstNameCapitalised(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "Parent";
  const letters = first.replace(/[^a-zA-Z]/g, "") || "Parent";
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

// Predictable, name-based parent password — "Aakash@123" style. SECURITY
// CAVEAT: this is easily guessable; for a hardened deployment force a
// password change on first login.
function deriveParentPassword(studentName) {
  return `${firstNameCapitalised(studentName)}@123`;
}

// Derive a parent login email when one wasn't explicitly supplied. New
// format (2026-06-04): `parent.{slugged-name}@sanfort.com`. If a student
// with the same slugged name already has an account, we append a 4-digit
// tail from the student ID to disambiguate siblings or namesakes.
async function deriveParentEmail(studentId, studentName) {
  const base = slugifyName(studentName) || String(studentId).toLowerCase();
  const candidate = `parent.${base}@sanfort.com`;
  // Fast path — first student with this name gets the clean email.
  try {
    const existing = await getUserByEmail(candidate);
    if (!existing) return candidate;
  } catch {}
  // Collision: append the numeric tail of the student id, e.g. "9499".
  // Falls back to the full id if there are no digits.
  const idTail = String(studentId).match(/\d+/)?.[0] || String(studentId).toLowerCase();
  return `parent.${base}.${idTail}@sanfort.com`;
}

// Create a parent login linked to a student so the parent dashboard scopes to
// just their child. Idempotent — won't create a duplicate if one exists.
// Returns { email, defaultPassword, role } when a fresh account was made,
// null otherwise.
export async function provisionParentLogin({ studentId, studentName, parentEmail }) {
  if (!studentId) return null;
  const email = (parentEmail && String(parentEmail).trim().toLowerCase()) ||
    await deriveParentEmail(studentId, studentName);
  try {
    const existing = await getUserByEmail(email);
    if (existing) return null;
    const defaultPassword = deriveParentPassword(studentName);
    const { hashPassword } = require("./auth.js");
    const passwordHash = await hashPassword(defaultPassword);
    await createUser({
      id: `USR-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
      email,
      passwordHash,
      role: "parent",
      name: `${studentName || "Parent"} (parent)`,
      linkedId: studentId,
    });
    return { email, defaultPassword, role: "parent" };
  } catch (e) {
    console.warn(`[db] auto-provision parent login failed: ${e.message}`);
    return null;
  }
}

function fileAddStaff(filled) {
  const db = fileRead();
  if (!Array.isArray(db.staff)) db.staff = [];
  db.staff.unshift(filled);
  fileWrite(db);
  return filled;
}

// Best-effort read of staff from the local file store. Safe to call even when
// the file doesn't exist yet — it returns an empty array rather than throwing.
function fileStaffSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.staff) ? data.staff : [];
  } catch { return []; }
}

function fileRoutesSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.routes) ? data.routes : [];
  } catch { return []; }
}

function fileInventorySafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.inventory) ? data.inventory : [];
  } catch { return []; }
}

function fileMovementsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.movements) ? data.movements.slice(0, 30) : [];
  } catch { return []; }
}

// Per-item remarks override map ({ [itemId]: "text" }). Backs remarks for
// Supabase-hosted items until the `remarks` column exists; once it does, the
// column value (non-empty) wins and this is just a mirror.
function fileInventoryRemarks() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    return (data && data.inventoryRemarks && typeof data.inventoryRemarks === "object") ? data.inventoryRemarks : {};
  } catch { return {}; }
}
function applyInventoryRemarkOverrides(list) {
  const ov = fileInventoryRemarks();
  if (!ov || !Object.keys(ov).length) return list;
  return list.map((it) => {
    const o = ov[it.id];
    // Only fill when the row itself has no remarks — the real column wins.
    if (o != null && !(it.remarks && String(it.remarks).trim())) return { ...it, remarks: o };
    return it;
  });
}

function fileBroadcastsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.broadcasts) ? data.broadcasts.slice(0, 50) : [];
  } catch { return []; }
}

function fileTemplatesSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.templates) ? data.templates : [];
  } catch { return []; }
}

// Side-store for pickup stops keyed by student id. Used when the Supabase
// students table doesn't yet have a pickup_stop column — we still want the
// per-stop boarding roster to work, so we keep the assignment in the file
// store and merge it back in readAllData.
//
// `pickupStops` carries the morning stop; the evening stop lives in
// `pickupStopsEvening`. Two flat maps (rather than a nested {morning,
// evening}) means existing morning-only callers don't break and the
// migration is purely additive.
function savePickupStop(studentId, stopName) {
  if (!studentId) return;
  const db = fileRead();
  if (!db.pickupStops || typeof db.pickupStops !== "object") db.pickupStops = {};
  db.pickupStops[studentId] = stopName || null;
  fileWrite(db);
}
function savePickupStopEvening(studentId, stopName) {
  if (!studentId) return;
  const db = fileRead();
  if (!db.pickupStopsEvening || typeof db.pickupStopsEvening !== "object") db.pickupStopsEvening = {};
  db.pickupStopsEvening[studentId] = stopName || null;
  fileWrite(db);
}
function pickupStopsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return (data.pickupStops && typeof data.pickupStops === "object") ? data.pickupStops : {};
  } catch { return {}; }
}
function pickupStopsEveningSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return (data.pickupStopsEvening && typeof data.pickupStopsEvening === "object") ? data.pickupStopsEvening : {};
  } catch { return {}; }
}

// Read the whole file db in a way that never throws. Returns {} when the
// file isn't there yet. Used by readAllData to union file-stored entities
// alongside Supabase rows.
function fileDbSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    const raw = fs.readFileSync(DB_PATH, "utf8");
    return JSON.parse(raw) || {};
  } catch { return {}; }
}

function fileRecentFeesSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.recentFees) ? data.recentFees : [];
  } catch { return []; }
}

function fileEnquiriesSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.enquiries) ? data.enquiries : [];
  } catch { return []; }
}

function fileComplaintsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.complaints) ? data.complaints : [];
  } catch { return []; }
}

function fileRecipientListsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.recipientLists) ? data.recipientLists : [];
  } catch { return []; }
}

// ---------- volunteers ----------
export async function listVolunteers() {
  // Pull from Supabase + file store and union them. We don't use a PostgREST
  // embed for volunteer_hours here because the volunteers/volunteer_hours
  // tables don't have an FK declared, so `select("*, volunteer_hours(*)")`
  // returns PGRST200 and the whole call errors out — silently masking every
  // cloud volunteer behind the file-store fallback. Hours are fetched in a
  // second small query and grouped by volunteer_id in JS.
  let cloud = [];
  if (supabaseEnabled) {
    const sel = await supabase.from("volunteers").select("*").order("created_at", { ascending: false });
    if (!sel.error) {
      cloud = (sel.data || []).map((r) => ({ ...fromVolunteer(r), assignments: [] }));
      const hoursSel = await supabase.from("volunteer_hours").select("*").order("created_at", { ascending: false });
      if (!hoursSel.error && Array.isArray(hoursSel.data)) {
        const byVid = new Map();
        for (const h of hoursSel.data) {
          const vid = h.volunteer_id;
          if (!byVid.has(vid)) byVid.set(vid, []);
          byVid.get(vid).push(fromVolunteerHours(h));
        }
        for (const v of cloud) v.assignments = byVid.get(v.id) || [];
      }
    } else if (!isSchemaMissError(sel.error)) {
      console.warn(`[db] volunteers fell back: ${sel.error.message}`);
    }
  }
  const db = fileRead();
  const file = Array.isArray(db.volunteers) ? db.volunteers : [];
  // Dedupe by id, Supabase wins.
  const merged = new Map();
  for (const v of file)  if (v?.id) merged.set(v.id, v);
  for (const v of cloud) if (v?.id) merged.set(v.id, v);
  return [...merged.values()];
}
export async function addVolunteer(payload = {}) {
  const name = payload.name;
  if (!name?.trim()) throw new Error("Name required");
  const now = new Date();
  const v = {
    id: `VOL-${1000 + Math.floor(Math.random() * 8999)}`,
    name: name.trim(),
    email: payload.email || null,
    phone: payload.phone || null,
    skills: Array.isArray(payload.skills) ? payload.skills : (payload.skills ? [payload.skills] : []),
    availability: payload.availability || "weekends",
    notes: payload.notes || null,
    hours: 0,
    assignments: [],
    createdAt: now.toISOString(),
    // Extended Sanvi registration fields. All optional — older callers that
    // only pass {name, email, phone, skills, availability, notes} still work.
    dob: payload.dob || null,
    age: payload.age == null ? null : Number(payload.age),
    gender: payload.gender || null,
    address: payload.address || null,
    idType: payload.idType || null,
    idNumber: payload.idNumber || null,
    panNumber: payload.panNumber || null,
    emergency: payload.emergency || null, // { name, relationship, phone }
    qualification: payload.qualification || null,
    otherSkill: payload.otherSkill || null,
    previousExperience: payload.previousExperience || null,
    interests: Array.isArray(payload.interests) ? payload.interests : [],
    otherInterest: payload.otherInterest || null,
    preferredTime: payload.preferredTime || null,
    duration: payload.duration || null, // "short" | "long"
    references: Array.isArray(payload.references) ? payload.references : [],
    health: payload.health || null,
    declarationAgreed: !!payload.declarationAgreed,
    signatureName: payload.signatureName || null,
    signatureDate: payload.signatureDate || null,
    // For Office Use
    dateOfJoining: payload.dateOfJoining || null,
    assignedRole: payload.assignedRole || null,
    approvedBy: payload.approvedBy || null,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("volunteers").insert(toVolunteer(v)).select().single();
    if (!ins.error) return { ...fromVolunteer(ins.data), assignments: [] };
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
    // Schema doesn't yet have the extended columns — fall through to the file
    // store, which will keep every field of the new shape intact.
  }
  const db = fileRead();
  if (!Array.isArray(db.volunteers)) db.volunteers = [];
  db.volunteers.unshift(v);
  fileWrite(db);
  return v;
}
export async function logVolunteerHours(id, { hours, activity, date }) {
  const h = Math.max(0, Number(hours) || 0);
  const today = date || new Date().toISOString().slice(0, 10);
  if (supabaseEnabled) {
    const sel = await supabase.from("volunteers").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const newHours = (Number(sel.data.hours) || 0) + h;
      const upd = await supabase.from("volunteers").update({ hours: newHours }).eq("id", id).select().single();
      if (!upd.error) {
        await supabase.from("volunteer_hours").insert({
          id: `VA-${Date.now().toString(36).toUpperCase()}`,
          volunteer_id: id, hours: h, activity: activity || "—", date: today,
        });
        const all = await supabase.from("volunteer_hours").select("*").eq("volunteer_id", id).order("created_at", { ascending: false });
        return { ...fromVolunteer(upd.data), assignments: (all.data || []).map(fromVolunteerHours) };
      }
      if (!isSchemaMissError(upd.error)) throw new Error(upd.error.message);
    } else if (sel.error && !isSchemaMissError(sel.error)) {
      throw new Error(sel.error.message);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.volunteers)) db.volunteers = [];
  const idx = db.volunteers.findIndex((v) => v.id === id);
  if (idx === -1) throw new Error("Volunteer not found");
  const v = db.volunteers[idx];
  v.hours = (Number(v.hours) || 0) + h;
  v.assignments = [
    { id: `VA-${Date.now().toString(36).toUpperCase()}`, hours: h, activity: activity || "—", date: today },
    ...(v.assignments || []),
  ];
  db.volunteers[idx] = v;
  fileWrite(db);
  return v;
}
export async function removeVolunteer(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("volunteers").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("volunteer_hours").delete().eq("volunteer_id", id);
      await supabase.from("volunteers").delete().eq("id", id);
      return fromVolunteer(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.volunteers)) db.volunteers = [];
  const idx = db.volunteers.findIndex((v) => v.id === id);
  if (idx === -1) return null;
  const removed = db.volunteers[idx];
  db.volunteers.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- meetings ----------
// Simple meeting scheduler. audience can be "all" (broadcast to all parents),
// "class:1-A" (one class), or "user:email@x" (single attendee). RSVPs are
// stored as a list per meeting.
const MEETING_AUDIENCE_PREFIXES = ["all", "class:", "user:"];

export async function listMeetings({ forEmail, role, classes } = {}) {
  let all = [];
  if (supabaseEnabled) {
    const sel = await supabase.from("meetings").select("*, meeting_rsvps(*)").order("created_at", { ascending: false });
    if (!sel.error) {
      all = (sel.data || []).map((r) => ({
        ...fromMeeting(r),
        rsvps: (r.meeting_rsvps || []).map(fromMeetingRsvp),
      }));
    } else if (!isSchemaMissError(sel.error)) {
      console.warn(`[db] meetings fell back: ${sel.error.message}`);
    }
  }
  if (all.length === 0) {
    const db = fileRead();
    all = Array.isArray(db.meetings) ? db.meetings : [];
  }
  if (!forEmail) return all;
  if (role === "admin" || role === "principal" || role === "academic_director") return all;
  return all.filter((m) => {
    if (m.createdByEmail === forEmail) return true;
    if (m.audience === "all") return true;
    if (m.audience?.startsWith("user:") && m.audience.slice(5).toLowerCase() === forEmail.toLowerCase()) return true;
    if (m.audience?.startsWith("class:") && Array.isArray(classes) && classes.includes(m.audience.slice(6))) return true;
    return false;
  });
}

export async function addMeeting({ title, description, scheduledAt, location, audience, audienceLabel, createdByEmail, createdByName }) {
  if (!title?.trim()) throw new Error("Title required");
  if (!scheduledAt) throw new Error("scheduledAt required");
  if (!audience || !MEETING_AUDIENCE_PREFIXES.some((p) => audience === p.replace(/:$/, "") || audience.startsWith(p))) {
    throw new Error("audience must be 'all', 'class:X-Y' or 'user:email'");
  }
  const now = new Date();
  const m = {
    id: `MTG-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    title: title.trim(),
    description: description || null,
    scheduledAt,
    location: location || "School premises",
    audience,
    audienceLabel: audienceLabel || audience,
    createdByEmail: createdByEmail || null,
    createdByName: createdByName || "Admin",
    createdAt: now.toISOString(),
    rsvps: [],
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("meetings").insert(toMeeting(m)).select().single();
    if (!ins.error) return { ...fromMeeting(ins.data), rsvps: [] };
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.meetings)) db.meetings = [];
  db.meetings.unshift(m);
  fileWrite(db);
  return m;
}

export async function rsvpMeeting({ id, fromEmail, fromName, response }) {
  if (!["yes", "no", "maybe"].includes(response)) throw new Error("response must be yes/no/maybe");
  if (supabaseEnabled) {
    const sel = await supabase.from("meetings").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const row = {
        meeting_id: id, from_email: fromEmail,
        from_name: fromName || fromEmail, response,
        responded_at: new Date().toISOString(),
      };
      const up = await supabase.from("meeting_rsvps").upsert(row, { onConflict: "meeting_id,from_email" });
      if (!up.error) {
        const all = await supabase.from("meeting_rsvps").select("*").eq("meeting_id", id);
        return { ...fromMeeting(sel.data), rsvps: (all.data || []).map(fromMeetingRsvp) };
      }
      if (!isSchemaMissError(up.error)) throw new Error(up.error.message);
    } else if (sel.error && !isSchemaMissError(sel.error)) {
      throw new Error(sel.error.message);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.meetings)) db.meetings = [];
  const idx = db.meetings.findIndex((m) => m.id === id);
  if (idx === -1) throw new Error("Meeting not found");
  const meeting = db.meetings[idx];
  meeting.rsvps = (meeting.rsvps || []).filter((r) => (r.fromEmail || "").toLowerCase() !== (fromEmail || "").toLowerCase());
  meeting.rsvps.push({ fromEmail, fromName: fromName || fromEmail, response, respondedAt: new Date().toISOString() });
  db.meetings[idx] = meeting;
  fileWrite(db);
  return meeting;
}

export async function removeMeeting(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("meetings").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("meeting_rsvps").delete().eq("meeting_id", id);
      await supabase.from("meetings").delete().eq("id", id);
      return fromMeeting(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.meetings)) db.meetings = [];
  const idx = db.meetings.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const removed = db.meetings[idx];
  db.meetings.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- parent-teacher chat ----------
// Threads are keyed by `${parentEmail}::${teacherEmail}::${studentId}` so a
// parent talking to two different class teachers about the same kid keeps the
// threads separate. Messages are appended in order.
function threadKey(parentEmail, teacherEmail, studentId) {
  return `${(parentEmail || "").toLowerCase()}::${(teacherEmail || "").toLowerCase()}::${studentId || ""}`;
}

export async function listChatThreads({ forEmail, role } = {}) {
  let all = [];
  if (supabaseEnabled) {
    const sel = await supabase.from("chat_threads").select("*, chat_messages(*)").order("last_message_at", { ascending: false, nullsFirst: false });
    if (!sel.error) {
      all = (sel.data || []).map((r) => ({
        ...fromChatThread(r),
        messages: (r.chat_messages || []).map(fromChatMessage)
          .sort((a, b) => (a.sentAt || "").localeCompare(b.sentAt || "")),
      }));
    } else if (!isSchemaMissError(sel.error)) {
      console.warn(`[db] chat_threads fell back: ${sel.error.message}`);
    }
  }
  if (all.length === 0) {
    const db = fileRead();
    all = Array.isArray(db.chatThreads) ? db.chatThreads : [];
  }
  if (!forEmail) return all;
  const lower = forEmail.toLowerCase();
  if (role === "parent") {
    return all.filter((t) => (t.parentEmail || "").toLowerCase() === lower);
  }
  if (role === "teacher") {
    // Teachers see threads addressed directly to them OR for any class
    // they're the class teacher of (so chats with co-teachers of the
    // same class are visible too — useful when one teacher is on leave
    // and a parent needs continuity).
    let myClasses = [];
    try {
      const me = await getUserByEmail(forEmail);
      myClasses = Array.isArray(me?.linkedClasses) ? me.linkedClasses : [];
    } catch {}
    const myClassSet = new Set(myClasses.map((c) => String(c).toUpperCase()));
    return all.filter((t) => {
      if ((t.teacherEmail || "").toLowerCase() === lower) return true;
      if (t.cls && myClassSet.has(String(t.cls).toUpperCase())) return true;
      return false;
    });
  }
  return all; // admin/principal see everything
}

// Helper: ensure the file-store has a copy of this thread. Returns the
// row reference inside db.chatThreads (mutable). The file copy acts as a
// safety net so message appends never lose data even if Supabase
// momentarily fails / the cloud table is missing / RLS rejects a write.
function ensureFileThread(db, key, fields) {
  if (!Array.isArray(db.chatThreads)) db.chatThreads = [];
  let thread = db.chatThreads.find((t) => t.id === key);
  if (!thread) {
    thread = {
      id: key,
      parentEmail: fields.parentEmail,
      parentName: fields.parentName || fields.parentEmail,
      teacherEmail: fields.teacherEmail,
      teacherName: fields.teacherName || fields.teacherEmail,
      studentId: fields.studentId,
      studentName: fields.studentName || "—",
      cls: fields.cls || "—",
      messages: [],
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    };
    db.chatThreads.unshift(thread);
  }
  return thread;
}

export async function getOrCreateThread({ parentEmail, parentName, teacherEmail, teacherName, studentId, studentName, cls }) {
  if (!parentEmail || !teacherEmail || !studentId) throw new Error("parentEmail, teacherEmail, studentId required");
  const key = threadKey(parentEmail, teacherEmail, studentId);
  const fields = { parentEmail, parentName, teacherEmail, teacherName, studentId, studentName, cls };

  // ALWAYS keep a file-store copy of the thread (safety net). The Supabase
  // copy below is best-effort — a network blip, schema mismatch, or RLS
  // rejection won't break send.
  const db = fileRead();
  const fileThread = ensureFileThread(db, key, fields);
  fileWrite(db);

  if (supabaseEnabled) {
    try {
      const sel = await supabase.from("chat_threads").select("*, chat_messages(*)").eq("id", key).maybeSingle();
      if (sel.data) {
        return {
          ...fromChatThread(sel.data),
          messages: (sel.data.chat_messages || []).map(fromChatMessage)
            .sort((a, b) => (a.sentAt || "").localeCompare(b.sentAt || "")),
        };
      }
      if (sel.error && !isSchemaMissError(sel.error)) {
        console.warn(`[db] chat thread select fell back to file: ${sel.error.message}`);
      }
      const ins = await supabase.from("chat_threads").insert(toChatThread({
        id: key, parentEmail, parentName: parentName || parentEmail,
        teacherEmail, teacherName: teacherName || teacherEmail,
        studentId, studentName: studentName || "—", cls: cls || "—",
      })).select().single();
      if (!ins.error) return { ...fromChatThread(ins.data), messages: [] };
      if (!isSchemaMissError(ins.error)) {
        console.warn(`[db] chat thread insert fell back to file: ${ins.error.message}`);
      }
    } catch (e) {
      console.warn(`[db] chat thread cloud path errored, using file: ${e.message}`);
    }
  }
  return fileThread;
}

export async function appendChatMessage({ threadId, fromEmail, fromName, fromRole, body }) {
  if (!threadId || !body?.trim()) throw new Error("threadId + body required");
  const now = new Date();
  const msg = {
    id: `MSG-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    fromEmail, fromName: fromName || fromEmail, fromRole: fromRole || "user",
    body: String(body).trim(),
    sentAt: now.toISOString(),
  };

  // Try Supabase first (best-effort).
  let cloudOk = false;
  let cloudThread = null;
  let cloudMessages = null;
  if (supabaseEnabled) {
    try {
      const sel = await supabase.from("chat_threads").select("*").eq("id", threadId).maybeSingle();
      if (sel.data) {
        const ins = await supabase.from("chat_messages").insert({
          id: msg.id, thread_id: threadId,
          from_email: msg.fromEmail, from_name: msg.fromName, from_role: msg.fromRole,
          body: msg.body, sent_at: msg.sentAt,
        });
        if (!ins.error) {
          await supabase.from("chat_threads").update({ last_message_at: msg.sentAt }).eq("id", threadId);
          const all = await supabase.from("chat_messages").select("*").eq("thread_id", threadId).order("sent_at");
          cloudOk = true;
          cloudThread = { ...fromChatThread(sel.data), lastMessageAt: msg.sentAt };
          cloudMessages = (all.data || []).map(fromChatMessage);
        } else if (!isSchemaMissError(ins.error)) {
          console.warn(`[db] chat message insert fell back to file: ${ins.error.message}`);
        }
      } else if (sel.error && !isSchemaMissError(sel.error)) {
        console.warn(`[db] chat message select fell back to file: ${sel.error.message}`);
      }
    } catch (e) {
      console.warn(`[db] chat message cloud path errored, using file: ${e.message}`);
    }
  }

  // Always mirror to file. If the thread isn't there yet (e.g. only ever
  // lived in Supabase), recreate it from the threadId components so the
  // append still succeeds — better to over-write than to throw.
  const db = fileRead();
  if (!Array.isArray(db.chatThreads)) db.chatThreads = [];
  let thread = db.chatThreads.find((t) => t.id === threadId);
  if (!thread) {
    const [pe, te, sid] = String(threadId).split("::");
    thread = ensureFileThread(db, threadId, {
      parentEmail: pe || fromEmail || "",
      parentName: cloudThread?.parentName || pe || "",
      teacherEmail: te || "",
      teacherName: cloudThread?.teacherName || te || "",
      studentId: sid || "",
      studentName: cloudThread?.studentName || "—",
      cls: cloudThread?.cls || "—",
    });
  }
  thread.messages = thread.messages || [];
  thread.messages.push(msg);
  thread.lastMessageAt = msg.sentAt;
  fileWrite(db);

  if (cloudOk) {
    return { thread: { ...cloudThread, messages: cloudMessages }, message: msg };
  }
  return { thread, message: msg };
}

// ---------- transfer certificates ----------
const TC_STATUSES = ["requested", "approved", "issued", "rejected"];

export async function addTcRequest({ studentId, studentName, cls, reason, requestedBy }) {
  if (!studentId) throw new Error("studentId required");
  const now = new Date();
  const tc = {
    id: `TC-${now.getFullYear()}-${(now.getTime() % 100000).toString().padStart(5, "0")}`,
    studentId,
    studentName: studentName || "—",
    cls: cls || "—",
    reason: reason || null,
    status: "requested",
    requestedBy: requestedBy || "Admin",
    requestedAt: now.toISOString(),
    issuedAt: null,
    issuedBy: null,
    serialNo: null,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("tc_requests").insert(toTcRequest(tc)).select().single();
    if (!ins.error) return fromTcRequest(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.tcRequests)) db.tcRequests = [];
  db.tcRequests.unshift(tc);
  fileWrite(db);
  return tc;
}

export async function updateTcRequest(id, patch = {}) {
  if (supabaseEnabled) {
    const sel = await supabase.from("tc_requests").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const next = { ...fromTcRequest(sel.data) };
      const upd = {};
      if (patch.status && TC_STATUSES.includes(patch.status)) upd.status = patch.status;
      if (typeof patch.reason === "string") upd.reason = patch.reason;
      if (upd.status === "issued" && !next.issuedAt) {
        upd.issued_at = new Date().toISOString();
        upd.issued_by = patch.issuedBy || "Admin";
        const cnt = await supabase.from("tc_requests").select("id", { count: "exact", head: true }).eq("status", "issued");
        const issuedCount = (cnt.count || 0) + 1;
        upd.serial_no = `TC/${new Date().getFullYear()}/${String(issuedCount).padStart(4, "0")}`;
      }
      const r = await supabase.from("tc_requests").update(upd).eq("id", id).select().single();
      if (!r.error) return fromTcRequest(r.data);
      if (!isSchemaMissError(r.error)) throw new Error(r.error.message);
    } else if (sel.error && !isSchemaMissError(sel.error)) {
      throw new Error(sel.error.message);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.tcRequests)) db.tcRequests = [];
  const idx = db.tcRequests.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const next = { ...db.tcRequests[idx] };
  if (patch.status && TC_STATUSES.includes(patch.status)) next.status = patch.status;
  if (patch.status === "issued" && !next.issuedAt) {
    next.issuedAt = new Date().toISOString();
    next.issuedBy = patch.issuedBy || "Admin";
    const issuedCount = db.tcRequests.filter((t) => t.status === "issued").length + 1;
    next.serialNo = `TC/${new Date().getFullYear()}/${String(issuedCount).padStart(4, "0")}`;
  }
  if (typeof patch.reason === "string") next.reason = patch.reason;
  db.tcRequests[idx] = next;
  fileWrite(db);
  return next;
}

export async function listTcRequests() {
  if (supabaseEnabled) {
    const sel = await supabase.from("tc_requests").select("*").order("requested_at", { ascending: false });
    if (!sel.error) return (sel.data || []).map(fromTcRequest);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] tc_requests fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return Array.isArray(db.tcRequests) ? db.tcRequests : [];
}

export async function removeTcRequest(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("tc_requests").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("tc_requests").delete().eq("id", id);
      return fromTcRequest(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.tcRequests)) db.tcRequests = [];
  const idx = db.tcRequests.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const removed = db.tcRequests[idx];
  db.tcRequests.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- teacher attendance ----------
// One row per (teacherId, date). Self-marked by teachers, can be overridden
// by principal/admin. File-only for now.
const TEACHER_ATTENDANCE_STATUSES = ["present", "late", "absent", "leave"];

export async function markTeacherAttendance({ teacherId, teacherName, date, status, leaveReason, lateReason, markedBy }) {
  if (!teacherId || !date) throw new Error("teacherId + date required");
  const st = TEACHER_ATTENDANCE_STATUSES.includes(status) ? status : "present";
  // For backward compat we keep storing the explanation in `leave_reason`
  // (the existing column) regardless of whether the status is "leave" or
  // "late". Callers can pass either `leaveReason` or `lateReason`; the API
  // surfaces both names so client code reads cleanly.
  const reasonText = st === "leave" ? (leaveReason || "")
                   : st === "late"  ? (lateReason  || leaveReason || "")
                   : null;
  const row = {
    id: `TAT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    teacherId,
    teacherName: teacherName || "—",
    date,
    status: st,
    leaveReason: st === "leave" ? reasonText : null,
    lateReason:  st === "late"  ? reasonText : null,
    markedBy: markedBy || teacherId,
    markedAt: new Date().toISOString(),
  };
  if (supabaseEnabled) {
    const dbRow = {
      id: row.id, teacher_id: teacherId, teacher_name: row.teacherName,
      date, status: st,
      // Reuse the existing leave_reason column for both leave + late notes.
      // Avoids a schema migration for the late-reason rollout while still
      // letting clients read it back via `lateReason` (mapped in fromTeacherAttendance).
      leave_reason: reasonText,
      marked_by: row.markedBy, marked_at: row.markedAt,
    };
    const up = await supabase.from("teacher_attendance").upsert(dbRow, { onConflict: "teacher_id,date" }).select().single();
    if (!up.error) return fromTeacherAttendance(up.data);
    if (!isSchemaMissError(up.error)) throw new Error(up.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.teacherAttendance)) db.teacherAttendance = [];
  const idx = db.teacherAttendance.findIndex((r) => r.teacherId === teacherId && r.date === date);
  if (idx !== -1) row.id = db.teacherAttendance[idx].id;
  if (idx === -1) db.teacherAttendance.unshift(row); else db.teacherAttendance[idx] = row;
  fileWrite(db);
  return row;
}

export async function listTeacherAttendance({ teacherId, fromDate, toDate } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("teacher_attendance").select("*").order("date", { ascending: false });
    if (teacherId) q = q.eq("teacher_id", teacherId);
    if (fromDate)  q = q.gte("date", fromDate);
    if (toDate)    q = q.lte("date", toDate);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromTeacherAttendance);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] teacher_attendance fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.teacherAttendance) ? db.teacherAttendance : [];
  if (teacherId) all = all.filter((r) => r.teacherId === teacherId);
  if (fromDate)  all = all.filter((r) => r.date >= fromDate);
  if (toDate)    all = all.filter((r) => r.date <= toDate);
  return all;
}

// ---------- exams & marks ----------
// An exam describes the assessment ("Unit Test 1 · 5-A · Maths" with max marks).
// Marks are stored per (examId, studentId). One mark row per student per exam.
const EXAM_TYPES = ["unit_test", "mid_term", "final", "assignment", "practical", "project", "periodic_1", "periodic_2", "periodic_3", "periodic_4", "term_1", "term_2"];
// Assessments class teachers record subject-wise via the marks grid: the four
// periodic tests (I–IV) and the two term exams (Term I / Term II).
export const PERIODIC_TESTS = [
  { k: "periodic_1", label: "Periodic Test I" },
  { k: "periodic_2", label: "Periodic Test II" },
  { k: "periodic_3", label: "Periodic Test III" },
  { k: "periodic_4", label: "Periodic Test IV" },
];
export const TERM_EXAMS = [
  { k: "term_1", label: "Term I" },
  { k: "term_2", label: "Term II" },
];
const ASSESSMENT_LABEL = Object.fromEntries([...PERIODIC_TESTS, ...TERM_EXAMS].map((p) => [p.k, p.label]));

export async function addExam({ name, type, cls, subject, maxMarks, date, createdBy }) {
  if (!name || !cls || !subject) throw new Error("name, cls and subject required");
  const t = EXAM_TYPES.includes(type) ? type : "unit_test";
  const now = new Date();
  const exam = {
    id: `EXM-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    name: String(name).trim(),
    type: t,
    cls: String(cls),
    subject: String(subject).trim(),
    maxMarks: Math.max(1, Number(maxMarks) || 100),
    date: date || now.toISOString().slice(0, 10),
    createdBy: createdBy || "Teacher",
    createdAt: now.toISOString(),
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("exams").insert(toExam(exam)).select().single();
    if (!ins.error) return fromExam(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.exams)) db.exams = [];
  db.exams.unshift(exam);
  fileWrite(db);
  return exam;
}

export async function listExams({ cls, subject } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("exams").select("*").order("created_at", { ascending: false });
    if (cls)     q = q.eq("cls", cls);
    if (subject) q = q.eq("subject", subject);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromExam);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] exams fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.exams) ? db.exams : [];
  if (cls)     all = all.filter((e) => e.cls === cls);
  if (subject) all = all.filter((e) => e.subject === subject);
  return all;
}

export async function removeExam(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("exams").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("exam_marks").delete().eq("exam_id", id);
      await supabase.from("exams").delete().eq("id", id);
      return fromExam(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.exams)) db.exams = [];
  const idx = db.exams.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const removed = db.exams[idx];
  db.exams.splice(idx, 1);
  if (Array.isArray(db.marks)) db.marks = db.marks.filter((m) => m.examId !== id);
  fileWrite(db);
  return removed;
}

export async function saveMarks({ examId, studentId, studentName, score, remarks, recordedBy }) {
  if (!examId || !studentId) throw new Error("examId + studentId required");
  let exam = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("exams").select("*").eq("id", examId).maybeSingle();
    if (sel.data) exam = fromExam(sel.data);
  }
  if (!exam) {
    const db = fileRead();
    exam = (db.exams || []).find((e) => e.id === examId);
  }
  if (!exam) throw new Error("Exam not found");
  const sc = Math.max(0, Math.min(exam.maxMarks, Number(score) || 0));
  const row = {
    id: `MRK-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    examId, studentId, studentName: studentName || "—",
    score: sc, maxMarks: exam.maxMarks,
    remarks: remarks || null,
    recordedBy: recordedBy || "Teacher",
    recordedAt: new Date().toISOString(),
  };
  if (supabaseEnabled) {
    const dbRow = {
      id: row.id, exam_id: examId, student_id: studentId,
      student_name: row.studentName, score: sc, max_marks: exam.maxMarks,
      remarks: row.remarks, recorded_by: row.recordedBy, recorded_at: row.recordedAt,
    };
    const up = await supabase.from("exam_marks").upsert(dbRow, { onConflict: "exam_id,student_id" }).select().single();
    if (!up.error) return fromExamMark(up.data);
    if (!isSchemaMissError(up.error)) throw new Error(up.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.marks)) db.marks = [];
  const idx = db.marks.findIndex((m) => m.examId === examId && m.studentId === studentId);
  if (idx !== -1) row.id = db.marks[idx].id;
  if (idx === -1) db.marks.unshift(row); else db.marks[idx] = row;
  fileWrite(db);
  return row;
}

export async function listMarks({ examId, studentId } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("exam_marks").select("*").order("recorded_at", { ascending: false });
    if (examId)    q = q.eq("exam_id", examId);
    if (studentId) q = q.eq("student_id", studentId);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromExamMark);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] exam_marks fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.marks) ? db.marks : [];
  if (examId)    all = all.filter((m) => m.examId === examId);
  if (studentId) all = all.filter((m) => m.studentId === studentId);
  return all;
}

export const __EXAM_META = { TYPES: EXAM_TYPES };
export const __TEACHER_ATTENDANCE_META = { STATUSES: TEACHER_ATTENDANCE_STATUSES };

// ---------- periodic tests (I–IV): class-teacher, subject-wise grid ----------
// The grid is backed by the existing exams/exam_marks model: each
// (class × periodic test × subject) is one exam of type periodic_N, and each
// student's cell is one exam_mark. Exams are auto-created on first save.

// Subjects taught in a class (from the class record's `subjects`; falls back
// to the global subject list so the grid is never empty).
async function classSubjectsFor(cls, all) {
  const n = Number(String(cls).split("-")[0]) || 0;
  const classes = (all && all.classes) || (await readAllData().catch(() => ({}))).classes || [];
  const row = (classes || []).find((c) => Number(c.n) === n);
  let subs = (row && Array.isArray(row.subjects)) ? row.subjects.filter(Boolean) : [];
  if (!subs.length) {
    const list = await listSubjects().catch(() => []);
    subs = (list || []).map((s) => s.name).filter(Boolean);
  }
  return subs;
}

async function updateExamMaxMarks(id, maxMarks) {
  const mm = Math.max(1, Math.floor(Number(maxMarks) || 25));
  if (supabaseEnabled) {
    const up = await supabase.from("exams").update({ max_marks: mm }).eq("id", id);
    if (up.error && !isSchemaMissError(up.error)) console.warn(`[db] exam max update failed: ${up.error.message}`);
  }
  const db = fileRead();
  if (Array.isArray(db.exams)) {
    const i = db.exams.findIndex((e) => e.id === id);
    if (i !== -1) { db.exams[i].maxMarks = mm; fileWrite(db); }
  }
}

// Load the grid for one class + test: subjects (columns), students (rows),
// the current marks, and the max. Returns empty marks until any are saved.
export async function getPeriodicGrid({ cls, test }) {
  const type = EXAM_TYPES.includes(test) ? test : "periodic_1";
  const all = await readAllData().catch(() => ({}));
  const subjects = await classSubjectsFor(cls, all);
  const students = (all.addedStudents || [])
    .filter((s) => s.cls === cls && (s.status ?? "active") !== "archived")
    .map((s) => ({ id: s.id, name: s.name, cls: s.cls, roll: s.roll || null }));
  const exams = (await listExams({ cls })).filter((e) => e.type === type);
  const examBySubject = {};
  for (const e of exams) examBySubject[e.subject] = e.id;
  const defaultMax = String(type).startsWith("term_") ? 100 : 25;
  const maxMarks = exams.length ? Number(exams[0].maxMarks) || defaultMax : defaultMax;
  const marks = {};
  for (const e of exams) {
    const ms = await listMarks({ examId: e.id });
    for (const m of ms) {
      if (!marks[m.studentId]) marks[m.studentId] = {};
      marks[m.studentId][e.subject] = m.score;
    }
  }
  return { cls, test: type, label: ASSESSMENT_LABEL[type] || "Assessment", subjects, maxMarks, students, marks, examBySubject };
}

// Save grid marks. `entries` = [{ studentId, studentName, subject, score }].
// Ensures one exam per subject (creating/updating maxMarks), then upserts each
// non-blank cell. Blank scores are skipped (leaves that cell unrecorded).
export async function savePeriodicMarks({ cls, test, maxMarks, entries, actor = "Teacher" }) {
  if (!cls) throw new Error("cls required");
  const type = EXAM_TYPES.includes(test) ? test : "periodic_1";
  const mm = Math.max(1, Math.floor(Number(maxMarks) || (String(type).startsWith("term_") ? 100 : 25)));
  const label = ASSESSMENT_LABEL[type] || "Assessment";
  const existing = (await listExams({ cls })).filter((e) => e.type === type);
  const examBySubject = {};
  for (const e of existing) examBySubject[e.subject] = e;
  const subjects = [...new Set((entries || []).map((x) => x.subject).filter(Boolean))];
  for (const sub of subjects) {
    let ex = examBySubject[sub];
    if (!ex) {
      ex = await addExam({ name: `${label} · ${sub}`, type, cls, subject: sub, maxMarks: mm, date: new Date().toISOString().slice(0, 10), createdBy: actor });
      examBySubject[sub] = ex;
    } else if (Number(ex.maxMarks) !== mm) {
      await updateExamMaxMarks(ex.id, mm);
      ex.maxMarks = mm;
    }
  }
  let saved = 0;
  for (const e of (entries || [])) {
    const ex = examBySubject[e.subject];
    if (!ex) continue;
    if (e.score === "" || e.score == null) continue;
    const score = Math.max(0, Math.min(mm, Math.floor(Number(e.score) || 0)));
    await saveMarks({ examId: ex.id, studentId: e.studentId, studentName: e.studentName || null, score, remarks: null, recordedBy: actor });
    saved++;
  }
  return { ok: true, saved, subjects: subjects.length, maxMarks: mm };
}

// ---------- vehicle maintenance ----------
// One log entry per maintenance event. Tied to a bus by `busNumber` (string —
// matches the route's `bus` field). `nextDueDate` drives renewal alerts.
const MAINTENANCE_TYPES = ["service", "fuel", "insurance", "FC", "PUC", "repair", "tyre", "battery"];

export async function addMaintenanceLog({ busNumber, routeCode, type, date, odometer, vendor, cost, notes, nextDueDate, recordedBy }) {
  if (!busNumber) throw new Error("busNumber required");
  const t = MAINTENANCE_TYPES.includes(type) ? type : "service";
  const now = new Date();
  const log = {
    id: `MNT-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    busNumber: String(busNumber).trim(),
    routeCode: routeCode || null,
    type: t,
    date: date || now.toISOString().slice(0, 10),
    odometer: odometer ? Number(odometer) : null,
    vendor: vendor || null,
    cost: cost ? Math.max(0, Math.round(Number(cost))) : 0,
    notes: notes || null,
    nextDueDate: nextDueDate || null,
    recordedBy: recordedBy || "unknown",
    createdAt: now.toISOString(),
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("maintenance_logs").insert(toMaintenance(log)).select().single();
    if (!ins.error) return fromMaintenance(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.maintenanceLogs)) db.maintenanceLogs = [];
  db.maintenanceLogs.unshift(log);
  fileWrite(db);
  return log;
}

export async function listMaintenanceLogs({ busNumber } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("maintenance_logs").select("*").order("created_at", { ascending: false });
    if (busNumber) q = q.eq("bus_number", busNumber);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromMaintenance);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] maintenance_logs fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  const all = Array.isArray(db.maintenanceLogs) ? db.maintenanceLogs : [];
  if (busNumber) return all.filter((l) => l.busNumber === busNumber);
  return all;
}

export async function removeMaintenanceLog(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("maintenance_logs").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("maintenance_logs").delete().eq("id", id);
      return fromMaintenance(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.maintenanceLogs)) db.maintenanceLogs = [];
  const idx = db.maintenanceLogs.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  const removed = db.maintenanceLogs[idx];
  db.maintenanceLogs.splice(idx, 1);
  fileWrite(db);
  return removed;
}

export const __MAINTENANCE_META = { TYPES: MAINTENANCE_TYPES };

// ---------- expenses ----------
// Logged expenses with a scope ("school" or "trust") so the Money screen and
// Trust dashboard can filter / sum independently.
const EXPENSE_SCOPES = ["school", "trust"];
const EXPENSE_CATEGORIES = [
  "Salary", "Utilities", "Supplies", "Maintenance", "Transport", "Events",
  "Stationery", "Software", "Marketing", "Donation outflow",
  // Stamped automatically by the inventory cascade — admin-edited
  // expenses can also use it manually.
  "Inventory purchase",
  "Misc",
];

export async function addExpense({ scope, category, amount, vendor, memo, date, paymentMethod, recordedBy, inventoryId } = {}) {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  if (!amt) throw new Error("Amount must be greater than zero");
  const sc = EXPENSE_SCOPES.includes(scope) ? scope : "school";
  const now = new Date();
  const exp = {
    id: `EXP-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    scope: sc,
    // Allow any string the caller passes — the dropdown enforces the
    // built-in list, custom categories from expense_categories pass
    // through, and the inventory cascade stamps "Inventory purchase".
    category: typeof category === "string" && category.trim() ? category.trim() : "Misc",
    amount: amt,
    vendor: vendor || null,
    memo: memo || null,
    date: date || now.toISOString().slice(0, 10),
    paymentMethod: paymentMethod || "Bank transfer",
    recordedBy: recordedBy || "unknown",
    inventoryId: inventoryId || null,
    createdAt: now.toISOString(),
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("expenses").insert(toExpense(exp)).select().single();
    if (ins.error) {
      // No silent file fallback — expenses go into the school's books
      // and must be in Supabase. Schema-cache misses surface to the
      // admin so they can run the migration.
      throw new Error(`Could not save expense to Supabase: ${ins.error.message}`);
    }
    return fromExpense(ins.data);
  }
  const db = fileRead();
  if (!Array.isArray(db.expenses)) db.expenses = [];
  db.expenses.unshift(exp);
  fileWrite(db);
  return exp;
}

export async function listExpenses({ scope } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("expenses").select("*").order("created_at", { ascending: false });
    if (scope) q = q.eq("scope", scope);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromExpense);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] expenses fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  const all = Array.isArray(db.expenses) ? db.expenses : [];
  if (scope) return all.filter((e) => e.scope === scope);
  return all;
}

export async function removeExpense(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("expenses").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("expenses").delete().eq("id", id);
      return fromExpense(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.expenses)) db.expenses = [];
  const idx = db.expenses.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const removed = db.expenses[idx];
  db.expenses.splice(idx, 1);
  fileWrite(db);
  return removed;
}

export const __EXPENSE_META = { SCOPES: EXPENSE_SCOPES, CATEGORIES: EXPENSE_CATEGORIES };

// ---------- schools (trust-level multi-school) ----------
export async function listSchools() {
  if (supabaseEnabled) {
    const sel = await supabase.from("schools").select("*").order("created_at", { ascending: true });
    if (!sel.error) return (sel.data || []).filter((r) => !r.archived_at).map(fromSchool);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] schools fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return Array.isArray(db.schools) ? db.schools : [];
}

export async function addSchool(row) {
  const id = row.id || `SCH-${Date.now().toString(36).toUpperCase()}`;
  const filled = {
    id,
    name: String(row.name || "").trim(),
    city: row.city || null,
    status: row.status || "Active",
    students: Number(row.students) || 0,
    fees: Number(row.fees) || 0,
    wellness: row.wellness || null,
    puck: row.puck || "ink",
  };
  if (!filled.name) throw new Error("School name is required");
  if (supabaseEnabled) {
    const ins = await supabase.from("schools").insert(toSchool(filled)).select().single();
    if (!ins.error) return fromSchool(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.schools)) db.schools = [];
  db.schools.unshift(filled);
  fileWrite(db);
  return filled;
}

export async function updateSchool(id, patch = {}) {
  if (!id) throw new Error("id required");
  if (supabaseEnabled) {
    const sel = await supabase.from("schools").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const upd = toSchool({ ...fromSchool(sel.data), ...patch, id });
      delete upd.id;
      const r = await supabase.from("schools").update(upd).eq("id", id).select().single();
      if (!r.error) return fromSchool(r.data);
      if (!isSchemaMissError(r.error)) throw new Error(r.error.message);
    } else if (sel.error && !isSchemaMissError(sel.error)) {
      throw new Error(sel.error.message);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.schools)) db.schools = [];
  const idx = db.schools.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  db.schools[idx] = { ...db.schools[idx], ...patch };
  fileWrite(db);
  return db.schools[idx];
}

export async function archiveSchool(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("schools").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const upd = await supabase.from("schools")
        .update({ archived_at: new Date().toISOString() }).eq("id", id);
      if (upd.error && /archived_at/.test(upd.error.message)) {
        await supabase.from("schools").delete().eq("id", id);
      }
      return fromSchool(sel.data);
    }
  }
  const db = fileRead();
  const idx = (db.schools || []).findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const removed = db.schools[idx];
  db.schools.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- app settings (trust-wide config bag) ----------
// Stored as { section, key, value } rows. Read returns a nested object:
// { section: { key: value, ... }, ... }
function settingsFromFile() {
  const db = fileRead();
  return db.appSettings && typeof db.appSettings === "object" ? db.appSettings : {};
}

function mergeSettings(base, overlay) {
  const out = {};
  for (const src of [base || {}, overlay || {}]) {
    for (const section of Object.keys(src)) {
      if (!src[section] || typeof src[section] !== "object") continue;
      if (!out[section]) out[section] = {};
      Object.assign(out[section], src[section]);
    }
  }
  return out;
}

export async function readSettings() {
  const fileSettings = settingsFromFile();
  if (supabaseEnabled) {
    const sel = await supabase.from("app_settings").select("section, key, value");
    if (!sel.error) {
      const cloud = {};
      for (const row of sel.data || []) {
        if (!cloud[row.section]) cloud[row.section] = {};
        cloud[row.section][row.key] = row.value;
      }
      // Cloud wins on conflict; file fills gaps if a save only landed locally.
      return mergeSettings(fileSettings, cloud);
    }
    if (!isSchemaMissError(sel.error)) console.warn(`[db] app_settings fell back: ${sel.error.message}`);
  }
  return fileSettings;
}

export async function writeSettings(patch) {
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
  const rows = [];
  for (const section of Object.keys(patch)) {
    const sectionMap = patch[section] || {};
    if (typeof sectionMap !== "object") continue;
    for (const key of Object.keys(sectionMap)) {
      const raw = sectionMap[key];
      // Persist arrays/objects as JSON (e.g. holidays) instead of "[object Object]".
      const value = raw == null
        ? ""
        : typeof raw === "string"
          ? raw
          : typeof raw === "object"
            ? JSON.stringify(raw)
            : String(raw);
      rows.push({ section, key, value, updated_at: new Date().toISOString() });
    }
  }
  if (supabaseEnabled && rows.length) {
    const up = await supabase.from("app_settings").upsert(rows, { onConflict: "section,key" });
    if (up.error && !isSchemaMissError(up.error)) {
      throw new Error(`Settings could not be saved: ${up.error.message}`);
    }
  }
  const db = fileRead();
  if (!db.appSettings || typeof db.appSettings !== "object") db.appSettings = {};
  for (const row of rows) {
    if (!db.appSettings[row.section]) db.appSettings[row.section] = {};
    db.appSettings[row.section][row.key] = row.value;
  }
  fileWrite(db);
  return readSettings();
}

// ---------- timetable period times (whole-school, admin-managed) ----------
// Period start/end times are a single whole-school setting (not per class).
// Stored under app_settings section "academic", key "periods" as a JSON
// string: [{ period, start: "HH:MM", end: "HH:MM" }]. Nine periods by default.
export const DEFAULT_PERIOD_TIMES = [
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

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Drop malformed rows, then renumber 1..N so the grid is always gap-free.
function sanitizePeriodList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach((row, i) => {
    const period = Number(row?.period) || i + 1;
    const start = String(row?.start || "").trim();
    const end = String(row?.end || "").trim();
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) return;
    out.push({ period, start, end });
  });
  if (!out.length) return null;
  return out
    .sort((a, b) => a.period - b.period)
    .map((r, i) => ({ period: i + 1, start: r.start, end: r.end }));
}

export async function readPeriodTimes() {
  const settings = await readSettings().catch(() => ({}));
  const raw = settings?.academic?.periods;
  if (raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const clean = sanitizePeriodList(parsed);
      if (clean) return clean;
    } catch {}
  }
  return DEFAULT_PERIOD_TIMES;
}

export async function writePeriodTimes(list) {
  const clean = sanitizePeriodList(list);
  if (!clean) throw new Error("Provide at least one period with valid HH:MM start and end times.");
  await writeSettings({ academic: { periods: JSON.stringify(clean) } });
  return clean;
}

// ---------- fee structure + compulsory term-wise seeding ----------
// The school's fee schedule per class number. Stored under app_settings
// section "fees", key "structure" as a JSON string:
//   { perClass: { "<n>": { term1, term2, term3, application, van } } }
// Amounts are whole rupees. Classes with no entry fall back to a legacy
// split of the old annual tuition so the school still sees sane numbers.
const feeNum = (v) => Math.max(0, Math.floor(Number(v) || 0));

export async function getFeeStructure() {
  const settings = await readSettings().catch(() => ({}));
  const raw = settings?.fees?.structure;
  if (!raw) return { perClass: {} };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object") {
      return parsed.perClass ? parsed : { perClass: parsed };
    }
  } catch {}
  return { perClass: {} };
}

export async function setFeeStructure(struct) {
  const src = (struct && struct.perClass) || struct || {};
  const perClass = {};
  for (const k of Object.keys(src)) {
    const n = Number(k);
    if (!n || Number.isNaN(n)) continue;
    const row = src[k] || {};
    perClass[String(n)] = {
      term1: feeNum(row.term1), term2: feeNum(row.term2), term3: feeNum(row.term3),
      application: feeNum(row.application), transport: feeNum(row.transport),
    };
  }
  const next = { perClass };
  await writeSettings({ fees: { structure: JSON.stringify(next) } });
  return next;
}

// Resolve the per-class fee breakdown used when seeding a new student.
export async function resolveClassFees(cls) {
  const n = Number(String(cls).split("-")[0]) || 1;
  const struct = await getFeeStructure();
  const pc = struct.perClass && struct.perClass[String(n)];
  if (pc) {
    return {
      term1: feeNum(pc.term1), term2: feeNum(pc.term2), term3: feeNum(pc.term3),
      application: feeNum(pc.application), transport: feeNum(pc.transport),
    };
  }
  // Legacy fallback: split the old annual tuition (14000 + n*1000) in three.
  const annual = 14000 + n * 1000;
  const t = Math.round(annual / 3);
  return { term1: t, term2: t, term3: annual - 2 * t, application: 0, transport: 0 };
}

// Upsert one pending-fee row by its (composite) id. Throws on a Supabase
// error so a schema mismatch can never silently drop the row — this is the
// "recorded correctly" guarantee (see the 2026-06-01 pending-fees migration,
// which documents how ignored { error } returns lost every imported fee).
async function upsertPendingFeeRow(row) {
  const filled = { ...row, studentId: row.studentId || row.id, feeType: row.feeType || DEFAULT_FEE_TYPE };
  if (supabaseEnabled) {
    const up = await supabase.from("pending_fees").upsert(toPendingFee(filled), { onConflict: "id" });
    if (up.error) throw new Error(`pending_fees upsert failed: ${up.error.message}`);
    return filled;
  }
  const db = fileRead();
  if (!Array.isArray(db.pendingFees)) db.pendingFees = [];
  const idx = db.pendingFees.findIndex((f) => f.id === filled.id);
  if (idx === -1) db.pendingFees.unshift(filled);
  else db.pendingFees[idx] = { ...db.pendingFees[idx], ...filled };
  fileWrite(db);
  return filled;
}

// Which of term1/term2/term3 currently have NO pending row for this student.
async function termFeesMissingFor(studentId) {
  const have = new Set();
  if (supabaseEnabled) {
    const sel = await supabase.from("pending_fees").select("id, fee_type, student_id");
    for (const r of sel.data || []) {
      const sid = r.student_id || String(r.id).split("__")[0];
      if (sid !== studentId) continue;
      have.add(r.fee_type || String(r.id).split("__")[1]);
    }
  } else {
    const db = fileRead();
    for (const f of db.pendingFees || []) {
      const sid = f.studentId || String(f.id).split("__")[0];
      if (sid !== studentId) continue;
      have.add(f.feeType || String(f.id).split("__")[1]);
    }
  }
  return ["term1", "term2", "term3"].filter((t) => !have.has(t));
}

// Create the full term-wise fee record for a student. term1+term2+term3 are
// ALWAYS written (even ₹0) so every student carries a complete three-term
// record; application + van are written only when configured > 0 (van only
// for students who actually have a transport route). All three terms are
// created upfront regardless of join month, then verified before returning.
export async function seedStudentTermFees(student, opts = {}) {
  if (!student?.id) throw new Error("student required");
  const struct = await resolveClassFees(student.cls);
  const due = opts.due || "in 7 days";
  const hasTransport = student.transport && student.transport !== "—";

  // Legacy single-total override (manual admission "fee amount", or a bulk
  // import's per-row annual figure): it becomes Term I, with Term II/III at
  // ₹0 — preserving the quoted total while still recording three term rows.
  let terms;
  const ov = opts.overrideTotal;
  if (ov != null && ov !== "" && Number.isFinite(Number(ov))) {
    terms = { term1: feeNum(ov), term2: 0, term3: 0 };
  } else {
    terms = { term1: struct.term1, term2: struct.term2, term3: struct.term3 };
  }

  const rows = [];
  for (const t of ["term1", "term2", "term3"]) {
    rows.push(await upsertPendingFeeRow({
      id: `${student.id}__${t}`, studentId: student.id, feeType: t,
      name: student.name, cls: student.cls, amount: terms[t] || 0, due, overdue: false,
    }));
  }
  if (struct.application > 0) {
    rows.push(await upsertPendingFeeRow({
      id: `${student.id}__application`, studentId: student.id, feeType: "application",
      name: student.name, cls: student.cls, amount: struct.application, due, overdue: false,
    }));
  }
  if (hasTransport && struct.transport > 0) {
    rows.push(await upsertPendingFeeRow({
      id: `${student.id}__transport`, studentId: student.id, feeType: "transport",
      name: student.name, cls: student.cls, amount: struct.transport, due, overdue: false,
    }));
  }
  const missing = await termFeesMissingFor(student.id);
  if (missing.length) throw new Error(`Term fee recording incomplete for ${student.id}: ${missing.join(", ")}`);
  return rows;
}

// Read-only reconciliation: active students with an incomplete term1/2/3
// pending record. Should be empty once every student is seeded term-wise.
// NOTE: a fully-PAID term moves to receipts and leaves no pending row, so a
// student who has paid a term can surface here — treat this as "needs review",
// not strictly "missing".
export async function studentsMissingTermFees() {
  const all = await readAllData().catch(() => ({}));
  const students = all.addedStudents || all.students || [];
  const out = [];
  for (const s of students) {
    if (!s?.id || s.archivedAt) continue;
    const missing = await termFeesMissingFor(s.id);
    if (missing.length) out.push({ id: s.id, name: s.name, cls: s.cls, missing });
  }
  return out;
}

// Conservative backfill: seed term rows ONLY for students who currently have
// NO term1/2/3 pending row AND no legacy single annual row (id === studentId).
// This avoids double-counting students still on the old single-fee model —
// those should be migrated deliberately, not by this safe pass.
export async function backfillTermFees() {
  const all = await readAllData().catch(() => ({}));
  const students = all.addedStudents || all.students || [];
  const pending = all.pendingFees || [];
  const legacyIds = new Set(pending.filter((f) => f.id && !String(f.id).includes("__")).map((f) => f.id));
  const seeded = [];
  const skipped = [];
  for (const s of students) {
    if (!s?.id || s.archivedAt) continue;
    if (legacyIds.has(s.id)) { skipped.push({ id: s.id, reason: "has legacy single-fee row" }); continue; }
    const missing = await termFeesMissingFor(s.id);
    if (!missing.length) { skipped.push({ id: s.id, reason: "already complete" }); continue; }
    try {
      await seedStudentTermFees(s);
      seeded.push(s.id);
    } catch (e) {
      skipped.push({ id: s.id, reason: e.message || "seed failed" });
    }
  }
  return { seeded, skipped };
}

// Set a student's fee breakdown directly: Term I/II/III + Application +
// Transport. Each supplied value REPLACES that component's outstanding pending
// amount (0 clears the row). Unlike the increase-only annual editor, this is
// the admin's authoritative per-term fee setup, so any amount >= 0 is allowed.
// Returns the saved component amounts and their overall total.
export async function setStudentFeeComponents({ studentId, components, actor = "Staff" }) {
  if (!studentId) throw new Error("studentId required");
  const KEYS = ["term1", "term2", "term3", "application", "transport"];

  let student = null;
  if (supabaseEnabled) {
    const sSel = await supabase.from("students").select("*").eq("id", studentId).maybeSingle();
    if (sSel.data) student = fromStudent(sSel.data);
  }
  if (!student) {
    const db = fileRead();
    student = (db.addedStudents || []).find((s) => s.id === studentId);
  }
  if (!student) throw new Error("Student not found");

  // Absorb any legacy single-fee row (id === studentId, the pre-breakdown
  // model) so it can't double-count alongside the new composite component
  // rows once the admin sets an explicit breakdown.
  if (supabaseEnabled) {
    const del = await supabase.from("pending_fees").delete().eq("id", studentId);
    if (del.error) throw new Error(`legacy fee clear failed: ${del.error.message}`);
  } else {
    const db = fileRead();
    const before = (db.pendingFees || []).length;
    db.pendingFees = (db.pendingFees || []).filter((f) => f.id !== studentId);
    if (db.pendingFees.length !== before) fileWrite(db);
  }

  const saved = {};
  for (const k of KEYS) {
    if (!components || !(k in components)) continue;
    const amt = Math.max(0, Math.floor(Number(components[k]) || 0));
    const rowId = `${studentId}__${k}`;
    if (amt === 0) {
      if (supabaseEnabled) {
        const del = await supabase.from("pending_fees").delete().eq("id", rowId);
        if (del.error) throw new Error(`pending_fees delete failed: ${del.error.message}`);
      } else {
        const db = fileRead();
        db.pendingFees = (db.pendingFees || []).filter((f) => f.id !== rowId);
        fileWrite(db);
      }
    } else {
      await upsertPendingFeeRow({
        id: rowId, studentId, feeType: k,
        name: student.name, cls: student.cls,
        amount: amt, due: "in 7 days", overdue: false,
      });
    }
    saved[k] = amt;
  }

  const overall = Object.values(saved).reduce((s, v) => s + v, 0);

  // Roll the student's fee status forward: any outstanding component → pending.
  if (overall > 0) {
    if (supabaseEnabled) {
      try { await supabase.from("students").update({ fee: "pending" }).eq("id", studentId); } catch {}
    } else {
      const db = fileRead();
      const i = (db.addedStudents || []).findIndex((s) => s.id === studentId);
      if (i !== -1) { db.addedStudents[i].fee = "pending"; fileWrite(db); }
    }
  }

  try {
    await logAudit(
      actor,
      "Set fee breakdown",
      `${studentId} · ${Object.keys(saved).map((k) => `${k} ₹${saved[k].toLocaleString("en-IN")}`).join(" · ")}`
    );
  } catch {}

  return { studentId, components: saved, overall };
}

// ---------- documents ----------
// Generic document attachment — entity can be "student" | "staff" | "volunteer"
// | "tc". File bytes are stored as base64 data-URLs in db.json. Good enough for
// demo-sized files (< 2MB); swap to object storage in prod.
export async function addDocument({ entityType, entityId, label, fileName, mimeType, dataUrl, uploadedBy }) {
  if (!entityType || !entityId) throw new Error("entityType + entityId required");
  if (!fileName || !dataUrl) throw new Error("fileName + dataUrl required");
  const now = new Date();
  const doc = {
    id: `DOC-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    entityType, entityId,
    label: label || fileName,
    fileName,
    mimeType: mimeType || "application/octet-stream",
    dataUrl,
    sizeBytes: dataUrl.length,
    uploadedBy: uploadedBy || "unknown",
    uploadedAt: now.toISOString(),
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("documents").insert(toDocument(doc)).select().single();
    if (!ins.error) return fromDocument(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.documents)) db.documents = [];
  db.documents.unshift(doc);
  fileWrite(db);
  return doc;
}

export async function listDocuments({ entityType, entityId } = {}) {
  if (supabaseEnabled) {
    // Strip the heavy `data_url` column — download endpoint serves it.
    let q = supabase.from("documents")
      .select("id, entity_type, entity_id, label, file_name, mime_type, size_bytes, uploaded_by, uploaded_at")
      .order("uploaded_at", { ascending: false });
    if (entityType) q = q.eq("entity_type", entityType);
    if (entityId)   q = q.eq("entity_id", entityId);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromDocument);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] documents fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  const all = Array.isArray(db.documents) ? db.documents : [];
  if (!entityType) return all.map(stripBlob);
  return all.filter((d) => d.entityType === entityType && (!entityId || d.entityId === entityId)).map(stripBlob);
}

// Public listing strips the heavy `dataUrl` field — download endpoint serves it.
function stripBlob({ dataUrl, ...rest }) { return rest; }

export async function getDocument(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("documents").select("*").eq("id", id).maybeSingle();
    if (sel.data) return fromDocument(sel.data);
    if (sel.error && !isSchemaMissError(sel.error)) console.warn(`[db] document fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return (db.documents || []).find((d) => d.id === id) || null;
}

export async function removeDocument(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("documents").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("documents").delete().eq("id", id);
      return stripBlob(fromDocument(sel.data));
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.documents)) db.documents = [];
  const idx = db.documents.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const removed = db.documents[idx];
  db.documents.splice(idx, 1);
  fileWrite(db);
  return stripBlob(removed);
}

// ---------- tasks ----------
// Lightweight assignment system. Admin creates tasks, picks a single staff
// user as the assignee; the assignee answers Yes/No with remarks.
const TASK_STATUSES = ["pending", "in_progress", "done"];
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
const TASK_RESPONSES = ["yes", "no"];

function fileTasksSafe() {
  try {
    const db = fileRead();
    return Array.isArray(db.tasks) ? db.tasks : [];
  } catch { return []; }
}

function taskResponseOverlaysSafe() {
  try {
    const db = fileRead();
    return (db.taskResponseOverlays && typeof db.taskResponseOverlays === "object")
      ? db.taskResponseOverlays : {};
  } catch { return {}; }
}

function saveTaskResponseOverlay(id, patch) {
  if (!id) return;
  const db = fileRead();
  if (!db.taskResponseOverlays || typeof db.taskResponseOverlays !== "object") db.taskResponseOverlays = {};
  db.taskResponseOverlays[id] = {
    ...(db.taskResponseOverlays[id] || {}),
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    updatedAt: new Date().toISOString(),
  };
  fileWrite(db);
}

function mergeTaskResponseOverlays(tasks) {
  const overlays = taskResponseOverlaysSafe();
  if (!overlays || !Object.keys(overlays).length) return tasks;
  return tasks.map((t) => {
    const o = overlays[t.id];
    if (!o) return t;
    return {
      ...t,
      // Overlay wins when set — covers DBs that lack response/remarks columns.
      response: o.response !== undefined ? o.response : t.response,
      remarks: o.remarks !== undefined ? o.remarks : t.remarks,
      status: o.status || t.status,
    };
  });
}

export async function listTasks(filter = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("tasks").select("*").order("created_at", { ascending: false });
    if (filter.assignedTo) q = q.eq("assigned_to", filter.assignedTo);
    const sel = await q;
    if (!sel.error) {
      const rows = mergeTaskResponseOverlays((sel.data || []).map(fromTask));
      return rows;
    }
    if (!isSchemaMissError(sel.error)) console.warn(`[db] tasks fell back: ${sel.error.message}`);
  }
  const all = mergeTaskResponseOverlays(fileTasksSafe());
  if (filter.assignedTo) return all.filter((t) => t.assignedTo === filter.assignedTo);
  return all;
}

export async function addTask({ title, description, assignedTo, assignedToName, assignedToRole, assignedBy, assignedByName, priority, dueDate }) {
  const t = String(title || "").trim();
  if (!t) throw new Error("Task title is required");
  if (!assignedTo) throw new Error("assignedTo (user id) is required");
  if (assignedToRole === "parent") throw new Error("Tasks cannot be assigned to parents");
  const now = new Date();
  const task = {
    id: `TSK-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    title: t,
    description: String(description || "").trim() || null,
    assignedTo,
    assignedToName: assignedToName || "—",
    assignedToRole: assignedToRole || "staff",
    assignedBy: assignedBy || null,
    assignedByName: assignedByName || "Admin",
    status: "pending",
    priority: TASK_PRIORITIES.includes(priority) ? priority : "normal",
    dueDate: dueDate || null,
    response: null,
    remarks: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (supabaseEnabled) {
    let payload = toTask(task);
    let ins = await supabase.from("tasks").insert(payload).select().single();
    // Older DBs may lack response/remarks — strip and retry once.
    if (ins.error && /Could not find the '(response|remarks)' column/i.test(ins.error.message)) {
      const retry = { ...payload };
      delete retry.response;
      delete retry.remarks;
      ins = await supabase.from("tasks").insert(retry).select().single();
    }
    if (!ins.error) return { ...fromTask(ins.data), response: task.response, remarks: task.remarks };
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.tasks)) db.tasks = [];
  db.tasks.unshift(task);
  fileWrite(db);
  return task;
}

export async function updateTask(id, patch = {}) {
  if (!id) throw new Error("id required");
  // Yes/No answer drives status so staff-performance "done" counts stay correct.
  if (patch.response === "yes") patch = { ...patch, status: "done" };
  else if (patch.response === "no") patch = { ...patch, status: "pending" };

  // Always mirror Yes/No + remarks to a file overlay so Super Admin sees the
  // update even when the live Supabase schema is missing those columns.
  const overlayPatch = {};
  if (patch.response === null || TASK_RESPONSES.includes(patch.response)) {
    overlayPatch.response = patch.response ?? null;
  }
  if (typeof patch.remarks === "string") overlayPatch.remarks = patch.remarks.trim() || null;
  if (patch.status && TASK_STATUSES.includes(patch.status)) overlayPatch.status = patch.status;
  if (Object.keys(overlayPatch).length) saveTaskResponseOverlay(id, overlayPatch);

  if (supabaseEnabled) {
    const sel = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const upd = { updated_at: new Date().toISOString() };
      if (patch.status && TASK_STATUSES.includes(patch.status)) upd.status = patch.status;
      if (typeof patch.title === "string" && patch.title.trim()) upd.title = patch.title.trim();
      if (typeof patch.description === "string") upd.description = patch.description.trim() || null;
      if (TASK_PRIORITIES.includes(patch.priority)) upd.priority = patch.priority;
      if (typeof patch.dueDate === "string") upd.due_date = patch.dueDate || null;
      if (patch.response === null || TASK_RESPONSES.includes(patch.response)) upd.response = patch.response ?? null;
      if (typeof patch.remarks === "string") upd.remarks = patch.remarks.trim() || null;
      let r = await supabase.from("tasks").update(upd).eq("id", id).select().single();
      // Older DBs may not have response/remarks yet — drop and retry; overlay
      // already holds the answer for listTasks merges.
      if (r.error && /Could not find the '(response|remarks)' column/i.test(r.error.message)) {
        const retry = { ...upd };
        delete retry.response;
        delete retry.remarks;
        r = await supabase.from("tasks").update(retry).eq("id", id).select().single();
      }
      if (!r.error) {
        const base = fromTask(r.data);
        return mergeTaskResponseOverlays([base])[0];
      }
      if (!isSchemaMissError(r.error)) throw new Error(r.error.message);
    } else if (sel.error && !isSchemaMissError(sel.error)) {
      throw new Error(sel.error.message);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.tasks)) db.tasks = [];
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    // Task may live only in Supabase; still return overlay-merged stub if we
    // at least wrote the answer.
    if (Object.keys(overlayPatch).length) {
      return { id, ...overlayPatch, status: overlayPatch.status || "pending" };
    }
    return null;
  }
  const next = { ...db.tasks[idx] };
  if (patch.status && TASK_STATUSES.includes(patch.status)) next.status = patch.status;
  if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim();
  if (typeof patch.description === "string") next.description = patch.description.trim() || null;
  if (TASK_PRIORITIES.includes(patch.priority)) next.priority = patch.priority;
  if (typeof patch.dueDate === "string") next.dueDate = patch.dueDate || null;
  if (patch.response === null || TASK_RESPONSES.includes(patch.response)) next.response = patch.response ?? null;
  if (typeof patch.remarks === "string") next.remarks = patch.remarks.trim() || null;
  next.updatedAt = new Date().toISOString();
  db.tasks[idx] = next;
  fileWrite(db);
  return next;
}

export async function removeTask(id) {
  if (!id) return null;
  if (supabaseEnabled) {
    const sel = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("tasks").delete().eq("id", id);
      return fromTask(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.tasks)) db.tasks = [];
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const removed = db.tasks[idx];
  db.tasks.splice(idx, 1);
  fileWrite(db);
  return removed;
}

function safeArr(key) {
  try {
    const db = fileRead();
    return Array.isArray(db[key]) ? db[key] : [];
  } catch { return []; }
}

// Side-store for daily-log fields that don't yet exist in the Supabase
// schema (classwork_status, homework_status, …). Keyed by `${studentId}|${date}`.
function dailyLogOverlayKey(studentId, date) { return `${studentId}|${date}`; }
function saveDailyLogOverlay(studentId, date, patch) {
  if (!studentId || !date || !patch) return;
  const db = fileRead();
  if (!db.dailyLogOverlays || typeof db.dailyLogOverlays !== "object") db.dailyLogOverlays = {};
  const key = dailyLogOverlayKey(studentId, date);
  db.dailyLogOverlays[key] = { ...(db.dailyLogOverlays[key] || {}), ...stripNullish(patch) };
  fileWrite(db);
}
function readDailyLogOverlay(studentId, date) {
  try {
    const db = fileRead();
    return (db.dailyLogOverlays && db.dailyLogOverlays[dailyLogOverlayKey(studentId, date)]) || null;
  } catch { return null; }
}
// Layer the side-store overlay onto each Supabase-backed daily log so the UI
// sees fields (classworkStatus, homeworkStatus, attendance, leaveReason) that
// the schema may not have yet.
function applyDailyLogOverlays(logs) {
  const overlays = dailyLogOverlaysSafe();
  if (!overlays || Object.keys(overlays).length === 0) return logs;
  return (logs || []).map((l) => {
    const o = overlays[`${l.studentId}|${l.date}`];
    return o ? { ...l, ...stripNullish(o) } : l;
  });
}

function dailyLogOverlaysSafe() {
  try {
    const db = fileRead();
    return (db.dailyLogOverlays && typeof db.dailyLogOverlays === "object") ? db.dailyLogOverlays : {};
  } catch { return {}; }
}
function stripNullish(obj) {
  if (!obj) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function fileTcRequestsSafe() {
  try {
    const db = fileRead();
    return Array.isArray(db.tcRequests) ? db.tcRequests : [];
  } catch { return []; }
}

function fileMaintenanceLogsSafe() {
  try {
    const db = fileRead();
    return Array.isArray(db.maintenanceLogs) ? db.maintenanceLogs : [];
  } catch { return []; }
}

function fileExpensesSafe() {
  try {
    const db = fileRead();
    return Array.isArray(db.expenses) ? db.expenses : [];
  } catch { return []; }
}

// Merge Supabase + file-store expenses, deduping by id so a row that
// exists in both backends only counts once on the Money Control KPIs.
async function mergeExpenses() {
  const map = new Map();
  let cloud = [];
  try { cloud = await listExpenses(); } catch {}
  for (const r of cloud) if (r?.id && !map.has(r.id)) map.set(r.id, r);
  for (const r of fileExpensesSafe()) if (r?.id && !map.has(r.id)) map.set(r.id, r);
  return Array.from(map.values());
}

// Same pattern for donor receipts — Money Control's donation income line
// reads these, so a missed cloud row used to silently undercount donations.
async function mergeDonorReceipts() {
  const map = new Map();
  let cloud = [];
  try { cloud = await listDonorReceipts(); } catch {}
  for (const r of cloud) if (r?.id && !map.has(r.id)) map.set(r.id, r);
  for (const r of fileDonorReceiptsSafe()) if (r?.id && !map.has(r.id)) map.set(r.id, r);
  return Array.from(map.values());
}

// Same pattern for TC requests — the Students screen looks at this list to
// stamp the "TC approved / issued" chip; without the cloud read, the chip
// stayed off whenever the TC update went to Supabase.
async function mergeTcRequests() {
  const map = new Map();
  let cloud = [];
  try { cloud = await listTcRequests(); } catch {}
  for (const r of cloud) if (r?.id && !map.has(r.id)) map.set(r.id, r);
  for (const r of fileTcRequestsSafe()) if (r?.id && !map.has(r.id)) map.set(r.id, r);
  return Array.from(map.values());
}

function rolePermissionsSafe() {
  try {
    const db = fileRead();
    return db.rolePermissions && typeof db.rolePermissions === "object" ? db.rolePermissions : {};
  } catch { return {}; }
}

function fileDonorReceiptsSafe() {
  try {
    const data = fileRead();
    return Array.isArray(data.donorReceipts) ? data.donorReceipts : [];
  } catch { return []; }
}

function fileDonorsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.donors) ? data.donors : [];
  } catch { return []; }
}

function fileCampaignsSafe() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.campaigns) ? data.campaigns : [];
  } catch { return []; }
}

// ---------- donors ----------
const DONOR_TYPES = ["CSR", "Trust", "Individual", "Alumni"];
export async function addDonor(row) {
  const id = row.id || `DON-${1000 + Math.floor(Math.random() * 8999)}`;
  const openingYtd = Math.max(0, Number(row.ytd) || 0);
  const filled = {
    id,
    name: String(row.name || "").trim(),
    type: DONOR_TYPES.includes(row.type) ? row.type : "Individual",
    email: row.email || null,
    phone: row.phone || null,
    ytd: openingYtd,
    // If they entered an opening YTD, surface it on the row right away so the
    // "Last gift" column doesn't look empty.
    last: row.last || (openingYtd > 0
      ? `${openingYtd >= 100000 ? `₹${(openingYtd / 100000).toFixed(2)}L` : `₹${openingYtd.toLocaleString("en-IN")}`} · ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`
      : null),
    next: row.next || null,
  };
  if (!filled.name) throw new Error("Donor name is required");
  if (supabaseEnabled) {
    const ins = await supabase.from("donors").insert(toDonor(filled)).select().single();
    if (ins.error) {
      if (/donor/i.test(ins.error.message)) {
        const created = fileAddDonor(filled);
        if (openingYtd > 0) writeOpeningReceipt(created, openingYtd);
        return created;
      }
      throw new Error(ins.error.message);
    }
    const created = fromDonor(ins.data);
    if (openingYtd > 0) writeOpeningReceipt(created, openingYtd);
    return created;
  }
  const created = fileAddDonor(filled);
  if (openingYtd > 0) writeOpeningReceipt(created, openingYtd);
  return created;
}

function fileAddDonor(filled) {
  const db = fileRead();
  if (!Array.isArray(db.donors)) db.donors = [];
  db.donors.unshift(filled);
  fileWrite(db);
  return filled;
}

// Auto-receipt for the opening YTD entered when adding a donor. Mirrors the
// shape produced by recordDonation() so the same UI / CSV / print code works.
function writeOpeningReceipt(donor, amount) {
  const now = new Date();
  const receipt = {
    id: `RDP-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    donorId: donor.id,
    donorName: donor.name,
    donorType: donor.type,
    amount,
    method: "Opening balance",
    memo: "Initial contribution recorded at donor onboarding",
    campaignId: null,
    issuedAt: now.toISOString(),
    issuedAtLabel: now.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
  };
  if (supabaseEnabled) {
    supabase.from("donor_receipts").insert(toDonorReceipt(receipt)).then(({ error }) => {
      if (error && !isSchemaMissError(error)) console.warn(`[db] donor_receipts insert failed: ${error.message}`);
    });
  }
  const db = fileRead();
  if (!Array.isArray(db.donorReceipts)) db.donorReceipts = [];
  db.donorReceipts.unshift(receipt);
  fileWrite(db);
  return receipt;
}

// Record a fresh donation against an existing donor. Bumps the donor's YTD,
// updates their `last gift` line, and persists a unique 80G-style receipt in
// db.donorReceipts (file-only — no Supabase table needed). Returns
// { donor, receipt } so the caller can show the receipt straight away.
export async function recordDonation(donorId, { amount, method, memo, campaignId } = {}) {
  if (!donorId) throw new Error("donorId is required");
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  if (!amt) throw new Error("Donation amount must be greater than zero");

  // Find the donor across whichever backend has it.
  let donor = null;
  let backend = "file";
  if (supabaseEnabled) {
    const sel = await supabase.from("donors").select("*").eq("id", donorId).maybeSingle();
    if (sel.data) { donor = fromDonor(sel.data); backend = "supabase"; }
  }
  if (!donor) {
    const db = fileRead();
    const found = (db.donors || []).find((d) => d.id === donorId);
    if (found) { donor = found; backend = "file"; }
  }
  if (!donor) throw new Error("Donor not found");

  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const niceAmount = amt >= 100000 ? `₹${(amt / 100000).toFixed(2)}L` : `₹${amt.toLocaleString("en-IN")}`;
  const receipt = {
    id: `RDP-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    donorId: donor.id,
    donorName: donor.name,
    donorType: donor.type,
    amount: amt,
    method: method || "Bank transfer",
    memo: memo || "",
    campaignId: campaignId || null,
    issuedAt: now.toISOString(),
    issuedAtLabel: now.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
  };

  // Bump YTD + update last-gift label on the donor record.
  const newYtd = (Number(donor.ytd) || 0) + amt;
  const newLast = `${niceAmount} · ${dateLabel}`;
  if (backend === "supabase") {
    const upd = await supabase.from("donors")
      .update({ ytd: newYtd, last: newLast })
      .eq("id", donor.id);
    if (upd.error) console.warn(`[db] donor update fell back: ${upd.error.message}`);
  }
  // Persist the receipt to Supabase too.
  if (supabaseEnabled) {
    const ins = await supabase.from("donor_receipts").insert(toDonorReceipt(receipt));
    if (ins.error && !isSchemaMissError(ins.error)) console.warn(`[db] donor_receipts insert failed: ${ins.error.message}`);
  }

  // Mirror to the file copy regardless — keeps receipts and totals in one place.
  const db = fileRead();
  if (!Array.isArray(db.donors)) db.donors = [];
  const fIdx = db.donors.findIndex((d) => d.id === donor.id);
  if (fIdx === -1) db.donors.unshift({ ...donor, ytd: newYtd, last: newLast });
  else db.donors[fIdx] = { ...db.donors[fIdx], ytd: newYtd, last: newLast };
  if (!Array.isArray(db.donorReceipts)) db.donorReceipts = [];
  db.donorReceipts.unshift(receipt);
  fileWrite(db);

  return { donor: { ...donor, ytd: newYtd, last: newLast }, receipt };
}

export async function listDonorReceipts() {
  if (supabaseEnabled) {
    const sel = await supabase.from("donor_receipts").select("*").order("issued_at", { ascending: false });
    if (!sel.error) return (sel.data || []).map(fromDonorReceipt);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] donor_receipts fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return Array.isArray(db.donorReceipts) ? db.donorReceipts : [];
}

export async function archiveDonor(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("donors").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      let upd = await supabase.from("donors")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
      if (upd.error && /archived_at/.test(upd.error.message)) {
        await supabase.from("donors").delete().eq("id", id);
      }
      return fromDonor(sel.data);
    }
  }
  const db = fileRead();
  const idx = (db.donors || []).findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const removed = db.donors[idx];
  db.donors.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- campaigns ----------
export async function addCampaign(row) {
  const id = row.id || `CMP-${Date.now().toString(36).toUpperCase()}`;
  const filled = {
    id,
    name: String(row.name || "").trim(),
    goal: Math.max(0, Number(row.goal) || 0),
    raised: Math.max(0, Number(row.raised) || 0),
    starts: row.starts || null,
    ends: row.ends || null,
    status: ["active", "completed", "paused"].includes(row.status) ? row.status : "active",
    description: row.description || null,
  };
  if (!filled.name) throw new Error("Campaign name is required");
  if (filled.goal <= 0) throw new Error("Set a fundraising goal greater than 0");
  if (supabaseEnabled) {
    const ins = await supabase.from("campaigns").insert(toCampaign(filled)).select().single();
    if (ins.error) {
      if (/campaign/i.test(ins.error.message)) return fileAddCampaign(filled);
      throw new Error(ins.error.message);
    }
    return fromCampaign(ins.data);
  }
  return fileAddCampaign(filled);
}

function fileAddCampaign(filled) {
  const db = fileRead();
  if (!Array.isArray(db.campaigns)) db.campaigns = [];
  db.campaigns.unshift(filled);
  fileWrite(db);
  return filled;
}

// ---------- communication ----------
// addBroadcast records the campaign + counts. We don't have a real WhatsApp/SMS
// gateway wired up yet, so the "delivered" count is just the audience size; in
// production a webhook would update it after Gupshup/Twilio reports back.
export async function addBroadcast(row) {
  const id = `BC-${Date.now().toString(36).toUpperCase()}`;
  const filled = {
    id,
    campaign: String(row.campaign || "").trim() || "Manual broadcast",
    channel: ["whatsapp", "sms", "both", "in_app"].includes(row.channel) ? row.channel : "whatsapp",
    audience: row.audience || "all",
    audienceLabel: row.audienceLabel || row.audience || "All parents",
    message: row.message || "",
    sent: Number(row.sent) || 0,
    delivered: Number(row.delivered) || Number(row.sent) || 0,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("broadcasts").insert(toBroadcast(filled)).select().single();
    if (ins.error) {
      if (/broadcast/i.test(ins.error.message)) return fileAddBroadcast(filled);
      throw new Error(ins.error.message);
    }
    return fromBroadcast(ins.data);
  }
  return fileAddBroadcast(filled);
}

function fileAddBroadcast(filled) {
  const db = fileRead();
  if (!Array.isArray(db.broadcasts)) db.broadcasts = [];
  db.broadcasts.unshift({ ...filled, sentAt: new Date().toISOString() });
  if (db.broadcasts.length > 200) db.broadcasts.length = 200;
  fileWrite(db);
  return db.broadcasts[0];
}

export async function addTemplate(row) {
  const id = `TPL-${Date.now().toString(36).toUpperCase()}`;
  const filled = {
    id,
    name: String(row.name || "").trim(),
    channel: ["whatsapp", "sms", "both", "in_app"].includes(row.channel) ? row.channel : "whatsapp",
    body: String(row.body || "").trim(),
  };
  if (!filled.name) throw new Error("Template name required");
  if (!filled.body) throw new Error("Template body required");
  if (supabaseEnabled) {
    const ins = await supabase.from("message_templates").insert(toTemplate(filled)).select().single();
    if (ins.error) {
      if (/template|message_templates/i.test(ins.error.message)) return fileAddTemplate(filled);
      throw new Error(ins.error.message);
    }
    return fromTemplate(ins.data);
  }
  return fileAddTemplate(filled);
}

function fileAddTemplate(filled) {
  const db = fileRead();
  if (!Array.isArray(db.templates)) db.templates = [];
  db.templates.unshift(filled);
  fileWrite(db);
  return filled;
}

export async function removeTemplate(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("message_templates").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("message_templates").delete().eq("id", id);
      return fromTemplate(sel.data);
    }
  }
  const db = fileRead();
  const idx = (db.templates || []).findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const removed = db.templates[idx];
  db.templates.splice(idx, 1);
  fileWrite(db);
  return removed;
}

export async function addRecipientList(row) {
  const id = `LIST-${Date.now().toString(36).toUpperCase()}`;
  const filled = {
    id,
    name: String(row.name || "").trim() || "Imported list",
    contacts: Array.isArray(row.contacts) ? row.contacts : [],
  };
  if (filled.contacts.length === 0) throw new Error("List has no valid contacts");
  if (supabaseEnabled) {
    const ins = await supabase.from("recipient_lists").insert(filled).select().single();
    if (ins.error) {
      if (/recipient_list/i.test(ins.error.message)) return fileAddRecipientList(filled);
      throw new Error(ins.error.message);
    }
    return fromRecipientList(ins.data);
  }
  return fileAddRecipientList(filled);
}

function fileAddRecipientList(filled) {
  const db = fileRead();
  if (!Array.isArray(db.recipientLists)) db.recipientLists = [];
  db.recipientLists.unshift(filled);
  fileWrite(db);
  return filled;
}

// ---------- inventory ----------
// Parse Indian-style amounts: "61,500", "3,36,756", "595(per.pcs)", "100(each)".
function parseInventoryNumber(raw) {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const cleaned = s.replace(/,/g, "").replace(/[^\d.-].*$/, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function slugInventoryCategory(raw) {
  const s = String(raw || "asset").trim().toLowerCase().slice(0, 48);
  return s.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function normalizeStockId(raw) {
  const id = String(raw || "").trim().toUpperCase();
  if (!id) return null;
  // Prefer school register IDs like SIS-001; also allow INV-… custom ids.
  if (/^[A-Z]{2,8}-\d+[A-Z]?$/i.test(id)) return id;
  return null;
}

export async function addInventoryItem(row) {
  const customId = normalizeStockId(row.id || row.stockId);
  const id = customId || `INV-${1000 + Math.floor(Math.random() * 8999)}`;
  const onHand = Math.max(0, parseInventoryNumber(row.onHand));
  const qtyPurchasedRaw = row.qtyPurchased != null && row.qtyPurchased !== ""
    ? parseInventoryNumber(row.qtyPurchased)
    : null;
  // Balance is source of truth; if purchased omitted, default to balance
  // (matches Excel rows where Purchased ≈ Balance and Issued is blank).
  const qtyPurchased = Math.max(0, qtyPurchasedRaw != null ? qtyPurchasedRaw : onHand);
  const issued = Math.max(0, parseInventoryNumber(row.issued));
  let unitPrice = Math.max(0, parseInventoryNumber(row.unitPrice));
  const totalCost = parseInventoryNumber(row.totalCost);
  if (!unitPrice && totalCost > 0 && qtyPurchased > 0) {
    unitPrice = Math.round((totalCost / qtyPurchased) * 100) / 100;
  }
  const filled = {
    id,
    name: String(row.name || "").trim(),
    category: slugInventoryCategory(row.category),
    cls: row.cls || null,
    description: String(row.description || "").trim() || "",
    storageLocation: String(row.storageLocation || "").trim() || "",
    onHand,
    min: Math.max(0, parseInventoryNumber(row.min)),
    issued,
    qtyPurchased,
    unitPrice,
    supplier: row.supplier ? String(row.supplier).trim() : null,
    remarks: String(row.remarks || "").trim() || "",
  };
  if (!filled.name) throw new Error("Item name is required");

  let saved;
  if (supabaseEnabled) {
    let payload = toInventory(filled);
    let ins = await supabase.from("inventory").insert(payload).select().single();
    // Older DBs may lack new columns — retry without them.
    if (ins.error && /(description|storage_location|qty_purchased|remarks)/i.test(ins.error.message)) {
      const { description, storage_location, qty_purchased, remarks, ...legacy } = payload;
      ins = await supabase.from("inventory").insert(legacy).select().single();
    }
    if (ins.error) {
      if (/duplicate|unique/i.test(ins.error.message) && customId) {
        // SIS-005 appeared twice in the sheet — suffix and retry once.
        filled.id = `${customId}B`;
        payload = toInventory(filled);
        ins = await supabase.from("inventory").insert(payload).select().single();
      }
      if (ins.error) {
        if (/inventory/i.test(ins.error.message)) {
          saved = fileAddInventory(filled);
        } else {
          throw new Error(ins.error.message);
        }
      } else {
        saved = fromInventory(ins.data);
      }
    } else {
      saved = fromInventory(ins.data);
    }
  } else {
    saved = fileAddInventory(filled);
  }

  // Cascade: if the item carries a cost, log a matching expense so the
  // money screen sees inventory purchases as part of school spend. Best
  // effort — failures don't fail the inventory write.
  //
  // skipExpenseCascade is set by the reverse flow (Add Expense modal with
  // "Also track in inventory" ticked) where the caller is creating the
  // expense itself and only wants the inventory row — without it we'd
  // double-book the same purchase.
  if (!row.skipExpenseCascade) {
    await maybeLogInventoryExpense(saved, row.recordedBy, saved.qtyPurchased || saved.onHand);
  }

  // Mirror remarks into the override map so they show for Supabase-hosted items
  // even before the `remarks` column migration is applied.
  if (filled.remarks && !(saved.remarks && String(saved.remarks).trim())) {
    try {
      const db = fileRead();
      if (!db.inventoryRemarks || typeof db.inventoryRemarks !== "object") db.inventoryRemarks = {};
      db.inventoryRemarks[saved.id] = filled.remarks;
      fileWrite(db);
    } catch {}
    saved.remarks = filled.remarks;
  }

  return saved;
}

// Edit an existing item's editable fields (Remarks, Rate, Reorder, Supplier,
// etc.). Resilient to DBs that don't yet have the `remarks` column — the write
// retries without it and still updates the other fields + the file mirror.
const INVENTORY_EDITABLE = {
  name: "name", category: "category", description: "description",
  storageLocation: "storage_location", supplier: "supplier",
  min: "min", unitPrice: "unit_price", remarks: "remarks",
};
export async function updateInventoryItem({ id, ...patch }) {
  if (!id) throw new Error("id required");

  // Build the snake_case DB body + a camelCase mirror for the file store.
  const body = {};
  const camelPatch = {};
  for (const [camel, col] of Object.entries(INVENTORY_EDITABLE)) {
    if (patch[camel] === undefined) continue;
    let v = patch[camel];
    if (camel === "min" || camel === "unitPrice") v = Math.max(0, parseInventoryNumber(v));
    else if (typeof v === "string") v = v.trim();
    camelPatch[camel] = v;
    body[col] = v === "" ? null : v;
  }
  if (Object.keys(body).length === 0) throw new Error("Nothing to update");

  let saved = null;
  if (supabaseEnabled) {
    let upd = await supabase.from("inventory").update(body).eq("id", id).select().single();
    // Retry without columns the DB may not have yet (remarks/newer fields).
    if (upd.error && /(remarks|storage_location|unit_price|description)/i.test(upd.error.message)) {
      const stripped = { ...body };
      ["remarks", "storage_location", "unit_price", "description"].forEach((c) => delete stripped[c]);
      upd = Object.keys(stripped).length
        ? await supabase.from("inventory").update(stripped).eq("id", id).select().single()
        : { data: null, error: null };
    }
    if (upd.error && !/inventory/i.test(upd.error.message)) throw new Error(upd.error.message);
    if (upd.data) saved = fromInventory(upd.data);
  }

  // Mirror to the file store (also the sole path when Supabase is off).
  const db = fileRead();
  let touched = false;
  if (Array.isArray(db.inventory)) {
    const i = db.inventory.findIndex((r) => r.id === id);
    if (i !== -1) {
      db.inventory[i] = { ...db.inventory[i], ...camelPatch };
      touched = true;
      if (!saved) saved = db.inventory[i];
    }
  }
  // Persist remarks into the override map so they survive for Supabase-hosted
  // items even before the `remarks` column migration is applied.
  if (camelPatch.remarks !== undefined) {
    if (!db.inventoryRemarks || typeof db.inventoryRemarks !== "object") db.inventoryRemarks = {};
    const v = String(camelPatch.remarks || "").trim();
    if (v) db.inventoryRemarks[id] = v; else delete db.inventoryRemarks[id];
    touched = true;
  }
  if (touched) fileWrite(db);

  if (saved) return { ...saved, ...camelPatch };
  return { id, ...camelPatch };
}

// Build one inventory row object without writing (used by bulk import).
function buildInventoryItem(row, usedIds) {
  const customId = normalizeStockId(row.id || row.stockId);
  let id = customId || `INV-${1000 + Math.floor(Math.random() * 8999)}`;
  if (usedIds.has(id)) {
    if (customId) {
      let n = 2;
      let candidate = `${customId}B`;
      while (usedIds.has(candidate)) {
        n += 1;
        candidate = `${customId}${String.fromCharCode(64 + n)}`; // C, D, …
      }
      id = candidate;
    } else {
      while (usedIds.has(id)) id = `INV-${1000 + Math.floor(Math.random() * 8999)}`;
    }
  }
  usedIds.add(id);

  const onHand = Math.max(0, parseInventoryNumber(row.onHand));
  const qtyPurchasedRaw = row.qtyPurchased != null && row.qtyPurchased !== ""
    ? parseInventoryNumber(row.qtyPurchased)
    : null;
  const qtyPurchased = Math.max(0, qtyPurchasedRaw != null ? qtyPurchasedRaw : onHand);
  const issued = Math.max(0, parseInventoryNumber(row.issued));
  let unitPrice = Math.max(0, parseInventoryNumber(row.unitPrice));
  const totalCost = parseInventoryNumber(row.totalCost);
  if (!unitPrice && totalCost > 0 && qtyPurchased > 0) {
    unitPrice = Math.round((totalCost / qtyPurchased) * 100) / 100;
  }
  const name = String(row.name || "").trim();
  if (!name) return null;
  return {
    id,
    name,
    category: slugInventoryCategory(row.category),
    cls: row.cls || "all",
    description: String(row.description || "").trim() || "",
    storageLocation: String(row.storageLocation || "").trim() || "",
    onHand,
    min: Math.max(0, parseInventoryNumber(row.min)),
    issued,
    qtyPurchased,
    unitPrice,
    supplier: row.supplier ? String(row.supplier).trim() : null,
  };
}

// Fast path for Excel import: one (or few) batch inserts instead of N round-trips.
export async function bulkAddInventoryItems(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const usedIds = new Set();
  const filled = [];
  const errors = [];
  const catsSeen = new Set();

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== "object") {
      errors.push({ row: i + 1, reason: "not an object" });
      continue;
    }
    try {
      const item = buildInventoryItem(row, usedIds);
      if (!item) {
        // Blank name — skip quietly (Excel sheets often have hundreds of empty rows).
        continue;
      }
      filled.push({ item, row: i + 1 });
      if (item.category) catsSeen.add(item.category);
    } catch (e) {
      errors.push({ row: i + 1, reason: e.message || "Invalid row" });
    }
  }

  if (!filled.length) {
    return { imported: [], errors, categories: [...catsSeen] };
  }

  const imported = [];

  if (supabaseEnabled) {
    const CHUNK = 100;
    let useLegacy = false;
    for (let i = 0; i < filled.length; i += CHUNK) {
      const chunk = filled.slice(i, i + CHUNK);
      let payloads = chunk.map(({ item }) => toInventory(item));
      if (useLegacy) {
        payloads = payloads.map(({ description, storage_location, qty_purchased, ...rest }) => rest);
      }
      let ins = await supabase.from("inventory").insert(payloads).select("id, name, category");
      if (ins.error && !useLegacy && /(description|storage_location|qty_purchased)/i.test(ins.error.message)) {
        useLegacy = true;
        payloads = chunk.map(({ item }) => {
          const full = toInventory(item);
          const { description, storage_location, qty_purchased, ...rest } = full;
          return rest;
        });
        ins = await supabase.from("inventory").insert(payloads).select("id, name, category");
      }
      if (ins.error) {
        // Fall back to per-row for this chunk so one bad id doesn't kill the batch.
        for (const { item, row } of chunk) {
          try {
            const saved = await addInventoryItem({ ...item, skipExpenseCascade: true });
            imported.push({ row, id: saved.id, name: saved.name });
          } catch (e) {
            errors.push({ row, reason: e.message || "Failed to add" });
          }
        }
      } else {
        const data = ins.data || [];
        for (let j = 0; j < chunk.length; j++) {
          const saved = data[j];
          imported.push({
            row: chunk[j].row,
            id: saved?.id || chunk[j].item.id,
            name: saved?.name || chunk[j].item.name,
          });
        }
      }
    }
  } else {
    const db = fileRead();
    if (!Array.isArray(db.inventory)) db.inventory = [];
    for (const { item, row } of filled) {
      db.inventory.unshift(item);
      imported.push({ row, id: item.id, name: item.name });
    }
    fileWrite(db);
  }

  // Categories once at the end (not per row).
  for (const cat of catsSeen) {
    try { await addInventoryCategory(cat); } catch {}
  }

  return { imported, errors, categories: [...catsSeen] };
}

// Helper: write an expense row mirroring an inventory purchase. Called
// from addInventoryItem (initial stock) and moveInventory (restock with
// type="in"). Skips if cost is zero.
async function maybeLogInventoryExpense(item, recordedBy, qtyOverride = null) {
  if (!item) return null;
  const qty = qtyOverride != null ? Number(qtyOverride) : Number(item.onHand) || 0;
  const unit = Number(item.unitPrice) || 0;
  const total = Math.round(qty * unit);
  if (!total) return null;
  try {
    return await addExpense({
      scope: "school",
      category: "Inventory purchase",
      amount: total,
      vendor: item.supplier || null,
      memo: `${item.name}${qty ? ` · ${qty} units` : ""}${unit ? ` @ ₹${unit}` : ""}`,
      date: new Date().toISOString().slice(0, 10),
      paymentMethod: "Bank transfer",
      recordedBy: recordedBy || "Inventory",
      inventoryId: item.id,
    });
  } catch (e) {
    console.warn(`[inventory→expense] cascade failed for ${item.id}: ${e.message}`);
    return null;
  }
}

function fileAddInventory(filled) {
  const db = fileRead();
  if (!Array.isArray(db.inventory)) db.inventory = [];
  db.inventory.unshift(filled);
  fileWrite(db);
  return filled;
}

// Persist a category id ("stationery", "lab"…) so it shows up in the picker
// even before any items use it. Idempotent — duplicates collapse to one row.
export async function addInventoryCategory(rawCategory) {
  const slug = String(rawCategory || "").trim().toLowerCase().slice(0, 32).replace(/[^a-z0-9_-]+/g, "_");
  if (!slug) throw new Error("Category is required");
  // Supabase first — upsert by primary key so re-saving the same slug is a
  // safe no-op rather than a duplicate-key error.
  if (supabaseEnabled) {
    const up = await supabase.from("inventory_categories").upsert({ key: slug }, { onConflict: "key" });
    if (up.error && !isSchemaMissError(up.error)) {
      console.warn(`[inventory_categories] upsert fell back: ${up.error.message}`);
    }
  }
  // Mirror to the file store so the dev fallback stays in sync.
  const db = fileRead();
  if (!Array.isArray(db.inventoryCategories)) db.inventoryCategories = [];
  if (!db.inventoryCategories.includes(slug)) {
    db.inventoryCategories.push(slug);
    fileWrite(db);
  }
  return slug;
}

// Movement types:
//   in     — purchase / restock: balance +, qty_purchased +, cascades to Expenses
//   out    — issue to a person/dept: balance -, issued +
//   return — issued stock comes back: balance +, issued - (no purchase, no expense)
export async function moveInventory({ itemId, type, qty, note, who, issuedTo }) {
  if (!itemId) throw new Error("Item required");
  const t = ["out", "return", "in"].includes(type) ? type : "in";
  const q = Math.max(0.001, parseInventoryNumber(qty));
  if (!q) throw new Error("Quantity must be positive");

  // Find current item (try Supabase first, then file).
  let current = null;
  let backend = "file";
  if (supabaseEnabled) {
    const sel = await supabase.from("inventory").select("*").eq("id", itemId).maybeSingle();
    if (sel.data) {
      current = fromInventory(sel.data);
      backend = "supabase";
    }
  }
  if (!current) {
    const list = fileInventorySafe();
    current = list.find((r) => r.id === itemId);
  }
  if (!current) throw new Error("Item not found");

  if (t === "out" && q > (Number(current.onHand) || 0) + 1e-9) {
    throw new Error(`Only ${current.onHand} on hand — can't issue ${q}`);
  }

  // in + return add to balance; out subtracts. return also clears the issued
  // count (stock came back), while out increases it.
  const newOnHand = (t === "in" || t === "return")
    ? (Number(current.onHand) || 0) + q
    : (Number(current.onHand) || 0) - q;
  const newIssued = t === "out"
    ? (Number(current.issued) || 0) + q
    : t === "return"
      ? Math.max(0, (Number(current.issued) || 0) - q)
      : (Number(current.issued) || 0);
  const newPurchased = t === "in"
    ? (Number(current.qtyPurchased) || 0) + q
    : (Number(current.qtyPurchased) || 0);
  const moveId = `MOV-${Date.now().toString(36).toUpperCase()}`;
  const issuedToVal = issuedTo ? String(issuedTo).trim() : null;
  const moveRow = {
    id: moveId, itemId, type: t, qty: q,
    note: note || null, issuedTo: issuedToVal, who: who || "—",
    at: new Date().toISOString(),
  };

  if (backend === "supabase") {
    let body = { on_hand: newOnHand, issued: newIssued, qty_purchased: newPurchased };
    let upd = await supabase.from("inventory").update(body).eq("id", itemId);
    if (upd.error && /qty_purchased/i.test(upd.error.message)) {
      const { qty_purchased, ...legacy } = body;
      upd = await supabase.from("inventory").update(legacy).eq("id", itemId);
    }
    if (upd.error) throw new Error(upd.error.message);
    // Movement log is best-effort — don't fail the move if the table is missing.
    try {
      let mov = {
        id: moveId, item_id: itemId, type: t, qty: q,
        note: moveRow.note, issued_to: issuedToVal, who: moveRow.who, at: moveRow.at,
      };
      let ins = await supabase.from("inventory_movements").insert(mov);
      if (ins.error && /issued_to/i.test(ins.error.message)) {
        delete mov.issued_to;
        await supabase.from("inventory_movements").insert(mov);
      }
    } catch {}
    // Cascade to expenses on a stock-IN movement.
    if (t === "in") {
      try { await maybeLogInventoryExpense(current, who, q); } catch {}
    }
    return {
      item: { ...current, onHand: newOnHand, issued: newIssued, qtyPurchased: newPurchased },
      movement: moveRow,
    };
  }

  // File backend update
  const db = fileRead();
  if (!Array.isArray(db.inventory)) db.inventory = [];
  if (!Array.isArray(db.movements)) db.movements = [];
  const idx = db.inventory.findIndex((r) => r.id === itemId);
  if (idx === -1) throw new Error("Item not found");
  db.inventory[idx] = {
    ...db.inventory[idx],
    onHand: newOnHand,
    issued: newIssued,
    qtyPurchased: newPurchased,
  };
  db.movements.unshift(moveRow);
  if (db.movements.length > 100) db.movements.length = 100;
  fileWrite(db);
  // Cascade to expenses on a stock-IN movement.
  if (t === "in") {
    try { await maybeLogInventoryExpense(db.inventory[idx], who, q); } catch {}
  }
  return { item: db.inventory[idx], movement: moveRow };
}

export async function archiveInventoryItem(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("inventory").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      let upd = await supabase.from("inventory")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
      if (upd.error && /archived_at/.test(upd.error.message)) {
        await supabase.from("inventory").delete().eq("id", id);
      }
      return fromInventory(sel.data);
    }
  }
  const db = fileRead();
  const idx = (db.inventory || []).findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const removed = db.inventory[idx];
  db.inventory.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// Bulk archive/remove — one DB update for Supabase, one file write locally.
export async function bulkArchiveInventoryItems(ids) {
  const list = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!list.length) return { removed: 0, ids: [] };
  if (list.length > 2000) throw new Error("Max 2000 items per bulk delete");

  if (supabaseEnabled) {
    const now = new Date().toISOString();
    let upd = await supabase.from("inventory").update({ archived_at: now }).in("id", list);
    if (upd.error && /archived_at/.test(upd.error.message)) {
      upd = await supabase.from("inventory").delete().in("id", list);
    }
    if (upd.error) throw new Error(upd.error.message);
    // Also mirror into file store so local fallback stays consistent.
    try {
      const db = fileRead();
      if (Array.isArray(db.inventory) && db.inventory.length) {
        const drop = new Set(list);
        db.inventory = db.inventory.filter((r) => !drop.has(r.id));
        fileWrite(db);
      }
    } catch {}
    return { removed: list.length, ids: list };
  }

  const db = fileRead();
  if (!Array.isArray(db.inventory)) db.inventory = [];
  const drop = new Set(list);
  const before = db.inventory.length;
  db.inventory = db.inventory.filter((r) => !drop.has(r.id));
  fileWrite(db);
  return { removed: before - db.inventory.length, ids: list };
}

// ---------- library ----------
// Books are file-store-only for now (Supabase tables not yet provisioned).
// Same pattern as the rest: a shape with `id`, plus a derived `available`
// computed from active loans rather than stored, so the count can never get
// out of sync with the loan log.

export async function addBook(row) {
  const id = row.id || `BOOK-${1000 + Math.floor(Math.random() * 8999)}`;
  const filled = {
    id,
    title: String(row.title || "").trim(),
    author: String(row.author || "").trim(),
    category: String(row.category || "general").trim().toLowerCase().slice(0, 32).replace(/[^a-z0-9_-]+/g, "_") || "general",
    isbn: String(row.isbn || "").trim() || null,
    shelf: String(row.shelf || "").trim() || null,
    totalCopies: Math.max(1, Number(row.totalCopies) || 1),
    addedAt: new Date().toISOString(),
  };
  if (!filled.title) throw new Error("Title is required");
  // Supabase first; fall back to the file store if the table isn't there yet
  // or PostgREST hasn't refreshed its schema cache after the migration.
  if (supabaseEnabled) {
    const ins = await supabase.from("library").insert(toBook(filled)).select().maybeSingle();
    if (!ins.error) {
      // Mirror to file too so dashboards built off the file store stay aligned.
      const db = fileRead();
      if (!Array.isArray(db.library)) db.library = [];
      db.library.unshift(filled); fileWrite(db);
      return ins.data ? fromBook(ins.data) : filled;
    }
    if (!isSchemaMissError(ins.error)) {
      throw new Error(ins.error.message);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.library)) db.library = [];
  db.library.unshift(filled);
  fileWrite(db);
  return filled;
}

export async function updateBook(id, patch) {
  // Build the update payload + run the active-loan guard once (works against
  // either backend by reading the file's loan log, which mirrors Supabase).
  const db = fileRead();
  const idx = (db.library || []).findIndex((b) => b.id === id);
  const allowed = {};
  if (typeof patch.title === "string")    allowed.title    = patch.title.trim();
  if (typeof patch.author === "string")   allowed.author   = patch.author.trim();
  if (typeof patch.category === "string") allowed.category = patch.category.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "general";
  if (typeof patch.isbn === "string")     allowed.isbn     = patch.isbn.trim() || null;
  if (typeof patch.shelf === "string")    allowed.shelf    = patch.shelf.trim() || null;
  if (patch.totalCopies != null) {
    const n = Math.max(0, Math.floor(Number(patch.totalCopies)));
    const active = (db.libraryLoans || []).filter((l) => l.bookId === id && !l.returnedAt).length;
    if (n < active) throw new Error(`Cannot set total below ${active} (active loans)`);
    allowed.totalCopies = n;
  }
  if (supabaseEnabled) {
    // Map allowed → snake_case columns for the Supabase patch.
    const sbPatch = {};
    if (allowed.title    != null) sbPatch.title    = allowed.title;
    if (allowed.author   != null) sbPatch.author   = allowed.author;
    if (allowed.category != null) sbPatch.category = allowed.category;
    if (allowed.isbn     !== undefined) sbPatch.isbn  = allowed.isbn;
    if (allowed.shelf    !== undefined) sbPatch.shelf = allowed.shelf;
    if (allowed.totalCopies != null) sbPatch.total_copies = allowed.totalCopies;
    const upd = await supabase.from("library").update(sbPatch).eq("id", id).select().maybeSingle();
    if (!upd.error && upd.data) {
      // Keep file mirror coherent.
      if (idx !== -1) { db.library[idx] = { ...db.library[idx], ...allowed }; fileWrite(db); }
      return fromBook(upd.data);
    }
    if (!isSchemaMissError(upd.error)) {
      // PostgREST returned a real error (not a missing table) — surface it.
      if (upd.error) throw new Error(upd.error.message);
    }
  }
  if (idx === -1) return null;
  db.library[idx] = { ...db.library[idx], ...allowed };
  fileWrite(db);
  return db.library[idx];
}

export async function removeBook(id) {
  const db = fileRead();
  const active = (db.libraryLoans || []).some((l) => l.bookId === id && !l.returnedAt);
  if (active) throw new Error("Cannot remove a book with active loans — return them first");
  let removed = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("library").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const del = await supabase.from("library").delete().eq("id", id);
      if (!del.error) removed = fromBook(sel.data);
    }
  }
  const idx = (db.library || []).findIndex((b) => b.id === id);
  if (idx !== -1) {
    if (!removed) removed = db.library[idx];
    db.library.splice(idx, 1);
    fileWrite(db);
  }
  return removed;
}

// Bulk-remove every book in the library catalogue. Refuses to run if
// any active loans exist — the loans table is the authoritative ledger
// of who has what, and orphaning them would lose audit trail. Returns
// the count removed.
export async function removeAllBooks() {
  const db = fileRead();
  const activeLoans = (db.libraryLoans || []).filter((l) => !l.returnedAt);
  if (activeLoans.length > 0) {
    throw new Error(`Cannot remove all books — ${activeLoans.length} active loan${activeLoans.length === 1 ? "" : "s"} still out. Return them first.`);
  }
  let removedCount = 0;
  if (supabaseEnabled) {
    // Supabase requires a non-trivial filter on bulk delete; use a
    // tautology on the primary key so every row matches.
    const sel = await supabase.from("library").select("id");
    if (!sel.error && sel.data) {
      removedCount = sel.data.length;
      if (removedCount > 0) {
        await supabase.from("library").delete().neq("id", "__never__");
      }
    }
  }
  if (Array.isArray(db.library) && db.library.length > 0) {
    if (!removedCount) removedCount = db.library.length;
    db.library = [];
    fileWrite(db);
  }
  return removedCount;
}

// Issue a book to a borrower (student or teacher). Decrements availability
// implicitly via the loan log. Throws if no copies are free.
export async function borrowBook({ bookId, borrowerType, borrowerId, borrowerName, dueDays, issuedBy }) {
  if (!bookId) throw new Error("bookId required");
  if (!["student", "teacher", "staff"].includes(borrowerType)) throw new Error("borrowerType must be student/teacher/staff");
  if (!borrowerId) throw new Error("borrowerId required");
  const db = fileRead();
  const book = (db.library || []).find((b) => b.id === bookId);
  if (!book) throw new Error("Book not found");
  const active = (db.libraryLoans || []).filter((l) => l.bookId === bookId && !l.returnedAt);
  if (active.length >= (book.totalCopies || 0)) throw new Error("No copies available right now");
  // Block multiple active loans of the same book to the same borrower —
  // common-sense rule and avoids confusion in the loans table.
  if (active.some((l) => l.borrowerId === borrowerId && l.borrowerType === borrowerType)) {
    throw new Error(`${borrowerName || borrowerId} already has this book on loan`);
  }
  const days = Math.max(1, Math.min(60, Number(dueDays) || 14));
  const now = new Date();
  const due = new Date(now.getTime() + days * 86400000);
  const loan = {
    id: `LOAN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    bookId,
    bookTitle: book.title,
    borrowerType,
    borrowerId,
    borrowerName: borrowerName || borrowerId,
    borrowedAt: now.toISOString(),
    dueAt: due.toISOString(),
    returnedAt: null,
    issuedBy: issuedBy || "Librarian",
  };
  // Persist to Supabase first so the row appears for everyone (other
  // sessions, Reports, dashboards). Mirror to file as a safety net.
  if (supabaseEnabled) {
    const ins = await supabase.from("library_loans").insert(toLoan(loan));
    if (ins.error && !isSchemaMissError(ins.error)) {
      console.warn(`[library_loans] insert fell back: ${ins.error.message}`);
    }
  }
  if (!Array.isArray(db.libraryLoans)) db.libraryLoans = [];
  db.libraryLoans.unshift(loan);
  fileWrite(db);
  return loan;
}

// Mark a loan returned. Idempotent — returning an already-returned loan is
// a no-op and returns the existing row.
export async function returnBook(loanId, returnedBy) {
  if (!loanId) throw new Error("loanId required");
  const returnedAt = new Date().toISOString();
  const by = returnedBy || "Librarian";
  if (supabaseEnabled) {
    // Set returned_at + returned_by; only flip rows that aren't already
    // returned so the call stays idempotent.
    const upd = await supabase
      .from("library_loans")
      .update({ returned_at: returnedAt, returned_by: by })
      .eq("id", loanId)
      .is("returned_at", null)
      .select()
      .maybeSingle();
    if (!upd.error && upd.data) {
      // Mirror the update into the file copy so the dev fallback shows it.
      const db = fileRead();
      const idx = (db.libraryLoans || []).findIndex((l) => l.id === loanId);
      if (idx !== -1) {
        db.libraryLoans[idx] = { ...db.libraryLoans[idx], returnedAt, returnedBy: by };
        fileWrite(db);
      }
      return fromLoan(upd.data);
    }
    if (upd.error && !isSchemaMissError(upd.error)) {
      console.warn(`[library_loans] return fell back: ${upd.error.message}`);
    }
  }
  const db = fileRead();
  const idx = (db.libraryLoans || []).findIndex((l) => l.id === loanId);
  if (idx === -1) return null;
  if (db.libraryLoans[idx].returnedAt) return db.libraryLoans[idx];
  db.libraryLoans[idx] = {
    ...db.libraryLoans[idx],
    returnedAt,
    returnedBy: by,
  };
  fileWrite(db);
  return db.libraryLoans[idx];
}

// ---------- syllabus ----------
// One row per topic/lesson within a class section. Stored file-first with
// Supabase mirror so the dev fallback keeps working before the schema
// migration is applied. Read path is union of cloud + file (deduped by id),
// matching the library/timetable pattern.

function normaliseSyllabusRow(row, who) {
  // Coerce + clamp the inputs so a sloppy import (mixed-case class ids,
  // text in the term column, etc.) still produces a clean row instead of
  // bailing the whole spreadsheet.
  const cls = String(row.cls || "").trim().toUpperCase().replace(/\s+/g, "");
  const subject = String(row.subject || "").trim();
  const topic   = String(row.topic   || "").trim();
  if (!cls)     throw new Error("class is required");
  if (!subject) throw new Error("subject is required");
  if (!topic)   throw new Error("topic is required");
  const termRaw = Number(row.term);
  const weekRaw = Number(row.weekNo);
  return {
    id: row.id || `SYL-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    cls,
    subject,
    chapter: String(row.chapter || "").trim() || null,
    topic,
    term:   Number.isFinite(termRaw) && termRaw >= 1 && termRaw <= 4 ? Math.floor(termRaw) : null,
    weekNo: Number.isFinite(weekRaw) && weekRaw >= 1 && weekRaw <= 60 ? Math.floor(weekRaw) : null,
    notes:  String(row.notes || "").trim() || null,
    addedAt: row.addedAt || new Date().toISOString(),
    addedBy: row.addedBy || who || null,
  };
}

export async function listSyllabus() {
  const byId = new Map();
  if (supabaseEnabled) {
    const r = await supabase.from("syllabus").select("*").order("cls").order("term").order("week_no");
    if (!r.error && Array.isArray(r.data)) {
      for (const row of r.data) {
        byId.set(row.id, {
          id: row.id, cls: row.cls, subject: row.subject,
          chapter: row.chapter, topic: row.topic,
          term: row.term, weekNo: row.week_no,
          notes: row.notes, addedAt: row.added_at, addedBy: row.added_by,
        });
      }
    } else if (r.error && !isSchemaMissError(r.error)) {
      console.warn(`[syllabus] read fell back: ${r.error.message}`);
    }
  }
  // Layer the file copy on top so any rows written before the migration was
  // applied (or while Supabase was unreachable) are still surfaced.
  try {
    const db = fileRead();
    const file = Array.isArray(db.syllabus) ? db.syllabus : [];
    for (const row of file) if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
  } catch {}
  return [...byId.values()];
}

export async function addSyllabusEntry(payload, who) {
  const filled = normaliseSyllabusRow(payload, who);
  // Mirror to Supabase + file store. Supabase is best-effort: if the table
  // hasn't been provisioned yet we still keep going via the file backend.
  if (supabaseEnabled) {
    const ins = await supabase.from("syllabus").insert({
      id: filled.id, cls: filled.cls, subject: filled.subject,
      chapter: filled.chapter, topic: filled.topic,
      term: filled.term, week_no: filled.weekNo,
      notes: filled.notes, added_at: filled.addedAt, added_by: filled.addedBy,
    });
    if (ins.error && !isSchemaMissError(ins.error)) {
      console.warn(`[syllabus] insert fell back: ${ins.error.message}`);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.syllabus)) db.syllabus = [];
  db.syllabus.unshift(filled);
  fileWrite(db);
  return filled;
}

export async function removeSyllabusEntry(id) {
  if (!id) throw new Error("id required");
  let removed = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("syllabus").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const del = await supabase.from("syllabus").delete().eq("id", id);
      if (!del.error) {
        removed = {
          id: sel.data.id, cls: sel.data.cls, subject: sel.data.subject,
          chapter: sel.data.chapter, topic: sel.data.topic,
          term: sel.data.term, weekNo: sel.data.week_no,
          notes: sel.data.notes,
        };
      }
    }
  }
  const db = fileRead();
  const idx = (db.syllabus || []).findIndex((r) => r.id === id);
  if (idx !== -1) {
    if (!removed) removed = db.syllabus[idx];
    db.syllabus.splice(idx, 1);
    fileWrite(db);
  }
  return removed;
}

// Wipe every syllabus row for a single class (e.g. before re-importing the
// year's full plan). Returns the count removed.
export async function removeAllSyllabusForClass(cls) {
  const target = String(cls || "").trim().toUpperCase();
  if (!target) throw new Error("cls required");
  let removed = 0;
  if (supabaseEnabled) {
    const sel = await supabase.from("syllabus").select("id").eq("cls", target);
    if (!sel.error && sel.data) {
      removed = sel.data.length;
      if (removed > 0) await supabase.from("syllabus").delete().eq("cls", target);
    }
  }
  const db = fileRead();
  if (Array.isArray(db.syllabus)) {
    const before = db.syllabus.length;
    db.syllabus = db.syllabus.filter((r) => r.cls !== target);
    const fileRemoved = before - db.syllabus.length;
    if (!removed) removed = fileRemoved;
    if (fileRemoved > 0) fileWrite(db);
  }
  return removed;
}

// ---------- subjects ----------
// Manageable subject list used by the Timetable dropdown and Exams.
// Falls back to a default set when the table doesn't exist yet OR there
// are no rows so the dropdown is never empty.

const DEFAULT_SUBJECTS = [
  { id: "SUB-ENG", name: "English",        category: "language" },
  { id: "SUB-TAM", name: "Tamil",          category: "language" },
  { id: "SUB-HIN", name: "Hindi",          category: "language" },
  { id: "SUB-MAT", name: "Maths",          category: "core" },
  { id: "SUB-SCI", name: "Science",        category: "core" },
  { id: "SUB-SST", name: "Social Science", category: "core" },
  { id: "SUB-PT",  name: "PT",             category: "activity" },
];

export async function listSubjects() {
  // Dedup by lowercased name so the defaults are never hidden by a single
  // user-added subject — and so a default that's also in Supabase doesn't
  // appear twice. Insertion order: Supabase first, then file, then bundled
  // defaults; the first one wins per name.
  const byName = new Map();
  const upsert = (s) => {
    if (!s?.name) return;
    const key = String(s.name).toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        id: s.id, name: s.name,
        code: s.code || null,
        category: s.category || "core",
      });
    }
  };

  if (supabaseEnabled) {
    const r = await supabase.from("subjects").select("*").order("name");
    if (!r.error && Array.isArray(r.data)) {
      for (const s of r.data) upsert(s);
    } else if (r.error && !isSchemaMissError(r.error)) {
      console.warn(`[db] subjects fell back: ${r.error.message}`);
    }
  }
  try {
    const db = fileRead();
    for (const s of (db.subjects || [])) upsert(s);
  } catch {}
  // ALWAYS merge in the bundled defaults so a Computer Science added
  // yesterday doesn't make English / Tamil / Maths disappear.
  for (const s of DEFAULT_SUBJECTS) upsert(s);

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function addSubject({ name, code, category }) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("Subject name is required");
  if (clean.length > 40) throw new Error("Name is too long");

  // Reject duplicates (case-insensitive).
  const existing = await listSubjects();
  const lower = clean.toLowerCase();
  if (existing.find((s) => s.name.toLowerCase() === lower)) {
    throw new Error(`"${clean}" already exists`);
  }

  // Build a stable id from the first 6 letters so the same name typed twice
  // in different cases produces the same id.
  const slug = clean.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) || "SUB";
  const row = {
    id: `SUB-${slug}-${Math.floor(Math.random() * 999).toString().padStart(3, "0")}`,
    name: clean,
    code: code ? String(code).trim().toUpperCase().slice(0, 6) : null,
    category: ["core", "language", "activity", "optional"].includes(category) ? category : "core",
  };

  if (supabaseEnabled) {
    const ins = await supabase.from("subjects").insert(row).select().maybeSingle();
    if (!ins.error && ins.data) return ins.data;
    if (!isSchemaMissError(ins.error)) {
      console.warn(`[db] subjects insert fell back to file: ${ins.error.message}`);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.subjects)) db.subjects = [];
  db.subjects.push(row);
  fileWrite(db);
  return row;
}

export async function removeSubject(id) {
  if (!id) return null;
  let removed = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("subjects").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("subjects").delete().eq("id", id);
      removed = sel.data;
    }
  }
  if (!removed) {
    const db = fileRead();
    const idx = (db.subjects || []).findIndex((s) => s.id === id);
    if (idx !== -1) {
      removed = db.subjects[idx];
      db.subjects.splice(idx, 1);
      fileWrite(db);
    }
  }
  return removed;
}

// ---------- timetable ----------
// Each entry pins a (class, day, period) slot to a subject + teacher. The
// id is composite so adding the same slot twice replaces (upserts) — the
// editor can post a new value without first deleting the old one.

export async function setTimetableEntry({ cls, day, period, subject, teacherId, teacherName, room }) {
  if (!cls)     throw new Error("cls required");
  if (!day)     throw new Error("day required");
  if (period == null) throw new Error("period required");
  if (!subject) throw new Error("subject required");
  const id = `TT-${cls}-${day}-${period}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const row = {
    id, cls, day, period: Number(period),
    subject: String(subject).trim(),
    teacherId: teacherId || null,
    teacherName: teacherName || null,
    room: room ? String(room).trim() : null,
    updatedAt: new Date().toISOString(),
  };
  // Supabase first via upsert on the composite id, so re-saving the same
  // (cls, day, period) just overwrites the assignment.
  if (supabaseEnabled) {
    const up = await supabase.from("timetable").upsert(toTimetable(row), { onConflict: "id" });
    if (up.error && !isSchemaMissError(up.error)) {
      console.warn(`[timetable] upsert fell back: ${up.error.message}`);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.timetable)) db.timetable = [];
  const idx = db.timetable.findIndex((t) => t.id === id);
  if (idx === -1) db.timetable.unshift(row);
  else db.timetable[idx] = { ...db.timetable[idx], ...row };
  fileWrite(db);
  return row;
}

export async function removeTimetableEntry(id) {
  if (!id) return null;
  let removed = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("timetable").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const del = await supabase.from("timetable").delete().eq("id", id);
      if (!del.error) removed = fromTimetable(sel.data);
    }
  }
  const db = fileRead();
  const idx = (db.timetable || []).findIndex((t) => t.id === id);
  if (idx !== -1) {
    if (!removed) removed = db.timetable[idx];
    db.timetable.splice(idx, 1);
    fileWrite(db);
  }
  return removed;
}

// Auto-compute a staff member's performance from real signals:
//   own attendance · students' performance · contribution to school
//
// Composite formula:
//   30% own attendance % (from teacher_attendance over the last 30 days)
//   50% student performance (mean of student attendance % + exam % +
//        daily log completion across the teacher's linkedClasses)
//   20% contribution (awards × 15 + tasks done × 5 + logs posted × 2,
//        capped at 100)
//
// Returns the updated staff row with attendance / tasks / score / status
// fields overwritten by the computed values, plus a non-persisted
// `breakdown` object describing exactly what fed the score (for the UI).
export async function recomputeStaffPerformance(staffId) {
  if (!staffId) return null;

  // Pull current staff + everything we need in one big read. Cheap enough
  // for an on-demand recompute; we don't need to do this on every page load.
  let staff = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("staff").select("*").eq("id", staffId).maybeSingle();
    if (sel.data) staff = fromStaff(sel.data);
  }
  if (!staff) {
    const db = fileRead();
    staff = (db.staff || []).find((s) => s.id === staffId) || null;
  }
  if (!staff) return null;

  // Resolve the teacher's user id + assigned classes via email match.
  // teacher_attendance and tasks are keyed off the user.id, not the
  // staff.id, so we need this hop.
  let userId = null;
  let linkedClasses = [];
  let teacherEmail = (staff.email || "").toLowerCase();
  try {
    const users = await listUsers();
    const u = users.find((x) => (x.email || "").toLowerCase() === teacherEmail && x.role === "teacher");
    if (u) {
      userId = u.id;
      linkedClasses = Array.isArray(u.linkedClasses) ? u.linkedClasses : [];
    }
  } catch {}

  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);

  // ------ A. own attendance ------
  let attendanceScore = Number(staff.attendance) || 0; // fallback to whatever's on the row
  let attendancePresent = 0, attendanceTotal = 0;
  if (userId) {
    try {
      const recs = await listTeacherAttendance({
        teacherId: userId, fromDate: thirtyDaysAgo,
      });
      attendanceTotal = recs.length;
      attendancePresent = recs.filter((r) => r.status === "present").length;
      if (attendanceTotal > 0) {
        attendanceScore = Math.round((attendancePresent / attendanceTotal) * 100);
      }
    } catch {}
  }

  // ------ B. students' performance ------
  let studentScore = Number(staff.tasks) || 0; // fallback
  let studentBreakdown = { studentCount: 0, attendance: null, examPct: null, homeworkPct: null };
  if (linkedClasses.length > 0) {
    const classSet = new Set(linkedClasses.map((c) => String(c).toUpperCase()));
    let students = [];
    try {
      const data = await readAllData();
      students = (data.addedStudents || []).filter(
        (s) => classSet.has(String(s.cls || "").toUpperCase())
      );
    } catch {}
    studentBreakdown.studentCount = students.length;

    if (students.length > 0) {
      // 1. Avg attendance % across the teacher's students.
      const avgStudentAtt = Math.round(
        students.reduce((a, s) => a + (Number(s.attendance) || 0), 0) / students.length
      );
      studentBreakdown.attendance = avgStudentAtt;

      // 2. Avg exam score % across the teacher's classes (if any exams exist).
      let examPct = null;
      try {
        const examsAll = await listExams();
        const classExams = (examsAll || []).filter(
          (e) => classSet.has(String(e.cls || "").toUpperCase())
        );
        if (classExams.length > 0) {
          const examIds = new Set(classExams.map((e) => e.id));
          const studentIds = new Set(students.map((s) => s.id));
          const marks = await listMarks();
          const relevant = (marks || []).filter(
            (m) => examIds.has(m.examId) && studentIds.has(m.studentId)
          );
          if (relevant.length > 0) {
            const total = relevant.reduce(
              (a, m) => a + ((Number(m.score) || 0) / Math.max(1, Number(m.maxMarks) || 100)) * 100,
              0
            );
            examPct = Math.round(total / relevant.length);
          }
        }
      } catch {}
      studentBreakdown.examPct = examPct;

      // 3. Daily-log completion % across the teacher's students (last 30 days).
      let hwPct = null;
      try {
        const data = await readAllData();
        const logs = (data.dailyLogs || []).filter(
          (l) => students.find((s) => s.id === l.studentId) && l.date >= thirtyDaysAgo
        );
        if (logs.length > 0) {
          const completed = logs.filter(
            (l) => l.homeworkStatus === "completed" && l.classworkStatus === "completed"
          ).length;
          hwPct = Math.round((completed / logs.length) * 100);
        }
      } catch {}
      studentBreakdown.homeworkPct = hwPct;

      // Mean of whatever signals we have.
      const parts = [avgStudentAtt, examPct, hwPct].filter((v) => v != null);
      if (parts.length > 0) {
        studentScore = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
      }
    }
  }

  // ------ C. contribution to school ------
  let awardsCount = 0, logsPostedCount = 0, tasksDoneCount = 0;
  try {
    const awards = await listStaffAwards(staffId);
    awardsCount = awards.length;
  } catch {}
  if (userId || teacherEmail) {
    try {
      const data = await readAllData();
      // Daily logs posted by this teacher in the last 30 days.
      logsPostedCount = (data.dailyLogs || []).filter(
        (l) => (l.postedBy === staff.name || l.postedBy === teacherEmail) && l.date >= thirtyDaysAgo
      ).length;
      // Tasks completed (assigned_to matches user id OR email; status === 'done').
      tasksDoneCount = (data.tasks || []).filter(
        (t) => t.status === "done" &&
          (t.assignedTo === userId || t.assignedToEmail === teacherEmail || t.assignedToName === staff.name)
      ).length;
    } catch {}
  }
  const contributionScore = Math.min(
    100,
    awardsCount * 15 + tasksDoneCount * 5 + logsPostedCount * 2
  );

  // ------ Composite ------
  const score = Math.round(
    attendanceScore * 0.30 +
    studentScore    * 0.50 +
    contributionScore * 0.20
  );
  const status = score >= 85 ? "top" : score >= 65 ? "ok" : "low";

  const next = {
    attendance: attendanceScore,
    tasks: studentScore,    // repurposed: now stores the student-perf component
    score, status,
  };

  if (supabaseEnabled) {
    const upd = await supabase.from("staff").update(next).eq("id", staffId).select().maybeSingle();
    if (!upd.error && upd.data) {
      const out = fromStaff(upd.data);
      out.breakdown = {
        attendance: { score: attendanceScore, present: attendancePresent, total: attendanceTotal },
        student:    { score: studentScore, ...studentBreakdown, classes: linkedClasses },
        contribution: { score: contributionScore, awards: awardsCount, tasksDone: tasksDoneCount, logsPosted: logsPostedCount },
      };
      return out;
    }
  }
  const db = fileRead();
  const idx = (db.staff || []).findIndex((s) => s.id === staffId);
  if (idx !== -1) {
    db.staff[idx] = { ...db.staff[idx], ...next };
    fileWrite(db);
  }
  return {
    ...staff, ...next,
    breakdown: {
      attendance: { score: attendanceScore, present: attendancePresent, total: attendanceTotal },
      student:    { score: studentScore, ...studentBreakdown, classes: linkedClasses },
      contribution: { score: contributionScore, awards: awardsCount, tasksDone: tasksDoneCount, logsPosted: logsPostedCount },
    },
  };
}

// Manual override for the rare case where the principal needs to nudge the
// numbers (e.g. a one-off correction). Returns the staff row after writing
// the patch but does NOT recompute — the next recompute will overwrite.
export async function updateStaffPerformance(id, patch = {}) {
  if (!id) return null;
  // No fields to patch → treat as a recompute request.
  if (!("attendance" in patch) && !("tasks" in patch) && !("salary" in patch)) {
    return recomputeStaffPerformance(id);
  }
  const clamp = (n) => Math.min(100, Math.max(0, Math.floor(Number(n) || 0)));
  const next = {};
  if ("attendance" in patch) next.attendance = clamp(patch.attendance);
  if ("tasks" in patch)      next.tasks      = clamp(patch.tasks);
  if ("salary" in patch)     next.salary     = Math.max(0, Math.floor(Number(patch.salary) || 0));

  let current = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("staff").select("*").eq("id", id).maybeSingle();
    if (sel.data) current = fromStaff(sel.data);
  }
  if (!current) {
    const db = fileRead();
    current = (db.staff || []).find((s) => s.id === id) || null;
  }
  if (!current) return null;

  const merged = { ...current, ...next };
  const a = Number(merged.attendance) || 0;
  const t = Number(merged.tasks) || 0;
  let activity = 0;
  try {
    const awards = await listStaffAwards(id);
    activity = Math.min(100, awards.length * 20);
  } catch {}
  merged.score = Math.round(a * 0.4 + t * 0.4 + activity * 0.2);
  merged.status = merged.score >= 85 ? "top" : merged.score >= 65 ? "ok" : "low";
  next.score = merged.score;
  next.status = merged.status;

  if (supabaseEnabled) {
    const upd = await supabase.from("staff").update(next).eq("id", id).select().maybeSingle();
    if (!upd.error && upd.data) return fromStaff(upd.data);
  }
  const db = fileRead();
  const idx = (db.staff || []).findIndex((s) => s.id === id);
  if (idx === -1) return null;
  db.staff[idx] = { ...db.staff[idx], ...next };
  fileWrite(db);
  return db.staff[idx];
}

// ---------- staff awards ----------
export async function listStaffAwards(staffId = null) {
  let all = [];
  if (supabaseEnabled) {
    const q = supabase.from("staff_awards").select("*").order("created_at", { ascending: false });
    const r = staffId ? await q.eq("staff_id", staffId) : await q;
    if (!r.error && r.data) all = r.data.map(fromStaffAward);
    else if (r.error && !isSchemaMissError(r.error)) {
      console.warn(`[db] staff_awards select fell back to file: ${r.error.message}`);
    }
  }
  if (all.length === 0) {
    const db = fileRead();
    const fileAwards = Array.isArray(db.staffAwards) ? db.staffAwards : [];
    all = staffId ? fileAwards.filter((a) => a.staffId === staffId) : fileAwards;
  }
  return all;
}

export async function addStaffAward({ staffId, title, citation, category, awardedAt, awardedBy }) {
  if (!staffId) throw new Error("staffId required");
  if (!title || !String(title).trim()) throw new Error("Award title is required");

  // Stamp a friendly month-year if caller didn't supply one.
  const friendly = awardedAt && String(awardedAt).trim()
    ? String(awardedAt).trim()
    : new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" });

  // Resolve staff name once so the award is self-contained for display
  // (so deleting/renaming a staff row later doesn't blank out the citation).
  let staffName = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("staff").select("name").eq("id", staffId).maybeSingle();
    if (sel.data?.name) staffName = sel.data.name;
  }
  if (!staffName) {
    const db = fileRead();
    staffName = (db.staff || []).find((s) => s.id === staffId)?.name || null;
  }

  const award = {
    id: `AWD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
    staffId,
    staffName,
    title: String(title).trim(),
    citation: citation ? String(citation).trim() : null,
    category: ["recognition", "attendance", "academic", "service"].includes(category) ? category : "recognition",
    awardedAt: friendly,
    awardedBy: awardedBy || null,
  };

  if (supabaseEnabled) {
    const ins = await supabase.from("staff_awards").insert(toStaffAward(award)).select().maybeSingle();
    if (!ins.error && ins.data) {
      // Recompute the staff member's score so the new award lifts their activity.
      try { await updateStaffPerformance(staffId, {}); } catch {}
      return fromStaffAward(ins.data);
    }
    if (!isSchemaMissError(ins.error)) {
      console.warn(`[db] staff_awards insert fell back to file: ${ins.error.message}`);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.staffAwards)) db.staffAwards = [];
  db.staffAwards.unshift(award);
  fileWrite(db);
  try { await updateStaffPerformance(staffId, {}); } catch {}
  return award;
}

export async function removeStaffAward(awardId) {
  if (!awardId) return null;
  let removed = null;
  if (supabaseEnabled) {
    const sel = await supabase.from("staff_awards").select("*").eq("id", awardId).maybeSingle();
    if (sel.data) {
      await supabase.from("staff_awards").delete().eq("id", awardId);
      removed = fromStaffAward(sel.data);
    }
  }
  if (!removed) {
    const db = fileRead();
    const idx = (db.staffAwards || []).findIndex((a) => a.id === awardId);
    if (idx !== -1) {
      removed = db.staffAwards[idx];
      db.staffAwards.splice(idx, 1);
      fileWrite(db);
    }
  }
  if (removed?.staffId) {
    try { await updateStaffPerformance(removed.staffId, {}); } catch {}
  }
  return removed;
}

export async function archiveStaff(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("staff").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      let upd = await supabase.from("staff")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
      if (upd.error && /archived_at/.test(upd.error.message)) {
        // Schema cache lag — fall back to hard delete.
        await supabase.from("staff").delete().eq("id", id);
      }
      return fromStaff(sel.data);
    }
    // If the table is missing from the cache OR the row isn't there, also
    // try the file fallback before giving up.
  }
  const db = fileRead();
  const idx = (db.staff || []).findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const removed = db.staff[idx];
  db.staff.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- auth users ----------
// CRUD for the users table (real login accounts). The file backend keeps
// users in db.json under `authUsers` so the dev fallback still works.
//
// Multi-class teachers: a teacher can be the class teacher of >1 section.
// The DB column `linked_id` (text) stores the assignments as a CSV string
// like "2-A,5-B". The JS layer surfaces them as an array `linkedClasses`,
// keeping `linkedId` in scope for backwards-compat with the parent flow
// (where it's a single student id).

// Parse a CSV string of class-section keys ("2-A,5-B") into an array.
// Empty / null / undefined → []. Trims and de-dupes.
export function parseLinkedClasses(linkedId) {
  if (!linkedId) return [];
  return Array.from(new Set(
    String(linkedId).split(",").map((s) => s.trim()).filter(Boolean)
  ));
}

// Pack an array back into a CSV string for storage. Empty array → null.
export function packLinkedClasses(arr) {
  const list = Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : [];
  const dedup = Array.from(new Set(list));
  return dedup.length ? dedup.join(",") : null;
}

// Heuristic: a value looks like a class-section assignment ("5-A", "10-B")
// rather than a student id ("STN-1234"). We use this only in the user shape
// helper so parent users (linkedId = student id) don't get a bogus
// linkedClasses array. Teachers' linked_id is always class-section strings.
function looksLikeClassKey(s) {
  return /^\d+-[A-Z]+$/i.test(String(s || "").trim());
}

const fromUser = (r) => {
  if (!r) return null;
  const linkedId = r.linked_id ?? null;
  // Only expose linkedClasses when the value parses as one or more class
  // keys. For parents (linkedId = student id) it stays empty.
  const parts = parseLinkedClasses(linkedId);
  const isClassList = parts.length > 0 && parts.every(looksLikeClassKey);
  return {
    id: r.id, email: r.email, role: r.role, name: r.name,
    passwordHash: r.password_hash,
    linkedId,
    linkedClasses: isClassList ? parts : [],
    createdAt: r.created_at,
  };
};

export async function getUserByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  if (supabaseEnabled) {
    const r = await supabase.from("users").select("*").eq("email", e).maybeSingle();
    if (!r.error && r.data) return fromUser(r.data);
    if (r.error) console.warn(`[db] users lookup: ${r.error.message}`);
    // Fall through to file store so reassignments persisted via the file
    // fallback (when Supabase users table is missing) still take effect.
  }
  const db = fileRead();
  const list = db.authUsers || [];
  const found = list.find((u) => u.email === e);
  if (!found) return null;
  // Normalise through fromUser so linkedClasses is computed from linkedId.
  return fromUser({
    id: found.id, email: found.email, role: found.role, name: found.name,
    password_hash: found.passwordHash, linked_id: found.linkedId,
    created_at: found.createdAt,
  });
}

export async function listUsers() {
  // Union Supabase + file so a user added via either path surfaces. This
  // matters when one is fresher than the other (e.g. createUser fell back
  // to file because Supabase users table is missing the schema).
  const out = new Map();
  if (supabaseEnabled) {
    const r = await supabase.from("users").select("*").order("created_at", { ascending: false });
    if (!r.error && r.data) {
      for (const row of r.data) {
        const u = fromUser(row);
        if (u) out.set(u.id, u);
      }
    }
  }
  const db = fileRead();
  for (const u of (db.authUsers || [])) {
    if (out.has(u.id)) continue;
    // File users are stored camelCase; normalise through fromUser (which
    // expects snake_case) so callers reliably get linkedClasses computed
    // from linkedId. Without this, /api/chat couldn't tell whether a
    // teacher was assigned to the child's class and rejected sends.
    const normalised = fromUser({
      id: u.id,
      email: u.email,
      role: u.role,
      name: u.name,
      password_hash: u.passwordHash,
      linked_id: u.linkedId,
      created_at: u.createdAt,
    });
    if (normalised) out.set(u.id, normalised);
  }
  return Array.from(out.values());
}

// Update mutable fields on a user (name, role, linked_id). Used by the
// "Class teacher" picker on the Classes screen.
//
// Patch shape supports both whole-list replace and atomic add/remove:
//   { linkedId: "2-A,5-B" }       — replace whole CSV
//   { linkedClasses: ["2-A","5-B"] } — replace whole array
//   { addClass: "5-B" }            — add this class to the user's list
//   { removeClass: "2-A" }         — remove just this class from the list
//
// Returns the updated user, or null if not found.
// Self-service profile update. Used by /api/auth/profile so a signed-in
// user can rename themselves and change their password without admin help.
//
// Phone is still read-only here (lives on the staff or student record and
// is admin-managed). Email IS editable — the new value cascades to the
// linked staff row so a teacher's account stays in sync with their staff
// record. Parent users link to students by linked_id, so changing a
// parent's email leaves the student's parent contact phone untouched.
// The caller is expected to have already verified the currentPassword if
// `newPassword` is set.
//
// Cascades:
//   - users.name (source of truth)
//   - staff.name  where staff.email === user.email
//   - users.email
//   - staff.email where staff.email === user.oldEmail
//
// Returns the updated user. Throws if the requested email is malformed
// or already taken by another account.
export async function updateMyProfile(userId, { name, email, newPassword } = {}) {
  if (!userId) return null;

  const fields = {};
  const cleanName = typeof name === "string" ? name.trim() : null;
  if (cleanName) fields.name = cleanName;

  // Email — basic format check + uniqueness against any *other* user.
  // We need the previous email to cascade to the staff row, so resolve
  // the current user before applying the update.
  let oldEmail = null;
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : null;
  if (cleanEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error("Email format is invalid");
    }
    const current = await getUserById(userId);
    if (!current) return null;
    oldEmail = String(current.email || "").toLowerCase();
    if (cleanEmail !== oldEmail) {
      const conflict = await getUserByEmail(cleanEmail);
      if (conflict && conflict.id !== userId) {
        throw new Error("That email is already in use by another account");
      }
      fields.email = cleanEmail;
    }
  }

  if (newPassword) {
    const { hashPassword } = require("./auth.js");
    fields.passwordHash = await hashPassword(newPassword);
  }

  if (Object.keys(fields).length === 0) {
    // Nothing to do — return current row.
    return getUserById(userId);
  }

  // 1. Update users row (Supabase first, then file fallback).
  let updated = null;
  if (supabaseEnabled) {
    const dbFields = {};
    if (fields.name)         dbFields.name = fields.name;
    if (fields.email)        dbFields.email = fields.email;
    if (fields.passwordHash) dbFields.password_hash = fields.passwordHash;
    const r = await supabase.from("users").update(dbFields).eq("id", userId).select().maybeSingle();
    if (!r.error && r.data) updated = fromUser(r.data);
    else if (r.error && /duplicate|unique/i.test(r.error.message || "")) {
      throw new Error("That email is already in use by another account");
    }
  }
  if (!updated) {
    const db = fileRead();
    if (!Array.isArray(db.authUsers)) db.authUsers = [];
    let idx = db.authUsers.findIndex((u) => u.id === userId);
    // Lazy-seed from DEMO_ACCOUNTS on first edit.
    if (idx === -1) {
      try {
        const seed = require("./seed-users.js");
        const demo = (seed.DEMO_ACCOUNTS || []).find((a) => a.id === userId);
        if (demo) {
          db.authUsers.push({
            id: demo.id, email: demo.email, role: demo.role, name: demo.name,
            linkedId: demo.linkedId || null,
            createdAt: new Date().toISOString(),
          });
          idx = db.authUsers.length - 1;
        }
      } catch {}
    }
    if (idx === -1) return null;
    // File-side uniqueness check (Supabase already enforces the index).
    if (fields.email) {
      const taken = db.authUsers.some((u, i) => i !== idx && (u.email || "").toLowerCase() === fields.email);
      if (taken) throw new Error("That email is already in use by another account");
    }
    const merged = {
      ...db.authUsers[idx],
      ...(fields.name  ? { name: fields.name }   : {}),
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.passwordHash ? { passwordHash: fields.passwordHash } : {}),
    };
    db.authUsers[idx] = merged;
    fileWrite(db);
    updated = fromUser({
      id: merged.id, email: merged.email, role: merged.role, name: merged.name,
      password_hash: merged.passwordHash, linked_id: merged.linkedId,
      created_at: merged.createdAt,
    });
  }

  // 2. Cascade name to staff record (if any). When the email itself is
  // changing we have to match against the *previous* email — otherwise
  // it'd be the same email either way.
  const matchEmail = (oldEmail || updated?.email || "").toLowerCase();
  if (fields.name && matchEmail) {
    if (supabaseEnabled) {
      try {
        await supabase.from("staff").update({ name: fields.name }).eq("email", matchEmail);
      } catch {}
    }
    try {
      const db = fileRead();
      if (Array.isArray(db.staff)) {
        let touched = false;
        for (let i = 0; i < db.staff.length; i++) {
          if ((db.staff[i].email || "").toLowerCase() === matchEmail) {
            db.staff[i] = { ...db.staff[i], name: fields.name };
            touched = true;
          }
        }
        if (touched) fileWrite(db);
      }
    } catch {}
  }

  // 3. Cascade email to the linked staff row. Parents link to students
  // by linked_id (student id), not email — so no student-side change is
  // needed; the parent contact phone on the student row is unaffected.
  if (fields.email && oldEmail && oldEmail !== fields.email) {
    if (supabaseEnabled) {
      try {
        await supabase.from("staff").update({ email: fields.email }).eq("email", oldEmail);
      } catch {}
    }
    try {
      const db = fileRead();
      if (Array.isArray(db.staff)) {
        let touched = false;
        for (let i = 0; i < db.staff.length; i++) {
          if ((db.staff[i].email || "").toLowerCase() === oldEmail) {
            db.staff[i] = { ...db.staff[i], email: fields.email };
            touched = true;
          }
        }
        if (touched) fileWrite(db);
      }
    } catch {}
  }

  return updated;
}

export async function updateUser(id, patch) {
  if (!id) return null;

  // Resolve the new CSV value if any class-related field is being patched.
  const wantsClassChange = (
    "linkedId" in patch || "linkedClasses" in patch ||
    typeof patch.addClass === "string" || typeof patch.removeClass === "string"
  );

  // Compute next CSV based on the current user (needed for add/remove).
  let nextLinkedCsv = null;
  let touchedClasses = false;
  if (wantsClassChange) {
    touchedClasses = true;
    if ("linkedId" in patch) {
      nextLinkedCsv = patch.linkedId || null;
    } else if ("linkedClasses" in patch) {
      nextLinkedCsv = packLinkedClasses(patch.linkedClasses);
    } else {
      // add / remove → need the current value
      const current = await getUserById(id);
      const set = new Set(parseLinkedClasses(current?.linkedId));
      if (typeof patch.addClass === "string" && patch.addClass.trim()) {
        set.add(patch.addClass.trim());
      }
      if (typeof patch.removeClass === "string" && patch.removeClass.trim()) {
        set.delete(patch.removeClass.trim());
      }
      nextLinkedCsv = packLinkedClasses(Array.from(set));
    }
  }

  const fields = {};
  if (typeof patch.name === "string") fields.name = patch.name;
  if (typeof patch.role === "string") fields.role = patch.role;
  if (touchedClasses)                 fields.linked_id = nextLinkedCsv;

  if (supabaseEnabled) {
    const r = await supabase.from("users").update(fields).eq("id", id).select().maybeSingle();
    if (!r.error && r.data) return fromUser(r.data);
    // Fall through to file fallback when Supabase doesn't know this user
    // (e.g. demo accounts created via in-memory fallback only).
  }
  const db = fileRead();
  if (!Array.isArray(db.authUsers)) db.authUsers = [];
  let idx = db.authUsers.findIndex((u) => u.id === id);
  // Lazy-seed from DEMO_ACCOUNTS if the user only exists in memory.
  if (idx === -1) {
    try {
      const seed = require("./seed-users.js");
      const demo = (seed.DEMO_ACCOUNTS || []).find((a) => a.id === id);
      if (demo) {
        db.authUsers.push({
          id: demo.id, email: demo.email, role: demo.role, name: demo.name,
          linkedId: demo.linkedId || null,
          createdAt: new Date().toISOString(),
        });
        idx = db.authUsers.length - 1;
      }
    } catch {}
  }
  if (idx === -1) return null;
  const merged = {
    ...db.authUsers[idx],
    ...(typeof patch.name === "string" ? { name: patch.name } : {}),
    ...(typeof patch.role === "string" ? { role: patch.role } : {}),
    ...(touchedClasses ? { linkedId: nextLinkedCsv } : {}),
  };
  db.authUsers[idx] = merged;
  fileWrite(db);
  return fromUser({
    id: merged.id, email: merged.email, role: merged.role, name: merged.name,
    password_hash: merged.passwordHash, linked_id: merged.linkedId,
    created_at: merged.createdAt,
  });
}

// Replace a user's bcrypt hash. Used by the admin "Reset password" flow on
// the Users screen. Falls back to seeding the user row from DEMO_ACCOUNTS if
// they only existed in memory before. Returns the safe (no-hash) user, or
// null if the id is unknown to both stores.
export async function setUserPassword(id, passwordHash) {
  if (!id || !passwordHash) return null;

  if (supabaseEnabled) {
    const r = await supabase
      .from("users")
      .update({ password_hash: passwordHash })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (!r.error && r.data) return fromUser(r.data);
    // Fall through to file fallback if Supabase doesn't know this user
    // (legacy demo accounts that were never written to the table).
  }

  const db = fileRead();
  if (!Array.isArray(db.authUsers)) db.authUsers = [];
  let idx = db.authUsers.findIndex((u) => u.id === id);
  if (idx === -1) {
    try {
      const seed = require("./seed-users.js");
      const demo = (seed.DEMO_ACCOUNTS || []).find((a) => a.id === id);
      if (demo) {
        db.authUsers.push({
          id: demo.id, email: demo.email, role: demo.role, name: demo.name,
          linkedId: demo.linkedId || null,
          createdAt: new Date().toISOString(),
        });
        idx = db.authUsers.length - 1;
      }
    } catch {}
  }
  if (idx === -1) return null;
  db.authUsers[idx] = { ...db.authUsers[idx], passwordHash };
  fileWrite(db);
  const merged = db.authUsers[idx];
  return fromUser({
    id: merged.id, email: merged.email, role: merged.role, name: merged.name,
    password_hash: merged.passwordHash, linked_id: merged.linkedId,
    created_at: merged.createdAt,
  });
}

// Look up a user by id. Used internally for atomic add/remove operations.
async function getUserById(id) {
  if (!id) return null;
  if (supabaseEnabled) {
    const r = await supabase.from("users").select("*").eq("id", id).maybeSingle();
    if (!r.error && r.data) return fromUser(r.data);
  }
  const db = fileRead();
  const list = db.authUsers || [];
  const found = list.find((u) => u.id === id);
  if (!found) {
    // Fall back to demo seed so add/remove works against teachers that
    // haven't been written to the file yet.
    try {
      const seed = require("./seed-users.js");
      const demo = (seed.DEMO_ACCOUNTS || []).find((a) => a.id === id);
      if (demo) {
        return fromUser({
          id: demo.id, email: demo.email, role: demo.role, name: demo.name,
          linked_id: demo.linkedId || null,
        });
      }
    } catch {}
    return null;
  }
  return fromUser({
    id: found.id, email: found.email, role: found.role, name: found.name,
    password_hash: found.passwordHash, linked_id: found.linkedId,
    created_at: found.createdAt,
  });
}

// Convenience: list teachers (id, email, name, linkedId) — feeds the
// "Class teacher" picker. Falls back to DEMO_ACCOUNTS so the picker is
// never empty during the demo, even before the users table is populated.
export async function listTeachers() {
  const fromDb = await listUsers();
  // Normalise everything through fromUser so linkedClasses is always set.
  const norm = (u) => fromUser({
    id: u.id, email: u.email, role: u.role, name: u.name,
    password_hash: u.passwordHash, linked_id: u.linkedId,
    created_at: u.createdAt,
  });
  const fileMap = new Map(
    fromDb.filter((u) => u.role === "teacher").map((u) => [u.id, norm(u)])
  );
  try {
    const seed = require("./seed-users.js");
    for (const a of (seed.DEMO_ACCOUNTS || [])) {
      if (a.role === "teacher" && !fileMap.has(a.id)) {
        fileMap.set(a.id, fromUser({
          id: a.id, email: a.email, role: a.role, name: a.name,
          linked_id: a.linkedId || null,
        }));
      }
    }
  } catch {}
  return Array.from(fileMap.values());
}

export async function createUser({ id, email, passwordHash, role, name, linkedId }) {
  const row = {
    id,
    email: String(email).trim().toLowerCase(),
    password_hash: passwordHash,
    role,
    name,
    linked_id: linkedId || null,
  };
  if (supabaseEnabled) {
    const r = await supabase.from("users").insert(row).select().maybeSingle();
    if (!r.error && r.data) return fromUser(r.data);
    // PostgREST cache lag / missing users table → fall through to file so
    // newly-provisioned accounts still persist locally.
    if (r.error) console.warn(`[db] users insert fell back to file: ${r.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.authUsers)) db.authUsers = [];
  // Don't double-write if it's already there.
  if (!db.authUsers.find((u) => u.id === id || u.email === row.email)) {
    db.authUsers.push({
      id, email: row.email, passwordHash, role, name, linkedId: linkedId || null,
      createdAt: new Date().toISOString(),
    });
    fileWrite(db);
  }
  return db.authUsers.find((u) => u.id === id) || db.authUsers.at(-1);
}

// ---------- bulk attendance ----------
// Mark attendance for many students for the same date in one shot. If a
// daily_logs row already exists for (student, date), only the attendance +
// leave_reason fields are touched — classwork / homework / handwriting /
// behaviour / extra notes are preserved. Falls back to file backend the
// same way upsertDailyLog does.
// Read attendance-bearing daily logs for one class over a date range (used by
// the teacher day-wise / month-wise attendance viewer). Paginates past the
// 1000-row default so a full month is never truncated, unions any file-store
// rows, and layers correction overlays on top.
export async function listAttendance({ cls, from, to } = {}) {
  let rows = [];
  if (supabaseEnabled) {
    const PAGE = 1000;
    let start = 0;
    for (;;) {
      let q = supabase.from("daily_logs").select("*").order("date", { ascending: true });
      if (cls)  q = q.eq("cls", cls);
      if (from) q = q.gte("date", from);
      if (to)   q = q.lte("date", to);
      const r = await q.range(start, start + PAGE - 1);
      if (r.error) {
        if (!isSchemaMissError(r.error)) console.warn(`[db] daily_logs range: ${r.error.message}`);
        break;
      }
      const chunk = r.data || [];
      rows = rows.concat(chunk);
      if (chunk.length < PAGE) break;
      start += PAGE;
    }
  }
  let logs = rows.map(fromDailyLog);
  // Union any file-store logs (writes that fell back), filtered to the range.
  try {
    const db = fileRead();
    let fileLogs = Array.isArray(db.dailyLogs) ? db.dailyLogs : [];
    if (cls)  fileLogs = fileLogs.filter((l) => l.cls === cls);
    if (from) fileLogs = fileLogs.filter((l) => (l.date || "") >= from);
    if (to)   fileLogs = fileLogs.filter((l) => (l.date || "") <= to);
    const seen = new Set(logs.map((l) => `${l.studentId}|${l.date}`));
    for (const l of fileLogs) {
      const k = `${l.studentId}|${l.date}`;
      if (!seen.has(k)) { seen.add(k); logs.push(l); }
    }
  } catch {}
  return applyDailyLogOverlays(logs);
}

export async function markAttendanceBulk({ date, cls, postedBy, marks }) {
  if (!date || !Array.isArray(marks) || marks.length === 0) {
    throw new Error("date and marks[] are required");
  }
  const results = [];
  // Allowed daily-log attendance buckets. "late" and "leave" join the
  // existing present/absent so reports can distinguish a student who
  // showed up late from a planned leave. "parent_drop" = missed morning
  // bus but arrived by parent (present at school; unlocks evening bus).
  const STUDENT_ATTENDANCE = new Set(["present", "late", "absent", "leave", "parent_drop"]);
  for (const m of marks) {
    const studentId = m.studentId;
    if (!studentId) continue;
    const att = STUDENT_ATTENDANCE.has(m.attendance) ? m.attendance : "present";
    // Reason text persists for absent/leave/late — useful for the audit
    // trail and the late-arrivals widget. Stored in `leaveReason` for
    // backward compat (the column is reused). parent_drop keeps a fixed note.
    const leaveReason = att === "present" ? ""
      : att === "parent_drop" ? (m.leaveReason || "Dropped by parent")
      : (m.leaveReason || m.lateReason || "");

    let existing = null;
    if (supabaseEnabled) {
      const sel = await supabase.from("daily_logs")
        .select("*").eq("student_id", studentId).eq("date", date).maybeSingle();
      if (sel.data) existing = sel.data;
    } else {
      const db = fileRead();
      existing = (db.dailyLogs || []).find((l) => l.studentId === studentId && l.date === date) || null;
    }

    // Build the merged row. For brand-new entries we only set the
    // attendance-relevant fields; classwork/homework etc. stay null until a
    // teacher posts the full daily log.
    const merged = existing ? {
      studentId, studentName: existing.student_name || existing.studentName || m.studentName,
      cls: existing.cls || cls, date,
      attendance: att, leaveReason,
      classwork: existing.classwork ?? null, classworkStatus: existing.classwork_status ?? existing.classworkStatus ?? null,
      homework:  existing.homework  ?? null, homeworkStatus:  existing.homework_status  ?? existing.homeworkStatus  ?? null,
      subjectLogs: existing.subject_logs ?? existing.subjectLogs ?? undefined,
      topics: existing.topics ?? null,
      handwritingNote: existing.handwriting_note ?? existing.handwritingNote ?? null,
      handwritingGrade: existing.handwriting_grade ?? existing.handwritingGrade ?? null,
      behaviour: existing.behaviour ?? null,
      extra: existing.extra ?? null,
      postedBy: postedBy || existing.posted_by || existing.postedBy || "Teacher",
    } : {
      studentId, studentName: m.studentName, cls, date,
      attendance: att, leaveReason,
      classwork: null, classworkStatus: null,
      homework: null, homeworkStatus: null,
      topics: null, handwritingNote: null, handwritingGrade: null,
      behaviour: null, extra: null,
      postedBy: postedBy || "Teacher",
    };
    const r = await upsertDailyLog(merged);
    results.push(r.log);
  }
  return results;
}

// ---------- complaints ----------
export async function addComplaint(row) {
  const id = "CMP-" + String(Math.floor(Math.random() * 1e5)).padStart(5, "0");
  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  // Whitelist: only the three buckets parents see in the picker. Anything
  // else (or null) drops to undefined so older complaints don't get a
  // bogus category back-filled.
  const ALLOWED_CATS = new Set(["academic", "non_academic", "transport"]);
  const cat = ALLOWED_CATS.has(row.category) ? row.category : null;
  const newRow = {
    id,
    student: row.student || "",
    student_id: row.studentId || null,
    cls: row.cls || "",
    parent: row.parent || "",
    issue: (row.issue || "").trim(),
    type: row.type === "leave_request" ? "leave_request" : "general",
    // Stored on the row so the staff filter strip and CSV export can use it.
    // Only set for general complaints — leave requests go straight to the
    // class teacher and don't need a bucket.
    category: row.type === "leave_request" ? null : cat,
    date: today,
    status: "Open",
    assigned: row.assigned || "Admin Desk",
    submitted_by: row.submittedBy || "parent",
  };
  if (supabaseEnabled) {
    let attempt = newRow;
    let r = await supabase.from("complaints").insert(attempt).select().maybeSingle();
    // PostgREST cache lag — strip whichever new column is unknown and retry.
    let safety = 5;
    while (r.error && safety-- > 0) {
      const m = /Could not find the '([a-z_]+)' column/i.exec(r.error.message);
      if (!m) break;
      const next = { ...attempt };
      delete next[m[1]];
      if (Object.keys(next).length === Object.keys(attempt).length) break;
      attempt = next;
      r = await supabase.from("complaints").insert(attempt).select().maybeSingle();
    }
    if (r.error) {
      // Table missing entirely → file fallback.
      if (/complaint/i.test(r.error.message)) {
        return fileAddComplaint(newRow);
      }
      throw new Error(r.error.message);
    }
    return r.data;
  }
  return fileAddComplaint(newRow);
}

function fileAddComplaint(newRow) {
  const db = fileRead();
  if (!Array.isArray(db.complaints)) db.complaints = [];
  db.complaints.unshift({
    id: newRow.id, student: newRow.student, studentId: newRow.student_id,
    cls: newRow.cls, parent: newRow.parent, issue: newRow.issue,
    type: newRow.type, date: newRow.date, status: newRow.status,
    assigned: newRow.assigned, submittedBy: newRow.submitted_by,
  });
  fileWrite(db);
  return db.complaints[0];
}

// =====================================================================
// v2: expense categories, donor-form submissions, notifications.
// All cloud + file dual-write so the app keeps working through outages.
// =====================================================================

// ---------- expense_categories ------------------------------------------
const fromExpenseCategory = (r) => r ? ({
  id: r.id, name: r.category_name, type: r.category_type,
  createdBy: r.created_by, createdAt: r.created_at,
}) : null;

export async function listExpenseCategories({ type } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("expense_categories").select("*").order("created_at", { ascending: false });
    if (type) q = q.eq("category_type", type);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromExpenseCategory);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] expense_categories fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  const all = Array.isArray(db.expenseCategories) ? db.expenseCategories : [];
  return type ? all.filter((c) => c.type === type) : all;
}

export async function addExpenseCategory({ name, type = "school", createdBy = null } = {}) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Category name is required");
  if (trimmed.length > 60) throw new Error("Category name is too long");
  const t = type === "trust" ? "trust" : "school";
  const id = `EC-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`;
  const row = { id, category_name: trimmed, category_type: t, created_by: createdBy };
  if (supabaseEnabled) {
    const ins = await supabase.from("expense_categories").insert(row).select().single();
    if (!ins.error) return fromExpenseCategory(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.expenseCategories)) db.expenseCategories = [];
  // Reject duplicate (name, type) combo.
  const exists = db.expenseCategories.find((c) => c.name.toLowerCase() === trimmed.toLowerCase() && c.type === t);
  if (exists) return exists;
  const local = { id, name: trimmed, type: t, createdBy, createdAt: new Date().toISOString() };
  db.expenseCategories.unshift(local);
  fileWrite(db);
  return local;
}

export async function removeExpenseCategory(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("expense_categories").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("expense_categories").delete().eq("id", id);
      return fromExpenseCategory(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.expenseCategories)) db.expenseCategories = [];
  const idx = db.expenseCategories.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const removed = db.expenseCategories[idx];
  db.expenseCategories.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- expense_templates (quick-add tiles on Money screen) ---------
const fromExpenseTemplate = (r) => r ? ({
  id: r.id,
  name: r.name,
  category: r.category,
  defaultAmount: Number(r.default_amount) || 0,
  defaultVendor: r.default_vendor || null,
  defaultPaymentMethod: r.default_payment_method || "Bank transfer",
  scope: r.scope || "school",
  createdBy: r.created_by || null,
  createdAt: r.created_at,
}) : null;

const toExpenseTemplate = (t) => ({
  id: t.id,
  name: String(t.name || "").trim(),
  category: String(t.category || "").trim(),
  default_amount: Math.max(0, Math.floor(Number(t.defaultAmount) || 0)),
  default_vendor: t.defaultVendor ? String(t.defaultVendor).trim() : null,
  default_payment_method: t.defaultPaymentMethod || "Bank transfer",
  scope: t.scope === "trust" ? "trust" : "school",
  created_by: t.createdBy || null,
});

export async function listExpenseTemplates({ scope } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("expense_templates").select("*").order("created_at", { ascending: false });
    if (scope) q = q.eq("scope", scope);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromExpenseTemplate);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] expense_templates fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  const all = Array.isArray(db.expenseTemplates) ? db.expenseTemplates : [];
  return scope ? all.filter((t) => t.scope === scope) : all;
}

export async function addExpenseTemplate({ name, category, defaultAmount = 0, defaultVendor = null, defaultPaymentMethod = "Bank transfer", scope = "school", createdBy = null } = {}) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Template name is required");
  if (trimmedName.length > 80) throw new Error("Template name is too long");
  const cat = String(category || "").trim();
  if (!cat) throw new Error("Category is required");
  const id = `ET-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`;
  const row = toExpenseTemplate({ id, name: trimmedName, category: cat, defaultAmount, defaultVendor, defaultPaymentMethod, scope, createdBy });
  if (supabaseEnabled) {
    const ins = await supabase.from("expense_templates").insert(row).select().single();
    if (!ins.error) return fromExpenseTemplate(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(`expense_templates insert failed: ${ins.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.expenseTemplates)) db.expenseTemplates = [];
  const local = fromExpenseTemplate({ ...row, created_at: new Date().toISOString() });
  db.expenseTemplates.unshift(local);
  fileWrite(db);
  return local;
}

export async function updateExpenseTemplate(id, patch = {}) {
  if (!id) throw new Error("id required");
  const allowed = ["name", "category", "defaultAmount", "defaultVendor", "defaultPaymentMethod", "scope"];
  const next = {};
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  if (!Object.keys(next).length) throw new Error("Nothing to update");
  if (next.name != null) next.name = String(next.name).trim();
  if (next.category != null) next.category = String(next.category).trim();
  if (next.defaultAmount != null) next.defaultAmount = Math.max(0, Math.floor(Number(next.defaultAmount) || 0));
  if (next.scope && next.scope !== "trust") next.scope = "school";
  const dbRow = toExpenseTemplate({ id, ...next });
  // toExpenseTemplate fills defaults for unspecified fields — strip them
  // so we only update what the caller actually passed.
  const updateOnly = {};
  if ("name"        in next) updateOnly.name        = dbRow.name;
  if ("category"    in next) updateOnly.category    = dbRow.category;
  if ("defaultAmount"        in next) updateOnly.default_amount         = dbRow.default_amount;
  if ("defaultVendor"        in next) updateOnly.default_vendor         = dbRow.default_vendor;
  if ("defaultPaymentMethod" in next) updateOnly.default_payment_method = dbRow.default_payment_method;
  if ("scope"       in next) updateOnly.scope       = dbRow.scope;

  if (supabaseEnabled) {
    const upd = await supabase.from("expense_templates").update(updateOnly).eq("id", id).select().single();
    if (!upd.error) return fromExpenseTemplate(upd.data);
    if (!isSchemaMissError(upd.error)) throw new Error(`expense_templates update failed: ${upd.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.expenseTemplates)) db.expenseTemplates = [];
  const idx = db.expenseTemplates.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const merged = { ...db.expenseTemplates[idx] };
  for (const k of allowed) if (k in next) merged[k] = next[k];
  db.expenseTemplates[idx] = merged;
  fileWrite(db);
  return merged;
}

export async function removeExpenseTemplate(id) {
  if (!id) throw new Error("id required");
  if (supabaseEnabled) {
    const sel = await supabase.from("expense_templates").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      const del = await supabase.from("expense_templates").delete().eq("id", id);
      if (del.error) throw new Error(`expense_templates delete failed: ${del.error.message}`);
      return fromExpenseTemplate(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.expenseTemplates)) db.expenseTemplates = [];
  const idx = db.expenseTemplates.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const removed = db.expenseTemplates[idx];
  db.expenseTemplates.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- donor_form_submissions (public /donorform) ------------------
const fromDonorFormSubmission = (r) => r ? ({
  id: r.id, donorName: r.donor_name, phone: r.phone, email: r.email,
  donationType: r.donation_type,
  donationAmount: r.donation_amount != null ? Number(r.donation_amount) : null,
  message: r.message, status: r.status, submittedAt: r.submitted_at,
}) : null;

export async function addDonorFormSubmission({ donorName, phone, email, donationType, donationAmount, message } = {}) {
  const name = String(donorName || "").trim();
  if (!name) throw new Error("Donor name is required");
  const amt = Number(donationAmount);
  const row = {
    id: `DFS-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`,
    donor_name: name,
    phone: phone ? String(phone).trim() : null,
    email: email ? String(email).trim().toLowerCase() : null,
    donation_type: donationType || "one_time",
    donation_amount: Number.isFinite(amt) && amt > 0 ? amt : null,
    message: message ? String(message).trim() : null,
    status: "pending",
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("donor_form_submissions").insert(row).select().single();
    if (!ins.error) return fromDonorFormSubmission(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.donorFormSubmissions)) db.donorFormSubmissions = [];
  const local = {
    id: row.id, donorName: row.donor_name, phone: row.phone, email: row.email,
    donationType: row.donation_type, donationAmount: row.donation_amount,
    message: row.message, status: "pending", submittedAt: new Date().toISOString(),
  };
  db.donorFormSubmissions.unshift(local);
  fileWrite(db);
  return local;
}

export async function listDonorFormSubmissions({ status, limit = 200 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("donor_form_submissions").select("*").order("submitted_at", { ascending: false }).limit(limit);
    if (status) q = q.eq("status", status);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromDonorFormSubmission);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] donor_form_submissions fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.donorFormSubmissions) ? db.donorFormSubmissions : [];
  if (status) all = all.filter((s) => s.status === status);
  return all.slice(0, limit);
}

export async function updateDonorFormSubmissionStatus(id, status) {
  if (!["pending", "accepted", "rejected"].includes(status)) {
    throw new Error("Invalid status");
  }
  if (supabaseEnabled) {
    const upd = await supabase.from("donor_form_submissions").update({ status }).eq("id", id).select().maybeSingle();
    if (!upd.error && upd.data) return fromDonorFormSubmission(upd.data);
    if (upd.error && !isSchemaMissError(upd.error)) console.warn(`[db] donor_form_submissions update fell back: ${upd.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.donorFormSubmissions)) db.donorFormSubmissions = [];
  const idx = db.donorFormSubmissions.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  db.donorFormSubmissions[idx] = { ...db.donorFormSubmissions[idx], status };
  fileWrite(db);
  return db.donorFormSubmissions[idx];
}

// ---------- notifications -----------------------------------------------
const fromNotification = (r) => r ? ({
  id: r.id, userId: r.user_id, type: r.notification_type,
  title: r.title, description: r.description, redirectUrl: r.redirect_url,
  isRead: !!r.is_read, createdAt: r.created_at,
}) : null;

export async function addNotification({ userId, type, title, description = null, redirectUrl = null } = {}) {
  if (!userId || !type || !title) throw new Error("userId, type, title required");
  const id = `NTF-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id, user_id: userId, notification_type: type, title,
    description, redirect_url: redirectUrl, is_read: false,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("notifications").insert(row).select().single();
    if (!ins.error) return fromNotification(ins.data);
    if (!isSchemaMissError(ins.error)) console.warn(`[db] notifications insert fell back: ${ins.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const local = { id, userId, type, title, description, redirectUrl, isRead: false, createdAt: new Date().toISOString() };
  db.notifications.unshift(local);
  fileWrite(db);
  return local;
}

// Broadcast to every user with the given role(s). Used when a parent
// messages admin, a donor submits the public form, etc.
export async function notifyRole(roles, { type, title, description = null, redirectUrl = null } = {}) {
  const target = Array.isArray(roles) ? roles : [roles];
  const users = await listUsers();
  const recipients = users.filter((u) => target.includes(u.role));
  const out = [];
  for (const u of recipients) {
    try { out.push(await addNotification({ userId: u.id, type, title, description, redirectUrl })); }
    catch (e) { console.warn(`[db] notify failed for ${u.id}: ${e.message}`); }
  }
  return out;
}

// Push an in-app notification to the parent linked to a given student.
// Best-effort: no-ops if no parent user is linked to this student yet.
export async function notifyStudentParent(studentId, { type = "transport", title, description = null, redirectUrl = null } = {}) {
  if (!studentId || !title) return null;
  try {
    const users = await listUsers();
    const parent = (users || []).find(
      (u) => u.role === "parent" && (u.linkedId === studentId || u.studentId === studentId)
    );
    if (!parent) return null;
    return await addNotification({ userId: parent.id, type, title, description, redirectUrl });
  } catch (e) {
    console.warn(`[db] notifyStudentParent failed: ${e.message}`);
    return null;
  }
}

export async function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  if (!userId) return [];
  if (supabaseEnabled) {
    let q = supabase.from("notifications").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
    if (unreadOnly) q = q.eq("is_read", false);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromNotification);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] notifications fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = (Array.isArray(db.notifications) ? db.notifications : []).filter((n) => n.userId === userId);
  if (unreadOnly) all = all.filter((n) => !n.isRead);
  return all.slice(0, limit);
}

export async function markNotificationRead(id, userId) {
  if (supabaseEnabled) {
    const upd = await supabase.from("notifications").update({ is_read: true }).eq("id", id).eq("user_id", userId).select().maybeSingle();
    if (!upd.error && upd.data) return fromNotification(upd.data);
  }
  const db = fileRead();
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const idx = db.notifications.findIndex((n) => n.id === id && n.userId === userId);
  if (idx === -1) return null;
  db.notifications[idx] = { ...db.notifications[idx], isRead: true };
  fileWrite(db);
  return db.notifications[idx];
}

export async function markAllNotificationsRead(userId) {
  if (supabaseEnabled) {
    await supabase.from("notifications").update({ is_read: true }).eq("user_id", userId).eq("is_read", false);
  }
  const db = fileRead();
  if (!Array.isArray(db.notifications)) db.notifications = [];
  let touched = 0;
  for (let i = 0; i < db.notifications.length; i++) {
    if (db.notifications[i].userId === userId && !db.notifications[i].isRead) {
      db.notifications[i] = { ...db.notifications[i], isRead: true };
      touched++;
    }
  }
  if (touched) fileWrite(db);
  return touched;
}

// ---------- leave_requests (students + teachers) ------------------------
const fromLeaveRequest = (r) => r ? ({
  id: r.id,
  requesterType: r.requester_type,
  requesterId: r.requester_id,
  leaveType: r.leave_type,
  reason: r.reason,
  fromDate: r.from_date,
  toDate: r.to_date,
  approvalStatus: r.approval_status,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
}) : null;

export async function addLeaveRequest({
  requesterType, requesterId,
  leaveType = "casual", reason = "",
  fromDate, toDate,
  requesterName, requesterCls,
} = {}) {
  if (!["student", "teacher"].includes(requesterType)) {
    throw new Error("requesterType must be 'student' or 'teacher'");
  }
  if (!requesterId) throw new Error("requesterId required");
  if (!fromDate || !toDate) throw new Error("fromDate and toDate required");
  if (new Date(toDate) < new Date(fromDate)) throw new Error("toDate must be on/after fromDate");

  const id = `LR-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id,
    requester_type: requesterType,
    requester_id: requesterId,
    leave_type: leaveType,
    reason: String(reason || ""),
    from_date: fromDate,
    to_date: toDate,
    approval_status: "pending",
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("leave_requests").insert(row).select().single();
    if (!ins.error) return { ...fromLeaveRequest(ins.data), requesterName, requesterCls };
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.leaveRequests)) db.leaveRequests = [];
  const local = {
    id, requesterType, requesterId, leaveType,
    reason: row.reason, fromDate, toDate,
    approvalStatus: "pending", approvedBy: null, approvedAt: null,
    createdAt: new Date().toISOString(),
    requesterName, requesterCls,
  };
  db.leaveRequests.unshift(local);
  fileWrite(db);
  return local;
}

export async function listLeaveRequests({ status, requesterType, requesterId, limit = 200 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("leave_requests").select("*").order("created_at", { ascending: false }).limit(limit);
    if (status)        q = q.eq("approval_status", status);
    if (requesterType) q = q.eq("requester_type", requesterType);
    if (requesterId)   q = q.eq("requester_id", requesterId);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromLeaveRequest);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] leave_requests fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.leaveRequests) ? db.leaveRequests : [];
  if (status)        all = all.filter((r) => r.approvalStatus === status);
  if (requesterType) all = all.filter((r) => r.requesterType === requesterType);
  if (requesterId)   all = all.filter((r) => r.requesterId === requesterId);
  return all.slice(0, limit);
}

export async function updateLeaveRequestStatus(id, { status, approvedBy } = {}) {
  if (!["pending", "approved", "rejected", "cancelled"].includes(status)) {
    throw new Error("Invalid status");
  }
  const patch = {
    approval_status: status,
    approved_by: approvedBy || null,
    approved_at: status === "pending" ? null : new Date().toISOString(),
  };
  if (supabaseEnabled) {
    const upd = await supabase.from("leave_requests").update(patch).eq("id", id).select().maybeSingle();
    if (!upd.error && upd.data) return fromLeaveRequest(upd.data);
    if (upd.error && !isSchemaMissError(upd.error)) console.warn(`[db] leave_requests update fell back: ${upd.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.leaveRequests)) db.leaveRequests = [];
  const idx = db.leaveRequests.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  db.leaveRequests[idx] = {
    ...db.leaveRequests[idx],
    approvalStatus: status,
    approvedBy: approvedBy || null,
    approvedAt: status === "pending" ? null : new Date().toISOString(),
  };
  fileWrite(db);
  return db.leaveRequests[idx];
}

// ---------- remarks_rewards (admin notes on students/teachers) ----------
const fromRemarkReward = (r) => r ? ({
  id: r.id,
  targetType: r.target_type,
  targetId: r.target_id,
  type: r.type,
  category: r.category,
  description: r.description,
  actionTaken: r.action_taken,
  createdBy: r.created_by,
  createdAt: r.created_at,
  // Resolution fields. May be null when the schema hasn't been migrated
  // yet — listRemarksRewards merges in the file-overlay for backward compat.
  resolvedAt:     r.resolved_at     ?? null,
  resolvedBy:     r.resolved_by     ?? null,
  resolutionNote: r.resolution_note ?? null,
}) : null;

export async function addRemarkReward({
  targetType, targetId,
  type, category = null,
  description, actionTaken = null,
  createdBy = null,
} = {}) {
  if (!["student", "teacher"].includes(targetType)) {
    throw new Error("targetType must be 'student' or 'teacher'");
  }
  if (!targetId)  throw new Error("targetId required");
  if (!["reward", "remark"].includes(type)) {
    throw new Error("type must be 'reward' or 'remark'");
  }
  if (!description || !String(description).trim()) {
    throw new Error("description required");
  }
  const id = `RR-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id,
    target_type: targetType,
    target_id: targetId,
    type, category,
    description: String(description).trim(),
    action_taken: actionTaken ? String(actionTaken).trim() : null,
    created_by: createdBy,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("remarks_rewards").insert(row).select().single();
    if (!ins.error) return fromRemarkReward(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.remarksRewards)) db.remarksRewards = [];
  const local = {
    id, targetType, targetId, type, category,
    description: row.description, actionTaken: row.action_taken,
    createdBy, createdAt: new Date().toISOString(),
  };
  db.remarksRewards.unshift(local);
  fileWrite(db);
  return local;
}

export async function listRemarksRewards({ targetType, targetId, type, limit = 200 } = {}) {
  // Always read the file-side resolution overlay so we can merge it on top
  // of whatever the primary store returns. Stored as
  // db.remarksRewardsResolutions = { [id]: { resolvedAt, resolvedBy, resolutionNote } }
  // — used for installs where the Supabase schema doesn't have the
  // resolution columns yet.
  const overlayDb = fileRead();
  const overlay = (overlayDb && typeof overlayDb.remarksRewardsResolutions === "object")
    ? overlayDb.remarksRewardsResolutions
    : {};
  const mergeOverlay = (item) => {
    if (!item) return item;
    const ov = overlay[item.id];
    if (!ov) return item;
    return {
      ...item,
      resolvedAt:     item.resolvedAt     ?? ov.resolvedAt     ?? null,
      resolvedBy:     item.resolvedBy     ?? ov.resolvedBy     ?? null,
      resolutionNote: item.resolutionNote ?? ov.resolutionNote ?? null,
    };
  };

  if (supabaseEnabled) {
    let q = supabase.from("remarks_rewards").select("*").order("created_at", { ascending: false }).limit(limit);
    if (targetType) q = q.eq("target_type", targetType);
    if (targetId)   q = q.eq("target_id", targetId);
    if (type)       q = q.eq("type", type);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromRemarkReward).map(mergeOverlay);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] remarks_rewards fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.remarksRewards) ? db.remarksRewards : [];
  if (targetType) all = all.filter((r) => r.targetType === targetType);
  if (targetId)   all = all.filter((r) => r.targetId === targetId);
  if (type)       all = all.filter((r) => r.type === type);
  return all.slice(0, limit).map(mergeOverlay);
}

// Mark a remark/reward as resolved. Optional `resolutionNote` records what
// was done. Tries Supabase first; on missing-column errors, falls back to
// a file-side overlay keyed by id so the change persists even before the
// schema migration is applied. Returns the merged row, or null if the
// id is unknown.
export async function resolveRemarkReward(id, { resolvedBy = null, resolutionNote = null } = {}) {
  if (!id) return null;
  const resolvedAt = new Date().toISOString();
  const note = resolutionNote ? String(resolutionNote).trim().slice(0, 500) : null;

  // Try Supabase update first (fast path on freshly-migrated installs).
  if (supabaseEnabled) {
    const upd = await supabase
      .from("remarks_rewards")
      .update({ resolved_at: resolvedAt, resolved_by: resolvedBy, resolution_note: note })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (!upd.error && upd.data) return fromRemarkReward(upd.data);
    // Schema lag (column doesn't exist yet) → fall through to overlay.
    if (upd.error && !isSchemaMissError(upd.error) && !/column\s+\".+\"\s+does not exist/i.test(upd.error.message)) {
      console.warn(`[db] remarks_rewards resolve fell back: ${upd.error.message}`);
    }
  }

  // File overlay path. Mirror to db.remarksRewardsResolutions[id] so reads
  // pick it up regardless of which store actually owns the row.
  const db = fileRead();
  if (!db.remarksRewardsResolutions || typeof db.remarksRewardsResolutions !== "object") {
    db.remarksRewardsResolutions = {};
  }
  // If the row lives in the file fallback, also update it in place so
  // subsequent reads see the resolution without needing the overlay.
  let baseRow = null;
  if (Array.isArray(db.remarksRewards)) {
    const idx = db.remarksRewards.findIndex((r) => r.id === id);
    if (idx !== -1) {
      db.remarksRewards[idx] = {
        ...db.remarksRewards[idx],
        resolvedAt, resolvedBy, resolutionNote: note,
      };
      baseRow = db.remarksRewards[idx];
    }
  }
  db.remarksRewardsResolutions[id] = { resolvedAt, resolvedBy, resolutionNote: note };
  fileWrite(db);
  return baseRow || { id, resolvedAt, resolvedBy, resolutionNote: note };
}

// Reopen — clears resolution metadata. Used when an admin marks a row as
// resolved by mistake. Mirrors resolveRemarkReward's overlay pattern.
export async function reopenRemarkReward(id) {
  if (!id) return null;
  if (supabaseEnabled) {
    const upd = await supabase
      .from("remarks_rewards")
      .update({ resolved_at: null, resolved_by: null, resolution_note: null })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (!upd.error && upd.data) {
      // Drop the overlay too so the row reads as fully reopened.
      const db = fileRead();
      if (db.remarksRewardsResolutions && db.remarksRewardsResolutions[id]) {
        delete db.remarksRewardsResolutions[id];
        fileWrite(db);
      }
      return fromRemarkReward(upd.data);
    }
  }
  const db = fileRead();
  if (db.remarksRewardsResolutions) delete db.remarksRewardsResolutions[id];
  if (Array.isArray(db.remarksRewards)) {
    const idx = db.remarksRewards.findIndex((r) => r.id === id);
    if (idx !== -1) {
      db.remarksRewards[idx] = {
        ...db.remarksRewards[idx],
        resolvedAt: null, resolvedBy: null, resolutionNote: null,
      };
    }
  }
  fileWrite(db);
  return { id, resolvedAt: null, resolvedBy: null, resolutionNote: null };
}

export async function removeRemarkReward(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("remarks_rewards").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("remarks_rewards").delete().eq("id", id);
      return fromRemarkReward(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.remarksRewards)) db.remarksRewards = [];
  const idx = db.remarksRewards.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const removed = db.remarksRewards[idx];
  db.remarksRewards.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- government_documents (admin-only vault) ---------------------
const fromGovernmentDocument = (r) => r ? ({
  id: r.id,
  title: r.title,
  documentType: r.document_type,
  fileUrl: r.file_url,
  expiryDate: r.expiry_date,
  uploadedBy: r.uploaded_by,
  notes: r.notes,
  createdAt: r.created_at,
}) : null;

export async function addGovernmentDocument({
  title, documentType = null, fileUrl = null,
  expiryDate = null, uploadedBy = null, notes = null,
} = {}) {
  if (!title || !String(title).trim()) throw new Error("title required");
  const id = `GOV-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id,
    title: String(title).trim(),
    document_type: documentType || null,
    file_url: fileUrl || null,
    expiry_date: expiryDate || null,
    uploaded_by: uploadedBy || null,
    notes: notes ? String(notes).trim() : null,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("government_documents").insert(row).select().single();
    if (!ins.error) return fromGovernmentDocument(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.governmentDocuments)) db.governmentDocuments = [];
  const local = {
    id, title: row.title, documentType: row.document_type,
    fileUrl: row.file_url, expiryDate: row.expiry_date,
    uploadedBy, notes: row.notes, createdAt: new Date().toISOString(),
  };
  db.governmentDocuments.unshift(local);
  fileWrite(db);
  return local;
}

export async function listGovernmentDocuments({ limit = 200 } = {}) {
  if (supabaseEnabled) {
    const sel = await supabase.from("government_documents").select("*").order("created_at", { ascending: false }).limit(limit);
    if (!sel.error) return (sel.data || []).map(fromGovernmentDocument);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] government_documents fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return (Array.isArray(db.governmentDocuments) ? db.governmentDocuments : []).slice(0, limit);
}

export async function updateGovernmentDocument(id, patch = {}) {
  const dbPatch = {};
  if ("title"        in patch) dbPatch.title        = patch.title;
  if ("documentType" in patch) dbPatch.document_type = patch.documentType;
  if ("fileUrl"      in patch) dbPatch.file_url     = patch.fileUrl;
  if ("expiryDate"   in patch) dbPatch.expiry_date  = patch.expiryDate;
  if ("notes"        in patch) dbPatch.notes        = patch.notes;
  if (supabaseEnabled) {
    const upd = await supabase.from("government_documents").update(dbPatch).eq("id", id).select().maybeSingle();
    if (!upd.error && upd.data) return fromGovernmentDocument(upd.data);
    if (upd.error && !isSchemaMissError(upd.error)) console.warn(`[db] gov_docs update fell back: ${upd.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.governmentDocuments)) db.governmentDocuments = [];
  const idx = db.governmentDocuments.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  db.governmentDocuments[idx] = { ...db.governmentDocuments[idx], ...patch };
  fileWrite(db);
  return db.governmentDocuments[idx];
}

export async function removeGovernmentDocument(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("government_documents").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("government_documents").delete().eq("id", id);
      return fromGovernmentDocument(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.governmentDocuments)) db.governmentDocuments = [];
  const idx = db.governmentDocuments.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const removed = db.governmentDocuments[idx];
  db.governmentDocuments.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- student_activities (extra-curricular ledger) ----------------
const fromStudentActivity = (r) => r ? ({
  id: r.id,
  studentId: r.student_id,
  activityName: r.activity_name,
  eventName: r.event_name,
  achievementLevel: r.achievement_level,
  externalCompetition: !!r.external_competition,
  activityLink: r.activity_link,
  certificateDocument: r.certificate_document,
  activityDate: r.activity_date,
  createdBy: r.created_by,
  createdAt: r.created_at,
}) : null;

export async function addStudentActivity({
  studentId, activityName, eventName = null,
  achievementLevel = "participation", externalCompetition = false,
  activityLink = null, certificateDocument = null,
  activityDate = null, createdBy = null,
} = {}) {
  if (!studentId)    throw new Error("studentId required");
  if (!activityName || !String(activityName).trim()) throw new Error("activityName required");
  const id = `SA-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id,
    student_id: studentId,
    activity_name: String(activityName).trim(),
    event_name: eventName ? String(eventName).trim() : null,
    achievement_level: achievementLevel || "participation",
    external_competition: !!externalCompetition,
    activity_link: activityLink || null,
    certificate_document: certificateDocument || null,
    activity_date: activityDate || null,
    created_by: createdBy,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("student_activities").insert(row).select().single();
    if (!ins.error) return fromStudentActivity(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.studentActivities)) db.studentActivities = [];
  const local = {
    id, studentId, activityName: row.activity_name, eventName: row.event_name,
    achievementLevel: row.achievement_level,
    externalCompetition: row.external_competition,
    activityLink: row.activity_link, certificateDocument: row.certificate_document,
    activityDate: row.activity_date, createdBy, createdAt: new Date().toISOString(),
  };
  db.studentActivities.unshift(local);
  fileWrite(db);
  return local;
}

export async function listStudentActivities({ studentId, achievementLevel, externalCompetition, limit = 500 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("student_activities").select("*").order("activity_date", { ascending: false, nullsFirst: false }).limit(limit);
    if (studentId)        q = q.eq("student_id", studentId);
    if (achievementLevel) q = q.eq("achievement_level", achievementLevel);
    if (typeof externalCompetition === "boolean") q = q.eq("external_competition", externalCompetition);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromStudentActivity);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] student_activities fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.studentActivities) ? db.studentActivities : [];
  if (studentId)        all = all.filter((a) => a.studentId === studentId);
  if (achievementLevel) all = all.filter((a) => a.achievementLevel === achievementLevel);
  if (typeof externalCompetition === "boolean") all = all.filter((a) => !!a.externalCompetition === externalCompetition);
  return all.slice(0, limit);
}

// Full 360° report for one student: profile + all fees activity + academics
// (attendance, exam marks) + extras (remarks/rewards, activities, transport).
// Per-student queries, so nothing is truncated by the global bootstrap caps.
export async function getStudentReport(studentId) {
  if (!studentId) throw new Error("studentId required");
  const all = await readAllData().catch(() => ({}));
  const student = (all.addedStudents || []).find((s) => s.id === studentId)
    || (all.archivedStudents || []).find((s) => s.id === studentId)
    || null;

  // ---- Fees (fully loaded + paginated in readAllData) ----
  const owns = (f) => (f.studentId || f.student_id || String(f.id || "").split("__")[0]) === studentId;
  const pendingFees = (all.pendingFees || []).filter(owns);
  const receipts = (all.recentFees || []).filter(owns)
    .sort((a, b) => String(b.paidAt || b.paid_at || "").localeCompare(String(a.paidAt || a.paid_at || "")));
  const paidTotal = receipts.reduce((a, f) => a + (Number(f.amount) || 0), 0);
  const pendingTotal = pendingFees.reduce((a, f) => a + (Number(f.amount) || 0), 0);

  // ---- Attendance (daily logs), per student, uncapped ----
  let dailyLogs = [];
  if (supabaseEnabled) {
    const PAGE = 1000; let start = 0;
    for (;;) {
      const r = await supabase.from("daily_logs").select("*").eq("student_id", studentId)
        .order("date", { ascending: false }).range(start, start + PAGE - 1);
      if (r.error) { if (!isSchemaMissError(r.error)) console.warn(`[db] student daily_logs: ${r.error.message}`); break; }
      const chunk = (r.data || []).map(fromDailyLog);
      dailyLogs = dailyLogs.concat(chunk);
      if (chunk.length < PAGE) break;
      start += PAGE;
    }
  }
  if (!dailyLogs.length) {
    try { const db = fileRead(); dailyLogs = (db.dailyLogs || []).filter((l) => l.studentId === studentId); } catch {}
  }
  dailyLogs = applyDailyLogOverlays(dailyLogs);
  const att = { present: 0, late: 0, absent: 0, leave: 0, parent_drop: 0 };
  for (const l of dailyLogs) { if (att[l.attendance] != null) att[l.attendance]++; }
  const marked = dailyLogs.length;
  const atSchool = att.present + att.late + att.parent_drop;
  const attendancePct = marked ? Math.round((atSchool / marked) * 100) : null;

  // ---- Exam marks + exam meta ----
  const marks = await listMarks({ studentId }).catch(() => []);
  const exams = await listExams().catch(() => []);
  const examById = Object.fromEntries((exams || []).map((e) => [e.id, e]));
  const examMarks = (marks || [])
    .map((m) => ({ ...m, exam: examById[m.examId] || null }))
    .sort((a, b) => String(b.recordedAt || "").localeCompare(String(a.recordedAt || "")));

  // ---- Extras ----
  const remarks = await listRemarksRewards({ targetType: "student", targetId: studentId, limit: 500 }).catch(() => []);
  const activities = await listStudentActivities({ studentId, limit: 500 }).catch(() => []);
  let transport = [];
  if (supabaseEnabled) {
    const r = await supabase.from("transport_attendance").select("*").eq("student_id", studentId)
      .order("marked_at", { ascending: false }).limit(120);
    if (!r.error) transport = (r.data || []).map(fromTransportAttendance);
  }
  if (!transport.length) {
    try { const db = fileRead(); transport = (db.transportAttendance || []).filter((t) => t.studentId === studentId).slice(0, 120); } catch {}
  }

  return {
    student,
    fees: { pending: pendingFees, receipts, paidTotal, pendingTotal },
    attendance: { logs: dailyLogs.slice(0, 90), summary: { ...att, marked, atSchool, attendancePct } },
    examMarks,
    remarks,
    activities,
    transport,
  };
}

export async function removeStudentActivity(id) {
  if (supabaseEnabled) {
    const sel = await supabase.from("student_activities").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("student_activities").delete().eq("id", id);
      return fromStudentActivity(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.studentActivities)) db.studentActivities = [];
  const idx = db.studentActivities.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const removed = db.studentActivities[idx];
  db.studentActivities.splice(idx, 1);
  fileWrite(db);
  return removed;
}

// ---------- custom_roles + role_feature_access --------------------------
const fromCustomRole = (r) => r ? ({
  id: r.id, roleName: r.role_name,
  createdBy: r.created_by, createdAt: r.created_at,
}) : null;
const fromRoleFeature = (r) => r ? ({
  id: r.id, roleId: r.role_id, featureName: r.feature_name,
  canView: !!r.can_view, canEdit: !!r.can_edit, canDelete: !!r.can_delete,
}) : null;

function slugifyRoleName(name) {
  return String(name || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export async function listCustomRoles() {
  if (supabaseEnabled) {
    const sel = await supabase.from("custom_roles").select("*").order("created_at", { ascending: false });
    if (!sel.error) return (sel.data || []).map(fromCustomRole);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] custom_roles fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return Array.isArray(db.customRoles) ? db.customRoles : [];
}

export async function addCustomRole({ roleName, createdBy = null } = {}) {
  const name = String(roleName || "").trim();
  if (!name) throw new Error("Role name required");
  if (name.length > 60) throw new Error("Role name is too long");
  const slug = slugifyRoleName(name);
  if (!slug) throw new Error("Role name must contain letters or numbers");
  const id = `role-${slug}-${Date.now().toString(36).slice(-4)}`;
  const row = { id, role_name: name, created_by: createdBy };
  if (supabaseEnabled) {
    const ins = await supabase.from("custom_roles").insert(row).select().single();
    if (!ins.error) return fromCustomRole(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.customRoles)) db.customRoles = [];
  // Reject same role name (case-insensitive).
  const dup = db.customRoles.find((r) => r.roleName.toLowerCase() === name.toLowerCase());
  if (dup) return dup;
  const local = { id, roleName: name, createdBy, createdAt: new Date().toISOString() };
  db.customRoles.unshift(local);
  fileWrite(db);
  return local;
}

export async function removeCustomRole(id) {
  if (supabaseEnabled) {
    // Children cascade via FK on role_feature_access.
    const sel = await supabase.from("custom_roles").select("*").eq("id", id).maybeSingle();
    if (sel.data) {
      await supabase.from("custom_roles").delete().eq("id", id);
      return fromCustomRole(sel.data);
    }
  }
  const db = fileRead();
  if (!Array.isArray(db.customRoles)) db.customRoles = [];
  const idx = db.customRoles.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const removed = db.customRoles[idx];
  db.customRoles.splice(idx, 1);
  // Cascade in file fallback.
  if (Array.isArray(db.roleFeatureAccess)) {
    db.roleFeatureAccess = db.roleFeatureAccess.filter((rf) => rf.roleId !== id);
  }
  fileWrite(db);
  return removed;
}

export async function listRoleFeatureAccess(roleId) {
  if (supabaseEnabled) {
    const sel = await supabase.from("role_feature_access").select("*").eq("role_id", roleId);
    if (!sel.error) return (sel.data || []).map(fromRoleFeature);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] role_feature_access fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  return (Array.isArray(db.roleFeatureAccess) ? db.roleFeatureAccess : []).filter((rf) => rf.roleId === roleId);
}

export async function setRoleFeatureAccess(roleId, featureName, { canView = true, canEdit = false, canDelete = false } = {}) {
  if (!roleId)      throw new Error("roleId required");
  if (!featureName) throw new Error("featureName required");
  const id = `${roleId}::${featureName}`;
  const row = {
    id, role_id: roleId, feature_name: featureName,
    can_view: !!canView, can_edit: !!canEdit, can_delete: !!canDelete,
  };
  if (supabaseEnabled) {
    const up = await supabase.from("role_feature_access").upsert(row, { onConflict: "role_id,feature_name" }).select().maybeSingle();
    if (!up.error && up.data) return fromRoleFeature(up.data);
    if (up.error && !isSchemaMissError(up.error)) console.warn(`[db] role_feature_access upsert fell back: ${up.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.roleFeatureAccess)) db.roleFeatureAccess = [];
  const idx = db.roleFeatureAccess.findIndex((rf) => rf.roleId === roleId && rf.featureName === featureName);
  const local = { id, roleId, featureName, canView: row.can_view, canEdit: row.can_edit, canDelete: row.can_delete };
  if (idx === -1) db.roleFeatureAccess.unshift(local);
  else            db.roleFeatureAccess[idx] = local;
  fileWrite(db);
  return local;
}

// ---------- messages (parent ↔ admin direct chat) -----------------------
const fromMessage = (r) => r ? ({
  id: r.id,
  senderId: r.sender_id, receiverId: r.receiver_id,
  senderRole: r.sender_role, receiverRole: r.receiver_role,
  message: r.message,
  isRead: !!r.is_read,
  createdAt: r.created_at,
}) : null;

export async function addMessage({ senderId, receiverId, senderRole, receiverRole, message } = {}) {
  if (!senderId || !receiverId) throw new Error("senderId and receiverId required");
  if (!message || !String(message).trim()) throw new Error("message required");
  const id = `MSG-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id, sender_id: senderId, receiver_id: receiverId,
    sender_role: senderRole || "", receiver_role: receiverRole || "",
    message: String(message).trim().slice(0, 4000),
    is_read: false,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("messages").insert(row).select().single();
    if (!ins.error) return fromMessage(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.messages)) db.messages = [];
  const local = {
    id, senderId, receiverId,
    senderRole: row.sender_role, receiverRole: row.receiver_role,
    message: row.message, isRead: false,
    createdAt: new Date().toISOString(),
  };
  db.messages.unshift(local);
  fileWrite(db);
  return local;
}

// Fetch every message between two specific users (both directions),
// chronological. Used by the chat panel.
export async function listMessagesBetween(userA, userB, { limit = 200 } = {}) {
  if (!userA || !userB) return [];
  if (supabaseEnabled) {
    const sel = await supabase
      .from("messages").select("*")
      .or(`and(sender_id.eq.${userA},receiver_id.eq.${userB}),and(sender_id.eq.${userB},receiver_id.eq.${userA})`)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (!sel.error) return (sel.data || []).map(fromMessage);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] messages fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  const all = Array.isArray(db.messages) ? db.messages : [];
  return all
    .filter((m) =>
      (m.senderId === userA && m.receiverId === userB) ||
      (m.senderId === userB && m.receiverId === userA))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, limit);
}

// Inbox view for the receiver — distinct conversation partners with the
// last message + unread count. Used by the admin "Parent messages"
// screen and by the parent's "Message admin" thread picker.
export async function listMessageThreads(userId) {
  if (!userId) return [];
  let messages = [];
  if (supabaseEnabled) {
    const sel = await supabase.from("messages").select("*")
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order("created_at", { ascending: false })
      .limit(500);
    if (!sel.error) messages = (sel.data || []).map(fromMessage);
    else if (!isSchemaMissError(sel.error)) console.warn(`[db] messages threads fell back: ${sel.error.message}`);
  }
  if (!messages.length) {
    const db = fileRead();
    messages = (Array.isArray(db.messages) ? db.messages : [])
      .filter((m) => m.senderId === userId || m.receiverId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  const threads = new Map();
  for (const m of messages) {
    const other = m.senderId === userId ? m.receiverId : m.senderId;
    const otherRole = m.senderId === userId ? m.receiverRole : m.senderRole;
    if (!threads.has(other)) {
      threads.set(other, {
        otherId: other, otherRole,
        lastMessage: m.message, lastAt: m.createdAt,
        unread: 0,
      });
    }
    if (!m.isRead && m.receiverId === userId) {
      threads.get(other).unread++;
    }
  }
  return Array.from(threads.values()).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}

// Mark every message from `fromUser` to `toUser` as read.
export async function markMessagesReadBetween(fromUser, toUser) {
  if (supabaseEnabled) {
    await supabase.from("messages").update({ is_read: true })
      .eq("sender_id", fromUser).eq("receiver_id", toUser).eq("is_read", false);
  }
  const db = fileRead();
  if (!Array.isArray(db.messages)) db.messages = [];
  let touched = 0;
  for (let i = 0; i < db.messages.length; i++) {
    const m = db.messages[i];
    if (m.senderId === fromUser && m.receiverId === toUser && !m.isRead) {
      db.messages[i] = { ...m, isRead: true };
      touched++;
    }
  }
  if (touched) fileWrite(db);
  return touched;
}

// =====================================================================
// SCALE — sessions + entries persistence (cloud + file dual write).
// Indicator catalogue + score math live in backend/lib/scale.js.
// =====================================================================

const fromScaleSession = (r) => r ? ({
  id: r.id, teacherId: r.teacher_id, cls: r.cls, subject: r.subject,
  sessionDate: r.session_date, sessionType: r.session_type,
  studentsPresent: r.students_present || 0,
  preChecklist:  r.pre_checklist  || {},
  duringRatings: r.during_ratings || {},
  postRatings:   r.post_ratings   || {},
  workedWell: r.worked_well, toChange: r.to_change,
  signoff: r.signoff || {}, notes: r.notes,
  createdAt: r.created_at,
}) : null;

const fromScaleEntry = (r) => r ? ({
  id: r.id, sessionId: r.session_id, studentId: r.student_id,
  indicatorKey: r.indicator_key, score: r.score, note: r.note,
  createdAt: r.created_at,
}) : null;

export async function addScaleSession({
  teacherId, cls = null, subject = null,
  sessionDate, sessionType = "regular", studentsPresent = 0,
  preChecklist = {}, duringRatings = {}, postRatings = {},
  workedWell = null, toChange = null, signoff = {}, notes = null,
} = {}) {
  if (!sessionDate) throw new Error("sessionDate required");
  const id = `SCS-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999)}`;
  const row = {
    id, teacher_id: teacherId || null,
    cls, subject,
    session_date: sessionDate,
    session_type: sessionType,
    students_present: Math.max(0, Number(studentsPresent) || 0),
    pre_checklist:  preChecklist  || {},
    during_ratings: duringRatings || {},
    post_ratings:   postRatings   || {},
    worked_well: workedWell ? String(workedWell).slice(0, 500) : null,
    to_change:   toChange   ? String(toChange).slice(0, 500)   : null,
    signoff: signoff || {},
    notes:   notes ? String(notes).slice(0, 1000) : null,
  };
  if (supabaseEnabled) {
    const ins = await supabase.from("scale_sessions").insert(row).select().single();
    if (!ins.error) return fromScaleSession(ins.data);
    if (!isSchemaMissError(ins.error)) throw new Error(ins.error.message);
  }
  const db = fileRead();
  if (!Array.isArray(db.scaleSessions)) db.scaleSessions = [];
  const local = {
    id, teacherId, cls, subject,
    sessionDate, sessionType, studentsPresent: row.students_present,
    preChecklist: row.pre_checklist, duringRatings: row.during_ratings,
    postRatings: row.post_ratings, workedWell: row.worked_well,
    toChange: row.to_change, signoff, notes: row.notes,
    createdAt: new Date().toISOString(),
  };
  db.scaleSessions.unshift(local);
  fileWrite(db);
  return local;
}

export async function listScaleSessions({ teacherId, cls, dateFrom, dateTo, limit = 200 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("scale_sessions").select("*").order("session_date", { ascending: false }).limit(limit);
    if (teacherId) q = q.eq("teacher_id", teacherId);
    if (cls)       q = q.eq("cls", cls);
    if (dateFrom)  q = q.gte("session_date", dateFrom);
    if (dateTo)    q = q.lte("session_date", dateTo);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromScaleSession);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] scale_sessions fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.scaleSessions) ? db.scaleSessions : [];
  if (teacherId) all = all.filter((s) => s.teacherId === teacherId);
  if (cls)       all = all.filter((s) => s.cls === cls);
  if (dateFrom)  all = all.filter((s) => (s.sessionDate || "") >= dateFrom);
  if (dateTo)    all = all.filter((s) => (s.sessionDate || "") <= dateTo);
  return all.slice(0, limit);
}

// Bulk insert. `entries` is [{ studentId, indicatorKey, score, note? }].
export async function addScaleEntries(sessionId, entries) {
  if (!sessionId) throw new Error("sessionId required");
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const rows = entries
    .filter((e) => e && e.studentId && e.indicatorKey && Number.isFinite(e.score))
    .map((e) => ({
      id: `SCE-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999999)}`,
      session_id: sessionId,
      student_id: e.studentId,
      indicator_key: e.indicatorKey,
      // Clamp to the indicator's own scale (1-10, Yes/No, G/VG/E) — not a flat 4.
      score: Math.max(1, Math.min(indicatorMax(e.indicatorKey), Math.round(Number(e.score)))),
      note: e.note ? String(e.note).slice(0, 240) : null,
    }));
  if (rows.length === 0) return [];
  if (supabaseEnabled) {
    const ins = await supabase.from("scale_entries").insert(rows).select();
    if (!ins.error) return (ins.data || []).map(fromScaleEntry);
    if (!isSchemaMissError(ins.error)) console.warn(`[db] scale_entries insert fell back: ${ins.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.scaleEntries)) db.scaleEntries = [];
  const local = rows.map((r) => ({
    id: r.id, sessionId: r.session_id, studentId: r.student_id,
    indicatorKey: r.indicator_key, score: r.score, note: r.note,
    createdAt: new Date().toISOString(),
  }));
  db.scaleEntries.unshift(...local);
  fileWrite(db);
  return local;
}

export async function listScaleEntries({ studentId, sessionId, dateFrom, dateTo, limit = 1000 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("scale_entries").select("*").order("created_at", { ascending: false }).limit(limit);
    if (studentId) q = q.eq("student_id", studentId);
    if (sessionId) q = q.eq("session_id", sessionId);
    if (dateFrom)  q = q.gte("created_at", dateFrom);
    if (dateTo)    q = q.lte("created_at", dateTo);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromScaleEntry);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] scale_entries fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.scaleEntries) ? db.scaleEntries : [];
  if (studentId) all = all.filter((e) => e.studentId === studentId);
  if (sessionId) all = all.filter((e) => e.sessionId === sessionId);
  if (dateFrom)  all = all.filter((e) => (e.createdAt || "") >= dateFrom);
  if (dateTo)    all = all.filter((e) => (e.createdAt || "") <= dateTo);
  return all.slice(0, limit);
}

// =====================================================================
// SCALE Phase 4 — weaker-student support plans (sequenced workflow).
// =====================================================================

const fromSupportPlan = (r) => r ? ({
  id: r.id, studentId: r.student_id, term: r.term,
  currentStep: r.current_step || 1,
  rootCause:      r.root_cause      || {},
  domainAdvisory: r.domain_advisory || {},
  strengthPlan:   r.strength_plan   || {},
  referral:       r.referral        || {},
  status: r.status || "active",
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
}) : null;

export async function listSupportPlans({ studentId, status, limit = 200 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("scale_support_plans").select("*").order("updated_at", { ascending: false }).limit(limit);
    if (studentId) q = q.eq("student_id", studentId);
    if (status)    q = q.eq("status", status);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromSupportPlan);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] scale_support_plans fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.scaleSupportPlans) ? db.scaleSupportPlans : [];
  if (studentId) all = all.filter((p) => p.studentId === studentId);
  if (status)    all = all.filter((p) => p.status === status);
  return all.slice(0, limit);
}

export async function upsertSupportPlan(plan = {}) {
  if (!plan.studentId) throw new Error("studentId required");
  const term = plan.term || "all";
  const id = plan.id || `SSP-${plan.studentId}-${term}`;
  const now = new Date().toISOString();
  const row = {
    id, student_id: plan.studentId, term,
    current_step: Math.max(1, Math.min(5, Number(plan.currentStep) || 1)),
    root_cause:      plan.rootCause      || {},
    domain_advisory: plan.domainAdvisory || {},
    strength_plan:   plan.strengthPlan   || {},
    referral:        plan.referral       || {},
    status: plan.status || "active",
    created_by: plan.createdBy || null,
    updated_at: now,
  };
  if (supabaseEnabled) {
    const up = await supabase.from("scale_support_plans").upsert(row, { onConflict: "id" }).select().maybeSingle();
    if (!up.error && up.data) return fromSupportPlan(up.data);
    if (up.error && !isSchemaMissError(up.error)) console.warn(`[db] scale_support_plans upsert fell back: ${up.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.scaleSupportPlans)) db.scaleSupportPlans = [];
  const idx = db.scaleSupportPlans.findIndex((p) => p.id === id);
  const local = {
    id, studentId: plan.studentId, term,
    currentStep: row.current_step,
    rootCause: row.root_cause, domainAdvisory: row.domain_advisory,
    strengthPlan: row.strength_plan, referral: row.referral,
    status: row.status, createdBy: row.created_by,
    createdAt: idx >= 0 ? db.scaleSupportPlans[idx].createdAt : now,
    updatedAt: now,
  };
  if (idx === -1) db.scaleSupportPlans.unshift(local);
  else            db.scaleSupportPlans[idx] = local;
  fileWrite(db);
  return local;
}

// =====================================================================
// SCALE Phase 5 — student daily 3-question ritual.
// =====================================================================

const fromDailyRitual = (r) => r ? ({
  id: r.id, studentId: r.student_id, ritualDate: r.ritual_date,
  q1Learned: r.q1_learned, q2DidWell: r.q2_did_well, q3Tomorrow: r.q3_tomorrow,
  recordedBy: r.recorded_by, createdAt: r.created_at,
}) : null;

export async function listDailyRituals({ studentId, dateFrom, dateTo, limit = 60 } = {}) {
  if (supabaseEnabled) {
    let q = supabase.from("scale_daily_rituals").select("*").order("ritual_date", { ascending: false }).limit(limit);
    if (studentId) q = q.eq("student_id", studentId);
    if (dateFrom)  q = q.gte("ritual_date", dateFrom);
    if (dateTo)    q = q.lte("ritual_date", dateTo);
    const sel = await q;
    if (!sel.error) return (sel.data || []).map(fromDailyRitual);
    if (!isSchemaMissError(sel.error)) console.warn(`[db] scale_daily_rituals fell back: ${sel.error.message}`);
  }
  const db = fileRead();
  let all = Array.isArray(db.scaleDailyRituals) ? db.scaleDailyRituals : [];
  if (studentId) all = all.filter((r) => r.studentId === studentId);
  if (dateFrom)  all = all.filter((r) => (r.ritualDate || "") >= dateFrom);
  if (dateTo)    all = all.filter((r) => (r.ritualDate || "") <= dateTo);
  return all.slice(0, limit);
}

export async function upsertDailyRitual({ studentId, ritualDate, q1Learned, q2DidWell, q3Tomorrow, recordedBy } = {}) {
  if (!studentId)  throw new Error("studentId required");
  if (!ritualDate) throw new Error("ritualDate required");
  const id = `SDR-${studentId}-${ritualDate}`;
  const row = {
    id, student_id: studentId, ritual_date: ritualDate,
    q1_learned: q1Learned ? String(q1Learned).slice(0, 500) : null,
    q2_did_well: q2DidWell ? String(q2DidWell).slice(0, 500) : null,
    q3_tomorrow: q3Tomorrow ? String(q3Tomorrow).slice(0, 500) : null,
    recorded_by: recordedBy || null,
  };
  if (supabaseEnabled) {
    const up = await supabase.from("scale_daily_rituals").upsert(row, { onConflict: "id" }).select().maybeSingle();
    if (!up.error && up.data) return fromDailyRitual(up.data);
    if (up.error && !isSchemaMissError(up.error)) console.warn(`[db] scale_daily_rituals upsert fell back: ${up.error.message}`);
  }
  const db = fileRead();
  if (!Array.isArray(db.scaleDailyRituals)) db.scaleDailyRituals = [];
  const idx = db.scaleDailyRituals.findIndex((r) => r.id === id);
  const local = {
    id, studentId, ritualDate,
    q1Learned: row.q1_learned, q2DidWell: row.q2_did_well, q3Tomorrow: row.q3_tomorrow,
    recordedBy, createdAt: idx >= 0 ? db.scaleDailyRituals[idx].createdAt : new Date().toISOString(),
  };
  if (idx === -1) db.scaleDailyRituals.unshift(local);
  else            db.scaleDailyRituals[idx] = local;
  fileWrite(db);
  return local;
}
