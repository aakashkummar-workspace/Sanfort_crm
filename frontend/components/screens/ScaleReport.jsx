"use client";

// SCALE — Student report card screen.
// Phase 3: parent-facing per-student profile (72 / 55 / 88 / 63 layout
// from the chat sample) with on-screen render + branded PDF export.
// Auto-generated narratives + priority-focus list keyed off the data.
//
// Visibility mirrors the API's auth rules:
//   parent → only their child (no picker)
//   teacher → students in their assigned classes (with picker)
//   admin / principal / academic_director → any student (with picker)

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { resolveSchool, downloadScaleReportPdf } from "@/lib/export";
import { formatClassLabel } from "@/lib/format";

const TERM_OPTIONS = [
  { k: "all",    label: "All-time" },
  { k: 1,        label: "Term 1" },
  { k: 2,        label: "Term 2" },
  { k: 3,        label: "Term 3" },
  { k: "last7",  label: "Last 7 days" },
  { k: "last30", label: "Last 30 days" },
  { k: "custom", label: "Custom date range…" },
];

// Rough term date windows. Adjust per school — these match a typical
// Indian academic calendar with three terms.
function termDateRange(term, custom) {
  if (term === "custom") return { from: custom?.from || null, to: custom?.to || null };
  if (term === "last7" || term === "last30") {
    const days = term === "last7" ? 7 : 30;
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return { from, to };
  }
  if (term === "all" || term == null) return { from: null, to: null };
  const year = new Date().getFullYear();
  const ranges = {
    1: { from: `${year}-04-01`, to: `${year}-07-31` },
    2: { from: `${year}-08-01`, to: `${year}-11-30` },
    3: { from: `${year}-12-01`, to: `${year + 1}-03-31` },
  };
  return ranges[Number(term)] || { from: null, to: null };
}

// Indicator label lookup for the timeline card.
const INDICATOR_LABELS = {
  "A.lesson_test":     "Lesson test",
  "A.worksheet":       "Worksheet",
  "A.oral_response":   "Oral response",
  "A.homework_return": "Homework return",
  "E.handwriting":     "Handwriting",
  "E.reading_fluency": "Reading fluency",
  "E.speaking":        "Speaking",
  "E.presentation":    "Presentation",
  "C.initiates":       "Initiates ideas",
  "C.participates":    "Participates",
  "C.invents_rules":   "Invents rules",
  "C.cross_domain":    "Cross-domain",
  "B.punctuality":     "Punctuality",
  "B.discipline":      "Discipline",
  "B.screen_free":     "Screen-free",
  "B.peer_tone":       "Peer tone",
};

