import { describe, expect, it, vi } from 'vitest';
import { MockBackend, type ModelBackend } from '@explainweave/ai';
import { NotebookController } from './controller';
import type { FileIO } from './storage';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function memory(beforeWrite?: (path: string) => Promise<void>) {
  const files = new Map([['article.md', '原始正文。\n']]);
  const io: FileIO = {
    async read(path) { return files.get(path) ?? null; },
    async write(path, content) { await beforeWrite?.(path); files.set(path, content); },
    async remove(path) { files.delete(path); },
  };
  return { io, files };
}

describe('controller shutdown and concurrent draft persistence', () => {
  it('flushes a save submitted immediately before closing the view', async () => {
    const { io, files } = memory();
    const controller = await NotebookController.open('article.md', io);
    await controller.initialize();
    // Do not await dispatch: closing a tab can occur before its queued edit starts.
    const save = controller.dispatch({
      type: 'node/update', nodeId: controller.document.nodes[0].id, markdown: '已经点击保存的修改。\n',
    });
    const outcome = save.then(() => ({ saved: true }), error => ({ saved: false, error: String(error) }));
    await controller.close();
    expect(await outcome).toEqual({ saved: true });
    expect(files.get('article.md')).toContain('已经点击保存的修改。');
  });

  it('preserves an imported draft when generation completes during its disk save', async () => {
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const finishGeneration = deferred();
    let firstDraftWrite = true;
    const { io, files } = memory(async path => {
      if (path.endsWith('.drafts.json') && firstDraftWrite) {
        firstDraftWrite = false;
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
    });
    const backend: ModelBackend = {
      id: 'offline-demo', capabilities: new MockBackend().capabilities,
      async *generate() {
        yield { type: 'text', text: '流式生成的解释。\n' };
        await finishGeneration.promise;
        yield { type: 'done', backendId: 'offline-demo', simulated: true };
      },
    };
    const controller = await NotebookController.open('article.md', io, backend);
    await controller.initialize();
    const nodeId = controller.document.nodes[0].id;
    await controller.dispatch({ type: 'draft/request', nodeId });
    await vi.waitFor(() => expect(controller.drafts[0].markdown).toContain('流式生成'));
    const importing = controller.receiveExternalDraft({
      taskId: 'cowork-return', nodeId, markdown: '从 Cowork 返回的解释。\n',
    });
    await firstWriteStarted.promise;
    // The old implementation captured a second snapshot before import reached
    // its in-memory commit, then queued that older array over the imported file.
    finishGeneration.resolve();
    await vi.waitFor(() => expect(controller.generating).toBe(false));
    releaseFirstWrite.resolve();
    await importing;
    await controller.close();
    const saved = JSON.parse(files.get('article.explainweave.drafts.json')!) as { drafts: { id: string }[] };
    expect(controller.drafts).toHaveLength(2);
    expect(saved.drafts).toHaveLength(2);
    expect(saved.drafts.some(draft => draft.id === 'cowork-return')).toBe(true);
    const reopened = await NotebookController.open('article.md', io);
    expect(reopened.drafts).toHaveLength(2);
    await reopened.close();
  });
});
