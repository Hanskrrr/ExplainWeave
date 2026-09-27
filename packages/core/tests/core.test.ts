import { describe, expect, it } from "vitest";
import {
  applyOperation, CoreError, createDocument, exportCleanMarkdown, getQuestionCoverage,
  hashText, isSafeSplit, readDocument, reconcileDocument, undoOperation, writeDocument,
  type DocumentState, type Operation,
} from "../src/index";

function run(document: DocumentState, operation: Operation): DocumentState {
  return applyOperation(document, operation).document;
}

function example(): DocumentState {
  let document = createDocument("Question origin.\n\n");
  document = run(document, { type: "insert-node", index: 1, markdown: "Middle argument.\n\n" });
  document = run(document, { type: "insert-node", index: 2, markdown: "The answer is a small step." });
  document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, text: "Why does it decrease?", quote: "Question origin." });
  return run(document, { type: "link-explanation", questionId: document.questions[0]!.id, nodeId: document.nodes[2]!.id,
    quote: "a small step", coverage: "full" });
}

function errorCode(action: () => unknown, code: string): void {
  try { action(); }
  catch (error) { expect(error).toBeInstanceOf(CoreError); expect((error as CoreError).code).toBe(code); return; }
  throw new Error(`Expected ${code}`);
}

describe("source preservation and managed serialization", () => {
  const sources = [
    "", "Plain text without a final newline", "\n  spaced text  \n\n", "中文解释\r\n\r\n最后一段",
    "---\ntitle: Test\n---\n\n# Heading\n\n$$\na+b\n$$\n\n- a\n  - b\n",
    "---\r\ntitle: 中文\r\n---\r\n\r\nText\r\n",
    "```markdown\n<!-- explainweave:node literal -->\n```\n\nAfter code",
    "~~~~\n```\n<!-- explainweave:node literal -->\n```\n~~~~\n",
    "<pre>\n<!-- explainweave:node literal -->\n</pre>\n",
    "<!--\n<!-- explainweave:node literal -->\n-->\n",
    "$$\n<!-- explainweave:node literal -->\n$$\n",
    "---\ntitle: frontmatter only\n---",
  ];
  it.each(sources)("clean export preserves source %j exactly", source => {
    const document = createDocument(source);
    expect(exportCleanMarkdown(document)).toBe(source);
    const written = writeDocument(document);
    const reloaded = readDocument(written.markdown, written.metadata);
    expect(reloaded.metadataStatus).toBe("valid");
    expect(exportCleanMarkdown(reloaded.document)).toBe(source);
    expect(reloaded.document).toEqual(document);
  });

  it("does not duplicate current body content into the sidecar", () => {
    const written = writeDocument(createDocument("PRIVATE_BODY_SENTINEL"));
    expect(written.metadata).not.toContain("PRIVATE_BODY_SENTINEL");
    const metadata = JSON.parse(written.metadata);
    expect(metadata.nodes[0]).toEqual(expect.objectContaining({ contentHash: hashText("PRIVATE_BODY_SENTINEL") }));
    expect(metadata.nodes[0]).not.toHaveProperty("markdown");
  });

  it("rejects corrupt sidecars and unsupported schemas instead of resetting them", () => {
    const saved = writeDocument(createDocument("Text"));
    errorCode(() => readDocument(saved.markdown, "{no"), "INVALID_METADATA");
    errorCode(() => readDocument(saved.markdown, JSON.stringify({ ...JSON.parse(saved.metadata), schemaVersion: 99 })), "UNSUPPORTED_SCHEMA");
    const tampered = JSON.parse(saved.metadata);
    tampered.nodes[0].contentHash = "0".repeat(64);
    errorCode(() => readDocument(saved.markdown, JSON.stringify(tampered)), "METADATA_INCONSISTENT");
  });

  it("refuses duplicate or malformed managed markers", () => {
    errorCode(() => createDocument("<!-- explainweave:node same -->\nA\n<!-- explainweave:node same -->\nB"), "DUPLICATE_MARKER");
    errorCode(() => createDocument("<!-- explainweave:node invalid id -->\nA"), "INVALID_MARKER");
  });

  it("preserves unresolved frontmatter without allowing automatic writes", () => {
    const source = "---\ntitle: incomplete";
    const document = createDocument(source);
    expect(exportCleanMarkdown(document)).toBe(source);
    expect(document.readOnlyReason).toBeTruthy();
    errorCode(() => writeDocument(document), "READ_ONLY");
  });
});

