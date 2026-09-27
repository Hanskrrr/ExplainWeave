import { describe, expect, it } from "vitest";
import { applyOperation, createDocument, exportCleanMarkdown, readDocument, writeDocument, type DocumentState } from "@explainweave/core";
import {
  assertTaskCurrent, buildCoworkURL, documentContentFingerprint, HandoffError,
  MAX_COWORK_PROMPT_CHARS, MAX_RETURN_BYTES, parseReturnDraft, parseTaskPack, prepareTaskPack,
  RETURN_SCHEMA, serializeTaskPack, type CoworkTaskPack,
} from "../src/index";

function setup(): { document: DocumentState; task: CoworkTaskPack } {
  let document = createDocument("Target paragraph.");
  document = applyOperation(document, { type: "insert-node", index: 1, markdown: "Unselected private material." }).document;
  document = applyOperation(document, { type: "add-question", nodeId: document.nodes[0]!.id, text: "Why?" }).document;
  const task = prepareTaskPack(document, { taskId: "task_1", nodeId: document.nodes[0]!.id,
    questionId: document.questions[0]!.id, instruction: "Explain the missing intermediate step." });
  return { document, task };
}
function resultFor(task: CoworkTaskPack, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, type: RETURN_SCHEMA, taskId: task.id, documentId: task.documentId,
    baseFingerprint: task.baseFingerprint, nodeId: task.nodeId, ...(task.questionId ? { questionId: task.questionId } : {}),
    markdown: "Here is a candidate explanation.", ...overrides });
}
function rejects(action: () => unknown, code: string): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(HandoffError); expect((error as HandoffError).code).toBe(code); return;
  }
  throw new Error(`Expected ${code}`);
}

describe("pure task preparation", () => {
  it("includes the selected source, a stable baseline and a restrictive return schema", () => {
    const { document, task } = setup();
    expect(task.baseFingerprint).toBe(documentContentFingerprint(document));
    expect(task.sourceContext.nodes).toHaveLength(1);
    expect(task.sourceContext.question?.text).toBe("Why?");
    expect(serializeTaskPack(task)).not.toContain("Unselected private material.");
    expect(task.returnSchema.additionalProperties).toBe(false);
    expect(task.returnSchema.required).toContain("questionId");
    expect(Object.isFrozen(task.sourceContext.nodes)).toBe(true);
  });

  it("does not change the source and includes parent-question context for a follow-up", () => {
    let { document } = setup();
    const original = exportCleanMarkdown(document);
    document = applyOperation(document, { type: "add-question", nodeId: document.nodes[0]!.id,
      parentQuestionId: document.questions[0]!.id, text: "What does that mean?" }).document;
    const task = prepareTaskPack(document, { nodeId: document.nodes[0]!.id, questionId: document.questions[1]!.id, instruction: "Explain." });
    expect(task.sourceContext.ancestorQuestions[0]!.text).toBe("Why?");
    expect(exportCleanMarkdown(document)).toBe(original);
  });

  it("rejects missing targets and stale selected questions", () => {
    const { document } = setup();
    rejects(() => prepareTaskPack(document, { nodeId: "absent", instruction: "Explain" }), "NODE_NOT_FOUND");
    rejects(() => prepareTaskPack(document, { nodeId: document.nodes[0]!.id, questionId: "absent", instruction: "Explain" }), "QUESTION_NOT_FOUND");
    rejects(() => prepareTaskPack(document, { nodeId: document.nodes[0]!.id, contextNodeIds: ["absent"], instruction: "Explain" }), "NODE_NOT_FOUND");
  });

  it("has the same baseline after serialization or navigation", () => {
    const { document, task } = setup();
    const navigated = applyOperation(document, { type: "set-reading", reading: { nodeId: document.nodes[1]!.id } }).document;
    expect(documentContentFingerprint(navigated)).toBe(task.baseFingerprint);
    const saved = writeDocument(navigated);
    expect(documentContentFingerprint(readDocument(saved.markdown, saved.metadata).document)).toBe(task.baseFingerprint);
  });

  it("strictly parses an archived task pack without casting unknown JSON", () => {
    const { task } = setup();
    const parsed = parseTaskPack(serializeTaskPack(task));
    expect(parsed).toEqual(task); expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseReturnDraft(resultFor(task), parsed).kind).toBe("candidate");
  });

  it.each([
    { schemaVersion: 2 }, { type: "unknown" },
  ])("rejects unknown persisted task schemas", patch => {
    const { task } = setup();
    rejects(() => parseTaskPack(JSON.stringify({ ...task, ...patch })), "UNKNOWN_TASK_SCHEMA");
  });

  it("rejects task paths, missing source, and permissive return-schema changes", () => {
    const { task } = setup();
    rejects(() => parseTaskPack(JSON.stringify({ ...task, outputPath: "/arbitrary" })), "INVALID_TASK");
    rejects(() => parseTaskPack(JSON.stringify({ ...task, sourceContext: { ...task.sourceContext, nodes: [] } })), "INVALID_TASK");
    rejects(() => parseTaskPack(JSON.stringify({ ...task, returnSchema: { type: "object" } })), "INVALID_TASK");
  });

  it("detects an archived source falsely claiming the current baseline", () => {
    const { document, task } = setup();
    const altered = parseTaskPack(JSON.stringify({ ...task, sourceContext: { ...task.sourceContext,
      nodes: task.sourceContext.nodes.map(node => ({ ...node, markdown: "Tampered source" })) } }));
    rejects(() => assertTaskCurrent(altered, document), "INVALID_TASK");
  });

  it("detects altered question text under an unchanged baseline", () => {
    const { document, task } = setup();
    const altered = parseTaskPack(JSON.stringify({ ...task, sourceContext: { ...task.sourceContext,
      question: { ...task.sourceContext.question, text: "An unrelated question" } } }));
    rejects(() => assertTaskCurrent(altered, document), "INVALID_TASK");
  });
});

