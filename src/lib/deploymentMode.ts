/**
 * src/lib/deploymentMode.ts
 * ---------------------------------------------------------------------------
 * One question, answered in one place: does this process serve more than one
 * person?
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The flag started life as a const inside vscodeBridge.ts, which is where it is
 * used most. But `agentContext.ts` needs the same answer — it decides where to
 * put `.omniroute` state, and the correct directory is different on a server —
 * and importing vscodeBridge to get it would be expensive in a way that is easy
 * to miss: vscodeBridge.ts ends with
 *
 *     export const vscodeBridge = new VSCodeBridgeManager();
 *     if (typeof window === "undefined") { vscodeBridge.initialize(); }
 *
 * so importing it *anywhere*, for any reason, opens the WebSocket listener as a
 * side effect of module evaluation. A module that only wants to know "am I on a
 * server" would have started a network service to find out.
 *
 * This file has no imports and no side effects, so anything can ask.
 *
 * WHY IT IS A FUNCTION AND NOT A CONST
 *
 * `process.env` is read at call time. A module-level const is evaluated when the
 * module is first imported, which in a bundled server build can be before the
 * runtime environment is fully populated — the resulting value would be `false`
 * (the permissive answer) for reasons nobody would ever think to look for.
 * Reading it per call costs nothing and cannot be wrong.
 */

/**
 * True when the file tools must refuse to touch this machine's own disk.
 *
 *   false (a laptop)  The Next server and VS Code are the same machine and the
 *                     same person. Reading a file directly is a convenience
 *                     that costs nothing, because the disk belongs to the
 *                     person asking.
 *
 *   true  (a server)  The disk is the OPERATOR's, shared by every account. The
 *                     same convenience would let any signed-in user read
 *                     /app/.env, the SQLite database holding everyone's
 *                     encrypted credentials, and the deploy key — by asking an
 *                     AI politely. So in this mode a file operation reaches the
 *                     user's own editor or it fails.
 *
 * Derived from NODE_ENV so a production build is multi-tenant by default and
 * nobody has to remember a flag in order to be safe. The override exists so the
 * behaviour can be exercised in development, where it is otherwise untestable:
 * every guard it controls is invisible until something is deployed.
 */
export function isMultiTenantBridge(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.OMNIROUTE_BRIDGE_MULTI_TENANT === "true";
}

/**
 * True when this deployment is willing to accept editor connections at all.
 *
 * A production build does not open the bridge listener unless someone sets
 * OMNIROUTE_BRIDGE_ENABLE=true — a thing you cannot do by accident. Three
 * separate places need that same answer and each had its own copy of the string
 * comparison:
 *
 *   - vscodeBridge.ts, to decide whether to bind the port;
 *   - bridgeEndpoint.ts, so the pairing UI does not hand out tokens for a socket
 *     that will never answer;
 *   - fileToolsGate.ts, so the file tools are not switched off underneath a
 *     bridge the operator deliberately turned on.
 *
 * Three copies of one rule is two chances for them to disagree, and the symptom
 * of disagreement is the worst kind: the app cheerfully issues a pairing code,
 * the extension connects, and every tool call comes back "this feature is only
 * available in a local install". So the rule lives here once.
 *
 * Development always returns true: there is nothing shared to protect, and
 * requiring the flag locally would mean the feature could only be tested by
 * people who already knew it existed.
 */
export function isBridgeEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.OMNIROUTE_BRIDGE_ENABLE === "true";
}
