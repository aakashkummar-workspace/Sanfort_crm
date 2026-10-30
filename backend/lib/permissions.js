// Role permissions — what each role is allowed to see in the sidebar.
// Mirrors NAV_BY_ROLE on the client; this is the server-side default. Admin
// can flip any of these off via the Access control screen. Persisted to the
// `role_permissions` Supabase table when available, with a JSON-file fallback
// for the local dev backend.
//
// Convention: a missing entry == allowed (defensive default for new screens
// that haven't been recorded in the matrix yet).

import { fileRead, fileWrite } from "./db";
import { supabase, supabaseEnabled } from "./supabase";

function isSchemaMissError(err) {
  if (!err) return false;
  const msg = String(err.message || err.code || "").toLowerCase();
  return /relation .* does not exist|could not find the table|schema cache|column .* does not exist|undefined column/.test(msg);
}

// Every screen that COULD be in any role's nav. Used by the Access control
// screen to render toggles, and as the canonical id list. Keep this in sync
// with NAV_BY_ROLE in components/Sidebar.jsx — but it's defensive: extra ids
// here are harmless, missing ones still default to allowed.
export const ALL_FEATURES = [
  { id: "dashboard",     label: "Dashboard / Home / Today",   group: "Overview" },
  { id: "trust",         label: "Trust overview",             group: "Overview" },
  { id: "schools",       label: "Schools",                    group: "Overview" },
  { id: "money",         label: "Money / Finance",            group: "Money" },
  { id: "fees",          label: "Fees & UPI",                 group: "Money" },
  { id: "payroll",       label: "Teacher salary / payroll",    group: "Money" },
  { id: "students",      label: "Students / My students",     group: "People" },
  { id: "classes",       label: "Classes",                    group: "People" },
  { id: "attendance",    label: "Attendance",                 group: "People" },
  { id: "academic",      label: "Academic / Class tracker",   group: "People" },
  { id: "staff",         label: "Staff",                      group: "People" },
  { id: "transport",     label: "Transport",                  group: "Operations" },
  { id: "inventory",     label: "Inventory",                  group: "Operations" },
  { id: "library",       label: "Library",                    group: "Operations" },
  { id: "timetable",     label: "Timetable",                  group: "People" },
  { id: "communication", label: "Communication / Broadcasts", group: "Operations" },
  { id: "whatsapp",      label: "WhatsApp messages",          group: "Operations" },
  { id: "enquiries",     label: "Admissions",                 group: "CRM" },
  { id: "complaints",    label: "Complaints / Raise ticket",  group: "CRM" },
  { id: "donors",        label: "Donors",                     group: "CRM" },
  { id: "users",         label: "Users & Roles",              group: "Governance" },
  { id: "audit",         label: "Audit log",                  group: "Governance" },
  { id: "settings",      label: "Settings",                   group: "Governance" },
  { id: "access",        label: "Access control",             group: "Governance" },
  { id: "tasks",         label: "Tasks / My tasks",           group: "Governance" },
  { id: "tc",            label: "Transfer certificates",      group: "People" },
  { id: "chat",          label: "Parent–Teacher chat",        group: "Operations" },
  { id: "meetings",      label: "Meetings / PTAs",            group: "Operations" },
  { id: "volunteers",    label: "Volunteers",                 group: "CRM" },
  { id: "reports",       label: "Reports & Financials",       group: "Governance" },
  { id: "exams",         label: "Exams & Marks",              group: "People" },
  { id: "syllabus",      label: "Syllabus",                   group: "People" },
  { id: "my_attendance", label: "My attendance (self mark)",  group: "People" },
  // v2 additions
  { id: "leave",                label: "Leave requests",            group: "Workflow" },
  { id: "remarks_rewards",      label: "Remarks & rewards",         group: "Workflow" },
  { id: "student_activities",   label: "Student activities",        group: "Workflow" },
  { id: "programs",             label: "School programs",           group: "Operations" },
  { id: "progress_videos",      label: "Progress videos (upload)",  group: "Workflow" },
  { id: "my_progress_videos",   label: "Progress videos (watch)",   group: "Account" },
  { id: "donor_dashboard",      label: "Donor dashboard",           group: "Account" },
  { id: "messages",             label: "Parent ↔ Admin messages",   group: "Workflow" },
  { id: "government_documents", label: "Government documents",      group: "Governance" },
  { id: "custom_roles",         label: "Custom roles",              group: "Governance" },
  { id: "account",              label: "My account",                group: "Account" },
];

