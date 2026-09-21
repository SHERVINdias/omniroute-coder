/**
 * POST /api/licence/check
 * ---------------------------------------------------------------------------
 * The licence server's signing endpoint. A desktop install sends its licence
 * KEY and its per-install UUID; this route validates the key, records the
 * install, and returns an Ed25519-SIGNED entitlement blob the app caches and
 * verifies offline.
 *
 * WHERE IT RUNS
 *
 * On the cloud licence server (OMNIROUTE_ROLE=licence). It is one of the few
 * routes the default-deny middleware there lets through. It never runs any AI,
 * stores no provider keys, and touches only the licence_keys and installs
 * tables.
 *
 * THE SIGNATURE IS THE POINT
 *
 * The blob sits on the user's disk between checks, so without a signature the
 * grace period would be extended by editing JSON. We sign the canonical JSON of
 * the entitlement with the server's Ed25519 PRIVATE key (LICENCE_SIGNING_KEY);
 * the app verifies with the baked-in public key. See src/lib/licence.ts for the
 * matching verification and the honest limits of this scheme.
 *
 * REVOCATION
 *
 * A key is entitled unless its row is flagged revoked (admin panel:
 * revoke-licence-key). A revoked key still gets a SIGNED blob — with
 * active:false — returned as 403, so the client caches the refusal and enforces
 * it on the next launch too, even offline. An UNKNOWN key gets 404 with no blob
 * (nothing to cache; the app asks for a valid key).
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

import { canonicalEntitlement, type Entitlement } from "@/lib/licence";
import {
  validateLicenceKey,
  recordInstall,
  touchLicenceKey,
} from "@/lib/licenceAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Ed25519 private key (PKCS8 PEM) used to sign blobs. Only the licence
 * server has this; the app has only the matching public key.
 *
 * Two ways to supply it, because a multi-line PEM is awkward in a server env
 * file: LICENCE_SIGNING_KEY holds the PEM verbatim (fine in a docker-compose
 * YAML block), or LICENCE_SIGNING_KEY_B64 holds the same PEM base64-encoded on a
 * single line (fine in a plain env_file). The base64 form is decoded here.
 */
function signingKey(): string | null {
  const b64 = process.env.LICENCE_SIGNING_KEY_B64?.trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (decoded.includes("PRIVATE KEY")) return decoded;
    } catch {
      /* fall through to the PEM form */
    }
  }
  const pem = process.env.LICENCE_SIGNING_KEY?.trim();
  return pem && pem.includes("PRIVATE KEY") ? pem : null;
}

function sign(entitlement: Entitlement): string {
  const key = signingKey();
  if (!key) throw new Error("LICENCE_SIGNING_KEY is not configured");
  return crypto
    .sign(null, Buffer.from(canonicalEntitlement(entitlement), "utf8"), key)
    .toString("base64");
}

export async function POST(req: NextRequest) {
  if (!signingKey()) {
    /* Misconfiguration, not a client error. Say so plainly in the server log
     * and return 500 rather than a signed-with-nothing blob. */
    console.error("[licence] LICENCE_SIGNING_KEY missing or malformed");
    return NextResponse.json({ error: "Licence signing is not configured." }, { status: 500 });
  }

  let body: { key?: unknown; installId?: unknown; appVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  const installId = typeof body.installId === "string" ? body.installId : "";
  const appVersion = typeof body.appVersion === "string" ? body.appVersion : null;

  if (!key || !installId) {
    return NextResponse.json({ error: "Missing key or installId." }, { status: 400 });
  }

  const verdict = validateLicenceKey(key);
  if (!verdict.exists) {
    /* Unknown key: nothing to sign or cache. The app should ask for a valid one. */
    return NextResponse.json({ error: "Unknown licence key." }, { status: 404 });
  }

  /* Record the check-in — this is the "which/how many machines" signal. */
  recordInstall(installId, key, appVersion);
  touchLicenceKey(key);

  const entitlement: Entitlement = {
    /* email/tier are cosmetic for the key model; email carries the label so the
     * app could show whose key this is, tier is a constant marker. */
    email: verdict.label,
    tier: "LICENSED",
    active: verdict.active,
    expiresAt: null,
    serverTime: Date.now(),
    installId,
  };

  const blob = { entitlement, signature: sign(entitlement) };

  /* A revoked key gets a signed active:false blob at 403, so the client caches
   * the revocation and enforces it offline. */
  return NextResponse.json(blob, { status: verdict.active ? 200 : 403 });
}
