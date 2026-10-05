"use client";

import { useMemo, useState } from "react";
import Icon from "../Icon";
import { formatClassLabel } from "@/lib/format";

// Class progress — what the marks add up to, per class.
//
// The app records exams and marks but never read them back as a picture, so
// "how is Class 5 doing?" had no answer. Four questions, in the order a
// principal asks them:
//
//   1. How is this class doing overall, and is it moving?
//   2. Which subjects are strong, which are lagging?
//   3. Did the class improve across the test rounds?
//   4. Who needs attention?
//
// Scores are normalised to a percentage (score / maxMarks) so a 25-mark unit
// test and a 50-mark mid-term sit on one scale.

// Series colours. Validated for colourblind separation (protan/deutan/tritan)
// and contrast against both the light and dark chart surface — all six checks
// pass in both modes. Fixed order, never cycled: subject N always gets slot N.
const SERIES = ["#3a63c4", "#e8530e", "#2f8f6f", "#b07c28", "#8a5bc0"];

// Band thresholds. Deliberately coarse — "who needs attention" should not
// imply false precision from a handful of tests.
const BANDS = [
  { min: 75, label: "Strong",         tone: "ok" },
  { min: 60, label: "On track",       tone: "ok" },
  { min: 45, label: "Needs support",  tone: "warn" },
  { min: 0,  label: "At risk",        tone: "bad" },
];
const bandFor = (pct) => BANDS.find((b) => pct >= b.min) || BANDS[BANDS.length - 1];

// Exam types, as stored on the exam row. The label is what a round is called
// on the chart; an unrecognised type falls back to the raw value so nothing
// silently disappears.
const TYPE_LABEL = {
  periodic_1: "Periodic Test I",
  periodic_2: "Periodic Test II",
  periodic_3: "Periodic Test III",
  periodic_4: "Periodic Test IV",
  term_1: "Term I",
  term_2: "Term II",
  unit_test: "Unit test",
  mid_term: "Mid-term",
  final: "Final",
  assignment: "Assignment",
  practical: "Practical",
  project: "Project",
};
// A round groups every subject paper sat in the same assessment. Keyed on the
// exam's `type` rather than its name: names are free text and vary between
// schools, so parsing them put each paper in its own round.
const roundKeyOf = (ex) => ex.type || "other";
const roundLabelOf = (key) => TYPE_LABEL[key] || key;

const pct = (score, max) => (max > 0 ? (Number(score) || 0) / max * 100 : 0);
const round1 = (n) => Math.round(n * 10) / 10;

