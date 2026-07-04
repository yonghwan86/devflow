import bcrypt from "bcryptjs";
export const BCRYPT_COST = 12;
export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_COST);
}
export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}
export function validatePasswordStrength(pw: string): boolean {
  return typeof pw === "string" && pw.length >= 8;
}

// Fixed hash used to equalize login timing for unknown users.
export const DUMMY_BCRYPT_HASH = "$2a$12$6qXkTUXIOPdy3Q/nVI1pEui4Q6wsz8JJ9G9OYYUEOMmyabIFV2dMm";
