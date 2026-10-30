"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, AvatarChip } from "../ui";
import { resolveSchool, downloadPdf } from "@/lib/export";

// Activity history.
//
// This screen used to read E.AUDIT, which /api/data caps at 100 rows — roughly
// one busy morning in this school. It now pages through /api/audit instead, so
// the full history is reachable, with filtering done server-side.

function toneFor(action = "") {
  const a = action.toLowerCase();
  if (a.includes("failed")) return "bad";
  if (a.includes("paid") || a.includes("receipt") || a.includes("board")) return "ok";
  if (a.includes("resolved") || a.includes("converted")) return "ok";
  if (a.includes("absent") || a.includes("complaint") || a.includes("removed") || a.includes("archived")) return "bad";
  if (a.includes("progress") || a.includes("contacted") || a.includes("late")) return "warn";
  if (a.includes("created") || a.includes("enquiry") || a.includes("viewed")) return "info";
  return "accent";
}

// The chip was printing its own CSS tone — every row read "accent", "bad" or
// "ok", which means nothing to the person reading the log. Say what the tone
// is actually indicating instead.
const TONE_LABEL = {
  bad: "Attention",
  ok: "Completed",
  warn: "In progress",
  info: "Created",
  accent: "Recorded",
};

const PAGE = 50;

// Categories are a coarse first cut; the Action dropdown beside them offers
// every distinct action the log actually holds. Both are free-text matches on
// the action because rows written before entity_type existed have none, and
// filtering on it would silently hide the entire back catalogue.
const CATEGORIES = [
  { k: "all",         label: "All activity" },
  { k: "financial",   label: "Fees & money" },
  { k: "students",    label: "Students" },
  { k: "attendance",  label: "Attendance" },
  { k: "transport",   label: "Transport" },
  { k: "academics",   label: "Exams & marks" },
  { k: "permissions", label: "Users & roles" },
  { k: "auth",        label: "Sign-ins" },
];

// Category → the server filter it maps to. Financial and permissions stay as a
// free-text match on the action, which is what the data supports: older rows
// have no entity_type, so filtering on it would silently hide all of them.
// Which screen an action was performed on.
//
// The audit row has never recorded this — the column does not exist, and
// backfilling 27,000+ rows is not possible because the information was never
// captured. Deriving it from the action name works on the whole back
// catalogue rather than only on rows written from today, which is what makes
// it useful. Ordered most-specific first: the first matching pattern wins.
const SCREEN_RULES = [
  [/^sign in/i,                              "Login page"],
  [/transport|bus run|boarded|marked board/i, "Transport"],
  [/teacher attendance/i,                    "Attendance · Teachers"],
  [/attendance|marked absent|marked present/i, "Attendance"],
  [/scale/i,                                 "SCALE session"],
  [/fee structure|fee component/i,            "Fees & UPI · structure"],
  [/fee|paid|receipt|reminder|upi|refund/i,   "Fees & UPI"],
  [/donor|donation|campaign|sponsorship/i,    "Trust & Donors"],
  [/payroll|payslip|salary/i,                 "Payroll"],
  [/expense|purchase/i,                       "Finance"],
  [/marks|exam|periodic/i,                    "Exams & Marks"],
  [/admission|student|parent login|bulk import/i, "Students"],
  [/staff|award/i,                            "Staff"],
  [/class\b|section/i,                        "Classes"],
  [/timetable|period/i,                       "Timetable"],
  [/syllabus/i,                               "Syllabus"],
  [/library|book|loan/i,                      "Library"],
  [/inventory|stock/i,                        "Inventory"],
  [/complaint|ticket/i,                       "Complaints"],
  [/enquiry|enquiries/i,                      "Admissions"],
  [/leave/i,                                  "Leave requests"],
  [/remark|reward/i,                          "Remarks & rewards"],
  [/program/i,                                "Programs"],
  [/whatsapp|broadcast|message/i,             "Communication"],
  [/user|role|permission|access/i,            "Users & Roles"],
  [/setting/i,                                "Settings"],
  [/document/i,                               "Documents"],
  [/task/i,                                   "Tasks"],
  [/meeting/i,                                "Meetings"],
  [/tc\b|transfer certificate/i,              "Transfer certificates"],
];

function screenFor(action = "", entity = "") {
  const hay = `${action} ${entity}`;
  for (const [re, screen] of SCREEN_RULES) if (re.test(hay)) return screen;
  return null;
}

function paramsForCategory(k) {
  if (k === "auth")        return { q: "Sign in" };
  if (k === "financial")   return { q: "fee" };
  if (k === "students")    return { q: "student" };
  if (k === "attendance")  return { q: "attendance" };
  if (k === "transport")   return { q: "transport" };
  if (k === "academics")   return { q: "marks" };
  if (k === "permissions") return { q: "role" };
  return {};
}

const initials = (name = "") => {
  const n = String(name).trim();
  if (!n || n === "—") return "?";
  if (n === "System") return "SY";
  if (n === "Unknown") return "??";
  if (n === "WhatsApp") return "WA";
  return n.split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
};

