/**
 * GET /api/auth/session
 * ---------------------------------------------------------------------------
 * Who is signed in right now.
 *
 * The client calls this on page load to restore a session. It reads the
 * httpOnly cookie first and falls back to the Authorization header, so a tab
 * that still only has the localStorage token keeps working.
 *
 * A missing or expired session is not an error condition — it is the normal
 * state of a signed-out visitor. It answers 200 with `authenticated: false`
 * rather than 401, so the restore path does not have to treat "nobody is signed
 * in" as a failure. `success` is kept in the payload because the existing
 * client checks it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { currentUser, publicUser } from "@/lib/authGuard";
import { deliveryStatus } from "@/lib/otpDelivery";
import { isAdmin } from "@/lib/emailAuth";
import { fileToolsEnabled } from "@/lib/fileToolsGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Feature switches the UI needs in order to explain itself.
 *
 * Deliberately NOT exported: Next.js generates a type check per route file that
 * validates the handler signatures, and an unexpected named export from a
 * route.ts is the kind of thing that turns into a confusing build error for no
 * benefit. The client declares its own copy of this shape.
 */
interface SessionFeatures {
  /**
   * Whether Cowork / Deep Cowork file tools are usable on this server.
   *
   * These are off by default in production because they read and write real
   * files on the machine running the app, with no per-user isolation. The
   * server already refuses the request (503 FILE_TOOLS_DISABLED), but without
   * this flag the client lets someone write a prompt, pick a mode, wait, and
   * only then get an error — the capability is knowable up front, so it is
   * reported up front.
   *
   * Not sensitive: it is a property of the deployment, and the same number is
   * already revealed by attempting any file-tool request.
   */
  fileTools: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const user = currentUser(request);

    if (!user) {
      return NextResponse.json({
        success: false,
        authenticated: false,
        user: null,
        features: { fileTools: fileToolsEnabled() } satisfies SessionFeatures,
      });
    }

    return NextResponse.json({
      success: true,
      authenticated: true,
      user: publicUser(user),
      features: { fileTools: fileToolsEnabled() } satisfies SessionFeatures,
      /* Admins get the delivery configuration so the panel can explain why
       * codes are or are not going out. Booleans and provider names only —
       * deliveryStatus never returns a credential. */
      delivery: isAdmin(user) ? deliveryStatus() : undefined,
    });
  } catch (error) {
    console.error("[auth/session]", error);
    return NextResponse.json(
      { error: "Could not read the session." },
      { status: 500 },
    );
  }
}
