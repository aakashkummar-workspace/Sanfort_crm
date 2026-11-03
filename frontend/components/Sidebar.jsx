"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { AvatarChip } from "./ui";

// Nav items per role. Five real roles now (admin replaces the old "super"
// demo; academic_director is brand new).
export const NAV_BY_ROLE = {
  admin: [
    { section: "Trust" },
    { id: "trust",     label: "Overview",     icon: "dashboard" },
    { id: "money",     label: "Finance",      icon: "money" },
    { id: "donors",    label: "Trust & Donors", icon: "donors" },
    { section: "School" },
    { id: "dashboard",  label: "Dashboard",    icon: "dashboard" },
    { id: "students",   label: "Students",     icon: "students" },
    { id: "classes",    label: "Classes",      icon: "book" },
    { id: "timetable",  label: "Timetable",    icon: "clock" },
    { id: "attendance", label: "Attendance",   icon: "check" },
    { id: "academic",   label: "Academic",     icon: "academic" },
    { id: "syllabus",   label: "Syllabus",     icon: "academic" },
    { id: "exams",      label: "Exams & Marks", icon: "reports" },
    { id: "class_progress", label: "Class progress", icon: "trending" },
    { id: "fees",      label: "Fees & UPI",   icon: "fees" },
    { id: "tc",        label: "Transfer certificates", icon: "reports" },
    { id: "staff",     label: "Staff",        icon: "staff" },
    { id: "payroll",   label: "Payroll",      icon: "money" },
    { id: "transport", label: "Transport",    icon: "bus" },
    { id: "inventory", label: "Inventory",    icon: "inventory" },
    { id: "library",   label: "Library",      icon: "book" },
    { id: "complaints",label: "Complaints",   icon: "complaint" },
    { id: "enquiries", label: "Admissions",   icon: "enquiry" },
    { id: "meetings",  label: "Meetings",     icon: "clock" },
    { id: "volunteers",label: "Volunteers",   icon: "users" },
    { id: "reports",   label: "Reports",      icon: "reports" },
    { id: "whatsapp",  label: "WhatsApp log", icon: "send" },
    { section: "People & workflow" },
    { id: "scale",                 label: "SCALE session",         icon: "academic" },
    { id: "scale_report",          label: "SCALE reports",         icon: "reports" },
    { id: "scale_admin",           label: "SCALE admin",           icon: "shield" },
    { id: "scale_advisory",        label: "Parent advisory",       icon: "send" },
    { id: "messages",              label: "Parent messages",       icon: "send" },
    { id: "leave",                 label: "Leave requests",        icon: "calendar" },
    { id: "remarks_rewards",       label: "Remarks & rewards",     icon: "shield" },
    { id: "student_activities",    label: "Student activities",    icon: "academic" },
    { id: "programs",              label: "Programs",              icon: "calendar" },
    { id: "progress_videos",       label: "Progress videos",       icon: "play" },
    { section: "Governance" },
    { id: "access",                label: "Access control",        icon: "shield" },
    { id: "custom_roles",          label: "Custom roles",          icon: "users" },
    { id: "tasks",                 label: "Tasks",                 icon: "check" },
    { id: "users",                 label: "Users & Roles",         icon: "users" },
    { id: "government_documents",  label: "Government documents",  icon: "reports" },
    // Its own section: it is the one screen an admin reaches for when
    // something needs explaining, and it was easy to miss buried in a
    // ten-item Governance list.
    { section: "Activity" },
    { id: "audit",                 label: "Activity history",      icon: "audit" },
    { id: "change_reports",       label: "Change reports",        icon: "flag" },
    { section: "System" },
    { id: "settings",              label: "Settings",              icon: "settings" },
    { id: "account",               label: "My account",            icon: "user" },
  ],
  academic_director: [
    { section: "Academics" },
    { id: "dashboard",  label: "Overview",     icon: "dashboard" },
    { id: "attendance", label: "Attendance",   icon: "check" },
    { id: "academic",   label: "Daily logs",   icon: "academic" },
    { id: "syllabus",   label: "Syllabus",     icon: "academic" },
    { id: "exams",      label: "Exams & Marks", icon: "reports" },
    { id: "class_progress", label: "Class progress", icon: "trending" },
    { id: "students",   label: "Students",     icon: "students" },
    { id: "classes",    label: "Classes",      icon: "book" },
    { id: "timetable",  label: "Timetable",    icon: "clock" },
    { section: "People" },
    { id: "complaints",label: "Complaints",   icon: "complaint" },
    { id: "communication", label: "Broadcasts", icon: "megaphone" },
    { id: "messages",      label: "Parent messages", icon: "send" },
    { id: "scale",                label: "SCALE session",         icon: "academic" },
    { id: "scale_report",         label: "SCALE reports",         icon: "reports" },
    { id: "scale_admin",          label: "SCALE admin",           icon: "shield" },
    { id: "scale_advisory",       label: "Parent advisory",       icon: "send" },
    { id: "leave",                label: "Leave requests",        icon: "calendar" },
    { id: "remarks_rewards",      label: "Remarks & rewards",     icon: "shield" },
    { id: "student_activities",   label: "Student activities",    icon: "academic" },
    { id: "programs",             label: "Programs",              icon: "calendar" },
    { id: "progress_videos",       label: "Progress videos",       icon: "play" },
    { id: "tasks",     label: "My tasks",     icon: "check" },
    { id: "change_reports", label: "Change reports", icon: "flag" },
    { section: "Account" },
    { id: "account",   label: "My account",   icon: "user" },
  ],
  principal: [
    { section: "Overview" },
    { id: "dashboard", label: "Dashboard",    icon: "dashboard" },
    { id: "money",     label: "Money",        icon: "money" },
    { id: "fees",      label: "Fees & Transaction", icon: "fees" },
    { section: "People" },
    { id: "students",   label: "Students",     icon: "students" },
    { id: "classes",    label: "Classes",      icon: "book" },
    { id: "timetable",  label: "Timetable",    icon: "clock" },
    { id: "attendance", label: "Attendance",   icon: "check" },
    { id: "academic",   label: "Academic",     icon: "academic" },
    { id: "syllabus",   label: "Syllabus",     icon: "academic" },
    { id: "exams",      label: "Exams & Marks", icon: "reports" },
    { id: "class_progress", label: "Class progress", icon: "trending" },
    { id: "staff",      label: "Staff",        icon: "staff" },
    { section: "Operations" },
    { id: "transport", label: "Transport",    icon: "bus" },
    { id: "inventory", label: "Inventory",    icon: "inventory" },
    { id: "library",   label: "Library",      icon: "book" },
    { id: "communication", label: "Communication", icon: "megaphone" },
    { id: "whatsapp",      label: "WhatsApp log",  icon: "send" },
    { section: "CRM" },
    { id: "enquiries", label: "Admissions",   icon: "enquiry" },
    { id: "complaints",label: "Complaints",   icon: "complaint" },
    { id: "donors",    label: "Donors",       icon: "donors" },
    { id: "volunteers",label: "Volunteers",   icon: "users" },
    { section: "Records" },
    { id: "tc",        label: "Transfer certs", icon: "reports" },
    { id: "meetings",  label: "Meetings",     icon: "clock" },
    { id: "reports",   label: "Reports",      icon: "reports" },
    { section: "Workflow" },
    { id: "scale",                label: "SCALE session",         icon: "academic" },
    { id: "scale_report",         label: "SCALE reports",         icon: "reports" },
    { id: "scale_admin",          label: "SCALE admin",           icon: "shield" },
    { id: "scale_advisory",       label: "Parent advisory",       icon: "send" },
    { id: "messages",             label: "Parent messages",       icon: "send" },
    { id: "leave",                label: "Leave requests",        icon: "calendar" },
    { id: "remarks_rewards",      label: "Remarks & rewards",     icon: "shield" },
    { id: "student_activities",   label: "Student activities",    icon: "academic" },
    { id: "programs",             label: "Programs",              icon: "calendar" },
    { id: "progress_videos",       label: "Progress videos",       icon: "play" },
    { id: "government_documents", label: "Government documents",  icon: "reports" },
    { section: "System" },
    { id: "change_reports",       label: "Change reports",        icon: "flag" },
    { id: "tasks",     label: "My tasks",     icon: "check" },
    { id: "account",   label: "My account",   icon: "user" },
  ],
  teacher: [
    { section: "My classroom" },
    { id: "dashboard",     label: "Today",          icon: "dashboard" },
    { id: "my_attendance", label: "My attendance",  icon: "check" },
    { id: "attendance",    label: "Class attendance", icon: "check" },
    { id: "timetable",     label: "Timetable",      icon: "clock" },
    { id: "academic",      label: "Class tracker",  icon: "academic" },
    { id: "syllabus",      label: "Syllabus",       icon: "academic" },
    { id: "exams",      label: "Exams & Marks", icon: "reports" },
    { id: "class_progress", label: "Class progress", icon: "trending" },
    { id: "students",   label: "My students",  icon: "students" },
    { id: "transport",  label: "Transport",    icon: "bus" },
    { id: "communication", label: "Broadcasts", icon: "megaphone" },
    { id: "messages",      label: "Parent messages", icon: "send" },
    { id: "meetings",   label: "Meetings",     icon: "clock" },
    { id: "library",    label: "Library",      icon: "book" },
    { section: "Workflow" },
    { id: "scale",                label: "SCALE session",         icon: "academic" },
    { id: "scale_report",         label: "SCALE report",          icon: "reports" },
    { id: "scale_advisory",       label: "Parent advisory",       icon: "send" },
    { id: "leave",                label: "Leave",                 icon: "calendar" },
    { id: "remarks_rewards",      label: "Remarks & rewards",     icon: "shield" },
    { id: "student_activities",   label: "Student activities",    icon: "academic" },
    { id: "programs",             label: "Programs",              icon: "calendar" },
    { id: "progress_videos",       label: "Progress videos",       icon: "play" },
    { section: "Admin" },
    { id: "users",      label: "Directory",    icon: "users" },
    { id: "complaints", label: "Complaints",   icon: "complaint" },
    { id: "tasks",      label: "My tasks",     icon: "check" },
    { id: "account",    label: "My account",   icon: "user" },
  ],
  parent: [
    { section: "My family" },
    { id: "dashboard",    label: "Home",         icon: "home" },
    { id: "academic",     label: "Academics",    icon: "academic" },
    { id: "syllabus",     label: "Syllabus",     icon: "academic" },
    // SCALE report + Daily ritual are intentionally NOT in the parent's
    // default nav — admins must explicitly enable them via Access
    // Control for schools that run the SCALE programme. Pre-this, every
    // school's parent saw "SCALE report" even if they hadn't bought into
    // the module, which was confusing.
    { id: "timetable",    label: "Timetable",    icon: "clock" },
    { id: "fees",         label: "Fees",         icon: "fees" },
    { id: "transport",    label: "Transport",    icon: "bus" },
    { id: "communication", label: "Broadcasts",   icon: "megaphone" },
    { id: "messages",     label: "Message admin", icon: "send" },
    { id: "meetings",     label: "Meetings",     icon: "clock" },
    { id: "library",      label: "Library",      icon: "book" },
    { id: "my_progress_videos", label: "Progress videos", icon: "play" },
    { section: "Workflow" },
    { id: "leave",                label: "Leave requests",        icon: "calendar" },
    { id: "remarks_rewards",      label: "Recognition",           icon: "shield" },
    { id: "student_activities",   label: "Achievements",          icon: "academic" },
    { id: "programs",             label: "Programs",              icon: "calendar" },
    { section: "Account" },
    { id: "account",   label: "My account",   icon: "user" },
  ],
  // Donor — the students they sponsor, and nothing else. Two items by
  // design: every other screen either exposes a child's family, finances or
  // welfare record, or is simply none of a sponsor's business.
  donor: [
    { section: "My sponsorship" },
    { id: "donor_dashboard", label: "My students", icon: "heart" },
    { id: "my_progress_videos", label: "Progress videos", icon: "play" },
    { section: "Account" },
    { id: "account",         label: "My account",  icon: "user" },
  ],
  // School Accountant — school finance only. No trust ledger, no
  // donations, no academic / staff modules.
  school_accountant: [
    { section: "School finance" },
    { id: "dashboard",  label: "Overview",      icon: "dashboard" },
    { id: "fees",       label: "Fees & UPI",    icon: "fees" },
    { id: "money",      label: "School expenses", icon: "money" },
    { id: "reports",    label: "Reports",       icon: "reports" },
    { section: "Records" },
    { id: "students",   label: "Students",      icon: "students" },
    // Staff visibility for payroll — server already returns the staff
    // roster to this role (treated as a manager in /api/data); this entry
    // surfaces the Staff screen in the nav so they can actually reach it.
    { id: "staff",      label: "Staff",         icon: "staff" },
    { section: "Activity" },
    { id: "audit",      label: "Activity history", icon: "audit" },
    { section: "Account" },
    { id: "account",    label: "My account",    icon: "user" },
  ],
  // Trust Accountant — trust finance only. Donations, trust expenses,
  // donor-form approvals.
  trust_accountant: [
    { section: "Trust finance" },
    { id: "trust",      label: "Overview",      icon: "dashboard" },
    { id: "money",      label: "Trust expenses", icon: "money" },
    { id: "donors",     label: "Donors",        icon: "donors" },
    { id: "reports",    label: "Reports",       icon: "reports" },
    { section: "Activity" },
    { id: "audit",      label: "Activity history", icon: "audit" },
    { section: "Account" },
    { id: "account",    label: "My account",    icon: "user" },
  ],
  // Transport Manager — buses, routes, and boarding only. No fees, exams,
  // staff, or student admin.
  transport_manager: [
    { section: "Transport" },
    { id: "transport", label: "Transport",  icon: "bus" },
    { section: "Account" },
    { id: "account",   label: "My account", icon: "user" },
  ],
  // Fees Manager — fee collection only, plus the SCALE session + reports.
  fees_manager: [
    { section: "Fees" },
    { id: "fees",         label: "Fees & UPI",    icon: "fees" },
    { section: "SCALE" },
    { id: "scale",        label: "SCALE session", icon: "academic" },
    { id: "scale_report", label: "SCALE reports", icon: "reports" },
    { section: "Account" },
    { id: "account",      label: "My account",    icon: "user" },
  ],
};

