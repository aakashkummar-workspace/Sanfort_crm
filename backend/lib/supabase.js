// Supabase client — server-side. Uses the service-role key when available so
// it can bypass RLS. Falls back to the anon key for read-only fetches.
import { createClient } from "@supabase/supabase-js";
import dns from "node:dns";

// Prefer IPv4 when resolving hostnames. On some hosts the IPv6 path to Supabase
// stalls, so a DB call intermittently hangs ~20s before falling back — which
// showed up as a frozen "Signing in…" and a 60s+ /api/data. IPv4-first avoids it.
try { dns.setDefaultResultOrder?.("ipv4first"); } catch {}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(url && (serviceKey || anonKey));


// Fetch used for every Supabase call:
//   - `cache: "no-store"` so Next.js's route-handler fetch cache doesn't
//     memoise our query results across requests (would surface stale/empty
//     rows intermittently).
//   - a short abort timeout + retry: the VPS↔Supabase link intermittently
//     stalls (a stale keep-alive TCP connection), so a call hangs until it
//     times out. Aborting at 6s and retrying on a fresh connection turns those
//     stalls into a quick success on the next attempt, instead of a 30s hang
//     (or a false failure). Retries are limited to reads (GET) so writes are
//     never double-applied; writes get a single, longer timeout.
// Real queries here return in well under a second, but the connection to
// Supabase intermittently *cold-stalls* (a new TCP/TLS connect hangs ~20s).
// So use a SHORT read timeout that only ever trips on a stall, and retry — a
// retry almost always lands on a working (kept-alive) connection. Keeping the
// timeout short also keeps each batch round quick, so Node's default HTTP
// keep-alive reuses warm connections instead of opening new stall-prone ones.
// Writes get a single, longer window (never retried, so never double-applied).
const TIMEOUT_MS = 3500;
const WRITE_TIMEOUT_MS = 25000;
const isRead = (method) => !method || String(method).toUpperCase() === "GET";

const supabaseFetch = async (input, init = {}) => {
  // If the caller already manages its own abort signal, don't interfere.
  if (init.signal) return fetch(input, { ...init, cache: "no-store" });

  const read = isRead(init.method);
  const attempts = read ? 4 : 1;
  const timeout = read ? TIMEOUT_MS : WRITE_TIMEOUT_MS;
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch(input, { ...init, cache: "no-store", signal: ctrl.signal });
    } catch (e) {
      // Only abort (timeout) / network errors reach here; retry those. A real
      // HTTP error (4xx/5xx) returns a Response and never throws.
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200));
  }
  throw lastErr;
};

export const supabase = supabaseEnabled
  ? createClient(url, serviceKey || anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: supabaseFetch },
    })
  : null;

// Mapping from snake_case columns to camelCase JSON shape used by screens.
// `transport` + `pickupStop` are the MORNING route. Evening lives in
// `transportEvening` + `pickupStopEvening` — added in a follow-up
// schema migration. Older rows where the columns don't exist (or the
// PostgREST cache hasn't picked them up yet) collapse to null, and the
// UI treats null as "same as morning" so legacy students still board.
export const fromStudent = (r) => r && {
  id: r.id, name: r.name, cls: r.cls, parent: r.parent,
  fee: r.fee, attendance: r.attendance, transport: r.transport,
  pickupStop: r.pickup_stop ?? r.pickupStop ?? null,
  transportEvening: r.transport_evening ?? r.transportEvening ?? null,
  pickupStopEvening: r.pickup_stop_evening ?? r.pickupStopEvening ?? null,
  heightCm: r.height_cm != null ? Number(r.height_cm) : (r.heightCm != null ? Number(r.heightCm) : null),
  weightKg: r.weight_kg != null ? Number(r.weight_kg) : (r.weightKg != null ? Number(r.weightKg) : null),
  measuredAt: r.measured_at ?? r.measuredAt ?? null,
  joined: r.joined,
  status: r.status ?? "active", archivedAt: r.archived_at ?? null,
};
export const toStudent = (r) => ({
  id: r.id, name: r.name, cls: r.cls, parent: r.parent ?? "—",
  fee: r.fee ?? "pending", attendance: r.attendance ?? 0,
  transport: r.transport ?? "—",
  pickup_stop: r.pickupStop ?? null,
  transport_evening: r.transportEvening ?? null,
  pickup_stop_evening: r.pickupStopEvening ?? null,
  height_cm: r.heightCm != null ? Number(r.heightCm) : null,
  weight_kg: r.weightKg != null ? Number(r.weightKg) : null,
  measured_at: r.measuredAt ?? null,
  joined: r.joined,
  status: r.status ?? "active",
});

