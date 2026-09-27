import { createRoot } from 'react-dom/client';
import { applyOperation, createDocument, writeDocument } from '../../packages/core/src/index';
import { MockBackend } from '../../packages/ai/src/index';
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

const controller = await NotebookController.open(path, io, new MockBackend(400));
const root = createRoot(window.document.getElementById('root')!);
function render() {
  root.render(<Notebook document={controller.viewModel} onAction={action => controller.dispatch(action)} busy={controller.saving}
    disabledActions={['backend/settings', 'handoff/cowork', 'handoff/import']} />);
}
controller.onChange = render;
render();
window.addEventListener('beforeunload', () => controller.close());

// Exposes only a serializable snapshot for integration assertions after real UI interactions.
Object.defineProperty(window, 'explainweaveTestState', {
  get: () => ({ document: controller.document, files: Object.fromEntries(files), generating: controller.generating }),
});