const ROLE_LABEL = {
  admin: "Admin",
  academic_director: "Academic Director",
  principal: "Principal",
  teacher: "Teacher",
  parent: "Parent",
  school_accountant: "School Accountant",
  trust_accountant: "Trust Accountant",
  transport_manager: "Transport Manager",
  fees_manager: "Fees Manager",
};

function initialsOf(name) {
  if (!name) return "—";
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || name[0].toUpperCase();
}

// Master catalog of every screen the app ships with — used to build a
// synthetic nav for custom-role users (whose role doesn't appear in
// NAV_BY_ROLE). The "section" buckets group features in a way that reads
// naturally on the sidebar.
const FEATURE_NAV_CATALOG = [
  { section: "Trust" },
  { id: "trust",                 label: "Overview",            icon: "dashboard" },
  { id: "money",                 label: "Finance",             icon: "money" },
  { id: "donors",                label: "Trust & Donors",      icon: "donors" },
  { section: "School" },
  { id: "dashboard",             label: "Dashboard",           icon: "dashboard" },
  { id: "students",              label: "Students",            icon: "students" },
  { id: "classes",               label: "Classes",             icon: "book" },
  { id: "timetable",             label: "Timetable",           icon: "clock" },
  { id: "attendance",            label: "Attendance",          icon: "check" },
  { id: "academic",              label: "Academic",            icon: "academic" },
  { id: "syllabus",              label: "Syllabus",            icon: "academic" },
  { id: "exams",                 label: "Exams & Marks",       icon: "reports" },
  { id: "class_progress",        label: "Class progress",      icon: "trending" },
  { id: "fees",                  label: "Fees & UPI",          icon: "fees" },
  { id: "tc",                    label: "Transfer certificates", icon: "reports" },
  { id: "staff",                 label: "Staff",               icon: "staff" },
  { id: "payroll",               label: "Payroll",             icon: "money" },
  { section: "Operations" },
  { id: "transport",             label: "Transport",           icon: "bus" },
  { id: "inventory",             label: "Inventory",           icon: "inventory" },
  { id: "library",               label: "Library",             icon: "book" },
  { id: "complaints",            label: "Complaints",          icon: "complaint" },
  { id: "enquiries",             label: "Admissions",          icon: "enquiry" },
  { id: "meetings",              label: "Meetings",            icon: "clock" },
  { id: "volunteers",            label: "Volunteers",          icon: "users" },
  { id: "reports",               label: "Reports",             icon: "reports" },
  { id: "communication",         label: "Communication",       icon: "megaphone" },
  { id: "messages",              label: "Parent messages",     icon: "send" },
  { id: "whatsapp",              label: "WhatsApp log",        icon: "send" },
  { section: "Workflow" },
  { id: "leave",                 label: "Leave requests",      icon: "calendar" },
  { id: "remarks_rewards",       label: "Remarks & rewards",   icon: "shield" },
  { id: "student_activities",    label: "Student activities",  icon: "academic" },
  { id: "programs",              label: "Programs",            icon: "calendar" },
  { id: "progress_videos",       label: "Progress videos",       icon: "play" },
  { section: "Governance" },
  { id: "access",                label: "Access control",      icon: "shield" },
  { id: "tasks",                 label: "Tasks",               icon: "check" },
  { id: "users",                 label: "Users & Roles",       icon: "users" },
  { id: "custom_roles",          label: "Custom roles",        icon: "users" },
  { id: "government_documents",  label: "Government documents",icon: "reports" },
  { id: "audit",                 label: "Activity history",    icon: "audit" },
  { id: "change_reports",        label: "Change reports",      icon: "flag" },
  { id: "settings",              label: "Settings",            icon: "settings" },
  { section: "Account" },
  { id: "account",               label: "My account",          icon: "user" },
];

