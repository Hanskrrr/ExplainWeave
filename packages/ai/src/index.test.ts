import { describe, expect, it } from 'vitest';
import { ContextJournal, MockBackend, parseWritingProposal, type WritingTask } from './index';

const task: WritingTask = { id: 'task-1', instruction: '补充说明', targetNodeId: 'a', context: [{ id: 'a', revision: '1', text: '原文' }] };

describe('offline backend', () => {
  it('labels output as simulated and never reports invented usage', async () => {
    const backend = new MockBackend(0);
    const events = [];
    for await (const event of backend.generate(task, new AbortController().signal)) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'done', backendId: 'offline-demo', simulated: true });
    expect(backend.capabilities.usageReporting).toBe(false);
    expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toContain('没有调用模型');
  });
  it('does not emit completion after cancellation', async () => {
    const controller = new AbortController();
    const stream = new MockBackend(0).generate(task, controller.signal)[Symbol.asyncIterator]();
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('returns structured compose suggestions without inventing explanation links', async () => {
    let output = '';
    for await (const event of new MockBackend(0).generate({ ...task, mode: 'compose' }, new AbortController().signal)) {
      if (event.type === 'text') output += event.text;
    }
    const proposal = parseWritingProposal(output);
    expect(proposal.markdown).toContain('没有调用模型');
    expect(proposal.explanations).toEqual([]);
    expect(proposal.deferred).toEqual([]);
  });
  it('keeps chat replies conversational and explicitly simulated', async () => {
    let output = '';
    for await (const event of new MockBackend(0).generate({ ...task, mode: 'chat', history: [{ role: 'user', content: '先前问题' }] }, new AbortController().signal)) {
      if (event.type === 'text') output += event.text;
    }
    expect(output).toContain('模拟回答');
    expect(output).toContain('1 条历史消息');
    expect(() => parseWritingProposal(output)).toThrow();
  });
});

it('appends revisions without changing an earlier serialized prefix', () => {
  const journal = new ContextJournal();
  const first = journal.append(task);
  const second = journal.append({ ...task, context: [{ id: 'a', revision: '2', text: '修改后的正文' }] });
  expect(second.startsWith(first)).toBe(true);
  expect(second).toContain('原文');
  expect(second).toContain('修改后的正文');
  const snapshot = journal.checkpoint({ ...task, context: [{ id: 'a', revision: '2', text: '修改后的正文' }] });
  expect(snapshot).not.toContain('原文');
});