export const fromPendingFee = (r) => r && {
  id: r.id, name: r.name, cls: r.cls, amount: r.amount,
  due: r.due, overdue: r.overdue,
  // student_id links this row back to the owning student (required when the
  // composite id is used, e.g. "STN-9001__kit"). Older rows without this
  // column fall back to the row id itself.
  studentId: r.student_id ?? r.studentId ?? r.id,
  // Fee category (one of FEE_TYPES keys). Older rows without this default to
  // "term1" downstream via feeTypeLabel().
  feeType: r.fee_type ?? r.feeType ?? null,
};
export const toPendingFee = (r) => ({
  id: r.id, name: r.name, cls: r.cls, amount: r.amount,
  due: r.due ?? "in 7 days", overdue: !!r.overdue,
  student_id: r.studentId ?? r.student_id ?? r.id,
  fee_type: r.feeType ?? r.fee_type ?? "term1",
});

export const fromRecentFee = (r) => r && {
  id: r.id, name: r.name, cls: r.cls, amount: r.amount,
  method: r.method, time: r.time, status: r.status ?? "paid",
  // student_id is the new column linking the receipt to the student row.
  // For older receipts that pre-date the column, fall back to using the
  // receipt id itself (those used student id as the primary key).
  studentId: r.student_id ?? r.studentId ?? r.id,
  // ISO timestamp added so Reports / Money screens can date-filter receipts.
  // Older rows (before this column existed) come back null — callers should
  // treat null as "unknown date" and decide whether to include or exclude.
  paidAt: r.paid_at ?? r.paidAt ?? null,
  // Which fee bucket this receipt covers (FEE_TYPES key). Older rows lack
  // this and render as Term I via feeTypeLabel().
  feeType: r.fee_type ?? r.feeType ?? null,
};

function parseSubjectLogs(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => ({
      subject: String(s?.subject || "").trim(),
      classwork: s?.classwork != null ? String(s.classwork) : "",
      classworkStatus: s?.classworkStatus || s?.classwork_status || null,
      homework: s?.homework != null ? String(s.homework) : "",
      homeworkStatus: s?.homeworkStatus || s?.homework_status || null,
    }))
    .filter((s) => s.subject);
}

export const fromDailyLog = (r) => r && {
  studentId: r.student_id, studentName: r.student_name, cls: r.cls,
  date: r.date,
  attendance: r.attendance ?? "present",
  leaveReason: r.leave_reason ?? "",
  classwork: r.classwork, classworkStatus: r.classwork_status ?? null,
  homework:  r.homework,  homeworkStatus:  r.homework_status  ?? null,
  subjectLogs: parseSubjectLogs(r.subject_logs ?? r.subjectLogs),
  topics: r.topics,
  handwritingNote: r.handwriting_note, handwritingGrade: r.handwriting_grade,
  behaviour: r.behaviour, extra: r.extra,
  postedBy: r.posted_by, postedAt: r.posted_at,
};

export const fromStaffAward = (r) => r && {
  id: r.id, staffId: r.staff_id, staffName: r.staff_name,
  title: r.title, citation: r.citation,
  category: r.category || "recognition",
  awardedAt: r.awarded_at, awardedBy: r.awarded_by,
  createdAt: r.created_at,
};
export const toStaffAward = (r) => ({
  id: r.id, staff_id: r.staffId, staff_name: r.staffName || null,
  title: r.title, citation: r.citation || null,
  category: r.category || "recognition",
  awarded_at: r.awardedAt || null, awarded_by: r.awardedBy || null,
});

