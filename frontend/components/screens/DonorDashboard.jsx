"use client";

import { useMemo } from "react";
import Icon from "../Icon";
import { formatClassLabel, money } from "@/lib/format";

// What a sponsor sees.
//
// The payload reaching this screen is already narrowed in two places —
// app/page.jsx for the first paint and scopeForRole in /api/data for every
// refresh — to an allowlisted projection of the sponsored students only. Fees,
// parent contact details, transport routes, complaints and welfare records are
// not in the payload at all. Treat that as the boundary; do not reach past it.
//
// Deliberately NOT shown: attendance. Every student row in production carries
// attendance = 0 because nothing populates that column, so a percentage here
// would be a confident-looking falsehood about a real child.

const pct = (score, max) => (max > 0 ? (Number(score) || 0) / max * 100 : 0);
const round = (n) => Math.round(n);

// SCALE indicators are scored on their own scales — reading fluency runs 1-10,
// punctuality is Good/Very Good/Excellent (1-3). Normalising to a percentage is
// the only way to put them side by side honestly.
const SCALE_META = {
  "A.lesson_test":     { label: "Lesson tests",        max: 10, domain: "Learning" },
  "A.worksheet":       { label: "Worksheets done",     max: 2,  domain: "Learning" },
  "A.oral_response":   { label: "Answering in class",  max: 2,  domain: "Learning" },
  "A.homework_return": { label: "Homework returned",   max: 2,  domain: "Learning" },
  "E.handwriting":     { label: "Handwriting",         max: 10, domain: "Expression" },
  "E.reading_fluency": { label: "Reading aloud",       max: 10, domain: "Expression" },
  "E.speaking":        { label: "Speaking confidence", max: 10, domain: "Expression" },
  "E.presentation":    { label: "Presenting",          max: 10, domain: "Expression" },
  "C.initiates":       { label: "Starts activities",   max: 3,  domain: "Creativity" },
  "C.participates":    { label: "Joins in play",       max: 3,  domain: "Creativity" },
  "C.invents_rules":   { label: "Invents games",       max: 3,  domain: "Creativity" },
  "C.cross_domain":    { label: "Connects ideas",      max: 3,  domain: "Creativity" },
  "B.punctuality":     { label: "Punctuality",         max: 3,  domain: "Habits" },
  "B.discipline":      { label: "Focus in class",      max: 3,  domain: "Habits" },
  "B.screen_free":     { label: "Screen-free play",    max: 3,  domain: "Habits" },
  "B.peer_tone":       { label: "Getting on with others", max: 3, domain: "Habits" },
};

const DOMAIN_COLOR = {
  Learning:   "#3a63c4",
  Expression: "#2f8f6f",
  Creativity: "#b07c28",
  Habits:     "#8a5bc0",
};

function bandFor(p) {
  if (p >= 75) return { label: "Doing well", tone: "ok" };
  if (p >= 55) return { label: "Coming along", tone: "ok" };
  if (p >= 40) return { label: "Needs support", tone: "warn" };
  return { label: "Finding it hard", tone: "bad" };
}

