import { describe, expect, it } from "vitest";
import {
  createDocumentStore,
  pathsFor,
  type DocumentSnapshot,
  type FileIO,
} from "./storage";

const documentPath = "notes/Article.md";
const paths = pathsFor(documentPath);
const metadata = (revision: number) => JSON.stringify({ schemaVersion: 1, documentId: "doc-1", revision });
const before = { markdown: "# Article\n\nOriginal.\n", sidecar: metadata(1) };
const after = { markdown: "# Article\n\nRevised.\n", sidecar: metadata(2) };

class MemoryIO implements FileIO {
  files = new Map<string, string>();
  changes: string[] = [];
  failWrite: string | null = null;
  failRemove = false;
  afterWrite?: (path: string, text: string) => void;

  constructor(initial: DocumentSnapshot = before) {
    if (initial.markdown !== null) this.files.set(paths.markdown, initial.markdown);
    if (initial.sidecar !== null) this.files.set(paths.sidecar, initial.sidecar);
  }

  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, text: string) {
    if (this.failWrite === path) throw new Error("Simulated process interruption");
    this.files.set(path, text);
    this.changes.push(`write:${path}`);
    this.afterWrite?.(path, text);
  }
  async remove(path: string) {
    if (this.failRemove) throw new Error("Simulated process interruption");
    this.files.delete(path);
    this.changes.push(`remove:${path}`);
  }
}

function store(io: MemoryIO) {
  return createDocumentStore(io, {
    validateSidecar(raw) {
      const value = JSON.parse(raw);
      if (value.documentId !== "doc-1" || !Number.isInteger(value.revision)) {
        throw new Error("Invalid test document metadata");
      }
    },
  });
}

const request = () => ({ documentPath, expected: { ...before }, next: { ...after } });

async function interruptBeforeBody(io: MemoryIO) {
  io.failWrite = paths.markdown;
  await expect(store(io).commit(request())).rejects.toThrow("interruption");
  io.failWrite = null;
  expect(io.files.has(paths.journal)).toBe(true);
}

describe("document transactions", () => {
  it("preserves raw text and completes body + metadata before removing its intent", async () => {
    const io = new MemoryIO();
    expect(await store(io).read(documentPath)).toEqual(before);
    expect(await store(io).commit(request())).toEqual(after);
    expect(io.changes).toEqual([
      `write:${paths.journal}`, `write:${paths.markdown}`, `write:${paths.sidecar}`, `remove:${paths.journal}`,
    ]);
    expect(await store(io).read(documentPath)).toEqual(after);
    expect(await store(io).recover(documentPath)).toEqual({ status: "none" });
  });

  it("does not create a transaction for an unchanged snapshot", async () => {
    const io = new MemoryIO();
    await store(io).commit({ documentPath, expected: before, next: before });
    expect(io.changes).toEqual([]);
  });

  it.each(["markdown", "sidecar"] as const)("rejects a stale %s before any write", async (part) => {
    const io = new MemoryIO();
    io.files.set(paths[part], part === "markdown" ? "External edit" : metadata(3));
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "conflict" });
    expect(io.changes).toEqual([]);
  });

  it("compares metadata raw strings, including whitespace", async () => {
    const io = new MemoryIO();
    io.files.set(paths.sidecar, `${before.sidecar}\n`);
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "conflict" });
    expect(io.files.get(paths.sidecar)).toBe(`${before.sidecar}\n`);
    expect(io.changes).toEqual([]);
  });

  it("rechecks both original files after persisting the intent", async () => {
    const io = new MemoryIO();
    io.afterWrite = (path) => {
      if (path === paths.journal) io.files.set(paths.markdown, "A user's new paragraph");
    };
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "conflict" });
    expect(io.changes).toEqual([`write:${paths.journal}`]);
    expect(io.files.get(paths.markdown)).toBe("A user's new paragraph");
    expect(io.files.get(paths.sidecar)).toBe(before.sidecar);
    expect(io.files.has(paths.journal)).toBe(true);
  });

  it("detects an external metadata update between body and metadata writes", async () => {
    const io = new MemoryIO();
    io.afterWrite = (path) => {
      if (path === paths.markdown) io.files.set(paths.sidecar, metadata(99));
    };
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "conflict" });
    expect(io.files.get(paths.markdown)).toBe(after.markdown);
    expect(io.files.get(paths.sidecar)).toBe(metadata(99));
    const changes = [...io.changes];
    await expect(store(io).recover(documentPath)).rejects.toMatchObject({ code: "conflict" });
    expect(io.changes).toEqual(changes);
    expect(io.files.has(paths.journal)).toBe(true);
  });

  it("retains the journal if the body changes before the final commit check", async () => {
    const io = new MemoryIO();
    io.afterWrite = (path) => {
      if (path === paths.sidecar) io.files.set(paths.markdown, "Concurrent handwritten work");
    };
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "conflict" });
    expect(io.files.get(paths.markdown)).toBe("Concurrent handwritten work");
    expect(io.files.has(paths.journal)).toBe(true);
    expect(io.changes.some((change) => change.startsWith("remove:"))).toBe(false);
  });

  it("serializes its own writers and rejects a second writer's stale snapshot", async () => {
    const io = new MemoryIO();
    const storage = store(io);
    const results = await Promise.allSettled([storage.commit(request()), storage.commit(request())]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
    expect(await storage.read(documentPath)).toEqual(after);
    expect(io.files.has(paths.journal)).toBe(false);
  });

  it("copies caller input before asynchronous execution", async () => {
    const io = new MemoryIO();
    const write = request();
    const commit = store(io).commit(write);
    write.expected.markdown = "Changed caller object";
    write.next.markdown = "Changed caller object";
    expect(await commit).toEqual(after);
  });
});

