import { CoreError, type DocumentMetadata, type ExplanationLink, type Question, type ReadingState } from "./types";
import { assert, ID_PATTERN } from "./utils";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_METADATA", "Metadata contains an invalid object.");
  return value as RecordValue;
}
function string(value: unknown): string {
  assert(typeof value === "string", "INVALID_METADATA", "Metadata contains an invalid string.");
  return value;
}
function id(value: unknown): string {
  const text = string(value);
  assert(ID_PATTERN.test(text), "INVALID_METADATA", "Metadata contains an invalid identifier.");
  return text;
}
function integer(value: unknown, minimum = 1): number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "INVALID_METADATA", "Metadata contains an invalid revision or range.");
  return value;
}
function hash(value: unknown): string {
  const text = string(value);
  assert(/^[a-f0-9]{64}$/.test(text), "INVALID_METADATA", "Metadata contains an invalid content hash.");
  return text;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value), "INVALID_METADATA", "Metadata contains an invalid collection.");
  return value;
}
function unique(values: readonly { id: string }[]): void {
  assert(new Set(values.map(value => value.id)).size === values.length, "INVALID_METADATA", "Metadata contains duplicate identifiers.");
}

export function validateReading(value: unknown): ReadingState {
  const obj = record(value);
  return {
    ...(obj.nodeId !== undefined ? { nodeId: id(obj.nodeId) } : {}),
    ...(obj.activeQuestionId !== undefined ? { activeQuestionId: id(obj.activeQuestionId) } : {}),
    ...(obj.returnNodeId !== undefined ? { returnNodeId: id(obj.returnNodeId) } : {}),
  };
}

export function parseMetadata(input: string | DocumentMetadata): DocumentMetadata {
  let parsed: unknown;
  try { parsed = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new CoreError("INVALID_METADATA", "The sidecar is not valid JSON; it must not be silently replaced."); }
  const obj = record(parsed);
  assert(obj.schemaVersion === 1, "UNSUPPORTED_SCHEMA", "This sidecar schema is unsupported; preserve it until a compatible migration is available.");
  const nodes = array(obj.nodes).map(value => {
    const node = record(value);
    return { id: id(node.id), revision: integer(node.revision), contentHash: hash(node.contentHash) };
  });
  const questions: Question[] = array(obj.questions).map(value => {
    const question = record(value);
    const text = string(question.text);
    assert(text.trim().length > 0, "INVALID_METADATA", "A saved question is empty.");
    return {
      id: id(question.id), revision: integer(question.revision), nodeId: id(question.nodeId), text,
      ...(question.quote !== undefined ? { quote: string(question.quote) } : {}),
      ...(question.parentQuestionId !== undefined ? { parentQuestionId: id(question.parentQuestionId) } : {}),
    };
  });
  const links: ExplanationLink[] = array(obj.links).map(value => {
    const link = record(value);
    assert(link.coverage === "partial" || link.coverage === "full", "INVALID_METADATA", "An explanation has an invalid coverage value.");
    assert(link.source === "manual" || link.source === "ai", "INVALID_METADATA", "An explanation has an invalid source.");
    const quote = string(link.quote);
    const start = integer(link.start, 0);
    const end = integer(link.end, 0);
    assert(quote.length > 0 && end - start === quote.length, "INVALID_METADATA", "An explanation has an invalid evidence range.");
    return {
      id: id(link.id), questionId: id(link.questionId), questionRevision: integer(link.questionRevision),
      nodeId: id(link.nodeId), nodeRevision: integer(link.nodeRevision), quote, start, end,
      coverage: link.coverage, source: link.source,
      ...(link.originNodeRevision !== undefined ? { originNodeRevision: integer(link.originNodeRevision) } : {}),
      ...(link.questionAncestors !== undefined ? { questionAncestors: array(link.questionAncestors).map(value => {
        const ancestor = record(value);
        return { questionId: id(ancestor.questionId), revision: integer(ancestor.revision) };
      }) } : {}),
      ...(link.dependencies !== undefined ? { dependencies: array(link.dependencies).map(value => {
        const dependency = record(value);
        return { nodeId: id(dependency.nodeId), revision: integer(dependency.revision) };
      }) } : {}),
    };
  });
  unique(nodes); unique(questions); unique(links);
  const questionsById = new Map(questions.map(question => [question.id, question]));
  for (const question of questions) {
    const seen = new Set<string>([question.id]);
    let parent = question.parentQuestionId;
    while (parent) {
      assert(!seen.has(parent), "INVALID_METADATA", "Question ancestry contains a cycle.");
      seen.add(parent);
      const ancestor = questionsById.get(parent);
      assert(ancestor, "INVALID_METADATA", "A question refers to a missing parent.");
      parent = ancestor.parentQuestionId;
    }
  }
  for (const link of links) assert(questionsById.has(link.questionId), "INVALID_METADATA", "An explanation refers to a missing question.");
  return {
    schemaVersion: 1, documentId: id(obj.documentId), revision: integer(obj.revision),
    markdownHash: hash(obj.markdownHash), prefixHash: hash(obj.prefixHash), nodes, questions, links,
    ...(obj.reading !== undefined ? { reading: validateReading(obj.reading) } : {}),
  };
}