export const fromTransportAttendance = (r) => r && {
  studentId: r.student_id, date: r.date,
  direction: r.direction || "morning",
  routeCode: r.route_code, stopName: r.stop_name,
  status: r.status || "boarded",
  studentName: r.student_name, cls: r.cls,
  markedBy: r.marked_by, markedAt: r.marked_at,
};
export const toTransportAttendance = (r) => ({
  student_id: r.studentId, date: r.date,
  direction: r.direction || "morning",
  route_code: r.routeCode || null, stop_name: r.stopName || null,
  status: r.status || "boarded",
  student_name: r.studentName || null, cls: r.cls || null,
  marked_by: r.markedBy || null,
});

export const fromAudit = (r) => r && {
  id: r.id, who: r.who, action: r.action, entity: r.entity,
  when: r.when_label, ip: r.ip,
};

export const fromActivity = (r) => r && {
  t: r.t, tone: r.tone, title: r.title, sub: r.sub, ts: r.ts,
};

export const fromComplaint = (r) => r && {
  id: r.id, student: r.student, cls: r.cls, parent: r.parent,
  issue: r.issue, date: r.date, status: r.status, assigned: r.assigned,
  studentId:   r.student_id ?? null,
  type:        r.type ?? "general",
  // Three buckets parents file under: academic / non_academic / transport.
  // Older rows (before this column existed) come back null.
  category:    r.category ?? null,
  submittedBy: r.submitted_by ?? "parent",
};
export const fromDonor = (r) => r && {
  id: r.id, name: r.name, type: r.type, email: r.email, phone: r.phone,
  ytd: r.ytd ?? 0, last: r.last_gift, next: r.next_touchpoint,
  archivedAt: r.archived_at ?? null,
};
export const toDonor = (r) => ({
  id: r.id, name: r.name, type: r.type ?? "Individual",
  email: r.email ?? null, phone: r.phone ?? null,
  ytd: r.ytd ?? 0,
  last_gift: r.last ?? null,
  next_touchpoint: r.next ?? null,
});

export const fromCampaign = (r) => r && {
  id: r.id, name: r.name, goal: r.goal ?? 0, raised: r.raised ?? 0,
  starts: r.starts, ends: r.ends, status: r.status ?? "active",
  description: r.description,
};
export const toCampaign = (r) => ({
  id: r.id, name: r.name, goal: r.goal ?? 0, raised: r.raised ?? 0,
  starts: r.starts ?? null, ends: r.ends ?? null,
  status: r.status ?? "active", description: r.description ?? null,
});

export const fromBroadcast = (r) => r && {
  id: r.id, campaign: r.campaign, channel: r.channel,
  audience: r.audience, audienceLabel: r.audience_label,
  message: r.message, sent: r.sent ?? 0, delivered: r.delivered ?? 0,
  sentAt: r.sent_at,
};
export const toBroadcast = (r) => ({
  id: r.id, campaign: r.campaign, channel: r.channel ?? "whatsapp",
  audience: r.audience ?? "all", audience_label: r.audienceLabel ?? null,
  message: r.message ?? "", sent: r.sent ?? 0, delivered: r.delivered ?? 0,
});

export const fromTemplate = (r) => r && {
  id: r.id, name: r.name, channel: r.channel ?? "whatsapp", body: r.body,
};
export const toTemplate = (r) => ({
  id: r.id, name: r.name, channel: r.channel ?? "whatsapp", body: r.body ?? "",
});

export const fromRecipientList = (r) => r && {
  id: r.id, name: r.name,
  contacts: Array.isArray(r.contacts) ? r.contacts : [],
};

