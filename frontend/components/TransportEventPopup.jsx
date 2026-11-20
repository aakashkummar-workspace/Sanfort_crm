"use client";

// Full-screen pop-up for parents when a transport event arrives.
// Replaces the per-stop WhatsApp message that used to fan out.
//
// Lifecycle:
//   1. Polls /api/notifications every 30s (same cadence as the bell-icon
//      NotificationsPanel — kept separate so changes there can't break this).
//   2. Filters for type === "transport" and id newer than the last one we
//      already showed (tracked in localStorage so a page refresh doesn't
//      retrigger old events).
//   3. Queues each new transport notification as a modal. Shows one at a
//      time; the next one in the queue waits for the previous to dismiss.
//   4. Plays a soft two-tone chime via Web Audio API each time a modal
//      opens (no audio asset needed). Silently skipped if the browser
//      blocks autoplay before any user interaction.
//   5. Modal auto-dismisses after 20s with a circular countdown. Parent
//      can also click OK or press Escape to close early.
//
// Mounted ONCE at AppShell for role === "parent". Listens across all
// parent screens (dashboard, fees, attendance, transport) — they all
// share the same shell.

import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

const POLL_MS = 30_000;
const MODAL_TTL_MS = 20_000;
const LAST_SEEN_KEY = "transport_popup_last_seen_id";