export default function ScreenAudit({ E, session }) {
  const school = useMemo(() => resolveSchool(E.SETTINGS), [E.SETTINGS]);
  const actor = session?.name || null;

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [actors, setActors] = useState([]);
  const [actions, setActions] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [grouped, setGrouped] = useState(false);

  // Filters
  const [category, setCategory] = useState("all");
  const [action, setAction] = useState("");
  const [screen, setScreen] = useState("");
  const [who, setWho] = useState("");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Debounce the free-text box so typing doesn't fire a request per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const reqId = useRef(0);

  const load = useCallback(async (offset = 0) => {
    const mine = ++reqId.current;
    if (offset === 0) setLoading(true);
    setErr("");
    try {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      const cat = paramsForCategory(category);
      for (const [k, v] of Object.entries(cat)) if (v) qs.set(k, v);
      if (who) qs.set("who", who);
      if (action) qs.set("action", action);
      // An explicit search box beats the category's canned term.
      if (debouncedQuery.trim()) qs.set("q", debouncedQuery.trim());
      if (from) qs.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) qs.set("to", new Date(`${to}T23:59:59`).toISOString());

      const r = await fetch(`/api/audit?${qs}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (mine !== reqId.current) return;   // a newer request has superseded this
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load the activity log");
      const batch = j.events || [];
      setEvents(offset === 0 ? batch : (prev) => [...prev, ...batch]);
      setTotal(j.total || 0);
      setHasMore(!!j.hasMore);
      if (Array.isArray(j.actors) && j.actors.length) setActors(j.actors);
      if (Array.isArray(j.actions) && j.actions.length) setActions(j.actions);
      if (j.counts) setCounts(j.counts);
    } catch (e) {
      if (mine === reqId.current) { setErr(e.message || String(e)); setEvents([]); }
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [category, action, who, debouncedQuery, from, to]);

  useEffect(() => { load(0); }, [load]);

  // Decorate each row with the screen it happened on, then apply the screen
  // filter here rather than server-side — the screen is derived from the
  // action, so the database has nothing to filter on.
  const decorated = useMemo(
    () => events.map((e) => ({ ...e, screen: screenFor(e.action, e.entity) })),
    [events]
  );
  const visible = useMemo(
    () => (screen ? decorated.filter((e) => e.screen === screen) : decorated),
    [decorated, screen]
  );
  // Screens present in what is loaded, so the dropdown never offers an option
  // that would show nothing.
  const screensSeen = useMemo(
    () => [...new Set(decorated.map((e) => e.screen).filter(Boolean))].sort(),
    [decorated]
  );

  // One row per actor, for the "group by user" view.
  const byActor = useMemo(() => {
    const m = new Map();
    for (const e of visible) {
      const key = e.who || "—";
      if (!m.has(key)) m.set(key, { who: key, items: [], last: e.when });
      m.get(key).items.push(e);
    }
    return [...m.values()].sort((a, b) => b.items.length - a.items.length);
  }, [visible]);

  function exportPdf() {
    const label = (CATEGORIES.find((c) => c.k === category) || {}).label || "All events";
    downloadPdf({
      title: `Activity log · ${label}`,
      subtitle: `${visible.length} of ${total} event${total === 1 ? "" : "s"} · exports the loaded rows only`,
      school, actor,
      dateRange: from || to ? `${from || "start"} → ${to || "today"}` : "All time",
      orientation: "landscape",
      summary: [
        { label: "Rows exported", value: visible.length },
        { label: "Matching total", value: total },
        { label: "Distinct users", value: new Set(visible.map((e) => e.who).filter(Boolean)).size },
        { label: "Filter", value: label },
      ],
      columns: [
        { key: "i",      label: "#",      align: "right", width: "32px" },
        { key: "t",      label: "When",   width: "110px" },
        { key: "who",    label: "Who",    width: "140px" },
        { key: "action", label: "Action" },
        { key: "screen", label: "Screen",  width: "130px" },
        { key: "entity", label: "Detail" },
      ],
      rows: visible.map((e, i) => ({
        i: i + 1,
        t: e.when || "—", who: e.who || "—",
        action: e.action || "—",
        screen: e.screen || "—",
        entity: e.entity || "—",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-activity-${category}-${new Date().toISOString().slice(0, 10)}`,
    });
  }

  const activeFilters = category !== "all" || who || debouncedQuery || from || to || action || screen;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Governance</div>
          <div className="page-title">Activity <span className="amber">history</span></div>
          <div className="page-sub">
            Every recorded action, by user. Searchable across the full history — not just the most recent events.
          </div>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => load(0)} disabled={loading}>
            <Icon name="refresh" size={13} />{loading ? "Loading…" : "Refresh"}
          </button>
          <button className="btn" onClick={exportPdf} disabled={visible.length === 0}
            title={visible.length === 0 ? "No events to export" : `Export the ${visible.length} loaded rows`}>
            <Icon name="download" size={13} />Export PDF
          </button>
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 18 }}>
        <KPI label="Events · total" value={counts.total ?? total} sub="all-time" puck="mint" puckIcon="audit" />
        <KPI label="Financial writes" value={counts.financial ?? "—"} sub="fee / donation actions" puck="peach" puckIcon="money" />
        <KPI label="Permission changes" value={counts.permissions ?? "—"} sub="user / role updates" puck="cream" puckIcon="shield" />
        <KPI label="Failed sign-ins" value={counts.failedLogins ?? 0} sub="wrong password or unknown email" puck="rose" puckIcon="warning" />
      </div>

      {/* Filters — one row above the list. */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "11px 14px" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search action, detail or user…"
            style={{
              flex: "1 1 220px", minWidth: 180, padding: "7px 11px", fontSize: 12.5,
              border: "1px solid var(--rule)", borderRadius: 7,
              background: "var(--bg)", color: "var(--ink)",
            }}
          />
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.k} value={c.k}>{c.label}</option>)}
          </select>
          <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">All users</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value)} title="Exact action">
            <option value="">All actions</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className="select" value={screen} onChange={(e) => setScreen(e.target.value)} title="Screen the action happened on">
            <option value="">All screens</option>
            {screensSeen.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
          </select>
          <input type="date" className="select" value={from} onChange={(e) => setFrom(e.target.value)} title="From date" />
          <input type="date" className="select" value={to} onChange={(e) => setTo(e.target.value)} title="To date" />
          <button
            className={`btn sm ${grouped ? "accent" : "ghost"}`}
            onClick={() => setGrouped((v) => !v)}
            title="Group the loaded events by user"
          >
            <Icon name="users" size={12} />By user
          </button>
          {activeFilters && (
            <button className="btn sm ghost" onClick={() => {
              setCategory("all"); setWho(""); setQuery(""); setFrom(""); setTo("");
              setAction(""); setScreen("");
            }}>Clear</button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{grouped ? "By user" : "Events"}</div>
            <div className="card-sub">
              {loading ? "Loading…" : (screen
                ? `Showing ${visible.length} on ${screen} · from ${events.length} loaded of ${total}`
                : `Showing ${visible.length} of ${total} · newest first`)}
            </div>
          </div>
        </div>

        {err && (
          <div className="empty" style={{ padding: 28, color: "var(--accent-2)" }}>{err}</div>
        )}

        {!err && !loading && visible.length === 0 && (
          <div className="empty" style={{ padding: 32 }}>
            {activeFilters ? "No events match these filters." : "No events recorded yet."}
          </div>
        )}

        {!err && grouped ? (
          <div>
            {byActor.map((g) => (
              <div key={g.who} style={{ borderTop: "1px solid var(--rule)", padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <AvatarChip initials={initials(g.who)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{g.who}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {g.items.length} event{g.items.length === 1 ? "" : "s"} · latest {g.last || "—"}
                    </div>
                  </div>
                  <button className="btn sm ghost" onClick={() => { setWho(g.who); setGrouped(false); }}>
                    See all
                  </button>
                </div>
                {g.items.slice(0, 5).map((e) => (
                  <div key={e.id} style={{ fontSize: 12, color: "var(--ink-2)", padding: "3px 0 3px 38px" }}>
                    <span style={{ color: "var(--ink-4)", marginRight: 8 }}>{e.when}</span>
                    {e.action} <span style={{ color: "var(--ink-3)" }}>· {e.entity}</span>
                  </div>
                ))}
                {g.items.length > 5 && (
                  <div style={{ fontSize: 11.5, color: "var(--ink-4)", paddingLeft: 38, marginTop: 3 }}>
                    + {g.items.length - 5} more
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : !err && (
          <div>
            {visible.map((e) => (
              <div key={e.id} className="lrow">
                <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", width: 92, flexShrink: 0 }}>
                  {e.when || "—"}
                </div>
                <AvatarChip initials={initials(e.who)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                    <strong style={{ fontWeight: 600 }}>{e.who}</strong>
                    <span style={{ color: "var(--ink-2)" }}>{e.action}</span>
                    {e.screen && (
                      <span className="chip" style={{ fontSize: 10.5 }} title={`Performed on the ${e.screen} screen`}>
                        {e.screen}
                      </span>
                    )}
                  </div>
                  {(e.entity || e.actorRole) && (
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                      {e.entity || ""}{e.actorRole ? `${e.entity ? " · " : ""}as ${e.actorRole}` : ""}
                    </div>
                  )}
                  {e.meta && Object.keys(e.meta).length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 2 }}>
                      {Object.entries(e.meta).filter(([, v]) => v != null && v !== "")
                        .map(([k, v]) => `${k}: ${v}`).join(" · ")}
                    </div>
                  )}
                </div>
                <span className={`chip ${toneFor(e.action)}`}>
                  <span className="dot" />{TONE_LABEL[toneFor(e.action)] || "Recorded"}
                </span>
              </div>
            ))}
          </div>
        )}

        {hasMore && !grouped && (
          <div style={{ padding: 14, textAlign: "center", borderTop: "1px solid var(--rule)" }}>
            <button className="btn" onClick={() => load(events.length)} disabled={loading}>
              {loading ? "Loading…" : `Load ${Math.min(PAGE, total - events.length)} more`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