export const fromInventory = (r) => r && {
  id: r.id, name: r.name, category: r.category, cls: r.cls,
  description: r.description ?? "",
  storageLocation: r.storage_location ?? r.storageLocation ?? "",
  onHand: r.on_hand != null ? Number(r.on_hand) : 0,
  min: r.min != null ? Number(r.min) : 0,
  issued: r.issued != null ? Number(r.issued) : 0,
  qtyPurchased: r.qty_purchased != null ? Number(r.qty_purchased) : (r.qtyPurchased != null ? Number(r.qtyPurchased) : 0),
  unitPrice: r.unit_price != null ? Number(r.unit_price) : 0,
  supplier: r.supplier,
  remarks: r.remarks ?? "",
  archivedAt: r.archived_at ?? null,
};
export const toInventory = (r) => ({
  id: r.id, name: r.name, category: r.category ?? "asset",
  cls: r.cls ?? null,
  description: r.description || null,
  storage_location: r.storageLocation || r.storage_location || null,
  on_hand: r.onHand ?? 0,
  min: r.min ?? 0,
  issued: r.issued ?? 0,
  qty_purchased: r.qtyPurchased ?? r.qty_purchased ?? 0,
  unit_price: r.unitPrice ?? 0,
  supplier: r.supplier ?? null,
  remarks: r.remarks ? String(r.remarks).trim() : null,
});

export const fromMovement = (r) => r && {
  id: r.id, itemId: r.item_id, type: r.type, qty: r.qty != null ? Number(r.qty) : 0,
  note: r.note, issuedTo: r.issued_to ?? r.issuedTo ?? null,
  who: r.who, at: r.at,
};

export const fromStaff = (r) => r && {
  id: r.id, name: r.name, role: r.role, dept: r.dept,
  phone: r.phone, email: r.email,
  joiningDate: r.joining_date, salary: r.salary,
  attendance: r.attendance ?? 0, tasks: r.tasks ?? 0,
  score: r.score ?? 0, status: r.status ?? "ok",
  avatar: r.avatar, archivedAt: r.archived_at ?? null,
};
export const toStaff = (r) => ({
  id: r.id, name: r.name, role: r.role ?? "Teacher",
  dept: r.dept ?? "—", phone: r.phone ?? "—", email: r.email ?? null,
  joining_date: r.joiningDate ?? null, salary: r.salary ?? 0,
  attendance: r.attendance ?? 0, tasks: r.tasks ?? 0,
  score: r.score ?? 0, status: r.status ?? "ok",
  avatar: r.avatar ?? null,
});

export const fromEnquiry = (r) => r && { ...r };
export const fromRoute = (r) => r && {
  code: r.code, name: r.name, driver: r.driver, attendant: r.attendant || "—", bus: r.bus,
  status: r.status, eta: r.eta, stops: r.stops || [],
  // 'morning' | 'evening' | 'both' — controls which student pickers
  // surface this route. Rows from before the migration default to 'both'
  // so they remain selectable in both AM and PM dropdowns.
  direction: r.direction || "both",
  // Run-level timestamps; may be absent on rows from before the
  // advanceRoute timestamp upgrade — UI treats null as "unknown".
  startedAt:   r.started_at   ?? r.startedAt   ?? null,
  completedAt: r.completed_at ?? r.completedAt ?? null,
  // Link back to the master timetable template this route was spawned
  // from (null = legacy free-hand route, no template).
  templateId:  r.template_id  ?? r.templateId  ?? null,
};

// Master timetable templates — see backend/migrations/route_templates.sql
// Stops here are the static spec only ({name, t}) — run-state fields
// (status, arrivedAt, boarded, absent) only live on the spawned routes row.
export const fromRouteTemplate = (r) => r && {
  code: r.code,
  name: r.name,
  bus: r.bus || "—",
  direction: r.direction === "evening" ? "evening" : "morning",
  tripNo: r.trip_no ?? r.tripNo ?? 1,
  active: r.active !== false,
  stops: Array.isArray(r.stops) ? r.stops.map((s) => ({
    name: s.name || "",
    t: s.t || "—",
  })) : [],
  createdAt: r.created_at ?? r.createdAt ?? null,
  updatedAt: r.updated_at ?? r.updatedAt ?? null,
};

export const toRouteTemplate = (r) => ({
  code: String(r.code || "").trim().toUpperCase(),
  name: String(r.name || r.code || "").trim(),
  bus: r.bus || "—",
  direction: r.direction === "evening" ? "evening" : "morning",
  trip_no: Number(r.tripNo || r.trip_no || 1) || 1,
  active: r.active === false ? false : true,
  stops: Array.isArray(r.stops) ? r.stops.map((s, i) => ({
    name: String(s.name || "").trim() || `Stop ${i + 1}`,
    t: s.t || "—",
  })) : [],
});

