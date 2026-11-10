// Forward a filed change report to SirahOS.
//
// Reports filed here notify an admin and then live only in this CRM. Sirah
// Digital, who actually make the changes, never see the queue. This copies
// each report into their Change requests list, so one list holds what every
// client has asked for.
//
// The report itself stays here: this is a copy for their side, not a move.
// Screenshots and triage stay in this CRM, where the reporter can see them.
//
// Reuses the SIRAHOS_* config the billing gate already needs, so there is
// nothing new to set up. Unset SIRAHOS_PROJECT_ID (or SIRAHOS_SECRET) and
// forwarding is simply off, exactly like the gate, so a dev copy is unaffected.

const TIMEOUT_MS = 10_000;

const config = () => ({
  base: (process.env.SIRAHOS_URL || "https://api.os.sirahagents.com").replace(/\/+$/, ""),
  projectId: (process.env.SIRAHOS_PROJECT_ID || "").trim(),
  secret: (process.env.SIRAHOS_SECRET || "").trim(),
});

/** Readable names for the SirahOS title; their side has no report types. */
const TYPE_LABEL = {
  bug: "Bug",
  logic_change: "Logic change",
  new_feature: "New feature",
  ui_issue: "UI issue",
  data_issue: "Data issue",
  performance: "Performance",
};

/**
 * Copy one report to SirahOS. Never throws and never rejects: the report is
 * already saved by the time this runs, and a billing server having a bad
 * minute must not cost the reporter their report.
 *
 * `reference` is the report's own id, so a retry — or this running twice for
 * any reason — files one request on their side, not two.
 */
export async function forwardToSirahOS(report) {
  const { base, projectId, secret } = config();
  if (!projectId || !secret) return; // forwarding not configured

  // SirahOS stores a title and a description, so fold the rest into the body:
  // without the screen and the severity they cannot tell urgent from cosmetic.
  const label = TYPE_LABEL[report.type] || report.type;
  const description = [
    report.description,
    report.expectedBehaviour ? `\nExpected: ${report.expectedBehaviour}` : "",
    `\nScreen: ${report.pageRoute || "unknown"}`,
    `Severity: ${report.severity}`,
    `Sanfort CRM report: ${report.id}`,
  ].join("\n").trim();

  try {
    const res = await fetch(`${base}/api/change-intake/${projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sirahos-Signature": secret },
      body: JSON.stringify({
        title: `[${label}] ${report.title}`,
        description,
        requestedBy: report.reporterName || "Staff",
        reference: report.id,
        source: "sanfort-crm",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[change-forward] SirahOS returned ${res.status} for report ${report.id}`);
    }
  } catch (e) {
    // Logged, not surfaced. The report is saved here regardless, and an admin
    // can still see it; only the copy on their side is missing.
    console.warn(`[change-forward] could not forward report ${report.id}: ${e.message}`);
  }
}
