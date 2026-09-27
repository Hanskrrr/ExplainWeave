import {
  applyOperation, getQuestionCoverage, hashText, isSafeSplit, readDocument,
  undoOperation, writeDocument, type DocumentState, type Operation, type UndoToken,
} from '@explainweave/core';
import { MockBackend, type ModelBackend, type WritingTask } from '@explainweave/ai';
import type { NotebookAction, NotebookDocument } from './Notebook';
import { createDocumentStore, type DocumentSnapshot, type FileIO } from './storage';
import { DraftFile, type SavedDraft } from './drafts';

type LocalDraft = SavedDraft;

function contentVersion(document: DocumentState): string {
  return JSON.stringify({ nodes: document.nodes, questions: document.questions, prefix: document.prefix });
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
  private snapshot: DocumentSnapshot;
  private readonly undo: UndoToken[] = [];
  private queue = Promise.resolve();
  private generation?: AbortController;
  private generationWork?: Promise<void>;
  private closed = false;
  private closing = false;
  private readonly store;
  private readonly draftFile;
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
      generatingNodeId: this.generating ? this.drafts.at(-1)?.nodeId : undefined,
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
        case 'draft/request': this.startDraft(action.nodeId, action.questionId); break;
        case 'draft/cancel': this.generation?.abort(); break;
        case 'draft/accept': {
          const draft = this.drafts.find(item => item.id === action.draftId);
          if (!draft) throw new Error('草稿已不存在。');
          if (this.generating) throw new Error('请等生成完成或取消后再采用。');
          if (draft.basedOn !== contentVersion(document)) throw new Error('生成依据已改变。请保留草稿并重新生成，避免覆盖当前内容。');
          const index = document.nodes.findIndex(node => node.id === draft.nodeId);
          if (index < 0) throw new Error('原插入位置已不存在。草稿仍然保留。');
          await this.operate({ type: 'insert-node', index: index + 1, markdown: draft.markdown });
          this.drafts.splice(this.drafts.indexOf(draft), 1);
          await this.draftFile.save(this.drafts); break;
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

  private startDraft(nodeId: string, questionId?: string): void {
    if (this.closing || this.closed) throw new Error('笔记正在关闭，未开始生成。');
    if (this.generating) throw new Error('当前草稿仍在生成，可先取消。');
    if (!this.document.nodes.some(node => node.id === nodeId)) throw new Error('节点已不存在。');
    const question = this.document.questions.find(item => item.id === questionId);
    const task: WritingTask = {
      id: crypto.randomUUID(), instruction: '在当前节点后补充必要的解释', targetNodeId: nodeId,
      question: question?.text,
      context: [
        ...this.document.nodes.map(node => ({ id: node.id, revision: String(node.revision), text: node.markdown })),
        ...this.document.questions.map(item => {
          const text = JSON.stringify({ kind: 'article-question', ...item, coverageAtTarget: getQuestionCoverage(this.document, item.id, nodeId).status });
          return { id: item.id, revision: hashText(text), text };
        }),
      ],
    };
    const simulated = this.backend.id === 'offline-demo';
    const draft: LocalDraft = { id: task.id, nodeId, questionId, markdown: '', basedOn: contentVersion(this.document), reason: simulated ? '离线模拟 · 不会自动标记问题已解释' : '模型草稿 · 请检查内容后采用', stale: false, simulated, providerLabel: this.backend.id };
    this.drafts.push(draft);
    const abort = new AbortController();
    this.generation = abort;
    this.generating = true;
    this.latestUsage = undefined;
    this.emit();
    this.generationWork = (async () => {
      try {
        for await (const event of this.backend.generate(task, abort.signal)) {
          if (abort.signal.aborted || this.closed) break;
          if (event.type === 'text') draft.markdown += event.text;
          if (event.type === 'usage') this.latestUsage = { ...this.latestUsage, ...event.usage };
          if (event.type === 'done') { draft.simulated = event.simulated; draft.providerLabel = event.backendId; }
          this.emit();
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) { this.error = String(error); draft.reason = '生成未完成，已保留收到的内容'; }
        else draft.reason = '生成已取消，已收到的内容保留为草稿';
      } finally {
        if (this.generation === abort) { this.generating = false; this.generation = undefined; }
        try { await this.enqueue(() => this.draftFile.save(this.drafts)); } catch (error) { this.error = String(error); }
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
