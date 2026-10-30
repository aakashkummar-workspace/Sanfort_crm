"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { TYPE_LABELS, SEVERITY_LABELS } from "@/lib/change-reports";

const TYPE_ORDER = ["bug", "data_issue", "logic_change", "new_feature", "ui_issue", "performance"];
const SEV_ORDER = ["blocking", "major", "minor"];

export default function ChangeReportDialog({ session = {}, screen, onClose }) {
  const [shot, setShot] = useState(null);
  const [capturing, setCapturing] = useState(true);
  const [shotError, setShotError] = useState("");
  const [type, setType] = useState("bug");
  const [severity, setSeverity] = useState("major");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const alive = useRef(true);

  // StrictMode mounts, unmounts and remounts in development. `alive` must be
  // re-armed on each mount, or the throwaway first unmount leaves it false
  // and the real mount's capture silently bails at every guard.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Capture after a short delay so the dialog's own opening transition has
  // finished — without it the half-drawn dialog lands in the picture.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        // The whole operation is capped, not just the render: loading the
        // 200 kB module can be the slow part on a poor connection, and a
        // spinner that never resolves would leave the reporter staring at
        // "Capturing…" with no way to finish their report.
        const shoot = (async () => {
          const html2canvas = (await import("html2canvas")).default;
          return html2canvas(document.body, {
            scale: 0.5,
            logging: false,
            useCORS: true,
            // Skip this dialog, the floating button and any other dialog on
            // screen, so the report shows the page they were looking at.
            ignoreElements: (el) =>
              el.hasAttribute?.("data-change-report-ui") ||
              el.getAttribute?.("role") === "dialog",
          });
        })();
        const canvas = await Promise.race([
          shoot,
          new Promise((_, rej) => setTimeout(() => rej(new Error("capture timed out")), 8000)),
        ]);
        if (cancelled || !alive.current) return;
        setShot(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        if (!cancelled && alive.current) {
          setShot(null);
          setShotError("The screenshot could not be captured on this screen. You can still send the report.");
        }
      } finally {
        if (!cancelled && alive.current) setCapturing(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!title.trim() || !description.trim()) {
      setErr("Please give a short title and describe what happened.");
      return;
    }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/change-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type, severity,
          title: title.trim(),
          description: description.trim(),
          expectedBehaviour: expected.trim() || null,
          screenshot: shot || null,
          pageUrl: window.location.href,
          pageRoute: screen || window.location.hash || "/",
          browserInfo: navigator.userAgent,
          screenSize: `${window.innerWidth}x${window.innerHeight}`,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not send the report");
      setDone(true);
      setTimeout(() => { if (alive.current) onClose(); }, 1800);
    } catch (e2) {
      setErr(e2.message || String(e2));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div
      data-change-report-ui="1"
      onClick={busy ? undefined : onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,16,10,0.5)",
        display: "grid", placeItems: "center", zIndex: 260, padding: 16, overflowY: "auto",
      }}
    >
      <div
        data-change-report-ui="1"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: "100%", maxWidth: 560, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}
      >
        <div className="card-head">
          <div>
            <div className="card-title">Report a problem</div>
            <div className="card-sub">
              {screen ? `From: ${screen}` : "From this screen"} · goes straight to the developers
            </div>
          </div>
          {!busy && (
            <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
          )}
        </div>

        {done ? (
          <div className="card-body" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Icon name="check" size={16} />
            <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
              <strong>Thank you — your report has been sent.</strong>
              <div style={{ color: "var(--ink-4)", marginTop: 3 }}>
                You will be notified when its status changes.
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

            <div>
              <Label>What kind of problem is it?</Label>
              <div style={{ display: "grid", gap: 6 }}>
                {TYPE_ORDER.map((k) => (
                  <label key={k} style={{
                    display: "flex", alignItems: "flex-start", gap: 9,
                    padding: "9px 11px", borderRadius: 8, cursor: "pointer",
                    border: `1px solid ${type === k ? "var(--accent)" : "var(--rule)"}`,
                    background: type === k ? "var(--accent-soft, rgba(194,65,12,0.06))" : "transparent",
                  }}>
                    <input type="radio" name="crtype" checked={type === k} disabled={busy}
                      onChange={() => setType(k)} style={{ marginTop: 2 }} />
                    <span>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{TYPE_LABELS[k].label}</span>
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.45 }}>
                        {TYPE_LABELS[k].hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <Label>How much is it affecting you?</Label>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {SEV_ORDER.map((k) => (
                  <label key={k} title={SEVERITY_LABELS[k].hint} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "7px 11px", borderRadius: 999, cursor: "pointer", fontSize: 12.5,
                    border: `1px solid ${severity === k ? "var(--accent)" : "var(--rule)"}`,
                    background: severity === k ? "var(--accent-soft, rgba(194,65,12,0.06))" : "transparent",
                  }}>
                    <input type="radio" name="crsev" checked={severity === k} disabled={busy}
                      onChange={() => setSeverity(k)} />
                    {SEVERITY_LABELS[k].label}
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-4)", marginTop: 5 }}>
                {SEVERITY_LABELS[severity].hint}
              </div>
            </div>

            <div>
              <Label>In one line, what is wrong?</Label>
              <input className="input" style={{ width: "100%" }} value={title} disabled={busy} maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Fee total does not match the receipts" />
            </div>

            <div>
              <Label>What happened?</Label>
              <textarea className="input" style={{ width: "100%" }} rows={3} value={description} disabled={busy}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What you did, and what the system did" />
            </div>

            <div>
              <Label optional>What did you expect instead?</Label>
              <textarea className="input" style={{ width: "100%" }} rows={2} value={expected} disabled={busy}
                onChange={(e) => setExpected(e.target.value)}
                placeholder="This is what tells us whether it is a fault or a change" />
            </div>

            {/* Screenshot preview and the warning about what it may contain. */}
            <div>
              <Label optional>Screenshot of this screen</Label>
              {capturing ? (
                <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Capturing…</div>
              ) : shot ? (
                <>
                  <img src={shot} alt="" style={{
                    width: "100%", borderRadius: 8, border: "1px solid var(--rule)",
                    maxHeight: 170, objectFit: "cover", objectPosition: "top",
                  }} />
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 8,
                    marginTop: 8, fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.5,
                  }}>
                    <Icon name="warning" size={13} />
                    <span style={{ flex: 1 }}>
                      This picture may show student, parent or staff details that were on
                      your screen. Only the developers and {`admins`} can open it.
                    </span>
                    <button type="button" className="btn sm ghost" disabled={busy}
                      onClick={() => setShot(null)} style={{ flexShrink: 0 }}>
                      Remove
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.55 }}>
                  {shotError || "No screenshot will be sent."}
                </div>
              )}
            </div>

            {err && <div style={{ color: "var(--err)", fontSize: 12.5, lineHeight: 1.6 }}>{err}</div>}

            <div style={{ display: "flex", gap: 7, justifyContent: "flex-end" }}>
              {!busy && <button type="button" className="btn sm ghost" onClick={onClose}>Cancel</button>}
              <button type="submit" className="btn sm accent" disabled={busy}>
                <Icon name="send" size={12} />{busy ? "Sending…" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Label({ children, optional }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 500, color: "var(--ink-2)",
      textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6,
    }}>
      {children}
      {optional && <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--ink-4)" }}> · optional</span>}
    </div>
  );
}
