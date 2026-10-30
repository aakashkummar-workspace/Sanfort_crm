import { NextResponse } from "next/server";
import {
  createDonorAccessLink, revokeDonorAccessLinks, listDonorAccessLinks,
  provisionDonorLogin, getUserByEmail, readAllData, logAudit,
} from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Issuing a link that signs someone in without a password is a narrower
// privilege than editing donor records.
const CAN_ISSUE = new Set(["admin", "principal"]);

async function gate(session) {
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_ISSUE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to issue donor links" }, { status: 403 });
  }
  return null;
}

// GET /api/donors/access-link?donorId= — existing links, for showing status.
export async function GET(req) {
  const session = await getSession();
  const denied = await gate(session);
  if (denied) return denied;
  const donorId = new URL(req.url).searchParams.get("donorId");
  try {
    return NextResponse.json({ ok: true, links: await listDonorAccessLinks(donorId || undefined) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}

// POST /api/donors/access-link  { donorId, days? }
//
// Creates the donor's login if they do not have one yet, then issues a link.
// Any previous link for that donor is revoked first: one live link per donor
// means "send them a new one" also means "the old one stops working", which is
// the behaviour someone reaches for when a link has gone astray.
export async function POST(req) {
  const session = await getSession();
  const denied = await gate(session);
  if (denied) return denied;

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
    // Find or create the donor's user account.
    let user = donor.email ? await getUserByEmail(donor.email) : null;
    if (user && user.role !== "donor") {
      return NextResponse.json({
        ok: false,
        error: `${donor.email} already belongs to a ${user.role} account — use a different email for this donor.`,
      }, { status: 409 });
    }
    if (!user) {
      if (!donor.email) {
        return NextResponse.json({ ok: false, error: "This donor has no email address on file." }, { status: 400 });
      }
      await provisionDonorLogin({ donorId, donorName: donor.name, email: donor.email });
      user = await getUserByEmail(donor.email);
    }
    if (!user) return NextResponse.json({ ok: false, error: "Could not resolve the donor login" }, { status: 500 });

    const revoked = await revokeDonorAccessLinks(donorId, session.name).catch(() => 0);
    const days = Math.min(Math.max(Number(body?.days) || 30, 1), 365);
    const { token, link } = await createDonorAccessLink({
      donorId, userId: user.id, createdBy: session.name || "System", days,
    });

    try {
      // The token is deliberately absent from the audit entry.
      await logAudit(session.name || "System", "Issued donor access link", `${donor.id} ${donor.name}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "donor", entityId: donor.id,
        meta: { linkId: link.id, days, revokedPrevious: revoked },
      });
    } catch {}

    return NextResponse.json({ ok: true, token, link, email: user.email, revokedPrevious: revoked });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to issue link" }, { status: 400 });
  }
}

// DELETE /api/donors/access-link  { donorId } — revoke every live link.
export async function DELETE(req) {
  const session = await getSession();
  const denied = await gate(session);
  if (denied) return denied;
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.donorId) return NextResponse.json({ ok: false, error: "donorId required" }, { status: 400 });
  try {
    const n = await revokeDonorAccessLinks(body.donorId, session.name);
    try {
      await logAudit(session.name || "System", "Revoked donor access link", body.donorId, {
        actorId: session.sub, actorRole: session.role,
        entityType: "donor", entityId: body.donorId, meta: { revoked: n },
      });
    } catch {}
    return NextResponse.json({ ok: true, revoked: n });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}