describe("interrupted write recovery", () => {
  it("recovers interruption immediately after the intent was written", async () => {
    const io = new MemoryIO();
    await interruptBeforeBody(io);
    expect(await store(io).recover(documentPath)).toEqual({ status: "recovered", snapshot: after });
    expect(await store(io).read(documentPath)).toEqual(after);
    expect(io.files.has(paths.journal)).toBe(false);
  });

  it("completes the sidecar after the body was already written", async () => {
    const io = new MemoryIO();
    io.failWrite = paths.sidecar;
    await expect(store(io).commit(request())).rejects.toThrow("interruption");
    expect(io.files.get(paths.markdown)).toBe(after.markdown);
    expect(io.files.get(paths.sidecar)).toBe(before.sidecar);
    io.failWrite = null;
    io.changes = [];
    await store(io).recover(documentPath);
    expect(io.changes).toEqual([`write:${paths.sidecar}`, `remove:${paths.journal}`]);
    expect(await store(io).read(documentPath)).toEqual(after);
  });

  it("can recover the reverse known mixture after sync restored only the old body", async () => {
    const io = new MemoryIO();
    await interruptBeforeBody(io);
    io.files.set(paths.sidecar, after.sidecar);
    io.changes = [];
    await store(io).recover(documentPath);
    expect(io.changes).toEqual([`write:${paths.markdown}`, `remove:${paths.journal}`]);
  });

  it("only cleans up when both committed files already exist", async () => {
    const io = new MemoryIO();
    io.failRemove = true;
    await expect(store(io).commit(request())).rejects.toThrow("interruption");
    expect(await store(io).read(documentPath)).toEqual(after);
    io.failRemove = false;
    io.changes = [];
    await store(io).recover(documentPath);
    expect(io.changes).toEqual([`remove:${paths.journal}`]);
    expect(await store(io).recover(documentPath)).toEqual({ status: "none" });
  });

  it("refuses to overwrite an external body edit on startup", async () => {
    const io = new MemoryIO();
    await interruptBeforeBody(io);
    io.files.set(paths.markdown, "Written while the plugin was stopped");
    const journal = io.files.get(paths.journal);
    io.changes = [];
    await expect(store(io).recover(documentPath)).rejects.toMatchObject({ code: "conflict" });
    expect(io.files.get(paths.journal)).toBe(journal);
    expect(io.files.get(paths.markdown)).toBe("Written while the plugin was stopped");
    expect(io.changes).toEqual([]);
  });

  it("can recover an interrupted creation without inventing an empty original file", async () => {
    const io = new MemoryIO({ markdown: null, sidecar: null });
    io.failWrite = paths.sidecar;
    await expect(store(io).commit({
      documentPath, expected: { markdown: null, sidecar: null }, next: after,
    })).rejects.toThrow("interruption");
    io.failWrite = null;
    await store(io).recover(documentPath);
    expect(await store(io).read(documentPath)).toEqual(after);
  });

  it("does not replace another journal discovered during its writes", async () => {
    const io = new MemoryIO();
    io.afterWrite = (path) => {
      if (path === paths.markdown) io.files.set(paths.journal, "external journal content");
    };
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "conflict" });
    expect(io.files.get(paths.journal)).toBe("external journal content");
    expect(io.files.get(paths.sidecar)).toBe(before.sidecar);
  });
});