describe("immutable editing operations", () => {
  it("inserts nodes at the requested position and preserves the original state", () => {
    const original = createDocument("First");
    const changed = run(original, { type: "insert-node", index: 1, markdown: "Last" });
    expect(exportCleanMarkdown(original)).toBe("First");
    expect(exportCleanMarkdown(changed)).toBe("First\n\nLast");
    expect(changed.nodes[0]!.id).toBe(original.nodes[0]!.id);
    expect(Object.isFrozen(changed.nodes[0])).toBe(true);
    expect(readDocument(writeDocument(changed).markdown, writeDocument(changed).metadata).document).toEqual(changed);
  });

  it("can add the first node to an empty or frontmatter-only file", () => {
    expect(exportCleanMarkdown(run(createDocument(""), { type: "insert-node", index: 0, markdown: "First" }))).toBe("First");
    expect(exportCleanMarkdown(run(createDocument("---\na: b\n---"), { type: "insert-node", index: 0, markdown: "Body" })))
      .toBe("---\na: b\n---\nBody");
  });

  it("splits and merges without changing source bytes", () => {
    const source = "First paragraph.\n\nSecond paragraph.";
    const original = createDocument(source);
    const split = run(original, { type: "split-node", nodeId: original.nodes[0]!.id, offset: source.indexOf("Second") });
    expect(split.nodes).toHaveLength(2);
    expect(exportCleanMarkdown(split)).toBe(source);
    const merged = run(split, { type: "merge-nodes", nodeIds: [split.nodes[0]!.id, split.nodes[1]!.id] });
    expect(exportCleanMarkdown(merged)).toBe(source);
    expect(merged.nodes[0]!.id).toBe(original.nodes[0]!.id);
  });

  it("moves an anchored question with the selected portion when splitting", () => {
    let document = createDocument("First.\n\nSecond.\n\n");
    document = run(document, { type: "insert-node", index: 1, markdown: "An answer." });
    document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, text: "Why second?", quote: "Second." });
    document = run(document, { type: "link-explanation", questionId: document.questions[0]!.id,
      nodeId: document.nodes[1]!.id, quote: "An answer.", coverage: "full" });
    expect(getQuestionCoverage(document, document.questions[0]!.id).status).toBe("explained");
    document = run(document, { type: "split-node", nodeId: document.nodes[0]!.id, offset: 8 });
    expect(document.questions[0]!.nodeId).toBe(document.nodes[1]!.id);
    expect(getQuestionCoverage(document, document.questions[0]!.id).status).toBe("needs-review");
  });

  it.each(["First.\n\nSecond. Second.", "Second.\n\nSecond."])("retains and reports a question whose quote is ambiguous after splitting", source => {
    let document = createDocument(source);
    document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, text: "Which second?", quote: "Second." });
    const originalNodeId = document.nodes[0]!.id;
    const result = applyOperation(document, { type: "split-node", nodeId: originalNodeId, offset: source.indexOf("\n\n") + 2 });
    expect(result.document.questions[0]!.nodeId).toBe(originalNodeId);
    expect(result).toHaveProperty("issues", expect.arrayContaining([expect.stringContaining("重新定位")]));
  });

  it.each([
    ["```\na\n\nb\n```\n", 7], ["$$\na\n\nb\n$$\n", 6],
    ["<pre>\na\n\nb\n</pre>\n", 9], ["First\r\nSecond", 7],
    ["- item\n\n  continuation", 8], ["> quote\n\n> next", 9],
  ] as const)("refuses a split inside or through ambiguous Markdown structure", (source, offset) => {
    expect(isSafeSplit(source, offset)).toBe(false);
    const document = createDocument(source);
    errorCode(() => run(document, { type: "split-node", nodeId: document.nodes[0]!.id, offset }), "UNSAFE_SPLIT");
  });

  it("prevents an unclosed block from swallowing a newly inserted node marker", () => {
    for (const source of ["```\nunclosed", "$$\nunclosed", "<pre>\nunclosed"]) {
      const document = createDocument(source);
      errorCode(() => run(document, { type: "insert-node", index: 1, markdown: "Next" }), "UNSAFE_STRUCTURE");
      expect(exportCleanMarkdown(document)).toBe(source);
    }
  });

  it("does not split inside an outer HTML block after an inner block closes", () => {
    const source = "<div>\n<div>\ninner\n</div>\n\nstill inside\n</div>\n";
    expect(isSafeSplit(source, source.indexOf("still inside"))).toBe(false);
    expect(exportCleanMarkdown(readDocument(writeDocument(createDocument(source)).markdown).document)).toBe(source);
  });

  it("refuses reserved markers injected into editable content", () => {
    const document = createDocument("Text");
    errorCode(() => run(document, { type: "edit-node", nodeId: document.nodes[0]!.id, markdown: "<!-- explainweave:node another -->\nInjected" }), "RESERVED_MARKER");
  });

  it("does not normalize untouched nodes during a local edit", () => {
    const source = "<!-- explainweave:node a -->\nA\n<!-- explainweave:node b -->\nB\n<!-- explainweave:node c -->\nC\n";
    const original = createDocument(source);
    const edited = run(original, { type: "edit-node", nodeId: "b", markdown: "B revised\n" });
    expect(edited.nodes[0]).toEqual(original.nodes[0]);
    expect(edited.nodes[2]).toEqual(original.nodes[2]);
    expect(exportCleanMarkdown(edited)).toBe("A\nB revised\nC\n");
  });

  it("can remove all body nodes without dropping their questions", () => {
    let document = createDocument("Text");
    document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, text: "Why?" });
    document = run(document, { type: "delete-node", nodeId: document.nodes[0]!.id });
    expect(document.nodes).toHaveLength(0);
    expect(document.questions).toHaveLength(1);
    expect(getQuestionCoverage(document, document.questions[0]!.id).status).toBe("needs-review");
    expect(exportCleanMarkdown(readDocument(writeDocument(document).markdown, writeDocument(document).metadata).document)).toBe("");
  });
});

