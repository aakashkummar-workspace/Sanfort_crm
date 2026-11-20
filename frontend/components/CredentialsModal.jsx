"use client";

import { useEffect } from "react";
import Icon from "./Icon";

// One-time credential receipt shown right after provisioning a new login
// (parent on student admission, teacher on staff hire, custom-role user from
// the Users screen). Plain password lives in component state only — the API
// returns it once and never re-issues it.
//
// Props:
//   title?        — heading (defaults based on `kind`)
//   subtitle?     — sub line under the heading
//   email         — login email (required)
//   password      — plain password (required)
//   extras?       — [{ label, value, mono? }] additional rows like Name / Role / Linked ID
//   note?         — small dashed-border explainer beneath the rows
//   onClose       — close handler
//   flash?        — optional toast callback (msg, tone) for copy feedback
export default function CredentialsModal({
  title,
  subtitle,
  email,
  password,
  extras = [],
  note,
  onClose,
  flash,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async (txt, what) => {
    try {
      await navigator.clipboard.writeText(txt);
      flash?.(`${what} copied`, "ok");
    } catch {
      flash?.(`Couldn't copy — select & copy manually`, "bad");
    }
  };
  const copyBoth = () => copy(`Login: ${email}\nPassword: ${password}`, "Credentials");

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.5)",
      display: "grid", placeItems: "center", zIndex: 260, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 480 }}>
        <div className="card-head">
          <div>
            <div className="card-title" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ok)" }}>
              <Icon name="check" size={14} />
              {title || "Account created"}
            </div>
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <CredRow label="Login email" value={email} onCopy={() => copy(email, "Email")} />
          <CredRow label="Password"    value={password} onCopy={() => copy(password, "Password")} mono />
          {extras.map((r, i) => (
            <CredRow
              key={i}
              label={r.label}
              value={r.value}
              mono={r.mono}
              onCopy={r.value ? () => copy(String(r.value), r.label) : undefined}
            />
          ))}
          {note && (
            <div style={{
              background: "var(--bg-2)", border: "1px dashed var(--rule)",
              padding: "9px 12px", borderRadius: 8, fontSize: 11.5,
              color: "var(--ink-3)", lineHeight: 1.5,
            }}>
              {note}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={copyBoth}>
              <Icon name="download" size={12} />Copy both
            </button>
            <button className="btn accent" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CredRow({ label, value, onCopy, mono }) {
  return (
    <div style={{
      background: "var(--bg-2)", borderRadius: 8, padding: "10px 12px",
      display: "flex", alignItems: "center", gap: 10,
    }}>
      <div style={{ minWidth: 110 }}>
        <div style={{
          fontSize: 10.5, color: "var(--ink-4)", textTransform: "uppercase",
          letterSpacing: 0.5, fontWeight: 600,
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 13, fontWeight: 500, color: "var(--ink)", marginTop: 2,
          fontFamily: mono ? "var(--font-mono)" : undefined,
          wordBreak: "break-all",
        }}>
          {value || "—"}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      {onCopy && (
        <button type="button" className="btn sm" onClick={onCopy} title={`Copy ${label.toLowerCase()}`}>
          <Icon name="download" size={11} />Copy
        </button>
      )}
    </div>
  );
}
