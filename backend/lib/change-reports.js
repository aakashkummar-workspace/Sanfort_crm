// Who may file a change report, and who may triage one.
//
// Kept in one small module because these two sets ARE the privacy boundary:
// a screenshot can contain any student's marks, any family's fee balance, or
// a staff member's salary. Scattering the role checks across routes is how
// one of them ends up wrong.
//
// Parents and donors are deliberately excluded from filing. A report queue
// that any parent can post to is a support inbox, not a developer queue, and
// the screenshots would then arrive from people outside the school.

export const CAN_FILE = new Set(["admin", "academic_director", "principal"]);

// Triagers see EVERY report, including other people's screenshots. Keep this
// smaller than CAN_FILE and widen it only deliberately.
export const CAN_TRIAGE = new Set(["admin", "principal"]);

export const canFile = (role) => CAN_FILE.has(String(role || ""));
export const canTriage = (role) => CAN_TRIAGE.has(String(role || ""));

export const REPORT_TYPES = [
  "bug", "logic_change", "new_feature", "ui_issue", "data_issue", "performance",
];
export const SEVERITIES = ["blocking", "major", "minor"];
export const STATUSES = [
  "new", "acknowledged", "in_progress", "fixed", "wont_fix", "duplicate",
];

// Plain language for the reporter. Nobody thinks in terms of "logic_change",
// so the dialog shows these and stores the key.
export const TYPE_LABELS = {
  bug:          { label: "Something is broken",             hint: "It errors, crashes, or does nothing" },
  data_issue:   { label: "Wrong information shown",         hint: "Numbers or details don't match reality" },
  logic_change: { label: "Works, but should work differently", hint: "The rule or behaviour needs changing" },
  new_feature:  { label: "Something is missing",            hint: "A new option or screen is needed" },
  ui_issue:     { label: "Layout or display problem",       hint: "Overlapping, cut off, hard to read" },
  performance:  { label: "Too slow",                        hint: "Takes a long time to load or save" },
};

export const SEVERITY_LABELS = {
  blocking: { label: "Blocking", hint: "I cannot do my work" },
  major:    { label: "Major",    hint: "Slows me down, I have a workaround" },
  minor:    { label: "Minor",    hint: "Cosmetic or rare" },
};

export const STATUS_LABELS = {
  new: "New",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
  fixed: "Fixed",
  wont_fix: "Won't fix",
  duplicate: "Duplicate",
};

// Statuses that still need somebody to act.
export const OPEN_STATUSES = new Set(["new", "acknowledged", "in_progress"]);