// ---------- new mappers ----------

export const fromTask = (r) => r && {
  id: r.id, title: r.title, description: r.description,
  assignedTo: r.assigned_to, assignedToName: r.assigned_to_name, assignedToRole: r.assigned_to_role,
  assignedBy: r.assigned_by, assignedByName: r.assigned_by_name,
  status: r.status ?? "pending", priority: r.priority ?? "normal",
  dueDate: r.due_date,
  response: r.response ?? null,
  remarks: r.remarks ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
};
export const toTask = (r) => ({
  id: r.id, title: r.title, description: r.description ?? null,
  assigned_to: r.assignedTo ?? null, assigned_to_name: r.assignedToName ?? null,
  assigned_to_role: r.assignedToRole ?? null,
  assigned_by: r.assignedBy ?? null, assigned_by_name: r.assignedByName ?? null,
  status: r.status ?? "pending", priority: r.priority ?? "normal",
  due_date: r.dueDate ?? null,
  response: r.response ?? null,
  remarks: r.remarks ?? null,
});

export const fromMeeting = (r) => r && {
  id: r.id, title: r.title, description: r.description,
  scheduledAt: r.scheduled_at, location: r.location,
  audience: r.audience, audienceLabel: r.audience_label,
  createdByEmail: r.created_by_email, createdByName: r.created_by_name,
  createdAt: r.created_at,
};
export const toMeeting = (r) => ({
  id: r.id, title: r.title, description: r.description ?? null,
  scheduled_at: r.scheduledAt, location: r.location ?? "School premises",
  audience: r.audience, audience_label: r.audienceLabel ?? r.audience,
  created_by_email: r.createdByEmail ?? null,
  created_by_name: r.createdByName ?? "Admin",
});

export const fromMeetingRsvp = (r) => r && {
  meetingId: r.meeting_id, fromEmail: r.from_email, fromName: r.from_name,
  response: r.response, respondedAt: r.responded_at,
};

export const fromVolunteer = (r) => r && {
  id: r.id, name: r.name, email: r.email, phone: r.phone,
  skills: Array.isArray(r.skills) ? r.skills : [],
  availability: r.availability ?? "weekends", notes: r.notes,
  hours: r.hours ?? 0, archivedAt: r.archived_at ?? null,
  createdAt: r.created_at,
};
export const toVolunteer = (r) => ({
  id: r.id, name: r.name, email: r.email ?? null, phone: r.phone ?? null,
  skills: Array.isArray(r.skills) ? r.skills : [],
  availability: r.availability ?? "weekends", notes: r.notes ?? null,
  hours: r.hours ?? 0,
});

export const fromVolunteerHours = (r) => r && {
  id: r.id, volunteerId: r.volunteer_id, hours: r.hours ?? 0,
  activity: r.activity ?? "—", date: r.date, createdAt: r.created_at,
};

export const fromChatThread = (r) => r && {
  id: r.id, parentEmail: r.parent_email, parentName: r.parent_name,
  teacherEmail: r.teacher_email, teacherName: r.teacher_name,
  studentId: r.student_id, studentName: r.student_name, cls: r.cls,
  createdAt: r.created_at, lastMessageAt: r.last_message_at,
};
export const toChatThread = (r) => ({
  id: r.id, parent_email: r.parentEmail, parent_name: r.parentName,
  teacher_email: r.teacherEmail, teacher_name: r.teacherName,
  student_id: r.studentId, student_name: r.studentName ?? "—",
  cls: r.cls ?? "—",
});

export const fromChatMessage = (r) => r && {
  id: r.id, threadId: r.thread_id,
  fromEmail: r.from_email, fromName: r.from_name, fromRole: r.from_role,
  body: r.body, sentAt: r.sent_at,
};