describe("unknown and corrupt data", () => {
  it.each([
    "not JSON",
    JSON.stringify({ schemaVersion: 2, documentId: "doc-1", revision: 1 }),
    JSON.stringify({ schemaVersion: 1, documentId: "wrong-document", revision: 1 }),
  ])("never overwrites unrecognized current metadata: %s", async (raw) => {
    const io = new MemoryIO();
    io.files.set(paths.sidecar, raw);
    await expect(store(io).read(documentPath)).rejects.toMatchObject({ code: "invalid-metadata" });
    await expect(store(io).commit({ ...request(), expected: { ...before, sidecar: raw } }))
      .rejects.toMatchObject({ code: "invalid-metadata" });
    expect(io.files.get(paths.sidecar)).toBe(raw);
    expect(io.changes).toEqual([]);
  });

  it("validates replacement metadata before writing the journal", async () => {
    const io = new MemoryIO();
    await expect(store(io).commit({ ...request(), next: { ...after, sidecar: "{}" } }))
      .rejects.toMatchObject({ code: "invalid-metadata" });
    expect(io.changes).toEqual([]);
  });

  it("preserves unknown pending files and blocks new transactions", async () => {
    const io = new MemoryIO();
    io.files.set(paths.journal, "{broken");
    await expect(store(io).commit(request())).rejects.toMatchObject({ code: "pending-transaction" });
    await expect(store(io).recover(documentPath)).rejects.toMatchObject({ code: "invalid-journal" });
    expect(io.files.get(paths.journal)).toBe("{broken");
    expect(io.changes).toEqual([]);
  });

  it("detects corruption of a journal's otherwise valid replacement text", async () => {
    const io = new MemoryIO();
    await interruptBeforeBody(io);
    const journal = JSON.parse(io.files.get(paths.journal)!);
    journal.intent.after.markdown = "A corrupted replacement";
    const corrupted = JSON.stringify(journal);
    io.files.set(paths.journal, corrupted);
    io.changes = [];
    await expect(store(io).recover(documentPath)).rejects.toMatchObject({ code: "invalid-journal" });
    expect(io.files.get(paths.journal)).toBe(corrupted);
    expect(io.files.get(paths.markdown)).toBe(before.markdown);
    expect(io.changes).toEqual([]);
  });

  it("does not follow paths supplied by a moved or malicious journal", async () => {
    const io = new MemoryIO();
    await interruptBeforeBody(io);
    const journal = JSON.parse(io.files.get(paths.journal)!);
    journal.intent.documentPath = "somewhere-else.md";
    io.files.set(paths.journal, JSON.stringify(journal));
    io.changes = [];
    await expect(store(io).recover(documentPath)).rejects.toMatchObject({ code: "invalid-journal" });
    expect(io.changes).toEqual([]);
  });

  it("derives adjacent paths without confusing dots in folder or file names", () => {
    expect(pathsFor("a.b/foo.bar.MD")).toEqual({
      markdown: "a.b/foo.bar.MD",
      sidecar: "a.b/foo.bar.explainweave.json",
      journal: "a.b/foo.bar.explainweave.pending.json",
    });
    expect(() => pathsFor("a/../foo.md")).toThrow();
    expect(() => pathsFor("a//foo.md")).toThrow();
    expect(() => pathsFor("foo.json")).toThrow();
  });
});
