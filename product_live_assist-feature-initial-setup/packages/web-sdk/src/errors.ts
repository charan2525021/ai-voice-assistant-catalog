export type SableErrorCode =
  | "ABORTED"
  | "AUTHENTICATION_FAILED"
  | "CATALOG_INVALID"
  | "CATALOG_UNTRUSTED"
  | "CATALOG_INCOMPATIBLE"
  | "COMMAND_INVALID"
  | "CONTROL_AMBIGUOUS"
  | "CONTROL_NOT_FOUND"
  | "CROSS_ORIGIN_BLOCKED"
  | "JOURNEY_NOT_FOUND"
  | "POLICY_BLOCKED"
  | "SCREEN_CHANGED"
  | "TOOL_NOT_FOUND"
  | "TOOL_INVALID_INPUT"
  | "TRANSPORT_FAILED"
  | "UNSUPPORTED_ACTION";

export class SableSdkError extends Error {
  constructor(
    public readonly code: SableErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "SableSdkError";
  }
}

export function abortError(message = "operation stopped"): SableSdkError {
  return new SableSdkError("ABORTED", message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
