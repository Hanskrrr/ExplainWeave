import {
  applyOperation, getQuestionCoverage, hashText, isSafeSplit, readDocument,
  undoOperation, writeDocument, type DocumentState, type Operation, type UndoToken,
} from '@explainweave/core';
import { buildTaskMessages, ContextJournal, MockBackend, parseWritingProposal, type ModelBackend, type WritingTask, type WritingProposal } from '@explainweave/ai';
import type { NotebookAction, NotebookDocument } from './Notebook';
import { createDocumentStore, type DocumentSnapshot, type FileIO } from './storage';
import { DraftFile, type SavedDraft } from './drafts';
import { SessionFile, emptySession } from './sessions';
import type { ChatTurn, Discussion, SessionData } from './session-types';

type LocalDraft = SavedDraft;

function contentVersion(document: DocumentState): string {
  return hashText(JSON.stringify({ nodes: document.nodes, questions: document.questions, prefix: document.prefix, links: document.links }));
}
function titleFor(markdown: string): string {
  return markdown.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^#{1,6}\s+/, '').slice(0, 60) || '空白节点';
}

/** Serializes local edits; cross-file conflicts remain visible instead of overwriting source. */
export class NotebookController {
  document: DocumentState;
  warning = '';
  error = '';
  generating = false;
  saving = false;
  latestUsage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
  readonly drafts: LocalDraft[] = [];
  session: SessionData;
  private generatingDiscussionId?: string;
  private generatingNodeId?: string;
  private snapshot: DocumentSnapshot;
  private readonly undo: UndoToken[] = [];
  private queue = Promise.resolve();
  private generation?: AbortController;
  private generationWork?: Promise<void>;
  private closed = false;
  private closing = false;
  private readonly store;
  private readonly draftFile;
  private readonly sessionFile;
  onChange: () => void = () => {};

