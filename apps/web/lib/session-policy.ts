import { ApiError } from "./api";

export function isAlreadyInvalidSession(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function sessionFailureMessage(error: unknown): string {
  if (isAlreadyInvalidSession(error)) return "Your session has already expired.";
  return "We could not sign you out. Check your connection and try again.";
}

export function isCurrentGeneration(current: number, requestGeneration: number): boolean {
  return current === requestGeneration;
}

export async function resolveCurrentRequest<T>(
  request: Promise<T>,
  getCurrentGeneration: () => number,
  requestGeneration: number,
): Promise<T | null> {
  try {
    const result = await request;
    return isCurrentGeneration(getCurrentGeneration(), requestGeneration) ? result : null;
  } catch (error) {
    if (!isCurrentGeneration(getCurrentGeneration(), requestGeneration)) return null;
    throw error;
  }
}
