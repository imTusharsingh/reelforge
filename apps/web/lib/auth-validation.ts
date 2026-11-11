export type AuthMode = "signin" | "register";

export function validateAuth(
  email: string,
  password: string,
  displayName: string,
  mode: AuthMode,
): string {
  if (!email.trim() || !email.includes("@")) return "Enter a valid email address.";
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (mode === "register" && !displayName.trim()) return "Enter a display name.";
  return "";
}
