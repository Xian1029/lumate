import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Create a browser-safe opaque identifier.
 *
 * Some embedded and older Chromium runtimes expose `crypto` but do not
 * implement `crypto.randomUUID`.  Tracking and rendering identifiers must
 * never make the application shell fail in those environments.
 */
export function createClientId(prefix = "id"): string {
  const browserCrypto = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (typeof browserCrypto?.randomUUID === "function") {
    return `${prefix}-${browserCrypto.randomUUID()}`;
  }

  const bytes = new Uint8Array(16);
  if (typeof browserCrypto?.getRandomValues === "function") {
    browserCrypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // IDs are used only for client-side deduplication; this final fallback is
  // deliberately not used as a security token.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