export default function ScreenScaleReport({ E, role, session, searchFocus, clearSearchFocus }) {
  const isParent = role === "parent";
  const myClasses = Array.isArray(session?.linkedClasses) ? session.linkedClasses : [];
  const isTeacher = role === "teacher";

  // Build the picker roster based on role-scoped students.
  const roster = useMemo(() => {
    const all = E.ADDED_STUDENTS || [];
    if (isParent) {
      return all.filter((s) => s.id === session?.linkedId);
    }
    if (isTeacher && myClasses.length > 0) {
      const set = new Set(myClasses);
      return all.filter((s) => set.has(s.cls));
    }
    return all;
  }, [E.ADDED_STUDENTS, isParent, isTeacher, myClasses, session?.linkedId]);

  const [classFilter, setClassFilter] = useState("");
  const [studentId, setStudentId] = useState("");
  const [term, setTerm] = useState("all");
  // Custom date range — only used when term === "custom". Default to
  // last 14 days so the inputs land on something sensible.
  const today = new Date().toISOString().slice(0, 10);
  const fortnight = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [customRange, setCustomRange] = useState({ from: fortnight, to: today });
  const [observation, setObservation] = useState("");
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  // Distinct class list pulled from the role-scoped roster — sorted
  // alphabetically so 1-A comes before 2-A and so on.
  const classes = useMemo(() => {
    const set = new Set(roster.map((s) => s.cls).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [roster]);

  // Students visible in the picker — filtered by selected class.
  const filteredRoster = useMemo(() => {
    if (!classFilter) return roster;
    return roster.filter((s) => s.cls === classFilter);
  }, [roster, classFilter]);

  // Default to the first available student. If the current student is
  // no longer in the filtered roster (class change), reset.
  useEffect(() => {
    if (filteredRoster.length === 0) { setStudentId(""); return; }
    if (!studentId || !filteredRoster.some((s) => s.id === studentId)) {
      setStudentId(filteredRoster[0].id);
    }
  }, [filteredRoster, studentId]);

  // Deep-link: when opened from the dashboard "Recently viewed" card (or global
  // search), jump straight to the requested student instead of the first one.
  useEffect(() => {
    if (!searchFocus?.id) return;
    const stu = roster.find((s) => s.id === searchFocus.id);
    if (stu) { setClassFilter(stu.cls || ""); setStudentId(stu.id); }
    clearSearchFocus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocus, roster]);

  // Track recently-viewed students (per user, in localStorage) so the dashboard
  // quick-access card can offer one-tap return to a report.
  useEffect(() => {
    if (!studentId) return;
    const stu = roster.find((s) => s.id === studentId);
    if (!stu) return;
    try {
      const uid = session?.sub || session?.id || "anon";
      const key = `scaleRecent:${uid}`;
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      const entry = { id: stu.id, name: stu.name, cls: stu.cls, ts: Date.now() };
      const next = [entry, ...prev.filter((x) => x && x.id !== stu.id)].slice(0, 8);
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, roster]);

  async function reload() {
    if (!studentId) return;
    setLoading(true); setErr("");
    try {
      const { from, to } = termDateRange(term, customRange);
      const qs = new URLSearchParams();
      if (from) qs.set("dateFrom", from);
      if (to)   qs.set("dateTo",   to);
      const r = await fetch(`/api/scale/student/${encodeURIComponent(studentId)}${qs.toString() ? `?${qs}` : ""}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load");
      setProfile(j);
    } catch (e) {
      setErr(e.message || "Failed");
      setProfile(null);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [studentId, term, customRange.from, customRange.to]);

  // Persist the teacher observation per (student, term) in localStorage
  // for now — survives reloads, doesn't burn schema. Server-side
  // persistence can come in a later phase if needed.
  const obsKey = studentId ? `scale.obs.${studentId}.${term}` : null;
  useEffect(() => {
    if (!obsKey) return;
    try { setObservation(localStorage.getItem(obsKey) || ""); } catch {}
  }, [obsKey]);
  function saveObservation(val) {
    setObservation(val);
    try { if (obsKey) localStorage.setItem(obsKey, val); } catch {}
  }

  const student = roster.find((s) => s.id === studentId);
  const school  = resolveSchool(E?.SETTINGS);

  // Derived view-model for both the on-screen card and the PDF.
  const view = useMemo(() => {
    if (!profile) return null;
    const domainList = (profile.domains || profile.perDomain) || {};
    // The API returns perDomain as an object map; normalise to a list.
    const list = Object.entries(domainList).map(([key, v]) => {
      const data = v && typeof v === "object" ? v : { score: v, band: { label: "" } };
      return {
        key,
        label: ({ A: "Academic output", E: "Expression", C: "Creativity & play", B: "Behaviour & habits" })[key] || key,
        short: ({ A: "Academic", E: "Expression", C: "Creativity", B: "Behaviour" })[key] || key,
        color: ({ A: "#1f3f8b", E: "#1f7a3a", C: "#e8530e", B: "#c11d1d" })[key] || "#1f3f8b",
        score: data.score ?? null,
        bandLabel: data.band?.label || "",
        bandTone:  data.band?.tone  || "info",
      };
    });
    return list.sort((a, b) => "AECB".indexOf(a.key) - "AECB".indexOf(b.key));
  }, [profile]);

  // Narratives + priority focus are computed client-side via the same
  // helpers the server would use, so the on-screen text matches the PDF.
  const [narratives, setNarratives] = useState({});
  const [priorityFocus, setPriorityFocus] = useState([]);
  useEffect(() => {
    if (!profile) { setNarratives({}); setPriorityFocus([]); return; }
    (async () => {
      const mod = await import("@/lib/scale");
      const narrs = {};
      for (const k of ["A", "E", "C", "B"]) {
        const score = profile.perDomain?.[k]?.score ?? null;
        narrs[k] = mod.narrativeFor(k, score, profile.perIndicator || {});
      }
      setNarratives(narrs);
      const flatPerDomain = {};
      for (const k of Object.keys(profile.perDomain || {})) {
        flatPerDomain[k] = profile.perDomain[k]?.score ?? null;
      }
      setPriorityFocus(mod.priorityFocusFor(profile.perIndicator || {}, flatPerDomain, 4));
    })();
  }, [profile]);

  async function exportPdf() {
    if (!profile || !view) return;
    await downloadScaleReportPdf({
      school,
      actor: session?.name || null,
      student: {
        name: student?.name,
        cls: student?.cls,
        roll: roster.findIndex((s) => s.id === studentId) + 1,
        term: term === "all" ? "All" : term,
      },
      composite: profile.composite,
      compositeBand: profile.compositeBand,
      domains: view.map((d) => ({
        ...d,
        narrative: narratives[d.key] || "",
      })),
      priorityFocus,
      observation,
    });
  }

  const compositeColor = (() => {
    const c = profile?.composite;
    if (c == null) return "var(--ink-3)";
    if (c >= 70) return "var(--ok)";
    if (c >= 55) return "var(--warn, #ad7900)";
    return "var(--bad, #b13c1c)";
  })();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Academics · SCALE</div>
          <div className="page-title">SCALE <span className="amber">report</span></div>
          <div className="page-sub">
            {isParent
              ? "Your child's competency profile across the four SCALE domains. Discuss this with the class teacher at the next parent meeting."
              : "Per-student competency profile. Pick a student to view, change term to scope the date range, then export the PDF for parent meetings."}
          </div>
        </div>
        <div className="page-actions">
          {(role === "parent" || profile) && (
            <button className="btn accent" onClick={exportPdf} disabled={!profile}>
              <Icon name="download" size={13} />Print / save as PDF
            </button>
          )}
        </div>
      </div>

      {/* Picker row — class first, then student. Parent role skips it
          entirely since they only ever see their own child. */}
      <div className="card" style={{ marginBottom: 14, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {!isParent && (
          <>
            <select
              className="select"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              title="Filter by class"
              style={{ flex: "0 0 auto", minWidth: 140 }}
            >
              <option value="">All classes ({roster.length})</option>
              {classes.map((c) => {
                const n = roster.filter((s) => s.cls === c).length;
                return <option key={c} value={c}>{formatClassLabel(c)} ({n})</option>;
              })}
            </select>
            <select
              className="select"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
              disabled={filteredRoster.length === 0}
            >
              {filteredRoster.length === 0
                ? <option value="">No students in {classFilter ? formatClassLabel(classFilter) : "scope"}</option>
                : <>
                    <option value="">Pick a student…</option>
                    {filteredRoster.map((s) => <option key={s.id} value={s.id}>{s.name} — {formatClassLabel(s.cls)}</option>)}
                  </>
              }
            </select>
          </>
        )}
        <select
          className="select"
          value={term}
          onChange={(e) => {
            const v = e.target.value;
            // Only the three numeric terms get coerced to Number; the
            // string keys stay as-is so the helper can branch on them.
            if (v === "1" || v === "2" || v === "3") setTerm(Number(v));
            else setTerm(v);
          }}
          style={{ minWidth: 160 }}
        >
          {TERM_OPTIONS.map((t) => <option key={t.k} value={t.k}>{t.label}</option>)}
        </select>
        {term === "custom" && (
          <>
            <input
              type="date"
              className="input"
              value={customRange.from}
              max={customRange.to || undefined}
              onChange={(e) => setCustomRange((r) => ({ ...r, from: e.target.value }))}
              style={{ flex: "0 0 auto" }}
              title="From date"
            />
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>→</span>
            <input
              type="date"
              className="input"
              value={customRange.to}
              min={customRange.from || undefined}
              max={today}
              onChange={(e) => setCustomRange((r) => ({ ...r, to: e.target.value }))}
              style={{ flex: "0 0 auto" }}
              title="To date"
            />
          </>
        )}
        {profile?.entriesCount != null && (
          <span className="chip">{profile.entriesCount} entries in this window</span>
        )}
      </div>

      {!studentId ? (
        <div className="card"><div className="empty" style={{ padding: 50 }}>Pick a student to view their SCALE report.</div></div>
      ) : loading && !loaded ? (
        <div className="card"><div className="empty" style={{ padding: 50 }}>Loading…</div></div>
      ) : err ? (
        <div className="card"><div className="empty" style={{ padding: 50, color: "var(--bad)" }}>{err}</div></div>
      ) : !profile ? null : (
        <>
          {/* Student identity + composite */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-body" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{
                width: 56, height: 56, borderRadius: 14,
                background: "linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)))",
                color: "#fff", display: "grid", placeItems: "center",
                fontWeight: 700, fontSize: 18, flexShrink: 0,
              }}>
                {(student?.name || "??").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)" }}>{student?.name || "Student"}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
                  {student?.cls ? formatClassLabel(student.cls) : "—"} · {term === "all" ? "All-time" : `Term ${term}`} ·
                  {" "}composite weights A/E/C/B = {Object.values(profile.weights || {}).join(" / ") || "default"}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>SCALE composite</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: compositeColor, fontFamily: "var(--font-serif, Georgia)" }}>
                  {profile.composite ?? "—"}<span style={{ fontSize: 14, color: "var(--ink-3)" }}> / 100</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-2, var(--accent))" }}>
                  {profile.compositeBand || "—"}
                </div>
              </div>
            </div>
          </div>

          {/* Domain bars */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Domain scores</div>
                <div className="card-sub">Each band shows where the student sits relative to the standard</div>
              </div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {(view || []).map((d) => (
                <div key={d.key}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                      {d.label}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      <strong style={{ fontSize: 14, color: "var(--ink)", fontFamily: "var(--font-mono)" }}>{d.score ?? "—"}</strong>
                      {d.bandLabel && <span style={{ marginLeft: 8 }}>{d.bandLabel}</span>}
                    </span>
                  </div>
                  <div style={{ height: 8, background: "var(--bg-2)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.max(0, Math.min(100, d.score || 0))}%`,
                      background: d.color,
                      borderRadius: 999,
                      transition: "width 0.4s ease",
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Domain narratives */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Domain observations</div>
                <div className="card-sub">Auto-generated from the data — read alongside the teacher observation below</div>
              </div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(view || []).map((d) => (
                <div key={d.key}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: d.color }} />
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>
                      {d.label} · {d.score ?? "—"}{d.bandLabel ? ` · ${d.bandLabel}` : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, paddingLeft: 17 }}>
                    {narratives[d.key] || "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Priority focus next term */}
          {priorityFocus.length > 0 && (
            <div className="card" style={{ marginBottom: 14, background: "rgba(255, 247, 230, 0.6)", borderLeft: "3px solid var(--accent)" }}>
              <div className="card-head">
                <div>
                  <div className="card-title" style={{ color: "var(--accent-2, var(--accent))" }}>Priority focus — next term</div>
                  <div className="card-sub">Concrete actions, not motivational labels. Pick the top 1–2 to discuss with the parent.</div>
                </div>
              </div>
              <div>
                {priorityFocus.map((p, i) => (
                  <div key={i} className="lrow" style={{ alignItems: "flex-start", gap: 12 }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 6,
                      background: "var(--accent)", color: "#fff",
                      display: "grid", placeItems: "center",
                      fontWeight: 800, fontSize: 12, flexShrink: 0,
                    }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{p.action}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                        Triggered by <strong>{p.indicator}</strong> · score {p.score}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Teacher observation field (free-text, persisted to localStorage) */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Teacher observation</div>
                <div className="card-sub">
                  {isParent
                    ? "What the class teacher wanted to add about your child this term."
                    : "Free-text observation that doesn't fit the score data — emotional state, family context, a specific moment that mattered. 2–3 sentences max. Saved to this device."}
                </div>
              </div>
            </div>
            <div className="card-body">
              {isParent ? (
                <div style={{ fontSize: 13, color: observation ? "var(--ink-2)" : "var(--ink-4)", fontStyle: observation ? "italic" : "normal", lineHeight: 1.55 }}>
                  {observation ? `"${observation}"` : "No observation recorded for this term."}
                </div>
              ) : (
                <textarea
                  className="input"
                  rows={3}
                  value={observation}
                  onChange={(e) => saveObservation(e.target.value.slice(0, 600))}
                  placeholder="One specific moment, interaction, or change observed this term that the score doesn't fully capture."
                  style={{ width: "100%", resize: "vertical", fontFamily: "inherit", fontStyle: "italic" }}
                />
              )}
            </div>
          </div>

          {/* Signatures */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Sign-off</div>
                <div className="card-sub">For the printed copy</div>
              </div>
            </div>
            <div className="card-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 24, paddingTop: 30, paddingBottom: 18 }}>
              {["Class teacher", "Principal / coordinator", "Parent / guardian"].map((label) => (
                <div key={label} style={{ borderTop: "1px solid var(--ink)", paddingTop: 6, fontSize: 11, color: "var(--ink-3)", textAlign: "center" }}>
                  {label}
                </div>
              ))}
            </div>
          </div>

          <SessionTimeline
            studentId={studentId}
            entries={E.SCALE_ENTRIES || []}
            sessions={E.SCALE_SESSIONS || []}
            dateFrom={termDateRange(term, customRange).from}
            dateTo={termDateRange(term, customRange).to}
          />

          <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--bg-2)", border: "1px dashed var(--rule)", borderRadius: 8, fontSize: 11.5, color: "var(--ink-3)" }}>
            <strong>What this report cannot tell you</strong> — learning depth, emotional state, family context, or whether a 3 today is better than a 4 three months ago for a specific child. Use the teacher observation above for that, and the parent-meeting conversation for the rest.
          </div>
        </>
      )}
    </div>
  );
}

// Per-session timeline for the selected student. Groups SCALE entries
// by their session, sorts newest first, and shows what was scored on
// each date along with which teacher recorded it. Drives the "see the
// data date-wise" view alongside the term/composite roll-ups.
function SessionTimeline({ studentId, entries, sessions, dateFrom, dateTo }) {
  const grouped = useMemo(() => {
    if (!studentId) return [];
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const byDate = new Map();
    for (const e of entries) {
      if (e.studentId !== studentId) continue;
      const created = (e.createdAt || "").slice(0, 10);
      // Filter to the active window. Compare by ISO date string —
      // good enough for day-precision and avoids timezone drift.
      if (dateFrom && created && created < dateFrom.slice(0, 10)) continue;
      if (dateTo   && created && created > dateTo.slice(0, 10))   continue;
      const sessionMeta = sessionById.get(e.sessionId);
      const dayKey = sessionMeta?.sessionDate || created || "—";
      if (!byDate.has(dayKey)) byDate.set(dayKey, { date: dayKey, sessions: new Map() });
      const bucket = byDate.get(dayKey);
      const sid = e.sessionId || "(no session)";
      if (!bucket.sessions.has(sid)) {
        bucket.sessions.set(sid, {
          sessionId: sid,
          subject: sessionMeta?.subject || null,
          cls: sessionMeta?.cls || null,
          sessionType: sessionMeta?.sessionType || null,
          entries: [],
        });
      }
      bucket.sessions.get(sid).entries.push(e);
    }
    // Convert maps to arrays + sort newest date first, biggest entry
    // count first within each day.
    return Array.from(byDate.values())
      .map((d) => ({ ...d, sessions: Array.from(d.sessions.values()).sort((a, b) => b.entries.length - a.entries.length) }))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [studentId, entries, sessions, dateFrom, dateTo]);

  const totalEntries = useMemo(() =>
    grouped.reduce((a, d) => a + d.sessions.reduce((b, s) => b + s.entries.length, 0), 0)
  , [grouped]);

  if (!studentId) return null;

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Session timeline</div>
          <div className="card-sub">
            Day-by-day breakdown of which indicators were scored on each lesson.
            {dateFrom || dateTo
              ? <> Window: {dateFrom?.slice(0, 10) || "—"} → {dateTo?.slice(0, 10) || "today"}.</>
              : null}
          </div>
        </div>
        <span className="chip">{totalEntries} entr{totalEntries === 1 ? "y" : "ies"} · {grouped.length} day{grouped.length === 1 ? "" : "s"}</span>
      </div>
      {grouped.length === 0 ? (
        <div className="empty" style={{ padding: 30 }}>
          No entries recorded for this student in the active window. Try widening the term filter or running a SCALE session.
        </div>
      ) : (
        <div>
          {grouped.map((day) => (
            <div key={day.date} style={{ borderTop: "1px solid var(--rule)", padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>
                  {day.date && day.date !== "—"
                    ? new Date(`${day.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })
                    : "(undated)"}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  {day.sessions.length} session{day.sessions.length === 1 ? "" : "s"} · {day.sessions.reduce((a, s) => a + s.entries.length, 0)} entries
                </span>
              </div>
              {day.sessions.map((sess) => (
                <div key={sess.sessionId} style={{ marginBottom: 10, paddingLeft: 12, borderLeft: "2px solid var(--rule)" }}>
                  <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 700, marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {sess.subject && <span>{sess.subject}</span>}
                    {sess.cls && <span className="chip">{formatClassLabel(sess.cls)}</span>}
                    {sess.sessionType && sess.sessionType !== "regular" && <span className="chip warn">{sess.sessionType}</span>}
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-4)" }}>{sess.sessionId}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {sess.entries.map((e) => (
                      <span key={e.id} style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "4px 9px", borderRadius: 999,
                        background: e.score === 4 ? "var(--ok-soft, #e3f2e7)"
                                  : e.score === 3 ? "var(--bg-2)"
                                  : e.score === 2 ? "var(--warn-soft, #fff3cd)"
                                  :                  "var(--bad-soft, #fbe1d8)",
                        color:      e.score === 4 ? "var(--ok)"
                                  : e.score === 3 ? "var(--ink-2)"
                                  : e.score === 2 ? "#856404"
                                  :                  "var(--bad, #b13c1c)",
                        fontSize: 11.5, fontWeight: 700,
                      }}>
                        {INDICATOR_LABELS[e.indicatorKey] || e.indicatorKey}
                        <span style={{ fontFamily: "var(--font-mono)" }}>· {e.score}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
