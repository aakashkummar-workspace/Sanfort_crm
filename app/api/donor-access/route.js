import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { redeemDonorAccessLink, logAudit } from "@/lib/db";
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/donor-access?t=<token>
//
// Public by necessity — a donor following their link has no session yet. The
// token IS the credential, which is why the link expires, is revocable, and
// resolves only to a donor account: redeemDonorAccessLink refuses anything
// whose user is not role "donor", so a leaked token can never open a staff
// session even if one were somehow pointed at the wrong user.
//
// Every outcome looks the same to a visitor. Expired, revoked and never-valid
// all land on the same page with the same message, so the URL cannot be used
// to probe which tokens exist.
export async function GET(req) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  const fail = NextResponse.redirect(new URL("/login?link=invalid", url.origin));

  if (!token) return fail;

  let resolved = null;
  try {
    resolved = await redeemDonorAccessLink(token);
  } catch {
    return fail;
  }
  if (!resolved?.user) return fail;

  const { user, link } = resolved;
  const jwt = await signSession({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    linkedId: user.linkedId ?? null,
    linkedClasses: user.linkedClasses ?? [],
    // Marks the session as link-derived, so a later change of policy can treat
    // these differently from a password sign-in without re-issuing links.
    via: "donor_link",
  });

  cookies().set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  try {
    await logAudit(user.name || "Donor", "Sign in via link", user.email, {
      actorId: user.id, actorRole: user.role,
      entityType: "auth", entityId: user.email,
      meta: { linkId: link?.id, useCount: (link?.useCount || 0) + 1 },
    });
  } catch {}

  return NextResponse.redirect(new URL("/", url.origin));
}
