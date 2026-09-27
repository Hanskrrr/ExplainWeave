export * from "./types";
export { hashText } from "./utils";
export { isSafeSplit } from "./markdown";

import { parseMetadata, validateReading } from "./metadata";
import { assertNoMarkers, hasBlankLineEnd, isSafeSplit, lineEnding, parseMarkdown } from "./markdown";
import { assert, deepFreeze, fingerprint, hashText, newId } from "./utils";
import {
  CoreError, type CoreOptions, type DocumentMetadata, type DocumentState, type ExplanationLink,
  type Node, type Operation, type OperationResult, type Question, type QuestionCoverage,
  type ReadingState, type ReadResult, type UndoToken,
} from "./types";

export function createDocument(markdown: string, options?: CoreOptions): DocumentState {
  return readDocument(markdown, undefined, options).document;
}

export function readDocument(markdown: string, metadataJson?: string | DocumentMetadata, options?: CoreOptions): ReadResult {
  assert(typeof markdown === "string", "INVALID_MARKDOWN", "Markdown must be a string.");
  const parsed = parseMarkdown(markdown);
  const metadata = metadataJson === undefined ? undefined : parseMetadata(metadataJson);
  const issues: string[] = [];
  let readOnlyReason = parsed.readOnlyReason;
  if (metadata && metadata.nodes.length > 1 && parsed.markerCount === 0 && parsed.chunks.length > 0) {
    readOnlyReason = "All managed node markers are missing. The current Markdown is preserved; restore markers or explicitly re-import before changing nodes.";
  }
  const savedNodes = new Map(metadata?.nodes.map(node => [node.id, node]) ?? []);
  const nodes: Node[] = parsed.chunks.map(chunk => {
    // A single unmarked body is unambiguous. Never infer boundaries from similar paragraphs.
    const saved = chunk.id ? savedNodes.get(chunk.id)
      : parsed.chunks.length === 1 && metadata?.nodes.length === 1 ? metadata.nodes[0] : undefined;
    return {
      id: chunk.id ?? saved?.id ?? newId("node", options),
      revision: saved ? saved.revision + (saved.contentHash === hashText(chunk.markdown) ? 0 : 1) : 1,
      markdown: chunk.markdown,
    };
  });
  assert(new Set(nodes.map(node => node.id)).size === nodes.length, "DUPLICATE_ID", "Generated node identifiers are not unique.");
  const sameSource = metadata?.markdownHash === hashText(markdown);
  if (metadata && sameSource) {
    assert(metadata.prefixHash === hashText(parsed.prefix)
      && metadata.nodes.length === nodes.length
      && nodes.every(node => savedNodes.get(node.id)?.contentHash === hashText(node.markdown)),
    "METADATA_INCONSISTENT", "The sidecar checksum matches the source but its node checksums do not; preserve both files for recovery.");
  }
  if (metadata && !sameSource) issues.push("Markdown changed since the sidecar was saved; node versions were reconciled from the actual source.");
  if (metadata && metadata.nodes.some(node => !nodes.some(current => current.id === node.id))) {
    issues.push("Some nodes are missing from the current source; their questions and explanation evidence were retained for recovery.");
  }
  if (readOnlyReason) issues.push(readOnlyReason);
  const document: DocumentState = {
    schemaVersion: 1, id: metadata?.documentId ?? newId("doc", options),
    revision: metadata ? metadata.revision + (sameSource ? 0 : 1) : 1,
    prefix: parsed.prefix, nodes, questions: metadata?.questions ?? [], links: metadata?.links ?? [],
    ...(metadata?.reading ? { reading: metadata.reading } : {}),
    ...(readOnlyReason ? { readOnlyReason } : {}),
  };
  return deepFreeze({ document, issues, metadataStatus: metadata ? sameSource ? "valid" : "stale" : "none" });
}

export function exportCleanMarkdown(document: DocumentState): string {
  return document.prefix + document.nodes.map(node => node.markdown).join("");
}

