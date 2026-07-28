// Bevia Navigator — shared error types + copy.
//
// BeviaApiError lives here (not api.ts) so the routing layer (local.ts)
// can throw the same typed error every view already knows how to
// render, without an api ↔ local import cycle. api.ts re-exports it,
// so existing `import { BeviaApiError } from "./api"` sites keep working.

export class BeviaApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "BeviaApiError";
  }
}

/** Shown when the local engine answers 401 — the pairing was revoked
 *  (the app was likely reinstalled). Nothing retries silently. */
export const LOCAL_RECONNECT =
  "Reconnect to Bevia — open Settings → Bevia Local and pair again with the port the Bevia app shows.";