describe("explanation coverage is based on reached evidence", () => {
  it("keeps a later answer out of the current prefix", () => {
    const document = example();
    const atStart = getQuestionCoverage(document, document.questions[0]!.id, document.nodes[0]!.id);
    expect(atStart.status).toBe("unexplained");
    expect(atStart.futureLinks).toHaveLength(1);
    expect(getQuestionCoverage(document, document.questions[0]!.id, document.nodes[2]!.id).status).toBe("explained");
  });

  it("recomputes route coverage on move without invalidating unchanged explanation text", () => {
    const document = example();
    const moved = run(document, { type: "move-node", nodeId: document.nodes[2]!.id, toIndex: 0 });
    const coverage = getQuestionCoverage(moved, moved.questions[0]!.id, document.nodes[0]!.id);
    expect(coverage.status).toBe("explained");
    expect(coverage.invalidLinks).toHaveLength(0);
  });

  it("invalidates evidence when the question, answer or explicitly bound premise changes", () => {
    const document = example();
    const questionChanged = run(document, { type: "edit-question", questionId: document.questions[0]!.id, text: "Why must it converge?" });
    expect(getQuestionCoverage(questionChanged, document.questions[0]!.id).status).toBe("needs-review");
    const answerChanged = run(document, { type: "edit-node", nodeId: document.nodes[2]!.id, markdown: "The answer no longer says that." });
    expect(getQuestionCoverage(answerChanged, document.questions[0]!.id).status).toBe("needs-review");
    const premiseChanged = run(document, { type: "edit-node", nodeId: document.nodes[0]!.id, markdown: "A different premise." });
    expect(getQuestionCoverage(premiseChanged, document.questions[0]!.id).status).toBe("needs-review");
    const unrelated = run(document, { type: "edit-node", nodeId: document.nodes[1]!.id, markdown: "An unrelated illustration." });
    expect(getQuestionCoverage(unrelated, document.questions[0]!.id).status).toBe("explained");
  });

  it("distinguishes partial from full coverage and rejects invented or ambiguous evidence", () => {
    let document = createDocument("Answer, answer.");
    document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, text: "Why?" });
    const op = { type: "link-explanation" as const, questionId: document.questions[0]!.id, nodeId: document.nodes[0]!.id, coverage: "partial" as const };
    errorCode(() => run(document, { ...op, quote: "not present" }), "INVALID_EVIDENCE");
    const repeated = run(document, { type: "edit-node", nodeId: document.nodes[0]!.id, markdown: "answer answer" });
    errorCode(() => run(repeated, { ...op, quote: "answer" }), "AMBIGUOUS_EVIDENCE");
    const linked = run(repeated, { ...op, quote: "answer", start: 7 });
    expect(getQuestionCoverage(linked, linked.questions[0]!.id).status).toBe("partial");
  });

  it("preserves follow-up questions when their parent is deleted", () => {
    let document = example();
    const parentId = document.questions[0]!.id;
    document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, parentQuestionId: parentId, text: "What does local mean?" });
    const childId = document.questions[1]!.id;
    document = run(document, { type: "delete-question", questionId: parentId });
    expect(document.questions[0]!.id).toBe(childId);
    expect(document.questions[0]!.parentQuestionId).toBeUndefined();
    expect(document.links).toHaveLength(0);
  });

  it("requires explicit prerequisites to precede the answer on the current route", () => {
    let document = example();
    document = run(document, { type: "remove-link", linkId: document.links[0]!.id });
    document = run(document, { type: "link-explanation", questionId: document.questions[0]!.id, nodeId: document.nodes[2]!.id,
      quote: "a small step", coverage: "full", dependencyNodeIds: [document.nodes[1]!.id] });
    expect(getQuestionCoverage(document, document.questions[0]!.id).status).toBe("explained");
    const beforeDependency = getQuestionCoverage(document, document.questions[0]!.id, document.nodes[0]!.id);
    expect(beforeDependency.status).toBe("unexplained");
    const moved = run(document, { type: "move-node", nodeId: document.nodes[1]!.id, toIndex: 2 });
    expect(getQuestionCoverage(moved, document.questions[0]!.id).status).toBe("needs-review");
  });

  it("invalidates a follow-up answer when an ancestor question changes", () => {
    let document = example();
    const parentId = document.questions[0]!.id;
    document = run(document, { type: "add-question", nodeId: document.nodes[0]!.id, parentQuestionId: parentId, text: "What does small mean?" });
    const childId = document.questions[1]!.id;
    document = run(document, { type: "link-explanation", questionId: childId, nodeId: document.nodes[2]!.id, quote: "a small step", coverage: "full" });
    expect(getQuestionCoverage(document, childId).status).toBe("explained");
    const changed = run(document, { type: "edit-question", questionId: parentId, text: "Can it converge globally?" });
    expect(getQuestionCoverage(changed, childId).status).toBe("needs-review");
    const saved = writeDocument(changed);
    expect(getQuestionCoverage(readDocument(saved.markdown, saved.metadata).document, childId).status).toBe("needs-review");
  });
});

