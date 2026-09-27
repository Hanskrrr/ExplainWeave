import { sha256 } from "@noble/hashes/sha2.js";
import { CoreError, type CoreOptions } from "./types";

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function hashText(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix: string, options?: CoreOptions): string {
  const value = options?.idFactory?.() ?? `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (!ID_PATTERN.test(value)) throw new CoreError("INVALID_ID", "An identifier contains unsupported characters.");
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function assert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new CoreError(code, message);
}

export function fingerprint(value: unknown): string {
  return hashText(JSON.stringify(value));
}