// True if the role isn't one of the seven canonical ones — i.e. it's a
// custom role created on the Custom Roles screen. Custom role ids are
// generated as "role-<slug>-<token>".
function isCustomRoleKey(role) {
  return typeof role === "string" && (role.startsWith("role-") || !NAV_BY_ROLE[role]);
}

// Build the sidebar nav for a role from its NAV_BY_ROLE default plus any
// extra features the admin has explicitly granted via Access Control.
//
// Two-pass logic:
//   1. Start with NAV_BY_ROLE[role] (or FEATURE_NAV_CATALOG for custom
//      roles) and remove any item the admin toggled OFF.
//   2. For canonical roles, walk FEATURE_NAV_CATALOG and ADD any feature
//      where `permExplicit[role][id] === true` AND the resolved value is
//      true AND it's not already present. This makes Access Control fully
//      bi-directional for the sparse-nav roles (Trust Accountant, School
//      Accountant, Parent) — toggling on a feature outside their default
//      nav actually adds it.
//
// Exported because AppShell uses `getAllowedNavIds(...)` to drive its
// auto-snap effect against the same set the sidebar shows.
export function buildSidebarNav(role, permissions, permExplicit) {
  const isCustom = isCustomRoleKey(role);
  const base = NAV_BY_ROLE[role] || (isCustom ? FEATURE_NAV_CATALOG : NAV_BY_ROLE.admin);
  const rolePerms = (permissions && permissions[role]) || null;
  const roleExplicit = (permExplicit && permExplicit[role]) || null;

  // Pass 1: filter base list by admin toggles. Missing perms => allowed.
  const kept = [];
  if (!rolePerms) {
    kept.push(...base);
  } else {
    let pendingSection = null;
    for (const it of base) {
      if (it.section) { pendingSection = it; continue; }
      if (rolePerms[it.id] === false) continue;
      if (pendingSection) { kept.push(pendingSection); pendingSection = null; }
      kept.push(it);
    }
  }

  // Pass 2: for canonical roles only, append admin-granted extras that
  // aren't already in `kept`. Skipped for custom roles (whose base list
  // is already FEATURE_NAV_CATALOG).
  if (!isCustom && rolePerms && roleExplicit) {
    const presentIds = new Set(kept.filter((it) => it.id).map((it) => it.id));
    let pendingSection = null;
    for (const cat of FEATURE_NAV_CATALOG) {
      if (cat.section) { pendingSection = cat; continue; }
      if (presentIds.has(cat.id)) continue;
      if (!roleExplicit[cat.id]) continue;          // not explicitly touched by admin
      if (rolePerms[cat.id] === false) continue;    // explicit OFF still wins
      if (pendingSection) { kept.push(pendingSection); pendingSection = null; }
      kept.push(cat);
      presentIds.add(cat.id);
    }
  }

  return kept;
}

