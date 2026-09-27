/** A minimal adapter; read returns null only when the file does not exist. */
export interface FileIO {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DocumentSnapshot {
  markdown: string | null;
  sidecar: string | null;
}

export interface DocumentWrite {
  documentPath: string;
  expected: DocumentSnapshot;
  next: { markdown: string; sidecar: string };
}

export interface StorageOptions {
  /** Validate the complete domain schema; throw on unknown or invalid metadata. */
  validateSidecar(raw: string): void;
  /** Unknown versions are rejected before calling the domain validator. */
  sidecarSchemaVersion?: number;
}

export type StorageErrorCode =
  | "invalid-path"
  | "invalid-metadata"
  | "invalid-journal"
  | "pending-transaction"
  | "conflict";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

interface Intent {
  kind: "explainweave.write-intent";
  version: 1;
  documentPath: string;
  before: DocumentSnapshot;
  after: { markdown: string; sidecar: string };
}

interface Journal {
  intent: Intent;
  /** Detect accidental journal corruption, including changes inside JSON strings. */
  sha256: string;
}

export type RecoveryResult =
  | { status: "none" }
  | { status: "recovered"; snapshot: DocumentSnapshot };

export function pathsFor(documentPath: string): {
  markdown: string;
  sidecar: string;
  journal: string;
} {
  if (
    !documentPath ||
    !/\.md$/i.test(documentPath) ||
    documentPath.includes("//") ||
    /[\0\\]/.test(documentPath) ||
    documentPath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new StorageError("invalid-path", "Expected a normalized Markdown file path.");
  }
  const stem = documentPath.slice(0, -3);
  return {
    markdown: documentPath,
    sidecar: `${stem}.explainweave.json`,
    journal: `${stem}.explainweave.pending.json`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSnapshot(value: unknown, allowMissing: boolean): value is DocumentSnapshot {
  return (
    isRecord(value) &&
    hasKeys(value, ["markdown", "sidecar"]) &&
    [value.markdown, value.sidecar].every(
      (part) => typeof part === "string" || (allowMissing && part === null),
    )
  );
}

function same(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  return a.markdown === b.markdown && a.sidecar === b.sidecar;
}

async function digest(intent: Intent): Promise<string> {
  // Fixed serialization prevents a harmless JSON property-order change from
  // becoming an integrity failure. No Node or Obsidian dependency is required.
  const bytes = new TextEncoder().encode(JSON.stringify({
    kind: intent.kind,
    version: intent.version,
    documentPath: intent.documentPath,
    before: { markdown: intent.before.markdown, sidecar: intent.before.sidecar },
    after: { markdown: intent.after.markdown, sidecar: intent.after.sidecar },
  }));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Single-writer, recoverable two-file storage. Call recover before loading a
 * document. An unresolved journal blocks new commits, never gets overwritten,
 * and is retained on every conflict/error for inspection and recovery.
 *
 * This is optimistic conflict detection, not an atomic filesystem CAS. The IO
 * interface cannot prevent an external writer racing the final read and write,
 * nor guarantee fsync/atomic replacement. The adapter should provide atomic
 * per-file writes where possible. One instance serializes its own operations;
 * multiple stores/devices must not act as concurrent writers.
 */
export function createDocumentStore(io: FileIO, options: StorageOptions) {
  const schemaVersion = options.sidecarSchemaVersion ?? 1;
  const queues = new Map<string, Promise<unknown>>();

  function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(path, current);
    void current.then(
      () => { if (queues.get(path) === current) queues.delete(path); },
      () => { if (queues.get(path) === current) queues.delete(path); },
    );
    return current;
  }

  function validateMetadata(raw: string | null): void {
    if (raw === null) return;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value.schemaVersion !== schemaVersion) {
        throw new Error("Unrecognized sidecar schema version.");
      }
      options.validateSidecar(raw);
    } catch {
      throw new StorageError("invalid-metadata", "Metadata is damaged or uses an unsupported schema; it was preserved.");
    }
  }

  async function readState(documentPath: string): Promise<DocumentSnapshot> {
    const paths = pathsFor(documentPath);
    const [markdown, sidecar] = await Promise.all([io.read(paths.markdown), io.read(paths.sidecar)]);
    return { markdown, sidecar };
  }

  async function parseJournal(raw: string, documentPath: string): Promise<Intent> {
    let value: unknown;
    try { value = JSON.parse(raw); } catch {
      throw new StorageError("invalid-journal", "The pending write journal is damaged; it was preserved.");
    }
    if (!isRecord(value) || !hasKeys(value, ["intent", "sha256"]) || !isRecord(value.intent)) {
      throw new StorageError("invalid-journal", "Unrecognized pending write journal; it was preserved.");
    }
    const candidate = value.intent;
    if (
      !hasKeys(candidate, ["kind", "version", "documentPath", "before", "after"]) ||
      candidate.kind !== "explainweave.write-intent" || candidate.version !== 1 ||
      candidate.documentPath !== documentPath ||
      !isSnapshot(candidate.before, true) || !isSnapshot(candidate.after, false) ||
      typeof value.sha256 !== "string"
    ) {
      throw new StorageError("invalid-journal", "The pending write journal has an unsupported format or target; it was preserved.");
    }
    const intent = candidate as unknown as Intent;
    if (await digest(intent) !== value.sha256) {
      throw new StorageError("invalid-journal", "The pending write journal failed its integrity check; it was preserved.");
    }
    validateMetadata(intent.before.sidecar);
    validateMetadata(intent.after.sidecar);
    return intent;
  }

  async function assertJournal(documentPath: string, raw: string): Promise<void> {
    if (await io.read(pathsFor(documentPath).journal) !== raw) {
      throw new StorageError("conflict", "The pending write journal changed externally; no further writes were made.");
    }
  }

  function assertKnown(current: DocumentSnapshot, intent: Intent): void {
    for (const key of ["markdown", "sidecar"] as const) {
      if (current[key] !== intent.before[key] && current[key] !== intent.after[key]) {
        throw new StorageError("conflict", `The ${key} changed externally; the pending write was preserved.`);
      }
    }
  }

  async function rollForward(intent: Intent, raw: string): Promise<DocumentSnapshot> {
    const paths = pathsFor(intent.documentPath);
    for (const key of ["markdown", "sidecar"] as const) {
      await assertJournal(intent.documentPath, raw);
      const state = await readState(intent.documentPath);
      // Check BOTH files before touching either one, including during recovery.
      assertKnown(state, intent);
      if (state[key] !== intent.after[key]) {
        await io.write(paths[key], intent.after[key]);
      }
    }
    await assertJournal(intent.documentPath, raw);
    const result = await readState(intent.documentPath);
    if (!same(result, intent.after)) {
      throw new StorageError("conflict", "The document changed before commit completed; the pending write was preserved.");
    }
    await io.remove(paths.journal);
    return result;
  }

  return {
    /** Raw strings are retained for exact compare-and-swap, including formatting. */
    read(documentPath: string): Promise<DocumentSnapshot> {
      pathsFor(documentPath);
      return serialized(documentPath, async () => {
        const state = await readState(documentPath);
        validateMetadata(state.sidecar);
        return state;
      });
    },

    commit(write: DocumentWrite): Promise<DocumentSnapshot> {
      pathsFor(write.documentPath);
      // Copy inputs synchronously: a caller may mutate its objects while awaiting.
      const intent: Intent = {
        kind: "explainweave.write-intent", version: 1, documentPath: write.documentPath,
        before: { markdown: write.expected.markdown, sidecar: write.expected.sidecar },
        after: { markdown: write.next.markdown, sidecar: write.next.sidecar },
      };
      return serialized(intent.documentPath, async () => {
        if (!isSnapshot(intent.before, true) || !isSnapshot(intent.after, false)) {
          throw new StorageError("invalid-metadata", "A commit must contain original and replacement raw file strings.");
        }
        validateMetadata(intent.before.sidecar);
        validateMetadata(intent.after.sidecar);
        const paths = pathsFor(intent.documentPath);
        if (await io.read(paths.journal) !== null) {
          throw new StorageError("pending-transaction", "A pending transaction must be recovered before another write.");
        }
        const before = await readState(intent.documentPath);
        validateMetadata(before.sidecar);
        if (!same(before, intent.before)) {
          throw new StorageError("conflict", "The document or metadata changed since it was read; nothing was written.");
        }
        if (same(intent.before, intent.after)) return before;
        const journal: Journal = { intent, sha256: await digest(intent) };
        const raw = JSON.stringify(journal, null, 2);
        // Recheck after asynchronous hashing, before writing the intent.
        if (await io.read(paths.journal) !== null) {
          throw new StorageError("pending-transaction", "Another pending transaction appeared; nothing was overwritten.");
        }
        if (!same(await readState(intent.documentPath), intent.before)) {
          throw new StorageError("conflict", "The document changed before the write intent was recorded.");
        }
        await io.write(paths.journal, raw);
        await assertJournal(intent.documentPath, raw);
        if (!same(await readState(intent.documentPath), intent.before)) {
          throw new StorageError("conflict", "The document changed after the write intent was recorded; the journal was preserved.");
        }
        return rollForward(intent, raw);
      });
    },

    recover(documentPath: string): Promise<RecoveryResult> {
      pathsFor(documentPath);
      return serialized(documentPath, async () => {
        const raw = await io.read(pathsFor(documentPath).journal);
        if (raw === null) return { status: "none" };
        const intent = await parseJournal(raw, documentPath);
        const snapshot = await rollForward(intent, raw);
        return { status: "recovered", snapshot };
      });
    },
  };
}
