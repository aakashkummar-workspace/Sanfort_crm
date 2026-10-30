"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, AvatarChip } from "../ui";
import { resolveSchool, downloadPdf } from "@/lib/export";

// WhatsApp messages.
//
// Every message the CRM has sent, body included. Self-fetching like the Audit
// screen: the log grows with every fee payment, so it is deliberately not in
// /api/data and there is no E.* slice to read. Filtering and counting happen
// server-side against the whole table, not over the loaded page.

const PAGE = 50;

const STATUSES = [
  { k: "",        label: "All statuses" },
  { k: "sent",    label: "Sent" },
  { k: "failed",  label: "Failed" },
  { k: "skipped", label: "Skipped" },
  { k: "queued",  label: "Queued" },
];

// The five event names notifyWhatsApp is called with today. A name not in this
// list still renders — the chip just falls back to a neutral tone — so adding
// a sixth caller doesn't require editing this file.
const EVENTS = [
  { k: "",             label: "All events" },
  { k: "fee_paid",     label: "Fee receipt" },
  { k: "fee_qr_send",  label: "UPI QR" },
  { k: "fee_reminder", label: "Fee reminder" },
  { k: "broadcast",    label: "Broadcast" },
  { k: "test",         label: "Diagnostic test" },
];

const EVENT_LABEL = Object.fromEntries(EVENTS.filter((e) => e.k).map((e) => [e.k, e.label]));

const STATUS_TONE = { sent: "ok", failed: "bad", skipped: "warn", queued: "info" };

const initials = (name = "") => {
  const n = String(name).trim();
  if (!n || n === "—") return "?";
  return n.split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
};

// 91XXXXXXXXXX → +91 XXXXX XXXXX. The stored form is what the provider needs;
// this is the form staff recognise from their own phones.
function prettyPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return p || "—";
}

function shortTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch { return "—"; }
}

const PREVIEW_CHARS = 90;