export default function ScreenClassProgress({ E, role, session }) {
  const isTeacher = role === "teacher";

  // Teachers see only their assigned classes; everyone else sees all.
  const myClasses = useMemo(() => {
    if (!isTeacher) return null;
    const arr = Array.isArray(session?.linkedClasses) && session.linkedClasses.length
      ? session.linkedClasses : [];
    return arr.length ? new Set(arr) : null;
  }, [isTeacher, session]);

  const exams = useMemo(() => {
    const all = E.EXAMS || [];
    return myClasses ? all.filter((e) => myClasses.has(e.cls)) : all;
  }, [E.EXAMS, myClasses]);

  const marks = E.MARKS || [];
  const students = E.ADDED_STUDENTS || [];

  // Classes that actually have marks — an empty class in the picker is noise.
  const classes = useMemo(() => {
    const withMarks = new Set();
    const examById = new Map(exams.map((e) => [e.id, e]));
    for (const m of marks) {
      const ex = examById.get(m.examId);
      if (ex?.cls) withMarks.add(ex.cls);
    }
    return [...withMarks].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || String(a).localeCompare(String(b)));
  }, [exams, marks]);

  const [cls, setCls] = useState("");
  const activeCls = cls && classes.includes(cls) ? cls : (classes[0] || "");

  // ---- everything derived for the selected class -------------------------
  const view = useMemo(() => {
    if (!activeCls) return null;
    const classExams = exams.filter((e) => e.cls === activeCls);
    const examById = new Map(classExams.map((e) => [e.id, e]));
    const classMarks = marks.filter((m) => examById.has(m.examId));
    if (classMarks.length === 0) return { empty: true };

    // --- by subject ---
    const subjAcc = new Map();
    for (const m of classMarks) {
      const ex = examById.get(m.examId);
      const key = ex.subject || "—";
      if (!subjAcc.has(key)) subjAcc.set(key, { sum: 0, n: 0 });
      const a = subjAcc.get(key);
      a.sum += pct(m.score, m.maxMarks || ex.maxMarks || 100);
      a.n += 1;
    }
    const subjects = [...subjAcc.entries()]
      .map(([subject, a]) => ({ subject, avg: round1(a.sum / a.n), count: a.n }))
      .sort((a, b) => b.avg - a.avg);

    // --- across test rounds, in date order ---
    const roundAcc = new Map();
    for (const m of classMarks) {
      const ex = examById.get(m.examId);
      const key = roundKeyOf(ex);
      if (!roundAcc.has(key)) roundAcc.set(key, { sum: 0, n: 0, date: ex.date || "" });
      const a = roundAcc.get(key);
      a.sum += pct(m.score, m.maxMarks || ex.maxMarks || 100);
      a.n += 1;
      // Earliest paper dates the round, so the line reads oldest to newest.
      if (ex.date && (!a.date || ex.date < a.date)) a.date = ex.date;
    }
    const rounds = [...roundAcc.entries()]
      .map(([key, a]) => ({ key, name: roundLabelOf(key), avg: round1(a.sum / a.n), date: a.date, count: a.n }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // --- per student, with their trend across rounds ---
    const stuAcc = new Map();
    for (const m of classMarks) {
      const ex = examById.get(m.examId);
      const id = m.studentId;
      if (!stuAcc.has(id)) stuAcc.set(id, { name: m.studentName, sum: 0, n: 0, byRound: new Map(), bySubject: new Map() });
      const a = stuAcc.get(id);
      const p = pct(m.score, m.maxMarks || ex.maxMarks || 100);
      a.sum += p; a.n += 1;
      const rk = roundKeyOf(ex);
      if (!a.byRound.has(rk)) a.byRound.set(rk, { sum: 0, n: 0 });
      const r = a.byRound.get(rk);
      r.sum += p; r.n += 1;
      const sk = ex.subject || "\u2014";
      if (!a.bySubject.has(sk)) a.bySubject.set(sk, { sum: 0, n: 0 });
      const sa = a.bySubject.get(sk);
      sa.sum += p; sa.n += 1;
    }
    const roundOrder = rounds.map((r) => r.key);
    const roundLabels = rounds.map((r) => r.name);
    const subjectOrder = subjects.map((s) => s.subject);
    const studentRows = [...stuAcc.entries()].map(([id, a]) => {
      const seq = roundOrder
        .map((rk) => (a.byRound.has(rk) ? a.byRound.get(rk).sum / a.byRound.get(rk).n : null))
        .filter((v) => v != null);
      const delta = seq.length >= 2 ? round1(seq[seq.length - 1] - seq[0]) : null;
      // Per-subject average, in the same column order for every row.
      const bySubject = {};
      for (const sub of subjectOrder) {
        const acc = a.bySubject.get(sub);
        bySubject[sub] = acc ? round1(acc.sum / acc.n) : null;
      }
      // Per-round average, so a row can show the arc of a student's year.
      const byRound = {};
      for (const rk of roundOrder) {
        const acc = a.byRound.get(rk);
        byRound[rk] = acc ? round1(acc.sum / acc.n) : null;
      }
      return { id, name: a.name, avg: round1(a.sum / a.n), delta, count: a.n, bySubject, byRound };
    }).sort((a, b) => a.avg - b.avg);

    const overall = round1(classMarks.reduce((s, m) => {
      const ex = examById.get(m.examId);
      return s + pct(m.score, m.maxMarks || ex.maxMarks || 100);
    }, 0) / classMarks.length);

    const trend = rounds.length >= 2 ? round1(rounds[rounds.length - 1].avg - rounds[0].avg) : null;
    const roll = students.filter((s) => s.cls === activeCls).length;

    return {
      subjects, rounds, studentRows, overall, trend, roll,
      subjectOrder, roundOrder, roundLabels,
      examCount: classExams.length, markCount: classMarks.length,
      needsAttention: studentRows.filter((s) => s.avg < 60),
    };
  }, [activeCls, exams, marks, students]);

  if (classes.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-eyebrow">Academics · progress</div>
            <h1 className="page-title">Class <em>progress</em></h1>
            <div className="page-sub">Average marks per class, by subject and across test rounds.</div>
          </div>
        </div>
        <div className="card">
          <div className="empty" style={{ padding: 40 }}>
            No marks recorded yet. Once a teacher enters marks on the Exams &amp; Marks
            screen, this page shows how each class is doing.
          </div>
        </div>
      </div>
    );
  }

  const band = view && !view.empty ? bandFor(view.overall) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Academics · progress</div>
          <h1 className="page-title">Class <em>progress</em></h1>
          <div className="page-sub">
            Average marks per class, by subject and across test rounds. All scores are
            shown as a percentage so tests with different totals compare fairly.
          </div>
        </div>
      </div>

      {/* Filter row — one row, above the charts. */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 14px" }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)" }}>
            Class
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {classes.map((c) => (
              <button
                key={c}
                className={`btn sm ${c === activeCls ? "accent" : "ghost"}`}
                onClick={() => setCls(c)}
              >
                {formatClassLabel(c)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view?.empty ? (
        <div className="card"><div className="empty" style={{ padding: 40 }}>No marks for {formatClassLabel(activeCls)} yet.</div></div>
      ) : view ? (
        <>
          {/* Headline numbers. A stat tile, not a chart — one value each. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 14 }}>
            <StatTile
              label="Class average"
              value={`${view.overall}%`}
              sub={band ? band.label : ""}
              tone={band?.tone}
            />
            <StatTile
              label="Change since first test"
              value={view.trend == null ? "—" : `${view.trend > 0 ? "+" : ""}${view.trend} pts`}
              sub={view.trend == null ? "needs two rounds" : (view.trend > 0 ? "improving" : view.trend < 0 ? "slipping" : "flat")}
              tone={view.trend == null ? undefined : view.trend > 0 ? "ok" : view.trend < 0 ? "bad" : undefined}
            />
            <StatTile label="Students" value={view.roll} sub={`${view.studentRows.length} with marks`} />
            <StatTile label="Needs attention" value={view.needsAttention.length} sub="below 60%" tone={view.needsAttention.length ? "warn" : "ok"} />
          </div>

          {/* Subject averages — magnitude by category, so horizontal bars. */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Average by subject</div>
                <div className="card-sub">{formatClassLabel(activeCls)} · across {view.examCount} exams</div>
              </div>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 11, paddingTop: 14 }}>
              {view.subjects.map((s, i) => (
                <SubjectBar key={s.subject} subject={s.subject} avg={s.avg} color={SERIES[i % SERIES.length]} />
              ))}
            </div>
          </div>

          {/* Trend across rounds — change over time, so a line. */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <div>
                <div className="card-title">Across test rounds</div>
                <div className="card-sub">Class average after each round, oldest first</div>
              </div>
            </div>
            <div className="card-body" style={{ paddingTop: 16 }}>
              <RoundsLine rounds={view.rounds} />
            </div>
          </div>

          {/* Every student, every subject. The table is the point here —
              identity and exact numbers matter more than shape. */}
          <StudentGrid view={view} />

        </>
      ) : null}
    </div>
  );
}

// Every student x every subject. Sortable, filterable, and it carries the
// exact numbers - the charts above show shape, this answers "what did
// Meera actually get in Science?".
function StudentGrid({ view }) {
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("avg");
  const [asc, setAsc] = useState(true);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("subject"); // subject | round

  const cols = mode === "subject" ? view.subjectOrder : view.roundOrder;
  // Round columns are keyed on exam type; show the readable label instead.
  const headerFor = (c) => (mode === "subject" ? c : (view.roundLabels[view.roundOrder.indexOf(c)] || c));
  const keyOf = (r) => (mode === "subject" ? r.bySubject : r.byRound);

  const rows = useMemo(() => {
    let out = view.studentRows;
    if (filter === "attention") out = out.filter((r) => r.avg < 60);
    else if (filter === "strong") out = out.filter((r) => r.avg >= 75);
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((r) => (r.name || "").toLowerCase().includes(q));
    const dir = asc ? 1 : -1;
    return [...out].sort((a, b) => {
      if (sortBy === "name") return dir * String(a.name || "").localeCompare(String(b.name || ""));
      if (sortBy === "delta") return dir * ((a.delta ?? -999) - (b.delta ?? -999));
      if (sortBy === "avg") return dir * (a.avg - b.avg);
      const av = keyOf(a)[sortBy], bv = keyOf(b)[sortBy];
      return dir * ((av ?? -1) - (bv ?? -1));
    });
  }, [view.studentRows, filter, sortBy, asc, query, mode]);

  function sortOn(key) {
    if (sortBy === key) setAsc((v) => !v);
    else { setSortBy(key); setAsc(key === "name"); }
  }
  const arrow = (key) => (sortBy === key ? (asc ? " ↑" : " ↓") : "");

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Every student</div>
          <div className="card-sub">
            {mode === "subject" ? "Average per subject" : "Average per test round"} ·
            {" "}click a column heading to sort
          </div>
        </div>
        <span className="chip">{rows.length} of {view.studentRows.length}</span>
      </div>

      {/* Filters, one row above the table. */}
      <div className="card-body" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--rule)" }}>
        <div className="segmented">
          <button className={mode === "subject" ? "active" : ""} onClick={() => { setMode("subject"); setSortBy("avg"); }}>By subject</button>
          <button className={mode === "round" ? "active" : ""} onClick={() => { setMode("round"); setSortBy("avg"); }}>By test round</button>
        </div>
        <div className="segmented">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
          <button className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")}>Needs attention</button>
          <button className={filter === "strong" ? "active" : ""} onClick={() => setFilter("strong")}>Strong</button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a student…"
          style={{
            flex: "1 1 160px", minWidth: 140, maxWidth: 260,
            padding: "6px 10px", fontSize: 12,
            border: "1px solid var(--rule)", borderRadius: 7,
            background: "var(--bg)", color: "var(--ink)",
          }}
        />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => sortOn("name")}>Student{arrow("name")}</th>
              {cols.map((c) => (
                <th key={c} className="num" style={{ cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => sortOn(c)}>
                  {headerFor(c)}{arrow(c)}
                </th>
              ))}
              <th className="num" style={{ cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => sortOn("avg")}>Average{arrow("avg")}</th>
              <th className="num" style={{ cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => sortOn("delta")} title="Change from the first test round to the latest">
                Change{arrow("delta")}
              </th>
              <th style={{ whiteSpace: "nowrap" }}>Band</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + 4} className="empty">No students match.</td></tr>
            )}
            {rows.map((r) => {
              const b = bandFor(r.avg);
              const vals = keyOf(r);
              return (
                <tr key={r.id}>
                  <td style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap" }}>{r.name}</td>
                  {cols.map((c) => {
                    const v = vals[c];
                    return (
                      <td key={c} className="num" style={{ color: v == null ? "var(--ink-4)" : v < 45 ? "var(--accent-2)" : v < 60 ? "var(--warn)" : "var(--ink-2)" }}>
                        {v == null ? "—" : `${v}%`}
                      </td>
                    );
                  })}
                  <td className="num" style={{ fontWeight: 700, color: "var(--ink)" }}>{r.avg}%</td>
                  <td className="num" style={{ color: r.delta == null ? "var(--ink-4)" : r.delta > 0 ? "var(--ok)" : r.delta < 0 ? "var(--accent-2)" : "var(--ink-3)" }}>
                    {r.delta == null ? "—" : `${r.delta > 0 ? "+" : ""}${r.delta}`}
                  </td>
                  <td><span className={`chip ${b.tone}`}>{b.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function StatTile({ label, value, sub, tone }) {
  const toneColor = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--accent-2)" : "var(--ink-3)";
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)" }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15, marginTop: 6, color: "var(--ink)" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11.5, marginTop: 3, color: toneColor }}>{sub}</div>}
    </div>
  );
}

// Horizontal bar. Direct-labelled, so identity never depends on colour alone.
function SubjectBar({ subject, avg, color }) {
  const w = Math.max(0, Math.min(100, avg));
  return (
    <div
      title={`${subject} · ${avg}%`}
      style={{
        display: "grid", gridTemplateColumns: "minmax(90px, 140px) 1fr auto",
        alignItems: "center", gap: 10, width: "100%",
        background: "none", border: 0, padding: 0, textAlign: "left",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {subject}
      </span>
      <span style={{ position: "relative", height: 10, background: "var(--bg-2)", borderRadius: 5, overflow: "hidden" }}>
        <span style={{
          position: "absolute", inset: "0 auto 0 0", width: `${w}%`,
          background: color, borderRadius: "5px 4px 4px 5px",
          transition: "width 0.3s ease",
        }} />
      </span>
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", minWidth: 42, textAlign: "right" }}>
        {avg}%
      </span>
    </div>
  );
}

// Line across test rounds. One series, so no legend — the title names it.
function RoundsLine({ rounds }) {
  const [hover, setHover] = useState(null);
  if (!rounds || rounds.length === 0) {
    return <div className="empty" style={{ padding: 24 }}>No rounds to plot.</div>;
  }
  if (rounds.length === 1) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
        Only one test round so far (<strong style={{ color: "var(--ink)" }}>{rounds[0].name}</strong>,
        average {rounds[0].avg}%). A trend appears once a second round is marked.
      </div>
    );
  }

  const W = 100, H = 42, PAD = 4;
  const xs = rounds.map((_, i) => PAD + (i * (W - PAD * 2)) / (rounds.length - 1));
  const lo = Math.max(0, Math.min(...rounds.map((r) => r.avg)) - 8);
  const hi = Math.min(100, Math.max(...rounds.map((r) => r.avg)) + 8);
  const span = hi - lo || 1;
  const ys = rounds.map((r) => PAD + (1 - (r.avg - lo) / span) * (H - PAD * 2));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${ys[i].toFixed(2)}`).join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 150, display: "block", overflow: "visible" }} role="img" aria-label={`Class average across ${rounds.length} test rounds`}>
        {/* Recessive baseline */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--rule)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke="#3a63c4" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        {xs.map((x, i) => (
          <g key={rounds[i].name}>
            {/* Oversized invisible hit target */}
            <circle cx={x} cy={ys[i]} r="6" fill="transparent" style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            <circle cx={x} cy={ys[i]} r={hover === i ? "2.6" : "2"} fill="#3a63c4"
              stroke="var(--bg)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>

      {/* Labels sit outside the SVG so they never stretch with preserveAspectRatio. */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, gap: 8 }}>
        {rounds.map((r, i) => (
          <div key={r.name} style={{ flex: 1, textAlign: i === 0 ? "left" : i === rounds.length - 1 ? "right" : "center", minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: hover === i ? "var(--accent)" : "var(--ink)" }}>{r.avg}%</div>
            <div style={{ fontSize: 10.5, color: "var(--ink-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