// Just the ids (no section headers) — used by AppShell's auto-snap.
export function getAllowedNavIds(role, permissions, permExplicit) {
  return buildSidebarNav(role, permissions, permExplicit)
    .filter((it) => it.id)
    .map((it) => it.id);
}

export default function Sidebar({ current, setCurrent, role, user, permissions, permExplicit }) {
  const items = buildSidebarNav(role, permissions, permExplicit);

  // Group the flat items[] into [{ name, items: [...] }] blocks so each
  // category becomes a collapsible dropdown. Items that come before any
  // section header (rare, but possible) bucket under the synthetic "" group.
  const groups = useMemo(() => {
    const out = [];
    let cur = { name: "", items: [] };
    for (const it of items) {
      if (it.section) {
        if (cur.items.length || cur.name) out.push(cur);
        cur = { name: it.section, items: [] };
      } else {
        cur.items.push(it);
      }
    }
    if (cur.items.length || cur.name) out.push(cur);
    return out;
  }, [items]);

  // Per-role collapsed state, persisted to localStorage so a closed group
  // stays closed across reloads. Default: every group expanded.
  const storageKey = `vidyalaya360.sidebar.collapsed.${role}`;
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Whether the WhatsApp service is locked for non-payment. Shown as a padlock
  // on the WhatsApp log item so it is obvious without opening the page.
  const [waLocked, setWaLocked] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch("/api/admin/whatsapp-diagnostic");
        if (!r.ok) return;
        const j = await r.json();
        if (alive) setWaLocked(j?.service?.allowed === false);
      } catch { /* a sidebar must never break on a failed poll */ }
    };
    check();
    const t = setInterval(check, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setCollapsed(new Set(JSON.parse(raw) || []));
      else setCollapsed(new Set());
    } catch { setCollapsed(new Set()); }
  }, [storageKey]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify([...collapsed])); } catch {}
  }, [collapsed, storageKey]);

  // Auto-expand the group that contains the active item — fires only on
  // navigation (`current` change), not on every re-render. If we also
  // reacted to `groups` changing, manual collapses would immediately get
  // undone because `groups` is a fresh array on every render and the
  // active section always contains the currently-active item.
  useEffect(() => {
    let targetSection = null;
    for (const g of groups) {
      if (g.name && g.items.find((it) => it.id === current)) {
        targetSection = g.name;
        break;
      }
    }
    if (!targetSection) return;
    setCollapsed((prev) => {
      if (!prev.has(targetSection)) return prev; // already expanded
      const next = new Set(prev);
      next.delete(targetSection);
      return next;
    });
  // Intentional: only re-run when navigation happens. groups/collapsed are
  // read freshly inside but not deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const toggleGroup = (name) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  // Track which collapsed group the cursor is currently over so we can
  // temporarily peek-expand it without changing the user's pinned state.
  // null means no group is being hovered.
  const [hoverGroup, setHoverGroup] = useState(null);

  const displayName = user?.name || "Signed in";
  return (
    <aside className="sidebar">
      <div className="brand">
        {/* Brand mark uses the school's actual logo (served from /public/logo.png).
            The wrapping div keeps the rounded square frame consistent with the
            rest of the design system. */}
        <div className="brand-mark" style={{ background: "#fff", padding: 2, overflow: "hidden" }}>
          <img src="/logo.png" alt="Sanfort International School" style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
        </div>
        <div className="brand-text">
          <div className="b1">
            Sanfort<span className="num"> International</span>
          </div>
        </div>
      </div>
      <div className="side-groups" style={{ overflowY: "auto", flex: 1, marginTop: 4 }}>
        {groups.map((group, gi) => {
          const pinnedCollapsed = group.name && collapsed.has(group.name);
          const peeking = group.name && hoverGroup === group.name;
          // visualOpen: items are visible iff the group is either not
          // pinned-collapsed, OR the cursor is hovering over it (peek-expand).
          const visualOpen = !pinnedCollapsed || peeking;
          return (
            <div
              key={gi}
              className={`side-group ${visualOpen ? "open" : "closed"} ${peeking ? "peek" : ""}`}
              onMouseEnter={() => group.name && pinnedCollapsed && setHoverGroup(group.name)}
              onMouseLeave={() => peeking && setHoverGroup(null)}
            >
              {group.name && (
                <button
                  type="button"
                  className="side-section"
                  onClick={() => toggleGroup(group.name)}
                  title={pinnedCollapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                >
                  <Icon
                    name="chevronDown"
                    size={10}
                    className="side-section-chev"
                    style={{
                      transform: visualOpen ? "rotate(0deg)" : "rotate(-90deg)",
                    }}
                  />
                  <span style={{ flex: 1 }}>{group.name}</span>
                  {pinnedCollapsed && !peeking && group.items.length > 0 && (
                    <span className="side-section-count">{group.items.length}</span>
                  )}
                </button>
              )}
              <div className="side-group-items">
                <div className="side-group-items-inner">
                  {group.items.map((it) => {
                    const active = current === it.id;
                    return (
                      <div key={it.id} className={`side-item ${active ? "active" : ""}`} onClick={() => setCurrent(it.id)}>
                        <Icon name={it.icon} size={16} className="side-icon" />
                        <span className="side-lbl">{it.label}</span>
                        {it.id === "whatsapp" && waLocked && (
                          <span
                            title="WhatsApp messaging is paused — the service is not paid up"
                            style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", color: "var(--bad, #dc2626)" }}
                          >
                            <Icon name="warning" size={13} />
                          </span>
                        )}
                        {it.live && (
                          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ok)", fontSize: 10.5, fontWeight: 500 }}>
                            <span className="pulse-dot" />
                            Live
                          </span>
                        )}
                        {it.badge && <span className={`side-badge ${it.badgeAlert ? "alert" : ""}`}>{it.badge}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <style jsx>{`
        .side-groups :global(.side-group) {
          margin-bottom: 10px;
        }
        .side-groups :global(.side-group + .side-group) {
          margin-top: 8px;
        }
        .side-groups :global(.side-section) {
          width: 100%;
          background: none;
          border: 0;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          text-align: left;
          padding: 14px 14px 6px;
          transition: color 0.15s ease;
        }
        .side-groups :global(.side-section:hover) {
          color: var(--ink-2);
        }
        .side-groups :global(.side-section-chev) {
          transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
          opacity: 0.7;
        }
        .side-groups :global(.side-section-count) {
          font-size: 9.5px;
          color: var(--ink-4);
          font-family: var(--font-mono);
          font-weight: 400;
        }
        /* The grid-template-rows 1fr -> 0fr trick gives a smooth height
           transition without needing a fixed max-height. The inner wrapper
           uses overflow:hidden so the items clip cleanly during transition. */
        .side-groups :global(.side-group-items) {
          display: grid;
          grid-template-rows: 1fr;
          transition: grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        .side-groups :global(.side-group.closed > .side-group-items) {
          grid-template-rows: 0fr;
        }
        .side-groups :global(.side-group-items-inner) {
          overflow: hidden;
          min-height: 0;
        }
        /* Peek-expand uses a slightly tinted background so the user sees
           which section the cursor is hovering. Doesn't shift layout — the
           grid transition above keeps the rest of the sidebar moving down
           naturally as the section opens. */
        .side-groups :global(.side-group.peek) {
          background: var(--bg-2);
          border-radius: 10px;
          transition: background 200ms ease;
        }
        .side-groups :global(.side-group.peek > .side-section) {
          color: var(--accent);
        }
      `}</style>
      <div className="side-foot">
        <AvatarChip initials={initialsOf(displayName)} />
        <div style={{ minWidth: 0, flex: 1 }} className="side-lbl">
          <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayName}</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{ROLE_LABEL[role] || role}</div>
        </div>
      </div>
    </aside>
  );
}
