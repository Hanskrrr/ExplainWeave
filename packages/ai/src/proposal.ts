import { boundedString, identifier, keys, record, strictJson } from './validation';

/** Suggestions only. The controller validates IDs/quotes before applying state. */
export interface WritingProposal {
  markdown: string;
  explanations: { questionId: string; quote: string; coverage: 'partial' | 'full' }[];
  deferred: { questionId: string; nodeId: string; reason?: string }[];
}

export class WritingProposalError extends Error {
  constructor() { super('The model did not return a valid writing proposal. Regenerate or revise the structured response.'); this.name = 'WritingProposalError'; }
}

/** Accept bare JSON or one enclosing JSON fence, never prose around a result. */
export function parseWritingProposal(text: string): WritingProposal {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000) throw new Error();
    let source = text.trim();
    const fence = /^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1$/iu.exec(source);
    if (fence) source = fence[2]!;
    const value = strictJson(source, 1_000_000);
    if (!record(value) || !keys(value, ['markdown', 'explanations', 'deferred'])
      || !boundedString(value.markdown, 500_000)
      || !Array.isArray(value.explanations) || value.explanations.length > 256
      || !Array.isArray(value.deferred) || value.deferred.length > 256) throw new Error();
    const explained = new Map<string, 'partial' | 'full'>();
    const explanations = value.explanations.map<WritingProposal['explanations'][number]>(entry => {
      if (!record(entry) || !keys(entry, ['questionId', 'quote', 'coverage'])
        || !identifier(entry.questionId) || !boundedString(entry.quote, 16_000)
        || (entry.coverage !== 'partial' && entry.coverage !== 'full')
        || explained.has(entry.questionId)) throw new Error();
      explained.set(entry.questionId, entry.coverage);
      return { questionId: entry.questionId, quote: entry.quote, coverage: entry.coverage };
    });
    const deferredIds = new Set<string>();
    const deferred = value.deferred.map(entry => {
      if (!record(entry) || !keys(entry, ['questionId', 'nodeId'], ['reason'])
        || !identifier(entry.questionId) || !identifier(entry.nodeId)
        || (Object.hasOwn(entry, 'reason') && !boundedString(entry.reason, 4_000))
        || deferredIds.has(entry.questionId) || explained.get(entry.questionId) === 'full') throw new Error();
      deferredIds.add(entry.questionId);
      return { questionId: entry.questionId, nodeId: entry.nodeId,
        ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}) };
    });
    return { markdown: value.markdown, explanations, deferred };
  } catch { throw new WritingProposalError(); }
}