describe("undo, persistence and external edits", () => {
  it("undo survives reading navigation and supports multiple undo steps", () => {
    const original = example();
    const first = applyOperation(original, { type: "edit-question", questionId: original.questions[0]!.id, text: "Changed question?" });
    const second = applyOperation(first.document, { type: "insert-node", index: 3, markdown: "Extra" });
    const navigated = run(second.document, { type: "set-reading", reading: { nodeId: original.nodes[1]!.id, returnNodeId: original.nodes[0]!.id, activeQuestionId: original.questions[0]!.id } });
    const undoSecond = undoOperation(navigated, second.undo);
    const undoFirst = undoOperation(undoSecond, first.undo);
    expect(exportCleanMarkdown(undoFirst)).toBe(exportCleanMarkdown(original));
    expect(undoFirst.questions).toEqual(original.questions);
    expect(undoFirst.reading?.nodeId).toBe(original.nodes[1]!.id);
    expect(undoFirst.revision).toBeGreaterThan(navigated.revision);
  });

  it("refuses undo after newer content edits and refuses outdated operations", () => {
    const original = example();
    const first = applyOperation(original, { type: "edit-question", questionId: original.questions[0]!.id, text: "Changed?" });
    const newer = run(first.document, { type: "edit-node", nodeId: original.nodes[1]!.id, markdown: "Handwritten later." });
    errorCode(() => undoOperation(newer, first.undo), "UNDO_CONFLICT");
    errorCode(() => run(newer, { type: "delete-node", nodeId: newer.nodes[0]!.id, expectedDocumentRevision: original.revision }), "VERSION_CONFLICT");
  });

  it("persists reading position without changing question or node revisions", () => {
    const original = example();
    const navigated = run(original, { type: "set-reading", reading: { nodeId: original.nodes[1]!.id, activeQuestionId: original.questions[0]!.id, returnNodeId: original.nodes[0]!.id } });
    expect(navigated.nodes).toEqual(original.nodes);
    expect(navigated.questions).toEqual(original.questions);
    const written = writeDocument(navigated);
    expect(readDocument(written.markdown, written.metadata).document.reading).toEqual(navigated.reading);
  });

  it("reconciles external content changes using markers, retaining IDs and invalidating stale evidence", () => {
    const original = example();
    const written = writeDocument(original);
    const changed = reconcileDocument(original, written.markdown.replace("a small step", "a different step"));
    expect(changed.document.nodes.map(node => node.id)).toEqual(original.nodes.map(node => node.id));
    expect(changed.document.nodes[2]!.revision).toBe(original.nodes[2]!.revision + 1);
    expect(changed.document.questions).toEqual(original.questions);
    expect(getQuestionCoverage(changed.document, original.questions[0]!.id).status).toBe("needs-review");
    expect(exportCleanMarkdown(original)).toContain("a small step");
  });

  it("derives route order from the actual Markdown rather than sidecar array order", () => {
    const original = example();
    const written = writeDocument(original);
    const metadata = JSON.parse(written.metadata);
    metadata.nodes.reverse();
    const read = readDocument(written.markdown, JSON.stringify(metadata));
    expect(read.document.nodes.map(node => node.id)).toEqual(original.nodes.map(node => node.id));
  });

  it("preserves externally edited source and blocks writes when all managed markers disappear", () => {
    const original = example();
    const external = "A completely reorganized external article.";
    const result = reconcileDocument(original, external);
    expect(exportCleanMarkdown(result.document)).toBe(external);
    expect(result.document.readOnlyReason).toBeTruthy();
    expect(result.document.questions).toEqual(original.questions);
    errorCode(() => writeDocument(result.document), "READ_ONLY");
  });
});
