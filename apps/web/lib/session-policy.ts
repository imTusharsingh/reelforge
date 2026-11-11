import { ApiError } from "./api";

export function isAlreadyInvalidSession(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function sessionFailureMessage(error: unknown): string {
  if (isAlreadyInvalidSession(error)) return "Your session has already expired.";
  return "We could not sign you out. Check your connection and try again.";
}
