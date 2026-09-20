/**
 * src/app/api/production-agent/route.ts — PARKED
 * ---------------------------------------------------------------------------
 * The server side of Production Agent Mode, which is not shipping in this
 * release. The mode is presented in the UI as "Coming soon"; this route is the
 * matching honest answer on the API side.
 *
 * WHY IT WAS PARKED RATHER THAN LEFT IN PLACE
 *
 * It did not build. The handler imported `makeUpstreamRequest` from
 * `@/lib/upstreamRequest`, and no such export exists — the module's outbound
 * functions are `postChatCompletion`, `postChatCompletionStream` and
 * `getModelList`. `next build` runs type checking, so this single import would
 * have failed the production build outright. That is the reason to deal with
 * it now rather than at deploy time.
 *
 * It was also unauthenticated, and it streamed an autonomous agent loop that
 * drives filesystem tools. Shipping that endpoint open to the internet while
 * the feature behind it is incomplete is not a trade worth making.
 *
 * WHAT IS PRESERVED
 *
 * `src/lib/phaseManager.ts` is untouched. The phase state machine is the part
 * that took the work and it has no bugs of its own; reviving this route means
 * rewriting the transport against the real upstream API, not rebuilding the
 * planner.
 *
 * A 410 rather than deleting the file: a stale browser tab still holding the
 * old client code gets a readable reason instead of Next's HTML 404 page, and
 * the next person to look for this endpoint finds this note.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PARKED = {
  success: false,
  code: "COMING_SOON",
  error:
    "Production Agent Mode is not available yet. Cowork, Deep Cowork and Ultra mode cover autonomous multi-file work in the meantime.",
} as const;

export async function POST() {
  return NextResponse.json(PARKED, { status: 410 });
}

export async function GET() {
  return NextResponse.json(PARKED, { status: 410 });
}
