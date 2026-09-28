/** Backends declare capabilities; opening another application is not a model response. */
export { DeepSeekBackend, ClaudeBackend, ProviderError, buildTaskMessages, type ProviderConfig, type FetchLike } from './providers';
export { ContextJournal, ContextJournalError } from './journal';
export { parseWritingProposal, WritingProposalError, type WritingProposal } from './proposal';
export type BackendKind = 'model' | 'agent' | 'handoff';
export interface BackendCapabilities {
  kind: BackendKind;
  streaming: boolean;
  cancellation: boolean;
  contextOwnership: 'application' | 'runtime' | 'external';
  usageReporting: boolean;
}
export interface ContextBlock { id: string; revision: string; text: string }
export interface ConversationMessage { role: 'user' | 'assistant'; content: string }
export interface WritingTask {
  id: string;
  instruction: string;
  context: readonly ContextBlock[];
  targetNodeId: string;
  question?: string;
  /** Undefined keeps the legacy Markdown-only composing contract. */
  mode?: 'chat' | 'compose';
  /** Complete prior conversation, in order; the current request is separate. */
  history?: ConversationMessage[];
  /** Validated, append-only ContextJournal serialization. */
  contextJournal?: string;
  /** With this present, history is the original wire transcript; append only this journal suffix. */
  contextJournalDelta?: string;
}
export type GenerationEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; backendId: string; usage: { inputTokens?: number; uncachedInputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } }
  | { type: 'done'; backendId: string; simulated: boolean };
export interface ModelBackend {
  id: string;
  capabilities: BackendCapabilities;
  generate(task: WritingTask, signal: AbortSignal): AsyncIterable<GenerationEvent>;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Offline workflow fixture, deliberately makes no claim to answer the question. */
export class MockBackend implements ModelBackend {
  readonly id = 'offline-demo';
  readonly capabilities: BackendCapabilities = {
    kind: 'model', streaming: true, cancellation: true,
    contextOwnership: 'application', usageReporting: false,
  };
  constructor(private readonly delayMs = 35) {}
  async *generate(task: WritingTask, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    const focus = task.question || task.instruction;
    const markdown = `### 补充解释（模拟草稿）\n\n> 这是离线流程演示，没有调用模型，也没有判断问题已被解释。\n\n待解释的问题：${focus}\n\n先补充读者需要的背景，再用一个具体例子展示中间步骤，最后说明它如何引出下一节。请把这一段改写为实际解释后，再关联它覆盖的问题。\n`;
    const output = task.mode === 'compose' ? JSON.stringify({ markdown, explanations: [], deferred: [] })
      : task.mode === 'chat' ? `这是模拟回答，没有调用模型。我收到的问题是：${focus}\n\n当前包含 ${task.history?.length ?? 0} 条历史消息。此演示不会把问题标记为已解释。` : markdown;
    for (const chunk of output.match(/[\s\S]{1,16}/gu) ?? []) {
      await pause(this.delayMs, signal);
      yield { type: 'text', text: chunk };
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    yield { type: 'done', backendId: this.id, simulated: true };
  }
}
