"use client";

import { lazy, Suspense, useState } from "react";
import Icon from "./Icon";
import { canFile } from "@/lib/change-reports";

// html2canvas is ~200 kB and most sessions never file a report, so the whole
// dialog is loaded on first click rather than on every page load.
const ChangeReportDialog = lazy(() => import("./ChangeReportDialog"));

export default function ChangeReportButton({ session = {}, screen }) {
  const [open, setOpen] = useState(false);
  if (!canFile(session.role)) return null;

  return (
    <>
      {/* data-change-report-ui marks this for html2canvas to skip, so the
          button never appears in its own screenshot. */}
      <button
        data-change-report-ui="1"
        onClick={() => setOpen(true)}
        title="Report a problem or request a change"
        aria-label="Report a problem or request a change"
        style={{
          position: "fixed",
          // Clear of any mobile bottom navigation.
          bottom: "calc(18px + env(safe-area-inset-bottom, 0px) + var(--bottom-nav-h, 0px))",
          right: 18, zIndex: 200,
          width: 46, height: 46, borderRadius: "50%",
          display: "grid", placeItems: "center", cursor: "pointer",
          background: "var(--accent)", color: "#fff", border: "none",
          boxShadow: "0 3px 14px rgba(0,0,0,0.22)",
        }}
      >
        <Icon name="flag" size={17} />
      </button>

      {open && (
        <Suspense fallback={null}>
          <ChangeReportDialog
            session={session}
            screen={screen}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