// Seven canonical roles. School / Trust Accountant added in v2.
// Must stay in step with ROLE_KEYS in backend/lib/auth.js. transport_manager
// and fees_manager were missing here, so readPermissions() never emitted a map
// for them and their nav fell back to defaults regardless of Access Control.
export const ROLES = [
  "admin", "academic_director", "principal", "teacher", "parent",
  "school_accountant", "trust_accountant", "transport_manager", "fees_manager",
  "donor",
];

// "Permanent" features — admin can never lock themselves out of these.
const ADMIN_LOCKED_ON = new Set(["access", "dashboard", "trust", "settings"]);

// Read the matrix from Supabase (preferred) with file-store fallback. Fills
// missing entries with `true` so brand-new features default to allowed.
//
// Returns `{ permissions, explicit }` where:
//   permissions[role][fid] — the resolved boolean (missing rows → true)
//   explicit[role][fid]   — whether there's an actual stored row for this
//                           (role, feature). Lets the sidebar distinguish
//                           "admin explicitly granted this" from "defaulted
//                           to true" — needed so toggling on a feature
//                           outside the role's default NAV_BY_ROLE actually
//                           adds it to the sidebar.
export async function readPermissions() {
  let raw = {};
  if (supabaseEnabled) {
    const sel = await supabase.from("role_permissions").select("role, feature_id, allowed");
    if (!sel.error) {
      for (const row of sel.data || []) {
        if (!raw[row.role]) raw[row.role] = {};
        raw[row.role][row.feature_id] = row.allowed !== false;
      }
    } else if (!isSchemaMissError(sel.error)) {
      console.warn(`[permissions] read fell back: ${sel.error.message}`);
    }
  }
  // Layer the file copy on top so older flips persisted to the JSON file
  // still apply when Supabase is empty.
  try {
    const db = fileRead();
    const fileRaw = db.rolePermissions && typeof db.rolePermissions === "object" ? db.rolePermissions : {};
    for (const role of Object.keys(fileRaw)) {
      if (!raw[role]) raw[role] = {};
      for (const fid of Object.keys(fileRaw[role] || {})) {
        if (raw[role][fid] === undefined) raw[role][fid] = !!fileRaw[role][fid];
      }
    }
  } catch {}
  const permissions = {};
  const explicit = {};
  for (const role of ROLES) {
    const roleMap = (raw[role] && typeof raw[role] === "object") ? raw[role] : {};
    permissions[role] = {};
    explicit[role] = {};
    for (const f of ALL_FEATURES) {
      const has = Object.prototype.hasOwnProperty.call(roleMap, f.id);
      if (role === "admin" && ADMIN_LOCKED_ON.has(f.id)) {
        permissions[role][f.id] = true;
        explicit[role][f.id] = true;
      } else {
        permissions[role][f.id] = roleMap[f.id] === false ? false : true;
        explicit[role][f.id] = has;
      }
    }
  }
  return { permissions, explicit };
}

// Write a partial patch — `{ role: { featureId: bool, ... } }`. Persists to
// Supabase and the file store, returns the fully merged matrix.
export async function writePermissions(patch) {
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
  const rows = [];
  for (const role of Object.keys(patch)) {
    if (!ROLES.includes(role)) continue;
    const roleMap = patch[role] || {};
    for (const fid of Object.keys(roleMap)) {
      if (role === "admin" && ADMIN_LOCKED_ON.has(fid)) continue;
      rows.push({ role, feature_id: fid, allowed: !!roleMap[fid], updated_at: new Date().toISOString() });
    }
  }
  if (supabaseEnabled && rows.length) {
    const up = await supabase.from("role_permissions").upsert(rows, { onConflict: "role,feature_id" });
    if (up.error && !isSchemaMissError(up.error)) {
      console.warn(`[permissions] upsert failed: ${up.error.message}`);
    }
  }
  // Mirror to the file store regardless so the dev fallback stays consistent.
  const db = fileRead();
  if (!db.rolePermissions || typeof db.rolePermissions !== "object") db.rolePermissions = {};
  for (const row of rows) {
    if (!db.rolePermissions[row.role]) db.rolePermissions[row.role] = {};
    db.rolePermissions[row.role][row.feature_id] = row.allowed;
  }
  fileWrite(db);
  return readPermissions();
}

export function isLockedOn(role, featureId) {
  return role === "admin" && ADMIN_LOCKED_ON.has(featureId);
}
