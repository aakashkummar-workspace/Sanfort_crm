"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { formatClassLabel } from "@/lib/format";

export default function ScreenChat({ E, refresh, role, session }) {
  const [threads, setThreads] = useState([]);
  const [active, setActive] = useState(null); // thread id
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showStart, setShowStart] = useState(false);
  const messagesEndRef = useRef(null);

  async function load() {
    try {
      const r = await fetch("/api/chat", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setThreads(j.threads || []);
        if (!active && (j.threads || []).length > 0) setActive(j.threads[0].id);
      }
    } catch {}
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // poll for new messages every 8s when the screen is open
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thread = useMemo(() => threads.find((t) => t.id === active) || null, [threads, active]);

  // Auto-scroll on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages?.length]);

  async function send() {
    if (!thread || !draft.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread.id, body: draft.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      setDraft("");
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function startNew(payload) {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `Send failed (${r.status})`);
      setShowStart(false);
      await load();
      setActive(j.thread.id);
    } catch (e) {
      setErr(e.message);
      // Re-throw so the modal can release its busy state and show the
      // error inside the modal instead of leaving "Sending…" stuck.
      throw e;
    }
    finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">{role === "parent" ? "Parents · Talk to teacher" : "Teacher · Parent inbox"}</div>
          <div className="page-title">Parent–Teacher <span className="amber">chat</span></div>
          <div className="page-sub">{threads.length} conversation{threads.length === 1 ? "" : "s"}</div>
        </div>
        {role === "parent" && (
          <div className="page-actions">
            <button className="btn accent" onClick={() => setShowStart(true)}>
              <Icon name="plus" size={13} />New conversation
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ height: 600, display: "flex", overflow: "hidden" }}>
        {/* Threads list */}
        <div style={{ width: 320, borderRight: "1px solid var(--rule)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--rule)", fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{role === "teacher" ? "Parent inbox" : "Conversations"}</span>
            {threads.length > 0 && <span style={{ color: "var(--ink-4)" }}>{threads.length}</span>}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {threads.length === 0 && (
              <div className="empty" style={{ padding: 20, fontSize: 12 }}>
                {role === "parent" ? "No conversations yet. Click New conversation." : "No parent has reached out yet."}
              </div>
            )}
            {threads.map((t) => {
              const last = t.messages?.[t.messages.length - 1];
              const counterpart = role === "parent" ? t.teacherName : t.parentName;
              const sub = role === "parent"
                ? `Re: ${t.studentName} (${formatClassLabel(t.cls)})`
                : `${t.studentName} · ${formatClassLabel(t.cls)}`;
              const initials = (counterpart || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
              // "Unread" = last message is from the other side. Reset
              // when we open the thread (active === t.id).
              const lastFromOther = last && last.fromRole && last.fromRole !== role;
              const isUnread = lastFromOther && active !== t.id;
              const lastTime = last?.sentAt
                ? new Date(last.sentAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
                : null;
              return (
                <button
                  key={t.id}
                  onClick={() => setActive(t.id)}
                  style={{
                    display: "flex", width: "100%", textAlign: "left",
                    gap: 10, alignItems: "flex-start",
                    padding: "12px 14px", border: 0,
                    background: active === t.id ? "var(--accent-soft)" : "transparent",
                    borderLeft: active === t.id ? "3px solid var(--accent)" : "3px solid transparent",
                    borderBottom: "1px solid var(--rule)",
                    cursor: "pointer",
                  }}
                >
                  <span style={{
                    width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                    color: "#fff", display: "grid", placeItems: "center",
                    fontSize: 12, fontWeight: 600,
                  }}>{initials}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: isUnread ? 600 : 500, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {counterpart}
                      </span>
                      {lastTime && (
                        <span style={{ fontSize: 10, color: "var(--ink-4)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                          {lastTime}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 2 }}>{sub}</div>
                    {last && (
                      <div style={{
                        fontSize: 11, marginTop: 4,
                        color: isUnread ? "var(--ink)" : "var(--ink-3)",
                        fontWeight: isUnread ? 500 : 400,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {last.fromRole === role ? "You: " : ""}{last.body.slice(0, 60)}
                      </div>
                    )}
                  </div>
                  {isUnread && (
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: "var(--accent)", flexShrink: 0, marginTop: 6,
                    }} title="Unread message" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Active thread */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {!thread ? (
            <div className="empty" style={{ flex: 1, display: "grid", placeItems: "center" }}>
              {threads.length === 0 ? "Start your first conversation" : "Pick a conversation on the left"}
            </div>
          ) : (
            <>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--rule)" }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                  {role === "parent" ? thread.teacherName : thread.parentName}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
                  {role === "parent" ? "Class teacher" : "Parent"} · {thread.studentName} ({formatClassLabel(thread.cls)})
                </div>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10, background: "var(--bg-2)" }}>
                {(thread.messages || []).length === 0 && (
                  <div className="empty" style={{ alignSelf: "center" }}>No messages yet — say hi.</div>
                )}
                {(thread.messages || []).map((m) => {
                  const mine = (m.fromEmail || "").toLowerCase() === (session?.email || "").toLowerCase();
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
                      <div style={{
                        maxWidth: "75%",
                        background: mine ? "var(--accent)" : "var(--card)",
                        color: mine ? "#fff" : "var(--ink)",
                        padding: "9px 12px", borderRadius: 12,
                        borderTopRightRadius: mine ? 4 : 12,
                        borderTopLeftRadius: mine ? 12 : 4,
                        fontSize: 13, lineHeight: 1.45,
                      }}>
                        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                        <div style={{ fontSize: 10, color: mine ? "rgba(255,255,255,0.75)" : "var(--ink-4)", marginTop: 4, textAlign: mine ? "right" : "left" }}>
                          {m.fromName} · {new Date(m.sentAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              <div style={{ padding: 12, borderTop: "1px solid var(--rule)", display: "flex", gap: 8 }}>
                <textarea
                  className="input"
                  style={{ flex: 1, height: 60, resize: "none", padding: "8px 10px", lineHeight: 1.5 }}
                  placeholder="Type a message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send(); }}
                />
                <button className="btn accent" onClick={send} disabled={busy || !draft.trim()}>
                  <Icon name="send" size={13} />Send
                </button>
              </div>
              {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "7px 12px", fontSize: 11.5 }}>{err}</div>}
            </>
          )}
        </div>
      </div>

      {showStart && role === "parent" && (
        <NewThreadModal
          students={E.ADDED_STUDENTS || []}
          onClose={() => setShowStart(false)}
          onSubmit={startNew}
        />
      )}
    </div>
  );
}

function NewThreadModal({ students, onClose, onSubmit }) {
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [teacherEmail, setTeacherEmail] = useState("");
  const [body, setBody] = useState("");
  const [teachers, setTeachers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Pull all teachers, then narrow to the class teacher(s) of the picked
  // child's class. Parents must NOT be able to message a random teacher.
  useEffect(() => {
    fetch("/api/users?role=teacher").then((r) => r.json()).then((j) => {
      if (j.ok) setTeachers(j.teachers || []);
    });
  }, []);

  const stu = students.find((s) => s.id === studentId);
  const assignedTeachers = useMemo(() => {
    if (!stu) return [];
    const cls = String(stu.cls || "").toUpperCase();
    return teachers.filter(
      (t) => Array.isArray(t.linkedClasses) &&
             t.linkedClasses.some((c) => String(c).toUpperCase() === cls)
    );
  }, [teachers, stu]);

  // Auto-select the only assigned teacher (or first if multiple).
  useEffect(() => {
    if (assignedTeachers.length === 0) {
      setTeacherEmail("");
      return;
    }
    if (!assignedTeachers.find((t) => t.email === teacherEmail)) {
      setTeacherEmail(assignedTeachers[0].email);
    }
  }, [assignedTeachers]); // eslint-disable-line

  const noAssignedTeacher = stu && teachers.length > 0 && assignedTeachers.length === 0;
  const canSend = !!stu && !!teacherEmail && body.trim() && assignedTeachers.length > 0;

  async function submit(e) {
    e.preventDefault();
    if (busy || !canSend) return;
    setBusy(true); setErr("");
    try {
      await onSubmit({ studentId: stu.id, studentName: stu.name, cls: stu.cls, teacherEmail, body: body.trim() });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  const selectedTeacher = assignedTeachers.find((t) => t.email === teacherEmail);

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 250, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 520 }}>
        <div className="card-head">
          <div><div className="card-title">Talk to teacher</div><div className="card-sub">Sends to your child's assigned class teacher</div></div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {students.length > 1 ? (
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>About child</span>
              <select className="select" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                {students.map((s) => <option key={s.id} value={s.id}>{s.name} · {formatClassLabel(s.cls)}</option>)}
              </select>
            </label>
          ) : stu && (
            <div style={{
              padding: "10px 12px", background: "var(--card-2)",
              border: "1px solid var(--rule)", borderRadius: 9,
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                color: "#fff", display: "grid", placeItems: "center",
                fontSize: 12, fontWeight: 600,
              }}>{(stu.name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{stu.name}</div>
                <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{formatClassLabel(stu.cls)} · {stu.id}</div>
              </div>
            </div>
          )}

          {noAssignedTeacher ? (
            <div style={{
              padding: 12, background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)",
              borderRadius: 7, fontSize: 12.5, lineHeight: 1.5,
            }}>
              No class teacher is assigned to <b>{formatClassLabel(stu?.cls)}</b> yet. Please contact the school office —
              once a class teacher is assigned, you'll be able to message them here.
            </div>
          ) : assignedTeachers.length === 1 && selectedTeacher ? (
            <div style={{
              padding: "10px 12px", background: "var(--accent-soft, #fff4dc)",
              border: "1px solid var(--accent, #c8510a)", borderRadius: 9,
            }}>
              <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Class teacher
              </div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{selectedTeacher.name}</div>
              <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                {selectedTeacher.email} · assigned to {selectedTeacher.linkedClasses.join(", ")}
              </div>
            </div>
          ) : (
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>Class teacher</span>
              <select className="select" value={teacherEmail} onChange={(e) => setTeacherEmail(e.target.value)}>
                {assignedTeachers.map((t) => (
                  <option key={t.email} value={t.email}>
                    {t.name} · {t.linkedClasses.join(", ")}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                {assignedTeachers.length} class teachers assigned to {formatClassLabel(stu?.cls)}. Pick one.
              </span>
            </label>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>First message</span>
            <textarea
              className="input" style={{ height: 100, padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }}
              value={body} onChange={(e) => setBody(e.target.value)}
              placeholder="Hi, I wanted to ask about…"
              disabled={noAssignedTeacher}
            />
          </label>
          {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy || !canSend}>
              <Icon name="send" size={13} />{busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
