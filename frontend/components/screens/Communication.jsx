"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel, classNameFromNumber } from "@/lib/format";

// Channels the compose form offers. In-app delivers via the parent's
// dashboard (no external dependency). WhatsApp actually fires the message
// through the Evolution API — requires EVOLUTION_API_URL/_KEY/_INSTANCE
// env vars on the server, and a 10-digit phone in `student.parent`.
const CHANNELS = [
  { k: "in_app",   label: "In-app message", icon: "megaphone" },
  { k: "whatsapp", label: "WhatsApp",       icon: "send" },
];
const DEFAULT_CHANNEL = "in_app";

// Pull a 10-digit Indian phone out of student.parent (which is a free-form
// string like "Mr Suresh · 9876543210"). Returns null if no valid number.
function parentPhoneOf(student) {
  if (!student) return null;
  const digits = String(student.parent || "").replace(/\D/g, "");
  if (!digits) return null;
  // Last 10 digits — handles entries that include the country code or a
  // leading 0. The server-side normaliser re-prefixes 91.
  const ten = digits.slice(-10);
  if (ten.length !== 10 || !/^[6-9]/.test(ten)) return null;
  return ten;
}

function Toast({ msg, tone, onClose }) {
  if (!msg) return null;
  const bg = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err, #b13c1c)" : "var(--ink)";
  return (
    <div onClick={onClose} role="status" style={{
      position: "fixed", bottom: 18, right: 18, zIndex: 9000,
      background: bg, color: "#fff", padding: "9px 14px", borderRadius: 8,
      fontSize: 12, fontWeight: 500, cursor: "pointer", maxWidth: 360,
      boxShadow: "0 12px 30px -16px rgba(0,0,0,0.35)",
    }}>{msg}</div>
  );
}

function ModalShell({ title, sub, onClose, children, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: width, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
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

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
    </label>
  );
}