function serializeManagedMarkdown(document: DocumentState): string {
  assert(!document.readOnlyReason, "READ_ONLY", document.readOnlyReason ?? "Document is read-only.");
  const eol = lineEnding(exportCleanMarkdown(document));
  assert(!document.nodes.length || !document.prefix || /[\r\n]$/.test(document.prefix), "UNSAFE_BOUNDARY", "The protected frontmatter needs a line boundary before adding nodes.");
  const markdown = document.prefix + document.nodes.map((node, index) => {
    assertNoMarkers(node.markdown);
    assert(index === document.nodes.length - 1 || /[\r\n]$/.test(node.markdown), "UNSAFE_BOUNDARY", "Adjacent nodes need a line boundary; no silent source rewrite is allowed.");
    return `<!-- explainweave:node ${node.id} -->${eol}${node.markdown}`;
  }).join("");
  const parsed = parseMarkdown(markdown);
  assert(parsed.prefix === document.prefix && parsed.chunks.length === document.nodes.length
    && parsed.chunks.every((chunk, index) => chunk.id === document.nodes[index]?.id && chunk.markdown === document.nodes[index]?.markdown),
  "UNSAFE_STRUCTURE", "A node boundary falls inside an unfinished Markdown block. Close the block or choose another boundary before changing nodes.");
  return markdown;
}

function metadataFor(document: DocumentState, markdown: string): DocumentMetadata {
  return {
    schemaVersion: 1, documentId: document.id, revision: document.revision,
    markdownHash: hashText(markdown), prefixHash: hashText(document.prefix),
    nodes: document.nodes.map(node => ({ id: node.id, revision: node.revision, contentHash: hashText(node.markdown) })),
    questions: document.questions, links: document.links,
    ...(document.reading ? { reading: document.reading } : {}),
  };
}

export function writeDocument(document: DocumentState): { markdown: string; metadata: string } {
  const markdown = serializeManagedMarkdown(document);
  return { markdown, metadata: JSON.stringify(metadataFor(document, markdown), null, 2) + "\n" };
}

export function reconcileDocument(document: DocumentState, newMarkdown: string): { document: DocumentState; issues: readonly string[] } {
  // This operation never writes a file. Failures leave the original state and external source intact.
  const currentMarkdown = serializeManagedMarkdown(document);
  const result = readDocument(newMarkdown, metadataFor(document, currentMarkdown));
  return deepFreeze({ document: result.document, issues: result.issues });
}

function requireNode(document: Pick<DocumentState, "nodes">, id: string): Node {
  const node = document.nodes.find(node => node.id === id);
  assert(node, "NODE_NOT_FOUND", "The target node no longer exists.");
  return node;
}

function requireQuestion(document: Pick<DocumentState, "questions">, id: string): Question {
  const question = document.questions.find(question => question.id === id);
  assert(question, "QUESTION_NOT_FOUND", "The target question no longer exists.");
  return question;
}

function validateText(text: string, what: string): void {
  assert(typeof text === "string" && text.trim().length > 0, "EMPTY_TEXT", `${what} cannot be empty.`);
}

function contentFingerprint(document: DocumentState): string {
  const { revision: _revision, reading: _reading, ...content } = document;
  return fingerprint(content);
}

function normalizeBoundaries(nodes: Node[], eol: string, touched: ReadonlySet<string>, paragraphBoundaries: ReadonlySet<string>): Node[] {
  return nodes.map((node, index) => {
    if (!touched.has(node.id) || index === nodes.length - 1 || hasBlankLineEnd(node.markdown)) return node;
    if (/[\r\n]$/.test(node.markdown) && !paragraphBoundaries.has(node.id)) return node;
    const separator = /[\r\n]$/.test(node.markdown) ? eol : eol + eol;
    return { ...node, revision: node.revision + 1, markdown: node.markdown + separator };
  });
}

function repairReading(reading: ReadingState | undefined, nodes: readonly Node[], questions: readonly Question[]): ReadingState | undefined {
  if (!reading) return undefined;
  const nodeId = reading.nodeId && nodes.some(node => node.id === reading.nodeId) ? reading.nodeId : nodes[0]?.id;
  return {
    ...(nodeId ? { nodeId } : {}),
    ...(reading.returnNodeId && nodes.some(node => node.id === reading.returnNodeId) ? { returnNodeId: reading.returnNodeId } : {}),
    ...(reading.activeQuestionId && questions.some(question => question.id === reading.activeQuestionId) ? { activeQuestionId: reading.activeQuestionId } : {}),
  };
}