export const fromTcRequest = (r) => r && {
  id: r.id, studentId: r.student_id, studentName: r.student_name, cls: r.cls,
  reason: r.reason, status: r.status ?? "requested",
  requestedBy: r.requested_by, requestedAt: r.requested_at,
  issuedAt: r.issued_at, issuedBy: r.issued_by, serialNo: r.serial_no,
};
export const toTcRequest = (r) => ({
  id: r.id, student_id: r.studentId, student_name: r.studentName ?? "—",
  cls: r.cls ?? "—", reason: r.reason ?? null,
  status: r.status ?? "requested",
  requested_by: r.requestedBy ?? "Admin",
  issued_at: r.issuedAt ?? null, issued_by: r.issuedBy ?? null,
  serial_no: r.serialNo ?? null,
});

export const fromTeacherAttendance = (r) => r && {
  id: r.id, teacherId: r.teacher_id, teacherName: r.teacher_name,
  date: r.date, status: r.status ?? "present",
  // late_reason is its own column now, but rows written before that migration
  // stored the late note in leave_reason — so prefer the real column and fall
  // back to the old status-based split. Not backfilled by design.
  leaveReason: r.status === "leave" ? r.leave_reason : null,
  lateReason:  r.late_reason ?? (r.status === "late" ? r.leave_reason : null),
  markedFrom: r.marked_from ?? null,
  markedBy: r.marked_by, markedAt: r.marked_at,
};

export const fromExam = (r) => r && {
  id: r.id, name: r.name, type: r.type ?? "unit_test",
  cls: r.cls, subject: r.subject, maxMarks: r.max_marks ?? 100,
  date: r.date, createdBy: r.created_by, createdAt: r.created_at,
};
export const toExam = (r) => ({
  id: r.id, name: r.name, type: r.type ?? "unit_test",
  cls: r.cls, subject: r.subject, max_marks: r.maxMarks ?? 100,
  date: r.date ?? null, created_by: r.createdBy ?? "Teacher",
});

export const fromExamMark = (r) => r && {
  id: r.id, examId: r.exam_id, studentId: r.student_id,
  studentName: r.student_name, score: r.score ?? 0,
  maxMarks: r.max_marks ?? 100, remarks: r.remarks,
  recordedBy: r.recorded_by, recordedAt: r.recorded_at,
};

export const fromMaintenance = (r) => r && {
  id: r.id, busNumber: r.bus_number, routeCode: r.route_code,
  type: r.type ?? "service", date: r.date, odometer: r.odometer,
  vendor: r.vendor, cost: r.cost ?? 0, notes: r.notes,
  nextDueDate: r.next_due_date, recordedBy: r.recorded_by,
  createdAt: r.created_at,
};
export const toMaintenance = (r) => ({
  id: r.id, bus_number: r.busNumber, route_code: r.routeCode ?? null,
  type: r.type ?? "service", date: r.date,
  odometer: r.odometer ?? null, vendor: r.vendor ?? null,
  cost: r.cost ?? 0, notes: r.notes ?? null,
  next_due_date: r.nextDueDate ?? null,
  recorded_by: r.recordedBy ?? "unknown",
});

export const fromExpense = (r) => r && {
  id: r.id, scope: r.scope ?? "school", category: r.category ?? "Misc",
  amount: r.amount ?? 0, vendor: r.vendor, memo: r.memo, date: r.date,
  paymentMethod: r.payment_method ?? "Bank transfer",
  recordedBy: r.recorded_by, createdAt: r.created_at,
  inventoryId: r.inventory_id ?? null,
};
export const toExpense = (r) => ({
  id: r.id, scope: r.scope ?? "school", category: r.category ?? "Misc",
  amount: r.amount ?? 0, vendor: r.vendor ?? null, memo: r.memo ?? null,
  date: r.date, payment_method: r.paymentMethod ?? "Bank transfer",
  recorded_by: r.recordedBy ?? "unknown",
  inventory_id: r.inventoryId ?? null,
});

export const fromDocument = (r) => r && {
  id: r.id, entityType: r.entity_type, entityId: r.entity_id,
  label: r.label, fileName: r.file_name, mimeType: r.mime_type,
  dataUrl: r.data_url, sizeBytes: r.size_bytes ?? 0,
  uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
};
export const toDocument = (r) => ({
  id: r.id, entity_type: r.entityType, entity_id: r.entityId,
  label: r.label ?? r.fileName, file_name: r.fileName,
  mime_type: r.mimeType ?? "application/octet-stream",
  data_url: r.dataUrl, size_bytes: r.sizeBytes ?? (r.dataUrl?.length || 0),
  uploaded_by: r.uploadedBy ?? "unknown",
});

