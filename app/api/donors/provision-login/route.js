import { NextResponse } from "next/server";
import { provisionDonorLogin, logAudit, readAllData } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Creating a login is a narrower privilege than managing donor records.
const CAN_PROVISION = new Set(["admin", "principal"]);

// POST /api/donors/provision-login  { donorId, email? }
//
// Returns the generated password ONCE. It is not stored in readable form, so
// it cannot be retrieved later — a lost password is reset, not recovered.
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_PROVISION.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to create donor logins" }, { status: 403 });
  }
  let body; try { body = await req.json(); } catch { body = null; }
  const donorId = body?.donorId;
  if (!donorId) return NextResponse.json({ ok: false, error: "donorId required" }, { status: 400 });

  let donor = null;
  try {
    const data = await readAllData();
    donor = (data.donors || []).find((d) => d.id === donorId) || null;
  } catch {}
  if (!donor) return NextResponse.json({ ok: false, error: "Donor not found" }, { status: 404 });

  try {
    const created = await provisionDonorLogin({
      donorId,
      donorName: donor.name,
      email: body?.email || donor.email,
    });
    try {
      // The password is deliberately absent from the audit entry.
      await logAudit(session.name || "System", "Provisioned donor login", `${donor.id} ${donor.name} · ${created.email}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "donor", entityId: donor.id,
      });
    } catch {}
    return NextResponse.json({ ok: true, login: created });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to create login" }, { status: 400 });
  }
}