export default function ScreenWhatsApp({ E, session }) {
  const school = useMemo(() => resolveSchool(E?.SETTINGS), [E?.SETTINGS]);
  const actor = session?.name || null;
  const isAdmin = session?.role === "admin";

  const [messages, setMessages] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());

  // Connection panel
  const [diag, setDiag] = useState(null);
  const [diagErr, setDiagErr] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Retry
  const [retrying, setRetrying] = useState("");

  // Filters
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [event, setEvent] = useState("");
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
      if (status) qs.set("status", status);
      if (event) qs.set("event", event);
      // Digits-only input is almost certainly a phone, and the phone filter is
      // a suffix match on the stored 91-prefixed number — free text would miss
      // it for anyone typing the 10 digits they have in their contacts.
      const qv = debouncedQuery.trim();
      if (qv) {
        const digits = qv.replace(/\D/g, "");
        if (digits.length >= 6 && digits.length === qv.replace(/[\s+-]/g, "").length) qs.set("phone", digits);
        else qs.set("q", qv);
      }
      if (from) qs.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) qs.set("to", new Date(`${to}T23:59:59`).toISOString());

      const r = await fetch(`/api/whatsapp/messages?${qs}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (mine !== reqId.current) return;   // a newer request has superseded this
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load the WhatsApp log");
      const batch = j.messages || [];
      setMessages(offset === 0 ? batch : (prev) => [...prev, ...batch]);
      setTotal(j.total || 0);
      setHasMore(!!j.hasMore);
      if (j.counts) setCounts(j.counts);
    } catch (e) {
      if (mine === reqId.current) { setErr(e.message || String(e)); setMessages([]); }
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [status, event, debouncedQuery, from, to]);

  useEffect(() => { load(0); }, [load]);

  // Connection state. Admin-only route, so principals see the panel without
  // the diagnostic detail rather than an error.
  const loadDiag = useCallback(async () => {
    if (!isAdmin) return;
    setDiagErr("");
    try {
      const r = await fetch("/api/admin/whatsapp-diagnostic", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not read the connection status");
      setDiag(j);
    } catch (e) { setDiagErr(e.message || String(e)); }
  }, [isAdmin]);

  useEffect(() => { loadDiag(); }, [loadDiag]);

  async function sendTest() {
    if (!testPhone.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch("/api/admin/whatsapp-diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: testPhone.trim(), message: testMsg.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Test send failed");
      // Pick the wording from the outcome first, never from whichever
      // field happens to be populated. A provider that fails without
      // setting `error` must still read as a failure here.
      const sent = !!j.result?.ok;
      const reason = j.result?.error || j.result?.skipped
        || (j.result?.status ? `Provider returned HTTP ${j.result.status}` : "")
        || "The provider rejected the message without giving a reason";
      setTestResult({
        ok: sent,
        detail: sent ? "Delivered to the provider" : reason,
      });
      // The test wrote its own log row; show it.
      load(0); loadDiag();
    } catch (e) {
      setTestResult({ ok: false, detail: e.message || String(e) });
    } finally { setTesting(false); }
  }

  async function retry(id) {
    setRetrying(id);
    try {
      const r = await fetch("/api/whatsapp/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Retry failed");
      // The retry is a new row, not a status flip on the old one, so reload
      // from the top rather than patching state.
      load(0);
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setRetrying(""); }
  }

  function toggle(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exportPdf() {
    downloadPdf({
      title: "WhatsApp messages",
      subtitle: `${messages.length} of ${total} message${total === 1 ? "" : "s"} · exports the loaded rows only`,
      school, actor,
      dateRange: from || to ? `${from || "start"} → ${to || "today"}` : "All time",
      orientation: "landscape",
      summary: [
        { label: "Rows exported", value: messages.length },
        { label: "Matching total", value: total },
        { label: "Sent · 24h", value: counts.sent24h ?? "—" },
        { label: "Failed · 24h", value: counts.failed24h ?? "—" },
      ],
      columns: [
        { key: "i",      label: "#",         align: "right", width: "30px" },
        { key: "t",      label: "When",      width: "110px" },
        { key: "to",     label: "Recipient", width: "150px" },
        { key: "ev",     label: "Event",     width: "90px" },
        { key: "st",     label: "Status",    width: "60px" },
        { key: "body",   label: "Message" },
      ],
      rows: messages.map((m, i) => ({
        i: i + 1,
        t: shortTime(m.createdAt),
        to: `${m.recipientName || m.studentName || "—"} ${prettyPhone(m.toPhone)}`,
        ev: EVENT_LABEL[m.event] || m.event || "—",
        st: m.status || "—",
        body: m.body || (m.hasMedia ? "[image]" : "—"),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-whatsapp-${new Date().toISOString().slice(0, 10)}`,
    });
  }

  const activeFilters = !!(status || event || debouncedQuery || from || to);
  const connected = diag?.env?.configured;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Operations</div>
          <div className="page-title">WhatsApp <span className="amber">messages</span></div>
          <div className="page-sub">
            Every message the CRM has sent — receipts, reminders, broadcasts and tests — with the exact text that went out.
          </div>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => { load(0); loadDiag(); }} disabled={loading}>
            <Icon name="refresh" size={13} />{loading ? "Loading…" : "Refresh"}
          </button>
          <button className="btn" onClick={exportPdf} disabled={messages.length === 0}
            title={messages.length === 0 ? "No messages to export" : `Export the ${messages.length} loaded rows`}>
            <Icon name="download" size={13} />Export PDF
          </button>
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 18 }}>
        <KPI label="Messages · total" value={counts.total ?? total} sub="all-time" puck="mint" puckIcon="send" />
        <KPI label="Sent · last 24h" value={counts.sent24h ?? "—"} sub="accepted by the provider" puck="cream" puckIcon="check" />
        <KPI label="Failed · last 24h" value={counts.failed24h ?? 0} sub="retryable from the list below" puck="rose" puckIcon="warning" />
        <KPI label="Skipped" value={counts.skipped ?? 0} sub="no valid phone or nothing to send" puck="peach" puckIcon="warning" />
      </div>

      {/* Connection. The diagnostic endpoint has existed since the Evolution
          switch with nothing in the UI reaching it. */}
      {isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Connection</div>
              <div className="card-sub">
                {diagErr
                  ? diagErr
                  : diag
                    ? `Provider: ${diag.provider || "—"} · ${connected ? "credentials present" : "NOT configured"}`
                    : "Checking…"}
              </div>
            </div>
            <span className={`chip ${connected ? "ok" : "bad"}`}>
              <span className="dot" />{connected ? "configured" : "not configured"}
            </span>
          </div>
          <div className="card-body" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
            {diag?.env && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 240px" }}>
                {Object.entries(diag.env)
                  .filter(([k]) => k !== "configured" && k !== "provider" && k !== "error")
                  .map(([k, v]) => (
                    <span key={k} className={`chip ${v ? "ok" : "bad"}`} title={v ? "present" : "missing from .env.local"}>
                      <span className="dot" />{k}
                    </span>
                  ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: "1 1 340px", alignItems: "center" }}>
              <input
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="Test to… 10-digit mobile"
                style={{
                  flex: "0 1 170px", padding: "7px 11px", fontSize: 12.5,
                  border: "1px solid var(--rule)", borderRadius: 7,
                  background: "var(--bg)", color: "var(--ink)",
                }}
              />
              <input
                value={testMsg}
                onChange={(e) => setTestMsg(e.target.value)}
                placeholder="Message (optional)"
                style={{
                  flex: "1 1 160px", minWidth: 140, padding: "7px 11px", fontSize: 12.5,
                  border: "1px solid var(--rule)", borderRadius: 7,
                  background: "var(--bg)", color: "var(--ink)",
                }}
              />
              <button className="btn sm" onClick={sendTest} disabled={testing || !testPhone.trim()}>
                <Icon name="send" size={12} />{testing ? "Sending…" : "Send test"}
              </button>
              {testResult && (
                <span className={`chip ${testResult.ok ? "ok" : "bad"}`} title={testResult.detail}>
                  <span className="dot" />{testResult.detail}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Filters — one row above the list, all applied server-side. */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "11px 14px" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search message text, parent, student or phone…"
            style={{
              flex: "1 1 220px", minWidth: 180, padding: "7px 11px", fontSize: 12.5,
              border: "1px solid var(--rule)", borderRadius: 7,
              background: "var(--bg)", color: "var(--ink)",
            }}
          />
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
          </select>
          <select className="select" value={event} onChange={(e) => setEvent(e.target.value)}>
            {EVENTS.map((e) => <option key={e.k} value={e.k}>{e.label}</option>)}
          </select>
          <input type="date" className="select" value={from} onChange={(e) => setFrom(e.target.value)} title="From date" />
          <input type="date" className="select" value={to} onChange={(e) => setTo(e.target.value)} title="To date" />
          {activeFilters && (
            <button className="btn sm ghost" onClick={() => {
              setStatus(""); setEvent(""); setQuery(""); setFrom(""); setTo("");
            }}>Clear</button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Messages</div>
            <div className="card-sub">
              {loading ? "Loading…" : `Showing ${messages.length} of ${total} · newest first · click a message to read it in full`}
            </div>
          </div>
        </div>

        {err && <div className="empty" style={{ padding: 28, color: "var(--accent-2)" }}>{err}</div>}

        {!err && !loading && messages.length === 0 && (
          <div className="empty" style={{ padding: 32 }}>
            {activeFilters
              ? "No messages match these filters."
              : "No messages logged yet. Receipts, reminders and broadcasts appear here as they go out."}
          </div>
        )}

        {!err && messages.map((m) => {
          const open = expanded.has(m.id);
          const body = m.body || "";
          const long = body.length > PREVIEW_CHARS;
          const tone = STATUS_TONE[m.status] || "accent";
          return (
            <div key={m.id} className="lrow" style={{ alignItems: "flex-start" }}>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", width: 92, flexShrink: 0, paddingTop: 2 }}>
                {shortTime(m.createdAt)}
              </div>
              <AvatarChip initials={initials(m.recipientName || m.studentName || "?")} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {m.recipientName || m.studentName || "Parent"}
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {prettyPhone(m.toPhone)}
                  </span>
                  <span className="chip info"><span className="dot" />{EVENT_LABEL[m.event] || m.event || "—"}</span>
                  {m.hasMedia && <span className="chip accent"><span className="dot" />image</span>}
                  {m.retryOf && <span className="chip warn"><span className="dot" />retry #{m.attempt}</span>}
                </div>

                <div
                  onClick={() => long && toggle(m.id)}
                  title={long ? (open ? "Collapse" : "Click to read the full message") : undefined}
                  style={{
                    fontSize: 12.5, color: "var(--ink-2)", marginTop: 4,
                    cursor: long ? "pointer" : "default",
                    whiteSpace: open ? "pre-wrap" : "nowrap",
                    overflow: open ? "visible" : "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {body
                    ? (open || !long ? body : `${body.slice(0, PREVIEW_CHARS)}…`)
                    : <span style={{ color: "var(--ink-4)" }}>{m.hasMedia ? "[image, no caption]" : "—"}</span>}
                </div>

                <div style={{ fontSize: 11.5, color: "var(--ink-4)", marginTop: 3 }}>
                  {m.studentName ? `${m.studentName}${m.studentId ? ` · ${m.studentId}` : ""} · ` : ""}
                  {m.actor || "System"}
                  {m.provider ? ` · ${m.provider}` : ""}
                  {m.providerMessageId ? ` · ${m.providerMessageId}` : ""}
                </div>

                {m.error && (
                  <div style={{ fontSize: 11.5, color: "var(--accent-2)", marginTop: 3 }}>{m.error}</div>
                )}
              </div>

              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, paddingTop: 2 }}>
                <span className={`chip ${tone}`}><span className="dot" />{m.status || "—"}</span>
                {/* Retry is admin-only and failed-only. A sent message re-sent
                    is a duplicate the parent has to interpret. */}
                {isAdmin && m.status === "failed" && (
                  <button className="btn sm ghost" onClick={() => retry(m.id)} disabled={retrying === m.id}>
                    <Icon name="refresh" size={12} />{retrying === m.id ? "Sending…" : "Retry"}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {hasMore && (
          <div style={{ padding: 14, textAlign: "center", borderTop: "1px solid var(--rule)" }}>
            <button className="btn" onClick={() => load(messages.length)} disabled={loading}>
              {loading ? "Loading…" : `Load ${Math.min(PAGE, total - messages.length)} more`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