export function applyOperation(document: DocumentState, operation: Operation, options?: CoreOptions): OperationResult {
  assert(!document.readOnlyReason, "READ_ONLY", document.readOnlyReason ?? "Document is read-only.");
  assert(operation.expectedDocumentRevision === undefined || operation.expectedDocumentRevision === document.revision,
    "VERSION_CONFLICT", "The document changed before this operation could be applied.");
  let nodes = [...document.nodes];
  let questions = [...document.questions];
  let links = [...document.links];
  let reading = document.reading;
  let prefix = document.prefix;
  const eol = lineEnding(exportCleanMarkdown(document));
  const normalizeIds = new Set<string>();
  const paragraphBoundaries = new Set<string>();
  const issues: string[] = [];
  switch (operation.type) {
    case "insert-node": {
      assert(Number.isInteger(operation.index) && operation.index >= 0 && operation.index <= nodes.length, "INVALID_INDEX", "The insertion position is invalid.");
      assert(typeof operation.markdown === "string", "INVALID_MARKDOWN", "Node Markdown must be a string.");
      assertNoMarkers(operation.markdown);
      const id = newId("node", options);
      assert(!nodes.some(node => node.id === id), "DUPLICATE_ID", "Generated node identifier already exists.");
      nodes.splice(operation.index, 0, { id, revision: 1, markdown: operation.markdown });
      if (prefix && !/[\r\n]$/.test(prefix)) prefix += eol;
      for (const neighbor of [nodes[operation.index - 1], nodes[operation.index]]) {
        if (neighbor) { normalizeIds.add(neighbor.id); paragraphBoundaries.add(neighbor.id); }
      }
      break;
    }
    case "edit-node": {
      const previous = requireNode(document, operation.nodeId);
      assert(typeof operation.markdown === "string", "INVALID_MARKDOWN", "Node Markdown must be a string.");
      assertNoMarkers(operation.markdown);
      nodes = nodes.map(node => node.id === previous.id && node.markdown !== operation.markdown
        ? { ...node, revision: node.revision + 1, markdown: operation.markdown } : node);
      normalizeIds.add(previous.id);
      break;
    }
    case "move-node": {
      const node = requireNode(document, operation.nodeId);
      assert(Number.isInteger(operation.toIndex) && operation.toIndex >= 0 && operation.toIndex < nodes.length, "INVALID_INDEX", "The final node position is invalid.");
      nodes = nodes.filter(item => item.id !== node.id);
      nodes.splice(operation.toIndex, 0, node);
      normalizeIds.add(node.id);
      if (nodes[operation.toIndex - 1]) normalizeIds.add(nodes[operation.toIndex - 1]!.id);
      break;
    }
    case "delete-node":
      requireNode(document, operation.nodeId);
      nodes = nodes.filter(node => node.id !== operation.nodeId);
      // Keep questions/evidence as orphaned records, allowing recovery through undo.
      break;
    case "split-node": {
      const node = requireNode(document, operation.nodeId);
      assert(isSafeSplit(node.markdown, operation.offset), "UNSAFE_SPLIT", "Split at an explicit blank-line boundary outside fenced code.");
      const rightId = newId("node", options);
      assert(!nodes.some(item => item.id === rightId), "DUPLICATE_ID", "Generated node identifier already exists.");
      const index = nodes.findIndex(item => item.id === node.id);
      nodes.splice(index, 1, { ...node, revision: node.revision + 1, markdown: node.markdown.slice(0, operation.offset) },
        { id: rightId, revision: 1, markdown: node.markdown.slice(operation.offset) });
      questions = questions.map(question => {
        if (question.nodeId !== node.id) return question;
        const quote = question.quote;
        const first = quote ? node.markdown.indexOf(quote) : -1;
        const unique = Boolean(quote) && first >= 0 && node.markdown.indexOf(quote!, first + 1) === -1;
        if (unique && first >= operation.offset) {
          // The attachment has changed even if both node versions happen to be 1.
          // Do not let an old answer appear verified against the new source node.
          return { ...question, nodeId: rightId, revision: question.revision + 1 };
        }
        if (unique && first + quote!.length <= operation.offset) return question;
        issues.push(`疑问「${question.text.slice(0, 60)}」的引用在拆分后不能唯一定位；已保留原节点，请重新定位。`);
        return question;
      });
      break;
    }
    case "merge-nodes": {
      const [leftId, rightId] = operation.nodeIds;
      const left = requireNode(document, leftId);
      const right = requireNode(document, rightId);
      const index = nodes.findIndex(node => node.id === leftId);
      assert(nodes[index + 1]?.id === rightId, "NONADJACENT_MERGE", "Only adjacent nodes in reading order can be merged.");
      nodes.splice(index, 2, { ...left, revision: left.revision + 1, markdown: left.markdown + right.markdown });
      questions = questions.map(question => question.nodeId === rightId ? { ...question, nodeId: leftId } : question);
      // Existing links keep their original versions and require review after a merge.
      break;
    }
    case "add-question": {
      const node = requireNode(document, operation.nodeId);
      validateText(operation.text, "A question");
      if (operation.quote !== undefined) assert(node.markdown.includes(operation.quote), "INVALID_QUOTE", "The selected question text is not in this node.");
      if (operation.parentQuestionId) requireQuestion(document, operation.parentQuestionId);
      const id = newId("question", options);
      assert(!questions.some(question => question.id === id), "DUPLICATE_ID", "Generated question identifier already exists.");
      questions.push({ id, revision: 1, nodeId: node.id, text: operation.text,
        ...(operation.quote !== undefined ? { quote: operation.quote } : {}),
        ...(operation.parentQuestionId ? { parentQuestionId: operation.parentQuestionId } : {}) });
      break;
    }
    case "edit-question": {
      requireQuestion(document, operation.questionId);
      validateText(operation.text, "A question");
      questions = questions.map(question => question.id === operation.questionId && question.text !== operation.text
        ? { ...question, revision: question.revision + 1, text: operation.text } : question);
      break;
    }
    case "delete-question": {
      requireQuestion(document, operation.questionId);
      questions = questions.filter(question => question.id !== operation.questionId).map(question => {
        if (question.parentQuestionId !== operation.questionId) return question;
        const { parentQuestionId: _parent, ...detached } = question;
        return detached;
      });
      links = links.filter(link => link.questionId !== operation.questionId);
      break;
    }
    case "link-explanation": {
      const question = requireQuestion(document, operation.questionId);
      const node = requireNode(document, operation.nodeId);
      validateText(operation.quote, "Explanation evidence");
      assert(operation.coverage === "full" || operation.coverage === "partial", "INVALID_COVERAGE", "Coverage must be full or partial.");
      assert(operation.source === undefined || operation.source === "manual" || operation.source === "ai", "INVALID_SOURCE", "Explanation source must be manual or ai.");
      const start = operation.start ?? node.markdown.indexOf(operation.quote);
      assert(Number.isInteger(start) && start >= 0 && node.markdown.slice(start, start + operation.quote.length) === operation.quote,
        "INVALID_EVIDENCE", "The evidence text does not match the selected answer range.");
      if (operation.start === undefined) assert(node.markdown.indexOf(operation.quote, start + 1) === -1, "AMBIGUOUS_EVIDENCE", "This quote occurs more than once; select an exact occurrence.");
      const origin = requireNode(document, question.nodeId);
      const dependencyIds = new Set(operation.dependencyNodeIds ?? []);
      const dependencies = [...dependencyIds].map(id => {
        const dependency = requireNode(document, id);
        return { nodeId: dependency.id, revision: dependency.revision };
      });
      const id = newId("link", options);
      assert(!links.some(link => link.id === id), "DUPLICATE_ID", "Generated link identifier already exists.");
      const questionAncestors: { questionId: string; revision: number }[] = [];
      let parentId = question.parentQuestionId;
      const ancestorIds = new Set<string>();
      while (parentId) {
        assert(!ancestorIds.has(parentId), "QUESTION_CYCLE", "Question ancestry contains a cycle.");
        ancestorIds.add(parentId);
        const parent = requireQuestion(document, parentId);
        questionAncestors.push({ questionId: parent.id, revision: parent.revision });
        parentId = parent.parentQuestionId;
      }
      links.push({ id, questionId: question.id, questionRevision: question.revision, nodeId: node.id, nodeRevision: node.revision,
        quote: operation.quote, start, end: start + operation.quote.length, coverage: operation.coverage,
        source: operation.source ?? "manual", originNodeRevision: origin.revision, questionAncestors, dependencies });
      break;
    }
    case "remove-link":
      assert(links.some(link => link.id === operation.linkId), "LINK_NOT_FOUND", "The explanation link no longer exists.");
      links = links.filter(link => link.id !== operation.linkId);
      break;
    case "set-reading":
      reading = validateReading(operation.reading);
      if (reading.nodeId) requireNode(document, reading.nodeId);
      if (reading.returnNodeId) requireNode(document, reading.returnNodeId);
      if (reading.activeQuestionId) requireQuestion(document, reading.activeQuestionId);
      break;
    default: {
      const impossible: never = operation;
      throw new CoreError("UNKNOWN_OPERATION", `Unsupported operation: ${String(impossible)}`);
    }
  }
  if (normalizeIds.size) {
    const beforeNormalization = nodes;
    nodes = normalizeBoundaries(nodes, eol, normalizeIds, paragraphBoundaries);
    // Only generated trailing separators are provably nonsemantic. Rebase evidence
    // across those changes, never across an author's content edit.
    const rebasedRevision = (id: string, revision: number): number => {
      const before = beforeNormalization.find(node => node.id === id);
      const after = nodes.find(node => node.id === id);
      return before && after && before.revision === revision ? after.revision : revision;
    };
    links = links.map(link => {
      const originId = questions.find(question => question.id === link.questionId)?.nodeId;
      return { ...link, nodeRevision: rebasedRevision(link.nodeId, link.nodeRevision),
        ...(originId && link.originNodeRevision !== undefined
          ? { originNodeRevision: rebasedRevision(originId, link.originNodeRevision) } : {}),
        ...(link.dependencies ? { dependencies: link.dependencies.map(dependency => ({ ...dependency,
          revision: rebasedRevision(dependency.nodeId, dependency.revision) })) } : {}) };
    });
  }
  reading = repairReading(reading, nodes, questions);
  const next: DocumentState = deepFreeze({
    schemaVersion: 1, id: document.id, revision: document.revision + 1, prefix, nodes, questions, links,
    ...(reading ? { reading } : {}),
  });
  // Validate the complete serialized structure before callers can adopt new state.
  serializeManagedMarkdown(next);
  const affectedNodeIds = [...new Set([...document.nodes, ...nodes].filter(node => {
    const before = document.nodes.findIndex(item => item.id === node.id);
    const after = nodes.findIndex(item => item.id === node.id);
    return before !== after || document.nodes[before]?.revision !== nodes[after]?.revision;
  }).map(node => node.id))];
  const undo: UndoToken = deepFreeze({ before: document, expectedRevision: next.revision,
    afterFingerprint: contentFingerprint(next), operation: structuredClone(operation) });
  return deepFreeze({ document: next, undo, affectedNodeIds, ...(issues.length ? { issues } : {}) });
}