export default function TransportEventPopup() {
  const [queue, setQueue] = useState([]); // notifications waiting to be shown
  const [current, setCurrent] = useState(null);
  const [countdown, setCountdown] = useState(20);
  const lastSeenRef = useRef(null);
  const dismissTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const audioCtxRef = useRef(null);

  // ----- Load last-seen id from localStorage on mount.
  // First-load fallback: if there's nothing stored, treat ALL existing
  // unread notifications as "already seen" by stamping the current top id.
  // Otherwise opening the app for the first time would burst-popup every
  // historical transport notification. Only NEW events trigger.
  useEffect(() => {
    try {
      lastSeenRef.current = localStorage.getItem(LAST_SEEN_KEY) || null;
    } catch { lastSeenRef.current = null; }
  }, []);

  // ----- Poll notifications.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/api/notifications", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (cancelled || !j?.ok) return;
        const items = Array.isArray(j.items) ? j.items : [];
        const transport = items.filter((n) => n.type === "transport");
        if (!transport.length) return;

        // First-ever load: stamp the newest id as "seen" so we don't
        // replay history. From now on, only newer ones popup.
        if (!lastSeenRef.current) {
          lastSeenRef.current = transport[0].id;
          try { localStorage.setItem(LAST_SEEN_KEY, transport[0].id); } catch {}
          return;
        }

        // Find notifications strictly newer than last-seen. The list comes
        // back newest-first. We walk until we hit the last-seen id (or run
        // out), then reverse so we show oldest-first (chronological).
        const fresh = [];
        for (const n of transport) {
          if (n.id === lastSeenRef.current) break;
          fresh.push(n);
        }
        if (!fresh.length) return;
        fresh.reverse();

        // Stamp the newest as last-seen NOW (before showing the modals)
        // so a slow modal queue + a re-poll mid-queue doesn't double-fire.
        lastSeenRef.current = transport[0].id;
        try { localStorage.setItem(LAST_SEEN_KEY, transport[0].id); } catch {}

        setQueue((q) => [...q, ...fresh]);
      } catch { /* swallow — best-effort */ }
    }
    tick();
    const t = setInterval(tick, POLL_MS);
    // Refresh immediately when the tab comes back into focus so a parent
    // who switched away doesn't have to wait the full poll cycle.
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // ----- Promote queue → current modal.
  useEffect(() => {
    if (current || !queue.length) return;
    const [next, ...rest] = queue;
    setCurrent(next);
    setQueue(rest);
    setCountdown(MODAL_TTL_MS / 1000);
    playChime();

    dismissTimerRef.current = setTimeout(() => setCurrent(null), MODAL_TTL_MS);
    countdownTimerRef.current = setInterval(() => {
      setCountdown((c) => (c > 1 ? c - 1 : c));
    }, 1000);
    return () => {
      clearTimeout(dismissTimerRef.current);
      clearInterval(countdownTimerRef.current);
    };
  }, [queue, current]);

  // ----- Manual dismiss (OK button / Escape key / backdrop click).
  function dismiss() {
    clearTimeout(dismissTimerRef.current);
    clearInterval(countdownTimerRef.current);
    setCurrent(null);
  }

  useEffect(() => {
    if (!current) return;
    const onKey = (e) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current]);

  // ----- Soft two-tone chime via Web Audio API.
  // Generates the sound at runtime — no asset file required. C5 → E5 sine
  // waves with a short attack/release envelope. Total duration ~0.45s.
  // Modern browsers gate audio behind a prior user interaction; the parent
  // has logged in, so this almost always works. If the AudioContext can't
  // start (very fresh tab), the failure is silent.
  function playChime() {
    try {
      if (typeof window === "undefined") return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const tone = (freq, t0, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + t0);
        gain.gain.linearRampToValueAtTime(0.18, now + t0 + 0.03);
        gain.gain.linearRampToValueAtTime(0, now + t0 + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + t0);
        osc.stop(now + t0 + dur + 0.02);
      };
      tone(523.25, 0,    0.22); // C5
      tone(659.25, 0.22, 0.30); // E5
    } catch { /* audio failures are non-fatal */ }
  }

  if (!current) return null;

  return (
    <div className="modal-backdrop"
      onClick={dismiss}
      role="dialog"
      aria-live="polite"
      style={{
        position: "fixed", inset: 0,
        background: "rgba(20,16,10,0.55)",
        backdropFilter: "blur(2px)",
        display: "grid", placeItems: "center",
        zIndex: 5000, padding: 20,
        animation: "transport-popup-fade 0.18s ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 440,
          background: "var(--card, #fff)",
          borderRadius: 16,
          padding: "32px 28px 24px",
          boxShadow: "0 24px 64px -16px rgba(0,0,0,0.4), 0 8px 24px -8px rgba(0,0,0,0.18)",
          textAlign: "center",
          position: "relative",
          animation: "transport-popup-rise 0.25s cubic-bezier(0.2, 0.7, 0.2, 1)",
        }}
      >
        {/* Bus icon */}
        <div style={{
          width: 64, height: 64, borderRadius: "50%",
          background: "linear-gradient(160deg, var(--accent-soft, #fde6d6), rgba(232,83,14,0.12))",
          color: "var(--accent, #e8530e)",
          display: "grid", placeItems: "center",
          margin: "0 auto 18px",
          border: "1px solid rgba(232,83,14,0.2)",
        }}>
          <Icon name="bus" size={30} />
        </div>

        {/* Title — strip the leading emoji from the stored title since the icon already covers that. */}
        <h2 style={{
          margin: "0 0 10px",
          fontFamily: "var(--font-serif, Georgia, serif)",
          fontSize: 22, fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--ink)",
          lineHeight: 1.25,
        }}>
          {String(current.title || "Transport update").replace(/^[^\w]+\s*/, "")}
        </h2>

        {/* Description */}
        <p style={{
          margin: "0 0 22px",
          fontSize: 13.5, lineHeight: 1.55,
          color: "var(--ink-3)",
        }}>
          {current.description || ""}
        </p>

        {/* Circular countdown ring */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          fontSize: 11.5, color: "var(--ink-4)",
          marginBottom: 16,
        }}>
          <CountdownRing seconds={countdown} totalSeconds={MODAL_TTL_MS / 1000} />
          <span>auto-closes in {countdown}s</span>
        </div>

        <button
          onClick={dismiss}
          style={{
            width: "100%",
            padding: "12px 16px",
            background: "var(--accent, #e8530e)",
            color: "#fff",
            border: 0, borderRadius: 10,
            fontSize: 14, fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 6px 18px -10px rgba(232,83,14,0.5)",
          }}
        >
          OK, got it
        </button>

        {/* Stack hint when more events are queued behind this one */}
        {queue.length > 0 && (
          <div style={{
            position: "absolute", top: 10, right: 14,
            fontSize: 10.5, color: "var(--ink-4)",
            fontFamily: "var(--font-mono, monospace)",
          }}>
            +{queue.length} more
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes transport-popup-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes transport-popup-rise {
          from { opacity: 0; transform: translateY(20px) scale(0.96); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
    </div>
  );
}

function CountdownRing({ seconds, totalSeconds }) {
  const size = 16;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, seconds / totalSeconds));
  const dash = c * pct;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="var(--rule, #e5dfd1)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="var(--accent, #e8530e)" strokeWidth={stroke}
        strokeDasharray={`${dash} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 1s linear" }} />
    </svg>
  );
}
