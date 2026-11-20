"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";

export default function ScreenMeetings({ E, refresh, role, session }) {
  const canCreate = ["admin", "principal", "academic_director", "teacher"].includes(role);
  const [meetings, setMeetings] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("upcoming"); // upcoming | past | all

  async function load() {
    try {
      const r = await fetch("/api/meetings", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setMeetings(j.meetings || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const now = Date.now();
  const filtered = useMemo(() => {
    return meetings.filter((m) => {
      const t = new Date(m.scheduledAt).getTime();
      if (filter === "upcoming") return t >= now - 60 * 60 * 1000; // include up to 1h past start
      if (filter === "past") return t < now - 60 * 60 * 1000;
      return true;
    }).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  }, [meetings, filter, now]);

  const counts = {
    upcoming: meetings.filter((m) => new Date(m.scheduledAt).getTime() >= now - 60 * 60 * 1000).length,
    past: meetings.filter((m) => new Date(m.scheduledAt).getTime() < now - 60 * 60 * 1000).length,
  };

  async function rsvp(m, response) {
    setBusyId(m.id); setErr("");
    try {
      const r = await fetch("/api/meetings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: m.id, response }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusyId(null); }
  }

  async function remove(m) {
    if (!confirm(`Remove meeting "${m.title}"?`)) return;
    setBusyId(m.id);
    try {
      const r = await fetch("/api/meetings", {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: m.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusyId(null); }
  }

  async function addMeeting(payload) {
    const r = await fetch("/api/meetings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowAdd(false);
    await load();
    await refresh?.();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Operations · Meetings</div>
          <div className="page-title">Meetings & <span className="amber">PTAs</span></div>
          <div className="page-sub">Schedule, broadcast, RSVP — class meetings, PTAs, 1:1s</div>
        </div>
        {canCreate && (
          <div className="page-actions">
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />Schedule meeting
            </button>
          </div>
        )}
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {(() => {
          const upcoming = meetings.filter((m) => new Date(m.scheduledAt).getTime() >= now - 60 * 60 * 1000);
          const past = meetings.filter((m) => new Date(m.scheduledAt).getTime() < now - 60 * 60 * 1000);
          const itemFor = (m, tone) => ({
            label: m.title,
            value: m.scheduledAt ? new Date(m.scheduledAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—",
            sub: m.audienceLabel || m.audience || "—",
            tone,
          });
          return (
            <>
              <KPI
                label="Upcoming" value={counts.upcoming} sub="needs attention"
                puck="mint" puckIcon="clock"
                details={{
                  title: `Upcoming · ${counts.upcoming}`,
                  sub: counts.upcoming === 0 ? "No upcoming meetings" : "Earliest first",
                  items: upcoming.slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)).map((m) => itemFor(m, "")),
                }}
              />
              <KPI
                label="Past" value={counts.past} sub="completed"
                puck="cream" puckIcon="check"
                details={{
                  title: `Past · ${counts.past}`,
                  sub: "Most recent first",
                  items: past.slice().sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt)).slice(0, 12).map((m) => itemFor(m, "ok")),
                }}
              />
              <KPI
                label="Total scheduled" value={meetings.length} sub="all-time"
                puck="peach" puckIcon="reports"
                details={{
                  title: `Total · ${meetings.length}`,
                  sub: `${counts.upcoming} upcoming · ${counts.past} past`,
                  items: meetings.slice().sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt)).slice(0, 12).map((m) => itemFor(m, "")),
                }}
              />
              <KPI
                label="Visible to you" value={filtered.length} sub={filter}
                puck="sky" puckIcon="users"
                details={{
                  title: `Visible · ${filtered.length} (${filter})`,
                  sub: "Filtered to your view",
                  items: filtered.slice(0, 12).map((m) => itemFor(m, "")),
                }}
              />
            </>
          );
        })()}
      </div>

      <div className="card">
        <div className="card-head">
          <div><div className="card-title">Meetings</div><div className="card-sub">{filtered.length} shown</div></div>
          <div className="card-actions">
            <div className="segmented">
              {["upcoming", "past", "all"].map((k) => (
                <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
                  {k === "upcoming" ? "Upcoming" : k === "past" ? "Past" : "All"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 14px", fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {filtered.length === 0 && (
            <div className="empty" style={{ padding: 28 }}>
              {meetings.length === 0
                ? (canCreate ? "No meetings yet. Click Schedule meeting." : "No meetings have been scheduled for you.")
                : `No ${filter} meetings.`}
            </div>
          )}
          {filtered.map((m) => {
            const when = new Date(m.scheduledAt);
            const isPast = when.getTime() < now - 60 * 60 * 1000;
            const myRsvp = (m.rsvps || []).find((r) => (r.fromEmail || "").toLowerCase() === (session?.email || "").toLowerCase());
            const counts2 = (m.rsvps || []).reduce((a, r) => { a[r.response] = (a[r.response] || 0) + 1; return a; }, {});
            return (
              <div key={m.id} style={{ padding: "14px 18px", borderBottom: "1px solid var(--rule)", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>{m.title}</span>
                      {isPast && <span className="chip"><span className="dot" />Past</span>}
                    </div>
                    {m.description && (
                      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>{m.description}</div>
                    )}
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <span><Icon name="clock" size={11} /> {when.toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      <span><Icon name="mapPin" size={11} /> {m.location}</span>
                      <span><Icon name="users" size={11} /> {m.audienceLabel}</span>
                      <span style={{ color: "var(--ink-4)" }}>by {m.createdByName}</span>
                    </div>
                  </div>
                  {(role === "admin" || role === "principal") && (
                    <button className="icon-btn" onClick={() => remove(m)} disabled={busyId === m.id} title="Remove"><Icon name="x" size={12} /></button>
                  )}
                </div>
                {!isPast && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      RSVPs: <b style={{ color: "var(--ok)" }}>{counts2.yes || 0} yes</b> · <b style={{ color: "var(--warn)" }}>{counts2.maybe || 0} maybe</b> · <b style={{ color: "var(--bad)" }}>{counts2.no || 0} no</b>
                      {myRsvp && <span style={{ marginLeft: 8 }}>· You: <b>{myRsvp.response}</b></span>}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className={`btn sm ${myRsvp?.response === "yes" ? "accent" : ""}`} onClick={() => rsvp(m, "yes")} disabled={busyId === m.id}>
                        <Icon name="check" size={11} />Yes
                      </button>
                      <button className={`btn sm ${myRsvp?.response === "maybe" ? "accent" : ""}`} onClick={() => rsvp(m, "maybe")} disabled={busyId === m.id}>
                        Maybe
                      </button>
                      <button className={`btn sm ${myRsvp?.response === "no" ? "accent" : ""}`} onClick={() => rsvp(m, "no")} disabled={busyId === m.id}>
                        <Icon name="x" size={11} />No
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showAdd && canCreate && (
        <AddMeetingModal classes={E.CLASSES || []} onClose={() => setShowAdd(false)} onSubmit={addMeeting} />
      )}
    </div>
  );
}

function AddMeetingModal({ classes, onClose, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    title: "",
    description: "",
    date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    time: "10:00",
    location: "School auditorium",
    audienceKind: "all",          // all | classes
    audienceClasses: [],           // array of "1-A", "2-B", ...
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleClass = (c) => setForm((f) => ({
    ...f,
    audienceClasses: f.audienceClasses.includes(c)
      ? f.audienceClasses.filter((x) => x !== c)
      : [...f.audienceClasses, c],
  }));

  // Flat list of class-sections for the picker. Sort numerically by class
  // number, then section letter — a plain string sort puts "12-C" between
  // "1-B" and "2-A".
  const classList = useMemo(() => {
    const out = [];
    classes.forEach((c) => (c.sections || ["A"]).forEach((s) => out.push(`${c.n}-${s}`)));
    return out.sort((a, b) => {
      const [an, as] = String(a).split("-");
      const [bn, bs] = String(b).split("-");
      const dn = (Number(an) || 0) - (Number(bn) || 0);
      return dn !== 0 ? dn : String(as || "").localeCompare(String(bs || ""));
    });
  }, [classes]);

  const setAllClasses = (on) => setForm((f) => ({ ...f, audienceClasses: on ? [...classList] : [] }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (!form.title.trim()) throw new Error("Title required");
      if (!form.date || !form.time) throw new Error("Date & time required");
      let audience = "all";
      let audienceLabel = "All parents";
      if (form.audienceKind === "classes") {
        if (form.audienceClasses.length === 0) throw new Error("Pick at least one class");
        // Sort the picked list before encoding so the audience label reads
        // naturally ("Classes 1-A, 2-B, 5-A" instead of insertion order).
        const sorted = [...form.audienceClasses].sort((a, b) => {
          const [an, as] = String(a).split("-");
          const [bn, bs] = String(b).split("-");
          const dn = (Number(an) || 0) - (Number(bn) || 0);
          return dn !== 0 ? dn : String(as || "").localeCompare(String(bs || ""));
        });
        // Encoding stays compatible with the existing `class:1-A` shape when
        // exactly one class is picked, so older meetings still render the
        // same way. Multiple classes use `classes:` (plural).
        if (sorted.length === 1) {
          audience = `class:${sorted[0]}`;
          audienceLabel = `Class ${sorted[0]}`;
        } else {
          audience = `classes:${sorted.join(",")}`;
          audienceLabel = `Classes ${sorted.join(", ")}`;
        }
      }
      const scheduledAt = new Date(`${form.date}T${form.time}:00`).toISOString();
      await onSubmit({
        title: form.title.trim(),
        description: form.description.trim() || null,
        scheduledAt,
        location: form.location.trim() || "School premises",
        audience,
        audienceLabel,
      });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 520, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div><div className="card-title">Schedule meeting</div><div className="card-sub">PTM, class meeting, 1:1</div></div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Title *">
            <input className="input" autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Term-1 Parent-Teacher Meeting" />
          </Field>
          <Field label="Description (optional)">
            <textarea className="input" style={{ height: 70, padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Date *">
              <input className="input" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
            </Field>
            <Field label="Time *">
              <input className="input" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
            </Field>
          </div>
          <Field label="Location">
            <input className="input" value={form.location} onChange={(e) => set("location", e.target.value)} />
          </Field>
          <Field label="Audience *">
            <div className="segmented">
              <button type="button" className={form.audienceKind === "all" ? "active" : ""} onClick={() => set("audienceKind", "all")}>All parents</button>
              <button type="button" className={form.audienceKind === "classes" ? "active" : ""} onClick={() => set("audienceKind", "classes")}>Pick classes</button>
            </div>
            {form.audienceKind === "classes" && (
              <div style={{ marginTop: 8, background: "var(--bg-2)", border: "1px solid var(--rule)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
                  <button type="button" className="btn sm ghost" onClick={() => setAllClasses(true)}>Select all</button>
                  <button type="button" className="btn sm ghost" onClick={() => setAllClasses(false)}>Clear</button>
                  <span style={{ marginLeft: "auto", alignSelf: "center" }}>
                    {form.audienceClasses.length === 0
                      ? <em style={{ color: "var(--ink-4)" }}>nothing picked</em>
                      : `${form.audienceClasses.length} picked`}
                  </span>
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
                  gap: 6,
                  maxHeight: 180,
                  overflowY: "auto",
                }}>
                  {classList.map((c) => {
                    const on = form.audienceClasses.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => toggleClass(c)}
                        className={on ? "btn sm accent" : "btn sm"}
                        style={{ justifyContent: "center" }}
                      >
                        {on && <Icon name="check" size={10} />}{c}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Field>
          {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn accent" disabled={busy}>{busy ? "Saving…" : "Schedule"}</button>
          </div>
        </form>
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