export function undoOperation(document: DocumentState, undo: UndoToken): DocumentState {
  assert(document.id === undo.before.id && contentFingerprint(document) === undo.afterFingerprint,
    "UNDO_CONFLICT", "Later edits exist; reverting this operation would overwrite newer work.");
  const { reading: _previousReading, ...before } = undo.before;
  const reading = repairReading(undo.operation.type === "set-reading" ? undo.before.reading : document.reading, before.nodes, before.questions);
  return deepFreeze({ ...before, revision: document.revision + 1, ...(reading ? { reading } : {}) });
}

export function getQuestionCoverage(document: DocumentState, questionId: string, cursorNodeId?: string): QuestionCoverage {
  const question = requireQuestion(document, questionId);
  const cursorId = cursorNodeId ?? document.reading?.nodeId ?? document.nodes.at(-1)?.id;
  const cursorIndex = cursorId === undefined ? -1 : document.nodes.findIndex(node => node.id === cursorId);
  assert(cursorId === undefined || cursorIndex >= 0, "CURSOR_NOT_FOUND", "The reading cursor is no longer in this document.");
  const reached: ExplanationLink[] = [];
  const future: ExplanationLink[] = [];
  const invalid: ExplanationLink[] = [];
  for (const link of document.links.filter(link => link.questionId === questionId)) {
    const nodeIndex = document.nodes.findIndex(node => node.id === link.nodeId);
    const node = document.nodes[nodeIndex];
    const valid = link.questionRevision === question.revision && node && link.nodeRevision === node.revision
      && node.markdown.slice(link.start, link.end) === link.quote
      && (link.originNodeRevision === undefined || document.nodes.some(item => item.id === question.nodeId && item.revision === link.originNodeRevision))
      && (link.questionAncestors ?? []).every(ancestor => document.questions.some(item => item.id === ancestor.questionId && item.revision === ancestor.revision))
      && (link.dependencies ?? []).every(dependency => {
        const dependencyIndex = document.nodes.findIndex(item => item.id === dependency.nodeId && item.revision === dependency.revision);
        return dependencyIndex >= 0 && dependencyIndex <= nodeIndex;
      });
    if (!valid) invalid.push(link);
    else if (nodeIndex <= cursorIndex) reached.push(link);
    else future.push(link);
  }
  const orphanedQuestion = !document.nodes.some(node => node.id === question.nodeId);
  const status: QuestionCoverage["status"] = orphanedQuestion ? "needs-review"
    : reached.some(link => link.coverage === "full") ? "explained"
    : invalid.length ? "needs-review" : reached.length ? "partial" : "unexplained";
  return deepFreeze({ status, links: reached, futureLinks: future, invalidLinks: invalid });
}