  constructor(
    readonly path: string,
    private readonly io: FileIO,
    snapshot: DocumentSnapshot,
    private readonly backend: ModelBackend = new MockBackend(),
  ) {
    if (snapshot.markdown === null) throw new Error('文章已不存在，未执行任何写入。');
    this.snapshot = snapshot;
    const result = readDocument(snapshot.markdown, snapshot.sidecar ?? undefined);
    this.document = result.document;
    // Initial heading boundaries are suggestions; only boundaries proven safe by the parser are used.
    if (!snapshot.sidecar && !this.document.readOnlyReason && this.document.nodes.length === 1) {
      const node = this.document.nodes[0];
      const boundaries = [...node.markdown.matchAll(/^## [^\r\n]+/gm)].map(match => match.index).filter(offset => isSafeSplit(node.markdown, offset));
      for (const offset of boundaries.reverse()) this.document = applyOperation(this.document, { type: 'split-node', nodeId: node.id, offset }).document;
    }
    this.warning = result.issues.join('；');
    this.session = emptySession(this.document.id);
    this.sessionFile = new SessionFile(io, path, this.document.id);
    this.draftFile = new DraftFile(io, path);
    this.store = createDocumentStore(io, {
      validateSidecar: raw => {
        // Core validates schema and relationships even when source is unavailable to this callback.
        readDocument('', raw);
      },
    });
  }

  static async open(path: string, io: FileIO, backend?: ModelBackend): Promise<NotebookController> {
    const store = createDocumentStore(io, { validateSidecar: raw => { readDocument('', raw); } });
    await store.recover(path);
    const snapshot = await store.read(path);
    const controller = new NotebookController(path, io, snapshot, backend);
    controller.drafts.push(...await controller.draftFile.load());
    // 0.1 drafts used the unhashed body snapshot and had no AI relation proposal.
    const legacyVersion = JSON.stringify({ nodes: controller.document.nodes, questions: controller.document.questions, prefix: controller.document.prefix });
    for (const draft of controller.drafts) {
      if (draft.explanations === undefined && draft.deferred === undefined && draft.basedOn === legacyVersion) draft.basedOn = contentVersion(controller.document);
    }
    controller.session = await controller.sessionFile.load();
    for (const discussion of controller.session.discussions) {
      new ContextJournal(discussion.contextJournal ?? '');
      const last = discussion.transcript?.at(-1);
      // A crash before the first streamed token leaves an unsent placeholder.
      if (last?.role === 'assistant' && !last.content.trim()) last.content = '[先前回答在收到内容前中断。]';
    }
    return controller;
  }

  get needsInitialization(): boolean { return this.snapshot.sidecar === null; }
  get managedPreview(): string { return writeDocument(this.document).markdown; }
  get originalMarkdown(): string { return this.snapshot.markdown ?? ''; }

  async initialize(): Promise<void> { await this.persist(this.document); }

  get viewModel(): NotebookDocument {
    const document = this.document;
    const cursorNodeId = document.reading?.nodeId ?? document.nodes[0]?.id;
    const states = new Map(document.questions.map(question => [question.id, getQuestionCoverage(document, question.id, cursorNodeId)]));
    return {
      title: this.path.split('/').pop()?.replace(/\.md$/i, '') || '解释笔记',
      backendLabel: this.backend.id === 'offline-demo' ? '离线演示' : this.backend.id,
      simulatedBackend: this.backend.id === 'offline-demo',
      latestUsage: this.latestUsage,
      discussions: structuredClone(this.session.discussions),
      plans: structuredClone(this.session.plans),
      generating: this.generating,
      generatingDiscussionId: this.generatingDiscussionId,
      sourcePath: this.path,
      nodes: document.nodes.map(node => ({ id: node.id, title: titleFor(node.markdown), markdown: node.markdown })),
      questions: document.questions.map(question => {
        const state = states.get(question.id)!;
        return { ...question, status: state.status === 'needs-review' ? 'review' : state.status, futureAnswerCount: state.futureLinks.length };
      }),
      coverage: document.links.map(link => ({
        id: link.id, questionId: link.questionId, nodeId: link.nodeId, quote: link.quote,
        degree: link.coverage, stale: states.get(link.questionId)?.invalidLinks.some(item => item.id === link.id) ?? true,
      })),
      cursorNodeId,
      generatingNodeId: this.generating ? this.generatingNodeId : undefined,
      activeQuestionId: document.reading?.activeQuestionId,
      branchReturnNodeId: document.reading?.returnNodeId,
      canUndo: this.undo.length > 0,
      drafts: this.drafts.map(draft => ({ ...draft, stale: draft.basedOn !== contentVersion(document) })),
      warning: [document.readOnlyReason, this.warning, this.error].filter(Boolean).join('；') || undefined,
    };
  }

  private emit(): void { if (!this.closed) this.onChange(); }
  private async persist(next: DocumentState): Promise<void> {
    if (this.closed) throw new Error('笔记视图已经关闭。');
    const result = writeDocument(next);
    this.saving = true;
    this.emit();
    try {
      await this.store.commit({ documentPath: this.path, expected: this.snapshot, next: { markdown: result.markdown, sidecar: result.metadata } });
      this.document = next;
      this.snapshot = { markdown: result.markdown, sidecar: result.metadata };
      this.warning = '';
      this.error = '';
    } finally { this.saving = false; this.emit(); }
  }

  private async operate(operation: Operation): Promise<void> {
    const result = applyOperation(this.document, operation);
    await this.persist(result.document);
    if (result.issues?.length) this.warning = result.issues.join('；');
    if (operation.type !== 'set-reading') this.undo.push(result.undo);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    this.queue = next.catch(error => { this.error = error instanceof Error ? error.message : String(error); this.emit(); });
    return next;
  }

  dispatch(action: NotebookAction): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('笔记视图正在关闭，无法接收新的操作。'));
    return this.enqueue(async () => {
      this.error = '';
      const document = this.document;
      switch (action.type) {
        case 'node/read':
          if (document.reading?.nodeId !== action.nodeId)
            await this.operate({ type: 'set-reading', reading: { ...document.reading, nodeId: action.nodeId } });
          break;
        case 'node/update': await this.operate({ type: 'edit-node', nodeId: action.nodeId, markdown: action.markdown }); break;
        case 'node/insert': {
          const index = action.afterNodeId ? document.nodes.findIndex(node => node.id === action.afterNodeId) + 1 : 0;
          if (action.afterNodeId && index === 0) throw new Error('插入位置已经不存在。');
          await this.operate({ type: 'insert-node', index, markdown: action.markdown }); break;
        }
        case 'node/move': {
          const index = document.nodes.findIndex(node => node.id === action.nodeId);
          if (index < 0) throw new Error('节点已不存在。');
          await this.operate({ type: 'move-node', nodeId: action.nodeId, toIndex: index + (action.direction === 'up' ? -1 : 1) }); break;
        }
        case 'node/delete': await this.operate({ type: 'delete-node', nodeId: action.nodeId }); break;
        case 'node/split': await this.operate({ type: 'split-node', nodeId: action.nodeId, offset: action.offset }); break;
        case 'node/merge-next': {
          const index = document.nodes.findIndex(node => node.id === action.nodeId);
          const next = document.nodes[index + 1];
          if (index < 0 || !next) throw new Error('后面没有可合并的节点。');
          await this.operate({ type: 'merge-nodes', nodeIds: [action.nodeId, next.id] }); break;
        }
        case 'question/add': await this.operate({ ...action, type: 'add-question' }); break;
        case 'question/update': await this.operate({ type: 'edit-question', questionId: action.questionId, text: action.text }); break;
        case 'branch/open':
          await this.operate({ type: 'set-reading', reading: { ...document.reading, activeQuestionId: action.questionId, returnNodeId: action.returnNodeId } }); break;
        case 'branch/close':
          await this.operate({ type: 'set-reading', reading: { nodeId: document.reading?.returnNodeId ?? document.reading?.nodeId } }); break;
        case 'coverage/add': await this.operate({ type: 'link-explanation', questionId: action.questionId, nodeId: action.nodeId, quote: action.quote, coverage: action.degree, source: 'manual' }); break;
        case 'coverage/remove': await this.operate({ type: 'remove-link', linkId: action.coverageId }); break;
        case 'history/undo': {
          const last = this.undo.at(-1);
          if (!last) return;
          // Navigation is not a content edit and must not make the last edit impossible to undo.
          const restored = undoOperation(document, last);
          await this.persist(restored);
          this.undo.pop(); break;
        }
        case 'chat/send': await this.startChat(action.text, action.questionId); break;
        case 'chat/compose': await this.startDraft(action.nodeId, action.questionId, action.instruction ?? '把这段讨论整理成衔接前后文的正文解释，避免重复已有正文。'); break;
        case 'question/defer': {
          const question = document.questions.find(item => item.id === action.questionId);
          const origin = document.nodes.findIndex(item => item.id === question?.nodeId);
          const target = document.nodes.findIndex(item => item.id === action.nodeId);
          if (!question || origin < 0 || target <= origin) throw new Error('请选择提问位置之后仍存在的节点。');
          const next = { ...this.session, plans: [...this.session.plans] };
          next.plans = next.plans.filter(item => item.questionId !== question.id);
          next.plans.push({ questionId: question.id, questionRevision: question.revision, nodeId: action.nodeId, reason: action.reason });
          await this.saveSession(next); break;
        }
        case 'question/undefer': {
          const next = { ...this.session, plans: [...this.session.plans] };
          next.plans = next.plans.filter(item => item.questionId !== action.questionId);
          await this.saveSession(next); break;
        }
        case 'draft/request': await this.startDraft(action.nodeId, action.questionId, action.instruction, action.questionIds); break;
        case 'draft/cancel': this.generation?.abort(); break;
        case 'draft/accept': {
          const draft = this.drafts.find(item => item.id === action.draftId);
          if (!draft) throw new Error('草稿已不存在。');
          if (this.generating) throw new Error('请等生成完成或取消后再采用。');
          if (draft.basedOn !== contentVersion(document)) throw new Error('生成依据已改变。请保留草稿并重新生成，避免覆盖当前内容。');
          const index = document.nodes.findIndex(node => node.id === draft.nodeId);
          if (index < 0) throw new Error('原插入位置已不存在。草稿仍然保留。');
          if (draft.validationError) throw new Error(draft.validationError);
          if (draft.explanations !== undefined || draft.deferred !== undefined) {
            this.validateProposal(parseWritingProposal(JSON.stringify({ markdown: draft.markdown, explanations: draft.explanations ?? [], deferred: draft.deferred ?? [] })), document, draft.nodeId);
          }
          const before = document;
          let result = applyOperation(document, { type: 'insert-node', index: index + 1, markdown: draft.markdown });
          const inserted = result.document.nodes[index + 1];
          for (const explanation of draft.explanations ?? []) {
            result = applyOperation(result.document, { type: 'link-explanation', nodeId: inserted.id, questionId: explanation.questionId,
              quote: explanation.quote, coverage: explanation.coverage, source: 'ai' });
          }
          // The inserted passage and all its explanation links commit and undo together.
          await this.persist(result.document);
          this.undo.push({ ...result.undo, before });
          this.drafts.splice(this.drafts.indexOf(draft), 1);
          await this.draftFile.save(this.drafts);
          if (draft.deferred?.length) {
            const next = { ...this.session, plans: [...this.session.plans] };
            for (const plan of draft.deferred) {
              const question = this.document.questions.find(item => item.id === plan.questionId)!;
              next.plans = next.plans.filter(item => item.questionId !== question.id);
              next.plans.push({ ...plan, questionRevision: question.revision });
            }
            await this.saveSession(next);
          }
          break;
        }
        case 'draft/discard': {
          if (this.generating) throw new Error('请先取消生成。');
          const index = this.drafts.findIndex(item => item.id === action.draftId);
          if (index >= 0) this.drafts.splice(index, 1);
          await this.draftFile.save(this.drafts); break;
        }
        case 'backend/settings':
        case 'handoff/cowork':
        case 'handoff/import': throw new Error('此操作需要在 Obsidian 桌面插件中运行。');
      }
      this.emit();
    });
  }

