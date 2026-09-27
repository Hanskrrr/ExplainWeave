export interface Node {
  readonly id: string;
  readonly revision: number;
  /** Exact source text, including whitespace owned by this node. */
  readonly markdown: string;
}

export interface Question {
  readonly id: string;
  /** Changes with text or a new source attachment, invalidating old coverage. */
  readonly revision: number;
  readonly nodeId: string;
  readonly text: string;
  readonly quote?: string;
  readonly parentQuestionId?: string;
}

export interface ExplanationLink {
  readonly id: string;
  readonly questionId: string;
  readonly questionRevision: number;
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly quote: string;
  readonly start: number;
  readonly end: number;
  readonly coverage: "partial" | "full";
  readonly source: "manual" | "ai";
  /** Binding to the question's source paragraph, not a prerequisite ordering edge. */
  readonly originNodeRevision?: number;
  readonly questionAncestors?: readonly { readonly questionId: string; readonly revision: number }[];
  readonly dependencies?: readonly { readonly nodeId: string; readonly revision: number }[];
}

export interface ReadingState {
  readonly nodeId?: string;
  readonly activeQuestionId?: string;
  readonly returnNodeId?: string;
}

export interface DocumentState {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  /** Protected frontmatter, if present, including its original line endings. */
  readonly prefix: string;
  /** The current Markdown order is the only main reading route. */
  readonly nodes: readonly Node[];
  readonly questions: readonly Question[];
  readonly links: readonly ExplanationLink[];
  readonly reading?: ReadingState;
  readonly readOnlyReason?: string;
}

export interface CoreOptions {
  readonly idFactory?: () => string;
}

type RevisionGuard = { readonly expectedDocumentRevision?: number };

export type Operation = RevisionGuard & (
  | { readonly type: "insert-node"; readonly index: number; readonly markdown: string }
  | { readonly type: "edit-node"; readonly nodeId: string; readonly markdown: string }
  | { readonly type: "move-node"; readonly nodeId: string; readonly toIndex: number }
  | { readonly type: "delete-node"; readonly nodeId: string }
  | { readonly type: "split-node"; readonly nodeId: string; readonly offset: number }
  | { readonly type: "merge-nodes"; readonly nodeIds: readonly [string, string] }
  | { readonly type: "add-question"; readonly nodeId: string; readonly text: string;
      readonly quote?: string; readonly parentQuestionId?: string }
  | { readonly type: "edit-question"; readonly questionId: string; readonly text: string }
  | { readonly type: "delete-question"; readonly questionId: string }
  | { readonly type: "link-explanation"; readonly questionId: string; readonly nodeId: string;
      readonly quote: string; readonly start?: number; readonly coverage: "partial" | "full";
      readonly source?: "manual" | "ai"; readonly dependencyNodeIds?: readonly string[] }
  | { readonly type: "remove-link"; readonly linkId: string }
  | { readonly type: "set-reading"; readonly reading: ReadingState }
);

export type DocumentOperation = Operation;

export interface UndoToken {
  readonly before: DocumentState;
  readonly expectedRevision: number;
  readonly afterFingerprint: string;
  readonly operation: Operation;
}

export interface OperationResult {
  readonly document: DocumentState;
  readonly undo: UndoToken;
  readonly affectedNodeIds: readonly string[];
  /** Recoverable source-location ambiguity; the original question is retained. */
  readonly issues?: readonly string[];
}

export interface QuestionCoverage {
  readonly status: "unexplained" | "partial" | "explained" | "needs-review";
  /** Valid explanation links reached along the current route. */
  readonly links: readonly ExplanationLink[];
  /** Valid links later than the current reading position; not yet explained here. */
  readonly futureLinks: readonly ExplanationLink[];
  readonly invalidLinks: readonly ExplanationLink[];
}

export interface DocumentMetadata {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly revision: number;
  readonly markdownHash: string;
  readonly prefixHash: string;
  readonly nodes: readonly { readonly id: string; readonly revision: number; readonly contentHash: string }[];
  readonly questions: readonly Question[];
  readonly links: readonly ExplanationLink[];
  readonly reading?: ReadingState;
}

export interface ReadResult {
  readonly document: DocumentState;
  readonly issues: readonly string[];
  readonly metadataStatus: "none" | "valid" | "stale";
}

export class CoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CoreError";
  }
}
