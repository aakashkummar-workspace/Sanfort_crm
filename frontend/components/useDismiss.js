"use client";

import { useEffect, useRef } from "react";

// Escape-to-close plus focus handling for a dialog.
//
// Most modals in this app already do this inline; these are the ones that
// did not. Returns a ref to put on the panel: focus moves into it on open
// and back to whatever was focused before, on close — otherwise keyboard
// users are dropped at the top of the page every time a dialog closes.
export function useDismiss(onClose, active = true) {
  const panelRef = useRef(null);
  const returnTo = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    returnTo.current = document.activeElement;

    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);

    // Focus the panel itself rather than guessing at a first field, so a
    // dialog whose first control is destructive is not pre-armed.
    const node = panelRef.current;
    if (node && !node.contains(document.activeElement)) {
      node.setAttribute("tabindex", "-1");
      node.focus({ preventScroll: true });
    }

    return () => {
      document.removeEventListener("keydown", onKey);
      const back = returnTo.current;
      if (back && typeof back.focus === "function" && document.contains(back)) {
        back.focus({ preventScroll: true });
      }
    };
  }, [onClose, active]);

  return panelRef;
}