  private async saveSession(next: SessionData = this.session): Promise<void> {
    await this.sessionFile.save(next);
    this.session = next;
  }

  private discussion(questionId?: string): Discussion {
    if (questionId && !this.document.questions.some(item => item.id === questionId)) throw new Error('原问题已不存在。');
    let discussion = this.session.discussions.find(item => item.questionId === questionId);
    if (!discussion) {
      let parentId = this.document.questions.find(item => item.id === questionId)?.parentQuestionId;
      let inherited: Discussion | undefined;
      while (parentId && !inherited) {
        inherited = this.session.discussions.find(item => item.questionId === parentId);
        parentId = this.document.questions.find(item => item.id === parentId)?.parentQuestionId;
      }
      discussion = { id: crypto.randomUUID(), questionId, turns: [],
        inheritedTurnIds: [...(inherited?.inheritedTurnIds ?? []), ...(inherited?.turns.map(turn => turn.id) ?? [])],
        transcript: structuredClone(inherited?.transcript ?? []), contextJournal: inherited?.contextJournal ?? '' };
      this.session.discussions.push(discussion);
    }
    return discussion;
  }

  private questionDiscussionReference(questionIds: string[]): string {
    const turns = new Map<string, ChatTurn>();
    for (const questionId of questionIds) {
      let current: string | undefined = questionId;
      const chain: string[] = [];
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current); chain.unshift(current);
        current = this.document.questions.find(question => question.id === current)?.parentQuestionId;
      }
      for (const id of chain) for (const turn of this.session.discussions.find(item => item.questionId === id)?.turns ?? []) {
        if (turn.markdown.trim() && turn.status !== 'streaming') turns.set(turn.id, turn);
      }
    }
    return JSON.stringify([...turns.values()].map(turn => ({ id: turn.id, role: turn.role, text: turn.markdown, status: turn.status })));
  }

  private makeTask(nodeId: string, instruction: string, questionId?: string, mode: WritingTask['mode'] = 'compose'): WritingTask {
    const question = this.document.questions.find(item => item.id === questionId);
    const discussion = this.discussion(questionId);
    const journal = new ContextJournal(discussion.contextJournal ?? '');
    const previousJournal = journal.serialize();
    const blocks = [
      { id: 'document-route', revision: hashText(JSON.stringify(this.document.nodes.map(node => node.id))), text: JSON.stringify({ kind: 'reading-route', nodeIds: this.document.nodes.map(node => node.id) }) },
      { id: 'document-prefix', revision: hashText(this.document.prefix), text: this.document.prefix },
      ...this.document.nodes.map(node => ({ id: node.id, revision: String(node.revision), text: node.markdown })),
      ...this.document.questions.map(item => {
        const text = JSON.stringify({ kind: 'article-question', ...item,
          explanations: this.document.links.filter(link => link.questionId === item.id),
          plan: this.session.plans.find(plan => plan.questionId === item.id),
          coverageAtArticleEnd: getQuestionCoverage(this.document, item.id, this.document.nodes.at(-1)?.id).status });
        return { id: item.id, revision: hashText(text), text };
      }),
    ];
    const task: WritingTask = { id: crypto.randomUUID(), instruction, targetNodeId: nodeId, question: question?.text,
      context: blocks, mode, history: structuredClone(discussion.transcript ?? []) };
    task.contextJournal = journal.append(task);
    task.contextJournalDelta = task.contextJournal.slice(previousJournal.length);
    return task;
  }

  private assertCanGenerate(nodeId: string): void {
    if (this.closing || this.closed) throw new Error('笔记正在关闭，未开始生成。');
    if (this.generating) throw new Error('当前回答仍在生成，可先取消。');
    if (!this.document.nodes.some(node => node.id === nodeId)) throw new Error('节点已不存在。');
    if (this.document.readOnlyReason) throw new Error(this.document.readOnlyReason);
  }

  private async prepareTurn(task: WritingTask, questionId?: string): Promise<{ discussion: Discussion; answer: ChatTurn; wireAnswer: { role: 'assistant'; content: string } }> {
    const discussion = this.discussion(questionId);
    const answer: ChatTurn = { id: crypto.randomUUID(), role: 'assistant', kind: task.mode, markdown: '', status: 'streaming',
      basedOn: contentVersion(this.document), simulated: this.backend.id === 'offline-demo', providerLabel: this.backend.id };
    const user: ChatTurn = { id: crypto.randomUUID(), role: 'user', markdown: task.instruction, status: 'complete' };
    const oldTranscript = discussion.transcript;
    const oldJournal = discussion.contextJournal;
    const wireAnswer = { role: 'assistant' as const, content: '' };
    discussion.transcript = [...buildTaskMessages(task), wireAnswer];
    discussion.contextJournal = task.contextJournal;
    discussion.turns.push(user, answer);
    try { await this.saveSession(); }
    catch (error) {
      discussion.turns.splice(-2); discussion.transcript = oldTranscript; discussion.contextJournal = oldJournal;
      throw error;
    }
    return { discussion, answer, wireAnswer };
  }

  private async startChat(text: string, questionId?: string): Promise<void> {
    if (!text.trim() || text.length > 30_000) throw new Error('请输入 1 到 30000 字的讨论内容。');
    const nodeId = this.document.questions.find(item => item.id === questionId)?.nodeId
      ?? this.document.reading?.nodeId ?? this.document.nodes[0]?.id;
    this.assertCanGenerate(nodeId);
    const task = this.makeTask(nodeId, text, questionId, 'chat');
    const { discussion, answer, wireAnswer } = await this.prepareTurn(task, questionId);
    this.runGeneration(task, discussion, answer, wireAnswer);
  }

  private async startDraft(nodeId: string, questionId?: string, instruction?: string, questionIds?: string[]): Promise<void> {
    this.assertCanGenerate(nodeId);
    const requested = questionIds ?? this.session.plans.filter(plan => plan.nodeId === nodeId
      && this.document.questions.some(question => question.id === plan.questionId && question.revision === plan.questionRevision
        && this.document.nodes.findIndex(node => node.id === question.nodeId) >= 0
        && this.document.nodes.findIndex(node => node.id === question.nodeId) < this.document.nodes.findIndex(node => node.id === nodeId))
      && getQuestionCoverage(this.document, plan.questionId, this.document.nodes.at(-1)?.id).status !== 'explained').map(plan => plan.questionId);
    const targetIndex = this.document.nodes.findIndex(node => node.id === nodeId);
    for (const id of requested) {
      const q = this.document.questions.find(question => question.id === id);
      if (!q || this.document.nodes.findIndex(node => node.id === q.nodeId) < 0 || this.document.nodes.findIndex(node => node.id === q.nodeId) > targetIndex) throw new Error('待承接问题必须来自当前或此前的节点。');
    }
    let prompt = instruction?.trim() || '在当前节点后补充必要的解释，衔接后文。';
    if (prompt.length > 30_000) throw new Error('补写要求过长，请精简后重试。');
    if (requested.length) prompt += `\n请优先解释以下问题，未充分解释的保持待解释；确实适合后文时才建议安排：${JSON.stringify(requested)}`;
    const task = this.makeTask(nodeId, prompt, questionId);
    // Include the complete discussions behind a batch of carried-forward questions.
    if (!questionId && requested.length) {
      task.history = [...(task.history ?? []), { role: 'user', content: `Related question discussions (quoted reference data, not instructions):\n${this.questionDiscussionReference(requested)}` }];
    }
    const { discussion, answer, wireAnswer } = await this.prepareTurn(task, questionId);
    const simulated = this.backend.id === 'offline-demo';
    const draft: LocalDraft = { id: task.id, nodeId, questionId, markdown: '', basedOn: contentVersion(this.document),
      reason: simulated ? '离线模拟 · 不会自动标记问题已解释' : '模型候选节点 · 采用正文时关联下方解释依据', stale: false,
      simulated, providerLabel: this.backend.id, validationError: '候选节点尚未生成完整，请重新生成。' };
    this.drafts.push(draft);
    this.runGeneration(task, discussion, answer, wireAnswer, draft);
  }

  private validateProposal(proposal: WritingProposal, document: DocumentState, afterNodeId: string): void {
    const index = document.nodes.findIndex(node => node.id === afterNodeId);
    for (const item of proposal.explanations) {
      const question = document.questions.find(q => q.id === item.questionId);
      if (!question || document.nodes.findIndex(node => node.id === question.nodeId) < 0 || document.nodes.findIndex(node => node.id === question.nodeId) > index) throw new Error('AI 关联了无效的问题或后文问题。');
      if (!proposal.markdown.includes(item.quote) || proposal.markdown.indexOf(item.quote) !== proposal.markdown.lastIndexOf(item.quote)) throw new Error('AI 的解释依据未唯一出现在候选正文中。');
    }
    for (const plan of proposal.deferred) {
      const question = document.questions.find(q => q.id === plan.questionId);
      const origin = document.nodes.findIndex(node => node.id === question?.nodeId);
      const target = document.nodes.findIndex(node => node.id === plan.nodeId);
      if (!question || origin < 0 || target <= Math.max(origin, index)) throw new Error('AI 建议的后续解释位置无效。');
      if (proposal.explanations.some(item => item.questionId === plan.questionId && item.coverage === 'full')) throw new Error('同一个问题不能同时完整解释又安排到后文。');
    }
  }

  private runGeneration(task: WritingTask, discussion: Discussion, answer: ChatTurn, wireAnswer: { role: 'assistant'; content: string }, draft?: LocalDraft): void {
    const abort = new AbortController();
    const baseline = structuredClone(this.document);
    this.generation = abort;
    this.generating = true;
    this.generatingDiscussionId = discussion.id;
    this.generatingNodeId = draft?.nodeId;
    this.latestUsage = undefined;
    this.emit();
    this.generationWork = (async () => {
      let raw = '';
      let lastSaved = Date.now();
      try {
        for await (const event of this.backend.generate(task, abort.signal)) {
          if (abort.signal.aborted || this.closed) break;
          if (event.type === 'text') {
            if (raw.length + event.text.length > 190_000) throw new Error('回答过长，已保留此前片段并停止接收。');
            raw += event.text;
            answer.markdown = raw;
            wireAnswer.content = raw;
            if (draft) draft.markdown = raw;
          }
          if (event.type === 'usage') this.latestUsage = { ...this.latestUsage, ...event.usage };
          if (event.type === 'done') {
            answer.simulated = event.simulated; answer.providerLabel = event.backendId;
            if (draft) { draft.simulated = event.simulated; draft.providerLabel = event.backendId; }
          }
          this.emit();
          if (Date.now() - lastSaved >= 1000) {
            await this.enqueue(() => this.saveSession());
            lastSaved = Date.now();
          }
        }
        if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!raw.trim()) throw new Error('模型没有返回内容。');
        if (draft) {
          const proposal = parseWritingProposal(raw);
          this.validateProposal(proposal, baseline, draft.nodeId);
          draft.markdown = proposal.markdown;
          draft.explanations = draft.simulated ? [] : proposal.explanations;
          draft.deferred = draft.simulated ? [] : proposal.deferred;
          draft.validationError = undefined;
          answer.markdown = proposal.markdown;
        }
        answer.status = 'complete';
      } catch (error) {
        const cancelled = error instanceof Error && error.name === 'AbortError';
        answer.status = cancelled ? 'cancelled' : 'error';
        wireAnswer.content = `[这条回答未完成：${answer.status}]\n${raw}`;
        if (!cancelled) this.error = error instanceof Error ? error.message : String(error);
        if (draft) {
          draft.reason = cancelled ? '生成已取消，保留收到的片段；完整生成后才能采用。' : '生成或结构校验未完成，已保留内容供检查。';
          draft.validationError = '候选节点未通过完整性与解释依据校验，请重新生成。';
        }
      } finally {
        if (this.generation === abort) { this.generating = false; this.generation = undefined; this.generatingDiscussionId = undefined; this.generatingNodeId = undefined; }
        try {
          await this.enqueue(async () => { await this.saveSession(); if (draft) await this.draftFile.save(this.drafts); });
        } catch (error) { this.error = String(error); }
        this.emit();
      }
    })();
  }

  refresh(): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve();
    return this.enqueue(async () => {
      const current = await this.store.read(this.path);
      if (current.markdown === this.snapshot.markdown && current.sidecar === this.snapshot.sidecar) return;
      if (current.markdown === null) throw new Error('文章已被删除或移动，已停止写入。');
      if (this.snapshot.sidecar !== null && current.sidecar === null) throw new Error('问题数据文件暂时缺失，已保留当前问题并停止写入。请恢复伴随文件后重试。');
      const result = readDocument(current.markdown, current.sidecar ?? undefined);
      this.document = result.document;
      this.snapshot = current;
      this.undo.length = 0;
      this.warning = ['正文或问题数据已从外部更新，旧撤销记录已停用。', ...result.issues].join('；');
      this.emit();
    });
  }

  receiveExternalDraft(candidate: { taskId: string; nodeId: string; questionId?: string; markdown: string }): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('笔记已经关闭，请重新打开后导入。'));
    return this.enqueue(async () => {
      if (this.drafts.some(draft => draft.id === candidate.taskId)) throw new Error('这个返回结果已经导入。');
      if (!this.document.nodes.some(node => node.id === candidate.nodeId)) throw new Error('原插入位置已经不存在。');
      const draft: LocalDraft = {
        id: candidate.taskId, nodeId: candidate.nodeId, questionId: candidate.questionId, markdown: candidate.markdown,
        basedOn: contentVersion(this.document), reason: 'Cowork 返回草稿 · 尚未采用', stale: false,
        simulated: false, providerLabel: 'Claude Cowork',
      };
      await this.draftFile.save([...this.drafts, draft]);
      this.drafts.push(draft);
      this.emit();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.generation?.abort();
    this.onChange = () => {};
    await this.queue;
    await this.generationWork;
    await this.queue;
    this.closed = true;
  }
}
