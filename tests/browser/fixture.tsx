import { createRoot } from 'react-dom/client';
import { applyOperation, createDocument, writeDocument } from '../../packages/core/src/index';
import { MockBackend, type ModelBackend } from '../../packages/ai/src/index';
import { Notebook } from '../../apps/obsidian/src/Notebook';
import { NotebookController } from '../../apps/obsidian/src/controller';
import type { FileIO } from '../../apps/obsidian/src/storage';
import '../../apps/obsidian/styles.css';
import './fixture.css';

// This fixture uses the real controller and domain/storage layers, but never reads a Vault.
const path = '演示/平均数与中位数.md';
let document = createDocument('# 平均数\n\n平均数会使用每一个数值。把所有数加起来，再除以个数。\n\n');
document = applyOperation(document, {
  type: 'insert-node', index: 1,
  markdown: '# 极端值\n\n一个数值变大，会抬高总和，从而抬高平均数。即使其他数没有变化，这一步也会改变结果。\n\n',
}).document;
document = applyOperation(document, {
  type: 'insert-node', index: 2,
  markdown: '# 中位数\n\n如果我们关心的是排序中间的位置，就可以观察中位数。这个选择回答了一个不同的问题。\n',
}).document;
const initial = writeDocument(document);
const files = new Map([[path, initial.markdown], ['演示/平均数与中位数.explainweave.json', initial.metadata]]);
const io: FileIO = {
  async read(filename) { return files.get(filename) ?? null; },
  async write(filename, content) { files.set(filename, content); },
  async remove(filename) { files.delete(filename); },
};

// A deterministic test provider exercises the non-simulated proposal adoption
// branch without making a network call. The fixture banner names it as a test.
const proposalFixture: ModelBackend = {
  id: 'browser-test-fixture', capabilities: new MockBackend().capabilities,
  async *generate(task, signal) {
    const questions = task.context.flatMap(block => {
      try { const value = JSON.parse(block.text); return value.kind === 'article-question' ? [value] : []; }
      catch { return []; }
    });
    const quote = '一个数值增大会提高总和，而个数不变，所以平均数也会增大。';
    const markdown = `# 候选解释\n\n${quote}\n\n这是固定测试输出，没有调用模型。\n`;
    const output = task.mode === 'compose' ? JSON.stringify({
      markdown, explanations: questions.map(question => ({ questionId: question.id, quote, coverage: 'full' })), deferred: [],
    }) : `固定测试回答：${task.instruction}\n\n本次带入 ${task.history?.filter(turn => turn.role === 'assistant').length ?? 0} 条先前回答。没有调用模型。`;
    for (const text of output.match(/[\s\S]{1,40}/gu) ?? []) {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      yield { type: 'text', text };
    }
    yield { type: 'done', backendId: 'browser-test-fixture', simulated: false };
  },
};
const backend = new URLSearchParams(location.search).get('backend') === 'fixture' ? proposalFixture : new MockBackend(400);
let controller = await NotebookController.open(path, io, backend);
let sessionKey = 0;
const root = createRoot(window.document.getElementById('root')!);
function render() {
  root.render(<Notebook key={sessionKey} document={controller.viewModel} onAction={action => controller.dispatch(action)} busy={controller.saving}
    disabledActions={['backend/settings', 'handoff/cowork', 'handoff/import']} />);
}
controller.onChange = render;
render();
window.addEventListener('beforeunload', () => controller.close());

// Exposes only a serializable snapshot for integration assertions after real UI interactions.
Object.defineProperty(window, 'explainweaveTestState', {
  get: () => ({ document: controller.document, session: controller.session, drafts: controller.drafts, files: Object.fromEntries(files), generating: controller.generating }),
});
Object.defineProperty(window, 'reopenExplainweaveFixture', { value: async () => {
  await controller.close();
  controller = await NotebookController.open(path, io, backend);
  controller.onChange = render;
  sessionKey += 1;
  render();
} });
