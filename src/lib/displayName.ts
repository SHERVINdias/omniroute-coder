/**
 * src/lib/displayName.ts
 * ---------------------------------------------------------------------------
 * Turns an account into something you can greet.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The UI said "Welcome back, Shervin!" to every visitor, signed in or not. That
 * was not a wrong value so much as the absence of one: the `users` table holds
 * `email`, `phone`, `tier` and `role`, and no name column at all. There was
 * nothing to render, so a literal went in during development and survived into
 * something other people were meant to use.
 *
 * WHAT THIS CAN AND CANNOT RECOVER
 *
 * An email local-part is a username, and a username only sometimes contains a
 * name. `john.doe@…` yields "John Doe" because the separator carries the
 * structure. `10cshervindias45@…` yields "Cshervindias" — every letter of the
 * real name is in there, but nothing in the string marks where the given name
 * begins, and no heuristic can distinguish "shervin" from "cshervindias"
 * without already knowing the answer.
 *
 * So treat this as a *sensible default*, never as a derivation of the truth.
 * Anything that has to be right has to be typed by the person it belongs to.
 * `users.displayName` exists for that; this runs only when it is empty.
 *
 * WHY THE TWO FUNCTIONS DIFFER
 *
 * `resolveDisplayName` always returns something printable, because a sidebar
 * row with a blank label looks broken. `greetingName` returns null unless it has
 * an actual name, because "Welcome back, ••••3257!" is worse than "Welcome
 * back!" — a fallback that is visibly a fallback is not a fallback.
 *
 * NO IMPORTS ON PURPOSE
 *
 * page.tsx is a client component and the session route is server-side; both
 * need this. Keeping the module free of node builtins and database access means
 * neither has to care.
 */

export interface NameableUser {
  /** Set by the user in Settings. Always wins when present. */
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Long names break the sidebar row and the greeting line. Truncation happens
 * here rather than in CSS so the *initial* and the *label* cannot disagree
 * about what the name is.
 */
const MAX_NAME_LENGTH = 32;

/** First letter upper, rest lower. "JOHNDOE" -> "Johndoe", "doe" -> "Doe". */
function titleCaseWord(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function clamp(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
}

/**
 * Best-effort human name from an email address, or null when the local-part
 * carries nothing name-shaped.
 *
 * Returning null matters: `123456@example.com` has no name in it, and inventing
 * one ("123456") reads worse than omitting the greeting entirely.
 */
export function deriveNameFromEmail(email?: string | null): string | null {
  const raw = (email || "").trim();
  if (!raw) return null;

  const at = raw.indexOf("@");
  /* An address with no "@" is not valid, but it may still be a username someone
   * typed, so use the whole string rather than bailing out. */
  let local = at === -1 ? raw : raw.slice(0, at);

  /* Plus-addressing: john.doe+receipts@ is still John Doe. */
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  /* camelCase and PascalCase carry word boundaries that separators do not:
   * "johnDoe" has to become "john Doe" BEFORE case is flattened, because
   * title-casing first would destroy the only evidence of the split. */
  local = local.replace(/([a-z])([A-Z])/g, "$1 $2");

  const words = local
    .replace(/[._\-\s]+/g, " ")
    .replace(/\d+/g, "")
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);

  const letters = words.join("");
  /* One stray character is not a name — "a@example.com" should greet nobody. */
  if (letters.length < 2) return null;

  return clamp(words.map(titleCaseWord).join(" "));
}

/**
 * A phone number rendered for display rather than for reading back.
 *
 * Kept partial because this sits in the sidebar, which is on screen in every
 * screenshot and screen-share a beta tester ever sends.
 */
export function maskPhone(phone?: string | null): string | null {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `••••${digits.slice(-4)}`;
}

/**
 * A label for this account. Always printable for a signed-in user.
 *
 * Order: the name they set, then the name their email implies, then a masked
 * phone, then the bare email, then a neutral word. The email sits below the
 * masked phone because a full address is the most identifying of the four.
 */
export function resolveDisplayName(user?: NameableUser | null): string {
  if (!user) return "there";

  const explicit = (user.displayName || "").trim();
  if (explicit) return clamp(explicit);

  const derived = deriveNameFromEmail(user.email);
  if (derived) return derived;

  const masked = maskPhone(user.phone);
  if (masked) return masked;

  const email = (user.email || "").trim();
  if (email) return clamp(email);

  return "there";
}

/**
 * The name to use after "Welcome back, " — or null to drop the name entirely.
 *
 * Deliberately stricter than `resolveDisplayName`: a greeting addressed to a
 * masked phone number or a raw email address announces that the app does not
 * know who you are, which is precisely what the greeting was meant to hide.
 */
export function greetingName(user?: NameableUser | null): string | null {
  if (!user) return null;

  const explicit = (user.displayName || "").trim();
  if (explicit) return clamp(explicit);

  return deriveNameFromEmail(user.email);
}

/**
 * A single character for an avatar bubble.
 *
 * Falls back through the same chain and ends at "?" rather than "" so the
 * bubble keeps its shape — an empty circle reads as a failed image load.
 */
export function resolveInitial(user?: NameableUser | null): string {
  if (!user) return "?";

  const name = (user.displayName || "").trim() || deriveNameFromEmail(user.email);
  if (name) return name.charAt(0).toUpperCase();

  const email = (user.email || "").trim();
  /* Only ever look at the local-part. Scanning the whole address finds a letter
   * in the domain, so "123456@example.com" produced an "E" avatar — an initial
   * taken from "example", which belongs to the mail host and not to the person.
   *
   * Within the local-part, prefer the first letter over the first character:
   * "10cshervin…" would otherwise give "1", which reads as a counter. */
  const at = email.indexOf("@");
  const local = at === -1 ? email : email.slice(0, at);
  const firstLetter = local.match(/[a-z]/i);
  if (firstLetter) return firstLetter[0].toUpperCase();
  if (local) return local.charAt(0).toUpperCase();

  const digits = (user.phone || "").replace(/\D/g, "");
  if (digits) return digits.charAt(0);

  return "?";
}