export const fromDonorReceipt = (r) => r && {
  id: r.id, donorId: r.donor_id, donorName: r.donor_name, donorType: r.donor_type,
  amount: r.amount ?? 0, method: r.method, memo: r.memo,
  campaignId: r.campaign_id, issuedAt: r.issued_at, issuedAtLabel: r.issued_at_label,
};
export const toDonorReceipt = (r) => ({
  id: r.id, donor_id: r.donorId, donor_name: r.donorName, donor_type: r.donorType,
  amount: r.amount ?? 0, method: r.method ?? "Bank transfer",
  memo: r.memo ?? null, campaign_id: r.campaignId ?? null,
  issued_at: r.issuedAt ?? new Date().toISOString(),
  issued_at_label: r.issuedAtLabel ?? null,
});

export const fromSchool = (r) => r && {
  id: r.id, name: r.name, city: r.city, status: r.status ?? "Active",
  students: r.students ?? 0, fees: r.fees ?? 0, wellness: r.wellness,
  puck: r.puck, archivedAt: r.archived_at ?? null,
};
export const toSchool = (r) => ({
  id: r.id, name: r.name, city: r.city ?? null, status: r.status ?? "Active",
  students: r.students ?? 0, fees: r.fees ?? 0,
  wellness: r.wellness ?? null, puck: r.puck ?? "ink",
});

// ---------- timetable ----------
export const fromTimetable = (r) => r && {
  id: r.id, cls: r.cls, day: r.day, period: r.period,
  subject: r.subject,
  teacherId: r.teacher_id ?? null,
  teacherName: r.teacher_name ?? null,
  room: r.room ?? null,
  updatedAt: r.updated_at ?? null,
};
export const toTimetable = (r) => ({
  id: r.id, cls: r.cls, day: r.day, period: Number(r.period),
  subject: r.subject,
  teacher_id: r.teacherId ?? null,
  teacher_name: r.teacherName ?? null,
  room: r.room ?? null,
  updated_at: r.updatedAt ?? new Date().toISOString(),
});

// ---------- library: books ----------
export const fromBook = (r) => r && {
  id: r.id,
  title: r.title,
  author: r.author ?? "",
  category: r.category ?? "general",
  isbn: r.isbn ?? null,
  shelf: r.shelf ?? null,
  totalCopies: r.total_copies ?? 1,
  addedAt: r.added_at ?? null,
};
export const toBook = (r) => ({
  id: r.id,
  title: r.title,
  author: r.author ?? "",
  category: r.category ?? "general",
  isbn: r.isbn ?? null,
  shelf: r.shelf ?? null,
  total_copies: Math.max(0, Math.floor(Number(r.totalCopies) || 0)),
  added_at: r.addedAt ?? new Date().toISOString(),
});

// ---------- library: loans ----------
export const fromLoan = (r) => r && {
  id: r.id,
  bookId: r.book_id,
  bookTitle: r.book_title ?? null,
  borrowerType: r.borrower_type,
  borrowerId: r.borrower_id,
  borrowerName: r.borrower_name ?? null,
  borrowedAt: r.borrowed_at ?? null,
  dueAt: r.due_at ?? null,
  returnedAt: r.returned_at ?? null,
  issuedBy: r.issued_by ?? null,
  returnedBy: r.returned_by ?? null,
};
export const toLoan = (r) => ({
  id: r.id,
  book_id: r.bookId,
  book_title: r.bookTitle ?? null,
  borrower_type: r.borrowerType,
  borrower_id: r.borrowerId,
  borrower_name: r.borrowerName ?? null,
  borrowed_at: r.borrowedAt ?? new Date().toISOString(),
  due_at: r.dueAt ?? null,
  returned_at: r.returnedAt ?? null,
  issued_by: r.issuedBy ?? null,
  returned_by: r.returnedBy ?? null,
});

