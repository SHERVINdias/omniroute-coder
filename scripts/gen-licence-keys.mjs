/**
 * scripts/gen-licence-keys.mjs
 * ---------------------------------------------------------------------------
 * Generate the Ed25519 keypair the licence system uses.
 *
 *   node scripts/gen-licence-keys.mjs
 *
 * Then:
 *   1. Put the PRIVATE key in the licence server's environment as
 *      LICENCE_SIGNING_KEY (keep the -----BEGIN/END PRIVATE KEY----- lines;
 *      it is a multi-line value, so quote it or use an env file that supports
 *      multi-line values).
 *   2. Paste the PUBLIC key into BOTH:
 *        - src/lib/licence.ts   (LICENCE_PUBLIC_KEY_PEM placeholder)
 *        - desktop/licence.js   (LICENCE_PUBLIC_KEY_PEM placeholder)
 *      They must match byte for byte, or every signature check fails.
 *
 * The private key NEVER ships in the desktop app. Only the public key is baked
 * in, and a public key is safe to embed.
 */

import { generateKeyPairSync } from "crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

console.log("=== LICENCE_SIGNING_KEY (private — licence server only) ===\n");
console.log(privateKey);
console.log("=== PUBLIC KEY (paste into src/lib/licence.ts AND desktop/licence.js) ===\n");
console.log(publicKey);
