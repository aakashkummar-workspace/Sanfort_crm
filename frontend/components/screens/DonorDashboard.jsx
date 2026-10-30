"use client";

import { useMemo } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel, money } from "@/lib/format";

// What a sponsor sees.
//
// The data reaching this screen is already narrowed server-side in
// scopeForRole: a donor receives an allowlisted projection of each sponsored
// student (name, class, attendance, join date) and nothing else. Fees, parent
// contact details, transport routes, complaints and welfare records are not in
// the payload at all — not hidden here, absent. Treat that as the boundary and
// do not reach for fields beyond it.

const pct = (score, max) => (max > 0 ? (Number(score) || 0) / max * 100 : 0);
const round1 = (n) => Math.round(n * 10) / 10;

export default function ScreenDonorDashboard({ E, session }) {
  const students = E.ADDED_STUDENTS || [];
  const marks = E.MARKS || [];
  const exams = E.EXAMS || [];
  const activities = E.STUDENT_ACTIVITIES || [];
  const receipts = E.DONOR_RECEIPTS || [];

  const examById = useMemo(() => new Map(exams.map((e) => [e.id, e])), [exams]);

  const cards = useMemo(() => students.map((s) => {
    const theirs = marks.filter((m) => m.studentId === s.id);
    const avg = theirs.length
      ? round1(theirs.reduce((a, m) => {
          const ex = examById.get(m.examId);
          return a + pct(m.score, m.maxMarks || ex?.maxMarks || 100);
        }, 0) / theirs.length)
      : null;
    // Per subject, so the card says something more useful than one number.
    const bySubject = new Map();
    for (const m of theirs) {
      const ex = examById.get(m.examId);
      const key = ex?.subject || "—";
      if (!bySubject.has(key)) bySubject.set(key, { sum: 0, n: 0 });
      const acc = bySubject.get(key);
      acc.sum += pct(m.score, m.maxMarks || ex?.maxMarks || 100);
      acc.n += 1;
    }
    const subjects = [...bySubject.entries()]
      .map(([subject, a]) => ({ subject, avg: round1(a.sum / a.n) }))
      .sort((a, b) => b.avg - a.avg);

    return {
      ...s,
      avg,
      subjects,
      markCount: theirs.length,
      activities: activities.filter((a) => a.studentId === s.id).slice(0, 4),
    };
  }), [students, marks, examById, activities]);

  const given = receipts.reduce((a, r) => a + (Number(r.amount) || 0), 0);

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
              When the school allocates a student to your sponsorship, their progress appears here.
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
            Progress for the {students.length === 1 ? "student" : `${students.length} students`} your
            giving supports. Shared by the school in confidence.
          </div>
        </div>
      </div>

      <div className="grid g-3" style={{ marginBottom: 16 }}>
        <KPI label="Students sponsored" value={students.length} sub="currently active" puck="mint" puckIcon="students" />
        <KPI
          label="Average attendance"
          value={students.length
            ? `${Math.round(students.reduce((a, s) => a + (Number(s.attendance) || 0), 0) / students.length)}%`
            : "—"}
          sub="across your students" puck="cream" puckIcon="check"
        />
        <KPI label="Your giving" value={money(given)} sub={`${receipts.length} receipt${receipts.length === 1 ? "" : "s"}`} puck="peach" puckIcon="heart" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
        {cards.map((s) => (
          <div key={s.id} className="card">
            <div className="card-head">
              <div>
                <div className="card-title">{s.name}</div>
                <div className="card-sub">
                  {s.cls ? formatClassLabel(s.cls) : "—"}{s.joined ? ` · joined ${s.joined}` : ""}
                </div>
              </div>
              <span className="chip">{s.attendance ?? 0}% present</span>
            </div>

            <div className="card-body" style={{ paddingTop: 12 }}>
              {s.avg == null ? (
                <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                  No exam results recorded yet this year.
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)" }}>{s.avg}%</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
                      average across {s.markCount} recorded mark{s.markCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {s.subjects.map((sub) => (
                      <div key={sub.subject} style={{ display: "grid", gridTemplateColumns: "minmax(80px,110px) 1fr auto", gap: 9, alignItems: "center" }}>
                        <span style={{ fontSize: 11.5, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {sub.subject}
                        </span>
                        <span style={{ height: 8, background: "var(--bg-2)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                          <span style={{
                            position: "absolute", inset: "0 auto 0 0",
                            width: `${Math.max(0, Math.min(100, sub.avg))}%`,
                            background: "#3a63c4", borderRadius: 4,
                          }} />
                        </span>
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink)", minWidth: 38, textAlign: "right" }}>
                          {sub.avg}%
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {s.activities.length > 0 && (
                <div style={{ marginTop: 14, borderTop: "1px solid var(--rule)", paddingTop: 11 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)", marginBottom: 7 }}>
                    Achievements
                  </div>
                  {s.activities.map((a) => (
                    <div key={a.id} style={{ fontSize: 12, color: "var(--ink-2)", padding: "2px 0" }}>
                      <Icon name="sparkles" size={11} /> {a.activityName}
                      {a.eventName ? <span style={{ color: "var(--ink-4)" }}> · {a.eventName}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {receipts.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Your giving</div>
              <div className="card-sub">Receipts issued to you</div>
            </div>
          </div>
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
        </div>
      )}

      <div style={{ marginTop: 16, padding: "11px 14px", background: "var(--bg-2)", border: "1px dashed var(--rule)", borderRadius: 8, fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.6 }}>
        This information is shared with you in confidence by the school. Please do not
        share or republish it. For anything concerning a student, contact the school
        office rather than the family directly.
      </div>
    </div>
  );
}
