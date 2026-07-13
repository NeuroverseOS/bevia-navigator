// Bevia Navigator — shared error types + Local-mode copy.
//
// BeviaApiError lives here (not api.ts) so the Bevia Local routing layer
// (local.ts) can throw the same typed error every view already knows how
// to render, without an api ↔ local import cycle. api.ts re-exports it,
// so existing `import { BeviaApiError } from "./api"` sites keep working.

export class BeviaApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "BeviaApiError";
  }
}

/** The one honest line for cloud-only features while Bevia Local is on.
 *  Shown wherever a surface would otherwise have called the cloud. */
export const LOCAL_UNAVAILABLE = "Not in Bevia Local yet.";

/** Shown when the local engine answers 401 — the pairing was revoked.
 *  There is never a silent cloud fallback on this path. */
export const LOCAL_RECONNECT =
  "Reconnect to Bevia Local — open Settings → Bevia Local and pair again with a fresh code from the desktop app.";

/** Typed refusal for cloud calls while Bevia Local is on (matrix leg 2:
 *  zero requests may leave for any non-127.0.0.1 host). status 0 on
 *  purpose: it must never trip the 401 "your cloud key died" handlers. */
export class LocalModeUnavailableError extends BeviaApiError {
  constructor() {
    super(LOCAL_UNAVAILABLE, 0);
    this.name = "LocalModeUnavailableError";
  }
}
