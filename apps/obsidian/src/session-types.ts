/** Persisted article and question discussions; explanation is not reader mastery. */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  kind?: 'chat' | 'compose';
  markdown: string;
  status: 'complete' | 'streaming' | 'cancelled' | 'error';
  basedOn?: string;
  simulated?: boolean;
  providerLabel?: string;
}
export interface Discussion {
  id: string;
  questionId?: string;
  turns: ChatTurn[];
  /** Frozen selection of ancestor turns inherited when this discussion first starts. */
  inheritedTurnIds?: string[];
  /** Exact provider messages, including structured compose output; separate from UI markdown. */
  transcript?: { role: 'user' | 'assistant'; content: string }[];
  /** Serialized document context already appended to this discussion's transcript. */
  contextJournal?: string;
}
export interface QuestionPlan {
  questionId: string;
  questionRevision: number;
  nodeId: string;
  reason?: string;
}
export interface SessionData {
  schemaVersion: 1;
  documentId: string;
  discussions: Discussion[];
  plans: QuestionPlan[];
  /** Append-only context entries, serialized by ContextJournal. */
  contextJournal: string;
}
