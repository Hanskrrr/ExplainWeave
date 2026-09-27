import { describe, expect, it, vi } from 'vitest';
import { exportCleanMarkdown } from '@explainweave/core';
import { MockBackend, type ModelBackend, type WritingTask } from '@explainweave/ai';
import { NotebookController } from './controller';
import { pathsFor, type FileIO } from './storage';

const source = '---\ntitle: 示例\n---\n\n# 阅读起点\n\n先提出一个问题。\n\n## 后续解释\n\n平均值将每个数相加，因此极端值会改变总和。\n';
function memory() {
  const files = new Map<string, string>([['article.md', source]]);
  const io: FileIO = {
    read: async path => files.get(path) ?? null,
    write: async (path, text) => { files.set(path, text); },
    remove: async path => { files.delete(path); },
  };
  return { io, files };
}
async function setup(backend: ModelBackend = new MockBackend(0)) {
  const result = memory();
  const controller = await NotebookController.open('article.md', result.io, backend);
  await controller.initialize();
  return { ...result, controller };
}

describe('notebook lifecycle', () => {
  it('includes parent questions and current coverage when generating a follow-up', async () => {
    let received: WritingTask | undefined;
    const backend: ModelBackend = {
      id: 'fixture', capabilities: new MockBackend().capabilities,
      async *generate(task) { received = task; yield { type: 'text', text: '候选解释' } as const; },
    };
    const { controller } = await setup(backend);
    const nodeId = controller.document.nodes[0].id;
    await controller.dispatch({ type: 'question/add', nodeId, text: '为什么使用平均值？' });
    const parent = controller.document.questions[0];
    await controller.dispatch({ type: 'question/add', nodeId, text: '那极端值呢？', parentQuestionId: parent.id });
    const child = controller.document.questions[1];
    await controller.dispatch({ type: 'draft/request', nodeId, questionId: child.id });
    await vi.waitFor(() => expect(controller.generating).toBe(false));
    expect(received?.question).toBe('那极端值呢？');
    expect(received?.context.some(block => block.text.includes('为什么使用平均值？'))).toBe(true);
    expect(received?.context.some(block => block.text.includes(`"parentQuestionId":"${parent.id}"`))).toBe(true);
    await controller.close();
  });
  it('previews without writing and preserves original Markdown through managed import', async () => {
    const { io, files } = memory();
    const controller = await NotebookController.open('article.md', io);
    expect(files.size).toBe(1);
    expect(controller.needsInitialization).toBe(true);
    expect(controller.document.nodes).toHaveLength(2);
    expect(exportCleanMarkdown(controller.document)).toBe(source);
    await controller.initialize();
    const reopened = await NotebookController.open('article.md', io);
    expect(reopened.document.nodes).toEqual(controller.document.nodes);
    expect(exportCleanMarkdown(reopened.document)).toBe(source);
  });

  it('tracks later explanation, question edits, navigation, undo and reload', async () => {
    const { controller, io } = await setup();
    const [origin, answer] = controller.document.nodes;
    await controller.dispatch({ type: 'question/add', nodeId: origin.id, text: '为什么极端值会影响平均值？' });
    const questionId = controller.document.questions[0].id;
    await controller.dispatch({ type: 'coverage/add', questionId, nodeId: answer.id, quote: '极端值会改变总和', degree: 'full' });
    expect(controller.viewModel.questions[0]).toMatchObject({ status: 'unexplained', futureAnswerCount: 1 });
    await controller.dispatch({ type: 'node/read', nodeId: answer.id });
    expect(controller.viewModel.questions[0].status).toBe('explained');
    await controller.dispatch({ type: 'question/update', questionId, text: '为什么中位数不受影响？' });
    expect(controller.viewModel.questions[0].status).toBe('review');
    await controller.dispatch({ type: 'node/read', nodeId: origin.id });
    await controller.dispatch({ type: 'history/undo' });
    expect(controller.document.questions[0].text).toBe('为什么极端值会影响平均值？');
    expect(controller.viewModel.cursorNodeId).toBe(origin.id);
    const reopened = await NotebookController.open('article.md', io);
    expect(reopened.viewModel.questions[0]).toMatchObject({ status: 'unexplained', futureAnswerCount: 1 });
    expect(reopened.viewModel.cursorNodeId).toBe(origin.id);
  });

  it('preserves questions when the sidecar disappears during synchronization', async () => {
    const { controller, files } = await setup();
    await controller.dispatch({ type: 'question/add', nodeId: controller.document.nodes[0].id, text: '为什么？' });
    files.delete(pathsFor('article.md').sidecar);
    await expect(controller.refresh()).rejects.toThrow('问题数据文件暂时缺失');
    expect(controller.document.questions).toHaveLength(1);
    await expect(controller.dispatch({ type: 'node/insert', markdown: '不应写入' })).rejects.toThrow();
    expect(files.has(pathsFor('article.md').sidecar)).toBe(false);
  });

  it('rejects a stale save and reconciles actual external content', async () => {
    const { controller, files } = await setup();
    const node = controller.document.nodes[1];
    const external = files.get('article.md')!.replace('改变总和', '改变总和（外部补充）');
    files.set('article.md', external);
    await expect(controller.dispatch({ type: 'node/update', nodeId: node.id, markdown: '过期内容' })).rejects.toThrow();
    expect(files.get('article.md')).toBe(external);
    await controller.refresh();
    expect(controller.document.nodes[1].markdown).toContain('外部补充');
    expect(controller.viewModel.canUndo).toBe(false);
  });

  it('persists a completed simulated draft, leaves it unlinked and can adopt it once', async () => {
    const { controller, io } = await setup();
    await controller.dispatch({ type: 'draft/request', nodeId: controller.document.nodes[0].id });
    await vi.waitFor(() => expect(controller.generating).toBe(false));
    await controller.close();
    const reopened = await NotebookController.open('article.md', io, new MockBackend(0));
    expect(reopened.drafts).toHaveLength(1);
    expect(reopened.drafts[0].markdown).toContain('没有调用模型');
    const id = reopened.drafts[0].id;
    await reopened.dispatch({ type: 'draft/accept', draftId: id });
    expect(reopened.document.links).toHaveLength(0);
    expect(reopened.document.nodes).toHaveLength(3);
    await expect(reopened.dispatch({ type: 'draft/accept', draftId: id })).rejects.toThrow('草稿已不存在');
  });

  it('allows editing during generation and rejects adopting an outdated result', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const backend: ModelBackend = {
      id: 'fixture', capabilities: new MockBackend().capabilities,
      async *generate(_task: WritingTask, signal: AbortSignal) {
        yield { type: 'text', text: '已生成部分' } as const;
        await gate;
        if (!signal.aborted) yield { type: 'text', text: '最终部分' } as const;
      },
    };
    const { controller } = await setup(backend);
    const node = controller.document.nodes[0];
    await controller.dispatch({ type: 'draft/request', nodeId: node.id });
    await controller.dispatch({ type: 'node/update', nodeId: node.id, markdown: node.markdown + '\n新的手写内容。\n' });
    release();
    await vi.waitFor(() => expect(controller.generating).toBe(false));
    expect(controller.viewModel.drafts?.[0].stale).toBe(true);
    await expect(controller.dispatch({ type: 'draft/accept', draftId: controller.drafts[0].id })).rejects.toThrow('生成依据已改变');
    expect(controller.document.nodes[0].markdown).toContain('新的手写内容');
  });
});