describe("Cowork URL encoding", () => {
  it("encodes query and path values without allowing extra parameters or fragments", () => {
    const options = { q: "解释中文 &file=/evil?q=1#fragment + %", folder: "/tmp/任务 &folder=other", file: "/tmp/a?file=/evil#x.json" };
    const url = new URL(buildCoworkURL(options));
    expect(url.protocol).toBe("claude:"); expect(url.hostname).toBe("cowork"); expect(url.pathname).toBe("/new");
    expect(url.searchParams.get("q")).toBe(options.q);
    expect(url.searchParams.get("folder")).toBe(options.folder);
    expect(url.searchParams.getAll("file")).toEqual([options.file]);
    expect(url.hash).toBe(""); expect([...url.searchParams.keys()]).toEqual(["q", "folder", "file"]);
  });

  it("accepts Windows absolute file names without treating backslashes as URLs", () => {
    const file = "C:\\Task Folder\\中文.json";
    expect(new URL(buildCoworkURL({ q: "Read the task pack.", file })).searchParams.get("file")).toBe(file);
  });

  it.each(["relative.json", "https://example.com/task.json", "file:///tmp/task.json", "/tmp/a\nfile=/evil", "/tmp/a\0.json"])("rejects unsafe attachment locations: %j", file => {
    rejects(() => buildCoworkURL({ q: "Read attached task", file }), "INVALID_PATH");
  });

  it("rejects long prompts and long encoded URLs instead of truncating content", () => {
    rejects(() => buildCoworkURL({ q: "a".repeat(MAX_COWORK_PROMPT_CHARS + 1), file: "/tmp/task.json" }), "PROMPT_TOO_LONG");
    rejects(() => buildCoworkURL({ q: "中".repeat(MAX_COWORK_PROMPT_CHARS), file: "/tmp/task.json" }), "URL_TOO_LONG");
  });
});

describe("untrusted return validation", () => {
  it("returns a candidate without modifying the document", () => {
    const { document, task } = setup();
    const original = exportCleanMarkdown(document);
    const candidate = parseReturnDraft(resultFor(task), task, document);
    expect(candidate.kind).toBe("candidate"); expect(candidate.backendId).toBe("claude-cowork");
    expect(candidate.markdown).toBe("Here is a candidate explanation.");
    expect(exportCleanMarkdown(document)).toBe(original);
  });

  it.each(["taskId", "documentId", "nodeId", "questionId"])("rejects a return impersonating a different %s", field => {
    const { task } = setup();
    rejects(() => parseReturnDraft(resultFor(task, { [field]: "other" }), task), "TASK_MISMATCH");
  });

  it("rejects old baselines and checks fresh document state when provided", () => {
    const { document, task } = setup();
    rejects(() => parseReturnDraft(resultFor(task, { baseFingerprint: "0".repeat(64) }), task), "STALE_RESULT");
    const changed = applyOperation(document, { type: "edit-node", nodeId: task.nodeId, markdown: "A changed premise." }).document;
    rejects(() => parseReturnDraft(resultFor(task), task, changed), "STALE_RESULT");
    rejects(() => assertTaskCurrent(task, changed), "STALE_RESULT");
  });

  it.each([{ schemaVersion: 2 }, { type: "other.schema" }])("rejects unknown return schemas", overrides => {
    const { task } = setup();
    rejects(() => parseReturnDraft(resultFor(task, overrides), task), "UNKNOWN_RETURN_SCHEMA");
  });

  it.each(["path", "file", "outputPath", "files", "edits", "__proto__"])("rejects arbitrary return fields including %s", field => {
    const { task } = setup();
    rejects(() => parseReturnDraft(resultFor(task, { [field]: "/Users/someone/article.md" }), task), "UNEXPECTED_FIELD");
  });

  it.each(["", "   ", null, {}, ["text"], "text\0text"])("rejects invalid markdown: %j", markdown => {
    const { task } = setup();
    rejects(() => parseReturnDraft(resultFor(task, { markdown }), task), "INVALID_MARKDOWN");
  });

  it("rejects fenced JSON and oversized files; accepts a UTF-8 BOM", () => {
    const { task } = setup();
    rejects(() => parseReturnDraft("```json\n" + resultFor(task) + "\n```", task), "INVALID_JSON");
    rejects(() => parseReturnDraft(" ".repeat(MAX_RETURN_BYTES + 1), task), "RETURN_TOO_LARGE");
    expect(parseReturnDraft("\uFEFF" + resultFor(task), task).kind).toBe("candidate");
  });

  it("does not turn paths mentioned in prose into filesystem operations", () => {
    const { task } = setup();
    const markdown = "The path `/tmp/example` is only explanatory text.";
    const candidate = parseReturnDraft(resultFor(task, { markdown }), task);
    expect(candidate.markdown).toBe(markdown); expect(candidate).not.toHaveProperty("path");
  });
});