export default function ScreenCommunication({ E, refresh, role, session }) {
  const canSend = role === "principal" || role === "admin" || role === "academic_director" || role === "teacher";
  // Parents only see the read-only "Recent broadcasts" log — no compose, no
  // templates, no audience picker. They consume messages, they don't send them.
  const isParent = role === "parent";
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [broadcastPrefill, setBroadcastPrefill] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [toast, setToast] = useState(null);

  const students  = E.ADDED_STUDENTS || [];
  const pending   = E.PENDING_FEES || [];
  const classes   = E.CLASSES || [];
  const broadcasts = E.BROADCASTS || [];
  const templates  = E.TEMPLATES || [];

  // Teachers only see the classes they're assigned to in the picker. Same
  // convention as Attendance: session.linkedClasses is the authoritative list,
  // session.linkedId is the legacy single-class fallback.
  const teacherClassSet = useMemo(() => {
    if (role !== "teacher") return null;
    const arr = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
      ? session.linkedClasses
      : (session?.linkedId ? [session.linkedId] : []);
    return new Set(arr);
  }, [role, session]);

  // Flat list of class-section keys ("1-A", "2-B", …) available to the picker.
  const availableClassKeys = useMemo(() => {
    const all = [];
    classes.forEach((c) => {
      (c.sections || ["A"]).forEach((sec) => all.push(`${c.n}-${sec}`));
    });
    if (teacherClassSet && teacherClassSet.size) {
      return all.filter((k) => teacherClassSet.has(k));
    }
    return all;
  }, [classes, teacherClassSet]);

  // Today's count from broadcasts.
  const todayCount = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return broadcasts
      .filter((b) => String(b.sentAt || "").slice(0, 10) === today)
      .reduce((a, b) => a + (b.sent || 0), 0);
  }, [broadcasts]);
  const totalSent = broadcasts.reduce((a, b) => a + (b.sent || 0), 0);
  const totalDelivered = broadcasts.reduce((a, b) => a + (b.delivered || 0), 0);
  const deliveryRate = totalSent ? Math.round((totalDelivered / totalSent) * 100) : null;
  const reachableTotal = students.filter((s) => s.parent && s.parent !== "—").length;
  const reachability = students.length ? Math.round((reachableTotal / students.length) * 100) : null;

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  async function handleBroadcast(payload) {
    const r = await fetch("/api/communication/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to send");
    setShowBroadcast(false);
    setBroadcastPrefill(null);
    showToast(`Broadcast sent to ${json.broadcast.sent} parents via ${json.broadcast.channel}`, "ok");
    await refresh?.();
  }

  async function handleImport(payload) {
    const r = await fetch("/api/communication/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) {
      const ex = new Error(json.error || "Failed");
      ex.rejected = json.rejected;
      throw ex;
    }
    setShowImport(false);
    showToast(`Imported ${json.accepted} contacts${json.rejected?.length ? ` (${json.rejected.length} rejected)` : ""}`, "ok");
    await refresh?.();
    return json;
  }

  async function handleAddTemplate(payload) {
    const r = await fetch("/api/communication/template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
    setShowTemplate(false);
    showToast(`Template "${json.template.name}" added`, "ok");
    await refresh?.();
  }

  async function handleRemoveTemplate(t) {
    if (!confirm(`Remove template "${t.name}"?`)) return;
    try {
      const r = await fetch("/api/communication/template", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      showToast(`Template removed`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Operations · Communication</div>
          <div className="page-title">Talk to <span className="amber">parents</span></div>
          <div className="page-sub">In-app messages · templates · logs</div>
        </div>
        {canSend && (
          <div className="page-actions">
            <button className="btn" onClick={() => setShowImport(true)}>
              <Icon name="upload" size={13} />Import list
            </button>
            <button className="btn accent" onClick={() => { setBroadcastPrefill(null); setShowBroadcast(true); }}>
              <Icon name="send" size={13} />New broadcast
            </button>
          </div>
        )}
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI label="Messages · today" value={todayCount} sub="In-app messages" puck="mint" puckIcon="megaphone" />
        <KPI label="Delivery rate" value={deliveryRate !== null ? `${deliveryRate}%` : "—"} sub={broadcasts.length ? `${totalDelivered}/${totalSent} delivered` : "no messages yet"} puck="cream" puckIcon="check" />
        <KPI label="Templates" value={templates.length} sub={templates.length ? "ready to use" : "add DLT-approved templates"} puck="peach" puckIcon="mail" />
        <KPI label="Parent reachability" value={reachability !== null ? `${reachability}%` : "—"} sub={students.length ? `${reachableTotal}/${students.length} have phone` : "add parent contacts first"} puck="sky" puckIcon="users" />
      </div>

      <div className="grid g-12">
        <div className={`card ${isParent ? "col-12" : "col-7"}`}>
          <div className="card-head">
            <div><div className="card-title">Recent broadcasts</div><div className="card-sub">{isParent ? "Messages from your school" : "Manual + system-generated"}</div></div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>Campaign</th><th>Channel</th><th>Audience</th><th className="num">Sent</th><th className="num">Delivered</th><th>When</th></tr></thead>
              <tbody>
                {broadcasts.length === 0 && (
                  <tr><td colSpan={6} className="empty">No broadcasts yet. Compose your first message on the right.</td></tr>
                )}
                {broadcasts.map((b) => {
                  const when = b.sentAt ? new Date(b.sentAt) : null;
                  const whenLabel = when ? when.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
                  const rate = b.sent ? Math.round((b.delivered / b.sent) * 100) : 0;
                  return (
                    <tr key={b.id}>
                      <td>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{b.campaign}</div>
                        <div style={{ fontSize: 11, color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }} title={b.message}>
                          {b.message?.slice(0, 80)}{(b.message || "").length > 80 ? "…" : ""}
                        </div>
                      </td>
                      <td><span className="chip"><Icon name="megaphone" size={11} />In-app</span></td>
                      <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{b.audienceLabel || b.audience}</td>
                      <td className="num"><span className="mono">{b.sent}</span></td>
                      <td className="num"><span className="mono" style={{ color: rate === 100 ? "var(--ok)" : "var(--ink-2)" }}>{b.delivered} <span style={{ color: "var(--ink-4)" }}>({rate}%)</span></span></td>
                      <td style={{ fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{whenLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {!isParent && (
        <div className="col-5" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div className="card-head">
              <div><div className="card-title">Templates</div><div className="card-sub">{templates.length ? `${templates.length} ready` : "DLT-approved, reusable"}</div></div>
              {canSend && (
                <div className="card-actions"><button className="btn sm" onClick={() => setShowTemplate(true)}><Icon name="plus" size={12} />New</button></div>
              )}
            </div>
            {templates.length === 0 ? (
              <div className="empty">No templates yet. Add DLT-approved templates to send bulk messages.</div>
            ) : (
              <div style={{ padding: "8px 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                {templates.map((t) => (
                  <div key={t.id} style={{ padding: 8, background: "var(--bg-2)", borderRadius: 7, display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.name}</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <span className="chip" style={{ fontSize: 10 }}><Icon name="megaphone" size={10} />In-app</span>
                        <button className="icon-btn" onClick={() => { setBroadcastPrefill({ message: t.body, channel: t.channel, campaign: t.name }); setShowBroadcast(true); }} title="Use this template"><Icon name="send" size={11} /></button>
                        {canSend && <button className="icon-btn" onClick={() => handleRemoveTemplate(t)} title="Remove"><Icon name="x" size={11} /></button>}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4 }}>{t.body}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <ComposeCard
            classes={availableClassKeys}
            students={students}
            pending={pending}
            role={role}
            onSend={handleBroadcast}
            disabled={!canSend}
            templates={templates}
          />
        </div>
        )}
      </div>

      {showBroadcast && canSend && (
        <BroadcastModal
          classes={availableClassKeys}
          students={students}
          pending={pending}
          role={role}
          templates={templates}
          prefill={broadcastPrefill}
          onClose={() => { setShowBroadcast(false); setBroadcastPrefill(null); }}
          onSubmit={handleBroadcast}
        />
      )}
      {showImport && canSend && (
        <ImportListModal onClose={() => setShowImport(false)} onSubmit={handleImport} />
      )}
      {showTemplate && canSend && (
        <TemplateModal onClose={() => setShowTemplate(false)} onSubmit={handleAddTemplate} />
      )}

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}

// Audience selection — multi-class chips, plus a per-student checklist for the
// selected classes. Teachers are locked to the "By class" mode and only see
// their assigned classes; other roles also get "All parents" and
// "Pending fees only" shortcuts.
function AudiencePicker({ value, onChange, classes, students, pending, role }) {
  const isTeacher = role === "teacher";
  const reachable = useMemo(
    () => students.filter((s) => s.parent && s.parent !== "—"),
    [students]
  );
  const studentsInSelectedClasses = useMemo(
    () => reachable.filter((s) => value.selectedClasses.includes(s.cls)),
    [reachable, value.selectedClasses]
  );

  function setMode(mode) {
    onChange({ mode, selectedClasses: [], selectedStudentIds: [] });
  }
  function toggleClass(k) {
    const nextClasses = value.selectedClasses.includes(k)
      ? value.selectedClasses.filter((x) => x !== k)
      : [...value.selectedClasses, k];
    // Tick all students of the newly-selected class set; this keeps the common
    // case (send to whole class) a single click while still allowing opt-out.
    const nextStudents = reachable.filter((s) => nextClasses.includes(s.cls)).map((s) => s.id);
    onChange({ ...value, selectedClasses: nextClasses, selectedStudentIds: nextStudents });
  }
  function toggleStudent(id) {
    const next = value.selectedStudentIds.includes(id)
      ? value.selectedStudentIds.filter((x) => x !== id)
      : [...value.selectedStudentIds, id];
    onChange({ ...value, selectedStudentIds: next });
  }
  const allSelected = studentsInSelectedClasses.length > 0
    && studentsInSelectedClasses.every((s) => value.selectedStudentIds.includes(s.id));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {!isTeacher && (
        <div className="segmented">
          <button type="button" className={value.mode === "classes" ? "active" : ""} onClick={() => setMode("classes")}>By class</button>
          <button type="button" className={value.mode === "all" ? "active" : ""} onClick={() => setMode("all")}>All parents ({reachable.length})</button>
          <button type="button" className={value.mode === "pending" ? "active" : ""} onClick={() => setMode("pending")}>Pending fees ({pending.filter((f) => students.some((s) => s.id === f.id)).length})</button>
        </div>
      )}

      {value.mode === "classes" && (
        <>
          <div>
            <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
              Classes{isTeacher ? " · your assigned classes" : ""}
            </div>
            {classes.length === 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
                {isTeacher ? "No classes assigned to you yet." : "No classes configured."}
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {classes.map((k) => {
                  const count = reachable.filter((s) => s.cls === k).length;
                  const selected = value.selectedClasses.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleClass(k)}
                      className={`chip ${selected ? "accent" : ""}`}
                      style={{ cursor: "pointer" }}
                    >
                      {selected && <Icon name="check" size={10} />}
                      {formatClassLabel(k)} ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {value.selectedClasses.length > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Students · {value.selectedStudentIds.length}/{studentsInSelectedClasses.length} selected
                </div>
                {studentsInSelectedClasses.length > 0 && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ fontSize: 10.5, height: 22, padding: "0 8px" }}
                    onClick={() => onChange({
                      ...value,
                      selectedStudentIds: allSelected ? [] : studentsInSelectedClasses.map((s) => s.id),
                    })}
                  >
                    {allSelected ? "Clear" : "Select all"}
                  </button>
                )}
              </div>
              {studentsInSelectedClasses.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--ink-4)", padding: "6px 10px", background: "var(--bg-2)", borderRadius: 7 }}>
                  No reachable parents in the selected class{value.selectedClasses.length === 1 ? "" : "es"}.
                </div>
              ) : (
                <div style={{ maxHeight: 180, overflowY: "auto", background: "var(--bg-2)", borderRadius: 7, padding: 4, display: "flex", flexDirection: "column", gap: 1 }}>
                  {studentsInSelectedClasses.map((s) => {
                    const checked = value.selectedStudentIds.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 5, cursor: "pointer", fontSize: 12 }}
                      >
                        <input type="checkbox" checked={checked} onChange={() => toggleStudent(s.id)} />
                        <span style={{ flex: 1, fontWeight: 500 }}>{s.name}</span>
                        <span style={{ color: "var(--ink-4)", fontSize: 11 }}>{formatClassLabel(s.cls)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {value.mode === "all" && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 10px", background: "var(--bg-2)", borderRadius: 7 }}>
          All {reachable.length} reachable parent{reachable.length === 1 ? "" : "s"} will receive this.
        </div>
      )}
      {value.mode === "pending" && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 10px", background: "var(--bg-2)", borderRadius: 7 }}>
          {pending.filter((f) => students.some((s) => s.id === f.id)).length} parent{pending.length === 1 ? "" : "s"} with pending fees will receive this.
        </div>
      )}
    </div>
  );
}

// Pure helpers derive the count / audience key / label from the picker's value,
// so ComposeCard and BroadcastModal don't duplicate the logic.
function audienceCount(value, students, pending) {
  const reachable = students.filter((s) => s.parent && s.parent !== "—");
  if (value.mode === "all") return reachable.length;
  if (value.mode === "pending") return pending.filter((f) => students.some((s) => s.id === f.id)).length;
  return value.selectedStudentIds.length;
}
// Build the WhatsApp recipient list (phone + studentId) for the chosen
// audience. Filters out students whose `parent` field doesn't parse to a
// valid 10-digit mobile — the server applies its own normaliser too, but
// trimming here keeps the request payload small and the count accurate.
function audienceRecipients(value, students, pending) {
  let pool = [];
  if (value.mode === "all") {
    pool = students;
  } else if (value.mode === "pending") {
    const pendingIds = new Set(pending.map((f) => f.id));
    pool = students.filter((s) => pendingIds.has(s.id));
  } else {
    const picked = new Set(value.selectedStudentIds);
    pool = students.filter((s) => picked.has(s.id));
  }
  const out = [];
  const seen = new Set();
  for (const s of pool) {
    const phone = parentPhoneOf(s);
    if (!phone) continue;
    if (seen.has(phone)) continue; // dedupe siblings sharing a parent phone
    seen.add(phone);
    out.push({ phone, studentId: s.id, name: s.name || "" });
  }
  return out;
}
function audienceKey(value) {
  if (value.mode === "all") return "all";
  if (value.mode === "pending") return "pending_fees";
  const sorted = [...value.selectedClasses].sort();
  return `classes_${sorted.join(",")}`;
}
function audienceLabelOf(value) {
  if (value.mode === "all") return "All parents";
  if (value.mode === "pending") return "Pending fees only";
  const classesLabel = value.selectedClasses.length
    ? value.selectedClasses.map((c) => formatClassLabel(String(c))).join(", ")
    : "No class selected";
  const n = value.selectedStudentIds.length;
  return `${classesLabel} · ${n} student${n === 1 ? "" : "s"}`;
}

function ComposeCard({ classes, students, pending, role, onSend, disabled, templates }) {
  const [audience, setAudience] = useState({
    mode: role === "teacher" ? "classes" : "all",
    selectedClasses: [],
    selectedStudentIds: [],
  });
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const count = audienceCount(audience, students, pending);

  async function send() {
    if (busy || disabled) return;
    setErr("");
    if (!message.trim()) { setErr("Type a message first"); return; }
    if (count === 0) {
      setErr(audience.mode === "classes" ? "Select at least one student" : "Selected audience has 0 reachable parents");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        campaign: "Manual broadcast",
        audience: audienceKey(audience),
        audienceLabel: audienceLabelOf(audience),
        channel, message: message.trim(), sent: count,
      };
      if (channel === "whatsapp") {
        const recipients = audienceRecipients(audience, students, pending);
        if (recipients.length === 0) {
          throw new Error("No reachable phone numbers in the selected audience");
        }
        payload.recipients = recipients;
        payload.sent = recipients.length;
      }
      await onSend(payload);
      setMessage("");
      setAudience((a) => ({ ...a, selectedClasses: [], selectedStudentIds: [] }));
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-head"><div><div className="card-title">Compose</div><div className="card-sub">In-app message to the selected students' parents</div></div></div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Audience · {count} reachable</div>
          <AudiencePicker
            value={audience} onChange={setAudience}
            classes={classes} students={students} pending={pending}
            role={role}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Channel</div>
          <div className="segmented">
            {CHANNELS.map((c) => (
              <button key={c.k} type="button" className={channel === c.k ? "active" : ""} onClick={() => setChannel(c.k)}>
                <Icon name={c.icon} size={11} />{c.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Message</span>
            {templates.length > 0 && (
              <select
                className="select" style={{ fontSize: 11, padding: "2px 6px", height: 24 }}
                value=""
                onChange={(e) => {
                  const tpl = templates.find((t) => t.id === e.target.value);
                  if (tpl) { setMessage(tpl.body); setChannel(tpl.channel); }
                }}
              >
                <option value="">Insert template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </div>
          <textarea
            className="input"
            style={{ width: "100%", height: 70, padding: "8px 10px", lineHeight: 1.5, resize: "none" }}
            placeholder={disabled ? "Read-only for this role" : "Type your message…  (use {{name}}, {{cls}} placeholders)"}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={disabled}
          />
        </div>
        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 10px", borderRadius: 7, fontSize: 11.5 }}>
            {err}
          </div>
        )}
        <button className="btn accent" style={{ justifyContent: "center" }} onClick={send} disabled={busy || disabled}>
          <Icon name="send" size={13} />{busy ? "Sending…" : `Send to ${count}`}
        </button>
      </div>
    </div>
  );
}

function BroadcastModal({ classes, students, pending, role, templates, prefill, onClose, onSubmit }) {
  const [audience, setAudience] = useState({
    mode: role === "teacher" ? "classes" : "all",
    selectedClasses: [],
    selectedStudentIds: [],
  });
  const [channel, setChannel] = useState(prefill?.channel || DEFAULT_CHANNEL);
  const [campaign, setCampaign] = useState(prefill?.campaign || "");
  const [message, setMessage] = useState(prefill?.message || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const count = audienceCount(audience, students, pending);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr("");
    if (!message.trim()) { setErr("Message is required"); return; }
    if (count === 0) {
      setErr(audience.mode === "classes" ? "Select at least one student" : "Selected audience has 0 reachable parents");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        campaign: campaign.trim() || "Manual broadcast",
        audience: audienceKey(audience),
        audienceLabel: audienceLabelOf(audience),
        channel, message: message.trim(), sent: count,
      };
      if (channel === "whatsapp") {
        const recipients = audienceRecipients(audience, students, pending);
        if (recipients.length === 0) {
          throw new Error("No reachable phone numbers in the selected audience");
        }
        payload.recipients = recipients;
        payload.sent = recipients.length;
      }
      await onSubmit(payload);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <ModalShell title="New broadcast" sub="Sends a one-shot message to the selected audience" onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Campaign name (optional)">
          <input className="input" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="e.g. Annual day reminder" />
        </Field>
        <Field label="Audience" hint={`${count} reachable parent${count === 1 ? "" : "s"} will receive this`}>
          <AudiencePicker
            value={audience} onChange={setAudience}
            classes={classes} students={students} pending={pending}
            role={role}
          />
        </Field>
        <Field label="Channel">
          <div className="segmented">
            {CHANNELS.map((c) => (
              <button key={c.k} type="button" className={channel === c.k ? "active" : ""} onClick={() => setChannel(c.k)}>
                <Icon name={c.icon} size={11} />{c.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Message" hint="Use {{name}}, {{cls}} for personalisation (gateway will fill these)">
          <textarea
            className="input"
            style={{ width: "100%", height: 110, padding: "10px 12px", lineHeight: 1.5, resize: "vertical" }}
            value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message…"
          />
          {templates.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Quick fill:</span>
              {templates.map((t) => (
                <button key={t.id} type="button" className="chip" style={{ cursor: "pointer" }} onClick={() => { setMessage(t.body); setChannel(t.channel); }}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </Field>
        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || count === 0}>
            <Icon name="send" size={13} />{busy ? "Sending…" : `Send to ${count}`}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ImportListModal({ onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rejected, setRejected] = useState(null);
  const fileRef = useRef(null);

  async function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    setCsv(text);
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr(""); setRejected(null);
    if (!csv.trim()) { setErr("Paste rows or upload a CSV"); return; }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim() || "Imported list", csv });
    } catch (ex) {
      setErr(ex.message);
      if (ex.rejected) setRejected(ex.rejected);
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Import recipient list"
      sub="Paste or upload Name,Phone rows · 10-digit Indian numbers (6/7/8/9 prefix)"
      onClose={onClose}
      width={560}
    >
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="List name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Class 5 picnic parents" autoFocus />
        </Field>
        <Field label="CSV" hint="Header row optional. Two columns: Name, Phone. Max 1000 rows.">
          <textarea
            className="input"
            style={{ width: "100%", height: 160, padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
            value={csv} onChange={(e) => setCsv(e.target.value)}
            placeholder={`Name,Phone\nAnita Sharma,9876543210\nRavi Kumar,8765432109`}
          />
        </Field>
        <div>
          <input type="file" accept=".csv,.txt" ref={fileRef} onChange={handleFile} style={{ display: "none" }} />
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={12} />Choose CSV file
          </button>
        </div>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}
        {rejected && rejected.length > 0 && (
          <div style={{ background: "var(--bg-2)", padding: "8px 10px", borderRadius: 7, fontSize: 11, maxHeight: 120, overflow: "auto" }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>Rejected ({rejected.length}):</div>
            {rejected.slice(0, 10).map((r, i) => (
              <div key={i} style={{ color: "var(--ink-3)" }}>
                {r.name || "—"} · {r.phone || "—"} · <span style={{ color: "var(--err, #b13c1c)" }}>{r.reason}</span>
              </div>
            ))}
            {rejected.length > 10 && <div style={{ color: "var(--ink-4)", marginTop: 4 }}>…and {rejected.length - 10} more</div>}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            {busy ? "Importing…" : <><Icon name="check" size={13} />Import</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function TemplateModal({ onClose, onSubmit }) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), channel, body: body.trim() });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <ModalShell title="New message template" sub="Re-usable bodies (DLT-approved) for bulk sending" onClose={onClose} width={520}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10 }}>
          <Field label="Name *">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fee due reminder" autoFocus />
          </Field>
          <Field label="Channel">
            <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              {CHANNELS.map((c) => <option key={c.k} value={c.k}>{c.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Body *" hint="Placeholders: {{name}}, {{cls}}, {{amount}}, {{due_date}}">
          <textarea
            className="input"
            style={{ width: "100%", height: 130, padding: "10px 12px", lineHeight: 1.5, resize: "vertical" }}
            value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={"Hi {{name}}, fees of ₹{{amount}} for {{cls}} are due by {{due_date}}. Pay at school office or via UPI."}
          />
        </Field>
        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            {busy ? "Saving…" : <><Icon name="check" size={13} />Save template</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