export default function ScreenDonorDashboard({ E, session }) {
  const students = E.ADDED_STUDENTS || [];
  const marks = E.MARKS || [];
  const exams = E.EXAMS || [];
  const activities = E.STUDENT_ACTIVITIES || [];
  const receipts = E.DONOR_RECEIPTS || [];
  const scale = E.SCALE_ENTRIES || [];

  const examById = useMemo(() => new Map(exams.map((e) => [e.id, e])), [exams]);

  const cards = useMemo(() => students.map((s) => {
    const theirs = marks.filter((m) => m.studentId === s.id);

    // Per subject, and per assessment round, so a donor sees the arc rather
    // than a single number.
    const bySubject = new Map();
    const byRound = new Map();
    for (const m of theirs) {
      const ex = examById.get(m.examId);
      const p = pct(m.score, m.maxMarks || ex?.maxMarks || 100);

      const subject = ex?.subject || "—";
      if (!bySubject.has(subject)) bySubject.set(subject, { sum: 0, n: 0, best: null });
      const sa = bySubject.get(subject);
      sa.sum += p; sa.n += 1;
      if (sa.best == null || p > sa.best) sa.best = p;

      const round = ex?.type || "other";
      if (!byRound.has(round)) byRound.set(round, { sum: 0, n: 0, date: ex?.date || "" });
      const ra = byRound.get(round);
      ra.sum += p; ra.n += 1;
      if (ex?.date && (!ra.date || ex.date < ra.date)) ra.date = ex.date;
    }

    const subjects = [...bySubject.entries()]
      .map(([subject, a]) => ({ subject, avg: round(a.sum / a.n) }))
      .sort((a, b) => b.avg - a.avg);

    const rounds = [...byRound.entries()]
      .map(([key, a]) => ({ key, avg: round(a.sum / a.n), date: a.date }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const avg = theirs.length ? round(theirs.reduce((acc, m) => {
      const ex = examById.get(m.examId);
      return acc + pct(m.score, m.maxMarks || ex?.maxMarks || 100);
    }, 0) / theirs.length) : null;

    // SCALE — the teacher's own observations, normalised per indicator.
    const scaleByKey = new Map();
    for (const e of scale.filter((x) => x.studentId === s.id)) {
      const meta = SCALE_META[e.indicatorKey];
      if (!meta) continue;
      if (!scaleByKey.has(e.indicatorKey)) scaleByKey.set(e.indicatorKey, { sum: 0, n: 0 });
      const a = scaleByKey.get(e.indicatorKey);
      // 1 is the floor on every scale, so normalise from 1 rather than 0.
      a.sum += ((Number(e.score) || 1) - 1) / Math.max(1, meta.max - 1) * 100;
      a.n += 1;
    }
    const observations = [...scaleByKey.entries()]
      .map(([key, a]) => ({
        key,
        label: SCALE_META[key].label,
        domain: SCALE_META[key].domain,
        pct: round(a.sum / a.n),
        count: a.n,
      }))
      .sort((a, b) => b.pct - a.pct);

    const strengths = observations.slice(0, 2);
    const working = observations.slice(-2).reverse().filter((o) => o.pct < 55);

    return {
      ...s, avg, subjects, rounds, observations, strengths, working,
      markCount: theirs.length,
      activities: activities.filter((a) => a.studentId === s.id).slice(0, 5),
    };
  }), [students, marks, examById, activities, scale]);

  const given = receipts.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const donorName = session?.name || "";

  if (students.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-eyebrow">Sponsorship</div>
            <h1 className="page-title">Your <em>students</em></h1>
          </div>
        </div>
        <div className="card">
          <div className="empty" style={{ padding: 44, textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
              No students allocated yet
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", maxWidth: 420, margin: "0 auto", lineHeight: 1.55 }}>
              When the school allocates a student to your sponsorship, their progress
              appears here.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Sponsorship</div>
          <h1 className="page-title">Your <em>students</em></h1>
          <div className="page-sub">
            {donorName ? `${donorName} — ` : ""}progress for the{" "}
            {students.length === 1 ? "student" : `${students.length} students`} your giving
            supports, shared by the school in confidence.
          </div>
        </div>
      </div>

      {cards.map((s) => {
        const band = s.avg != null ? bandFor(s.avg) : null;
        return (
          <div key={s.id} className="card" style={{ marginBottom: 16 }}>
            {/* Header — who, and the headline */}
            <div className="card-head" style={{ alignItems: "flex-start" }}>
              <div style={{ display: "flex", gap: 13, alignItems: "center" }}>
                <div style={{
                  width: 46, height: 46, borderRadius: "50%", flexShrink: 0,
                  background: "var(--accent-soft)", color: "var(--accent)",
                  display: "grid", placeItems: "center",
                  fontSize: 17, fontWeight: 800,
                }}>
                  {(s.name || "?").split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "var(--ink)", lineHeight: 1.2 }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>
                    {s.cls ? formatClassLabel(s.cls) : "—"}
                    {s.joined ? ` · at the school since ${s.joined}` : ""}
                  </div>
                </div>
              </div>
              {band && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "var(--ink)", lineHeight: 1 }}>
                    {s.avg}%
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3 }}>
                    average across {s.markCount} test{s.markCount === 1 ? "" : "s"}
                  </div>
                  <span className={`chip ${band.tone}`} style={{ marginTop: 5 }}>{band.label}</span>
                </div>
              )}
            </div>

            <div className="card-body" style={{ paddingTop: 14 }}>
              {/* A plain-language summary first — most donors are not reading charts */}
              {(s.strengths.length > 0 || s.working.length > 0) && (
                <div style={{
                  padding: "12px 14px", background: "var(--bg-2)", borderRadius: 9,
                  fontSize: 13, lineHeight: 1.65, color: "var(--ink-2)", marginBottom: 16,
                }}>
                  {s.strengths.length > 0 && (
                    <>Teachers rate {s.name.split(/[\s.]/)[0]} highly on{" "}
                      <strong style={{ color: "var(--ink)" }}>
                        {s.strengths.map((x) => x.label.toLowerCase()).join(" and ")}
                      </strong>.{" "}
                    </>
                  )}
                  {s.working.length > 0 && (
                    <>Still working on{" "}
                      <strong style={{ color: "var(--ink)" }}>
                        {s.working.map((x) => x.label.toLowerCase()).join(" and ")}
                      </strong>.
                    </>
                  )}
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 22 }}>
                {/* Subjects */}
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--ink-4)", marginBottom: 10 }}>
                    How each subject is going
                  </div>
                  {s.subjects.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                      No test results recorded yet this year.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      {s.subjects.map((sub) => (
                        <div key={sub.subject} style={{ display: "grid", gridTemplateColumns: "minmax(86px,118px) 1fr auto", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {sub.subject}
                          </span>
                          <span style={{ height: 9, background: "var(--bg-2)", borderRadius: 5, position: "relative", overflow: "hidden" }}>
                            <span style={{
                              position: "absolute", inset: "0 auto 0 0",
                              width: `${Math.max(2, Math.min(100, sub.avg))}%`,
                              background: sub.avg >= 55 ? "#3a63c4" : sub.avg >= 40 ? "#b07c28" : "#c0504d",
                              borderRadius: 5,
                            }} />
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", minWidth: 38, textAlign: "right" }}>
                            {sub.avg}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Teacher observations */}
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--ink-4)", marginBottom: 10 }}>
                    What teachers notice day to day
                  </div>
                  {s.observations.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                      No classroom observations recorded yet.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      {s.observations.map((o) => (
                        <div key={o.key} style={{ display: "grid", gridTemplateColumns: "minmax(110px,150px) 1fr auto", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                            title={`${o.domain} · ${o.count} observation${o.count === 1 ? "" : "s"}`}>
                            {o.label}
                          </span>
                          <span style={{ height: 9, background: "var(--bg-2)", borderRadius: 5, position: "relative", overflow: "hidden" }}>
                            <span style={{
                              position: "absolute", inset: "0 auto 0 0",
                              width: `${Math.max(2, Math.min(100, o.pct))}%`,
                              background: DOMAIN_COLOR[o.domain] || "#3a63c4",
                              borderRadius: 5,
                            }} />
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", minWidth: 38, textAlign: "right" }}>
                            {o.pct}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {s.activities.length > 0 && (
                <div style={{ marginTop: 18, borderTop: "1px solid var(--rule)", paddingTop: 13 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--ink-4)", marginBottom: 8 }}>
                    Achievements
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {s.activities.map((a) => (
                      <div key={a.id} style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                        <Icon name="sparkles" size={11} />{" "}
                        {a.activityName}
                        {a.eventName ? <span style={{ color: "var(--ink-4)" }}> · {a.eventName}</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* The donor's own giving, last — it is about them, not the child */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Your giving</div>
            <div className="card-sub">
              {money(given)} across {receipts.length} receipt{receipts.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        {receipts.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>No receipts recorded yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>Receipt</th><th>When</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {receipts.slice(0, 20).map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12 }}>{r.id}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{r.issuedAtLabel || r.issuedAt || "—"}</td>
                    <td className="num">{money(r.amount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, padding: "12px 15px", background: "var(--bg-2)", border: "1px dashed var(--rule)", borderRadius: 9, fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.65 }}>
        Shared with you in confidence by the school. Please do not share or republish it.
        For anything concerning a student, contact the school office rather than the
        family directly.
      </div>
    </div>
  );
}
