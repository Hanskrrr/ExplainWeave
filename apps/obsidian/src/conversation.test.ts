import { describe, expect, it, vi } from 'vitest';
import { buildTaskMessages, MockBackend, type ModelBackend, type WritingTask } from '@explainweave/ai';
import { NotebookController } from './controller';
import type { FileIO } from './storage';

const original = '# 平均值\n\n平均值是总和除以个数。\n\n## 异常值\n\n接下来讨论异常值。\n\n## 中位数\n\n再介绍中位数。\n';
function fixture(reply: (task: WritingTask) => string = task => task.mode === 'chat' ? '平均值使用所有数值，所以极端值会改变总和。' : JSON.stringify({ markdown: '新增解释。\n', explanations: [], deferred: [] })) {
  const files = new Map([['article.md', original]]);
  const io: FileIO = { read: async path => files.get(path) ?? null, write: async (path, text) => { files.set(path, text); }, remove: async path => { files.delete(path); } };
  const requests: WritingTask[] = [];
  const backend: ModelBackend = { id: 'fixture-real', capabilities: new MockBackend().capabilities,
    async *generate(task) { requests.push(structuredClone(task)); yield { type: 'text', text: reply(task) }; yield { type: 'done', backendId: 'fixture-real', simulated: false }; } };
  return { files, io, requests, backend };
}
async function open(options: ReturnType<typeof fixture>) {
  const c = await NotebookController.open('article.md', options.io, options.backend);
  if (c.needsInitialization) await c.initialize();
  return c;
}
async function finish(c: NotebookController) { await vi.waitFor(() => expect(c.generating).toBe(false)); }
async function question(c: NotebookController, text = '为什么会受极端值影响？') {
  await c.dispatch({ type: 'question/add', nodeId: c.document.nodes[0].id, text });
  return c.document.questions.at(-1)!;
}

describe('article discussion, question branches and authored explanations', () => {
  it('retains unadopted assistant answers across article turns and reopening', async () => {
    const f = fixture(); const c = await open(f);
    await c.dispatch({ type: 'chat/send', text: '解释一下这篇文章的主线' }); await finish(c);
    expect(c.document.nodes).toHaveLength(3);
    expect(c.document.links).toHaveLength(0);
    await c.close();
    const reopened = await open(f);
    await reopened.dispatch({ type: 'chat/send', text: '把你刚才的回答展开一下' }); await finish(reopened);
    expect(f.requests[1].history).toEqual([...buildTaskMessages(f.requests[0]),
      { role: 'assistant', content: '平均值使用所有数值，所以极端值会改变总和。' },
    ]);
    expect(reopened.viewModel.discussions?.[0].turns).toHaveLength(4);
    await reopened.close();
  });

  it('includes parent answers when following up, without leaking sibling discussions', async () => {
    const f = fixture(task => `针对 ${task.question} 的详细回答`); const c = await open(f);
    const parent = await question(c);
    await c.dispatch({ type: 'chat/send', questionId: parent.id, text: parent.text }); await finish(c);
    const sibling = await question(c, '什么是中位数？');
    await c.dispatch({ type: 'chat/send', questionId: sibling.id, text: sibling.text }); await finish(c);
    await c.dispatch({ type: 'question/add', nodeId: parent.nodeId, parentQuestionId: parent.id, text: '为什么总和会变化？' });
    const child = c.document.questions.at(-1)!;
    await c.dispatch({ type: 'chat/send', questionId: child.id, text: child.text }); await finish(c);
    expect(f.requests[2].history?.map(turn => turn.content)).toContain(`针对 ${parent.text} 的详细回答`);
    expect(f.requests[2].history?.map(turn => turn.content)).not.toContain(`针对 ${sibling.text} 的详细回答`);
    await c.close();
  });

  it('turns a discussion into a candidate, then atomically adopts passage and AI evidence', async () => {
    let qid = '';
    const f = fixture(task => task.mode === 'chat' ? '还未插入正文的回答。' : JSON.stringify({ markdown: '极端值增大总和，因此平均值上升。\n', explanations: [{ questionId: qid, quote: '极端值增大总和', coverage: 'full' }], deferred: [] }));
    const c = await open(f); const q = await question(c); qid = q.id;
    await c.dispatch({ type: 'chat/send', questionId: q.id, text: q.text }); await finish(c);
    await c.dispatch({ type: 'chat/compose', questionId: q.id, nodeId: c.document.nodes[1].id }); await finish(c);
    expect(f.requests[1].history?.some(turn => turn.content === '还未插入正文的回答。')).toBe(true);
    expect(c.document.links).toHaveLength(0);
    expect(c.drafts[0].explanations).toHaveLength(1);
    await c.dispatch({ type: 'draft/accept', draftId: c.drafts[0].id });
    expect(c.document.nodes).toHaveLength(4);
    expect(c.document.links[0]).toMatchObject({ source: 'ai', questionId: q.id, quote: '极端值增大总和' });
    expect(c.viewModel.questions[0]).toMatchObject({ status: 'unexplained', futureAnswerCount: 1 });
    await c.dispatch({ type: 'node/read', nodeId: c.document.nodes[2].id });
    expect(c.viewModel.questions[0].status).toBe('explained');
    await c.dispatch({ type: 'history/undo' });
    expect(c.document.nodes).toHaveLength(3); expect(c.document.links).toHaveLength(0);
    await c.close();
  });

  it('plans a later explanation, brings its discussion to that node, and keeps it pending', async () => {
    const f = fixture(); const c = await open(f); const q = await question(c);
    await c.dispatch({ type: 'chat/send', questionId: q.id, text: q.text }); await finish(c);
    const target = c.document.nodes[1].id;
    await c.dispatch({ type: 'question/defer', questionId: q.id, nodeId: target, reason: '先介绍异常值' });
    expect(c.viewModel.questions[0].status).toBe('unexplained');
    await c.dispatch({ type: 'draft/request', nodeId: target }); await finish(c);
    expect(f.requests[1].instruction).toContain(q.id);
    expect(f.requests[1].history?.some(turn => turn.content.includes('平均值使用所有数值'))).toBe(true);
    await c.close();
    const reopened = await open(f);
    expect(reopened.viewModel.plans).toEqual([{ questionId: q.id, questionRevision: q.revision, nodeId: target, reason: '先介绍异常值' }]);
    await reopened.dispatch({ type: 'question/update', questionId: q.id, text: '什么情况下不受影响？' });
    await reopened.dispatch({ type: 'draft/request', nodeId: target }); await finish(reopened);
    expect(f.requests[2].instruction).not.toContain(q.id);
    await reopened.close();
  });

  it('appends middle edits and restored journal updates without rewriting old prefix', async () => {
    const f = fixture(); const c = await open(f);
    await c.dispatch({ type: 'chat/send', text: '先阅读文章' }); await finish(c);
    const prefix = f.requests[0].contextJournal!;
    const node = c.document.nodes[1];
    await c.dispatch({ type: 'node/update', nodeId: node.id, markdown: '## 异常值\n\n这里有新的解释。\n' });
    await c.close(); const reopened = await open(f);
    await reopened.dispatch({ type: 'chat/send', text: '针对我修改的部分继续' }); await finish(reopened);
    expect(f.requests[1].contextJournal?.startsWith(prefix)).toBe(true);
    expect(f.requests[1].contextJournal?.slice(prefix.length)).toContain('这里有新的解释');
    expect(buildTaskMessages(f.requests[1]).slice(0, buildTaskMessages(f.requests[0]).length)).toEqual(buildTaskMessages(f.requests[0]));
    expect(f.requests[1].contextJournalDelta).toContain('这里有新的解释');
    await reopened.close();
  });

  it.each([
    { markdown: '解释。', explanations: [{ questionId: 'missing', quote: '解释', coverage: 'full' }], deferred: [] },
    { markdown: '解释。', explanations: [], deferred: [{ questionId: 'missing', nodeId: 'missing' }] },
  ])('does not accept ungrounded model relations: %j', async proposal => {
    const f = fixture(() => JSON.stringify(proposal)); const c = await open(f); await question(c);
    await c.dispatch({ type: 'draft/request', nodeId: c.document.nodes[1].id }); await finish(c);
    expect(c.drafts[0].validationError).toBeTruthy();
    await expect(c.dispatch({ type: 'draft/accept', draftId: c.drafts[0].id })).rejects.toThrow('校验');
    expect(c.document.links).toHaveLength(0); expect(c.document.nodes).toHaveLength(3);
    await c.close();
  });

  it('rejects stale automatic evidence after editing the question', async () => {
    let qid = '';
    const f = fixture(() => JSON.stringify({ markdown: '总和变化。', explanations: [{ questionId: qid, quote: '总和变化', coverage: 'full' }], deferred: [] }));
    const c = await open(f); const q = await question(c); qid = q.id;
    await c.dispatch({ type: 'draft/request', nodeId: q.nodeId, questionId: q.id }); await finish(c);
    await c.dispatch({ type: 'question/update', questionId: q.id, text: '为什么中位数不变？' });
    await expect(c.dispatch({ type: 'draft/accept', draftId: c.drafts[0].id })).rejects.toThrow('生成依据已改变');
    expect(c.document.links).toHaveLength(0); await c.close();
  });

  it('persists partial cancelled conversation and identifies it in the next request', async () => {
    const f = fixture(); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.backend.generate = async function* (_task, signal) {
      yield { type: 'text', text: '已收到的半句' }; started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    const c = await open(f);
    await c.dispatch({ type: 'chat/send', text: '解释一下' }); await ready;
    await c.dispatch({ type: 'draft/cancel' }); await finish(c); await c.close();
    f.backend.generate = async function* (task) { f.requests.push(task); yield { type: 'text', text: '继续回答' }; };
    const reopened = await open(f);
    expect(reopened.viewModel.discussions?.[0].turns[1]).toMatchObject({ status: 'cancelled', markdown: '已收到的半句' });
    await reopened.dispatch({ type: 'chat/send', text: '继续' }); await finish(reopened);
    expect(f.requests[0].history?.at(-1)?.content).toContain('未完成'); await reopened.close();
  });

  it('refuses requests if saving their conversation would overwrite external changes', async () => {
    const f = fixture(); const c = await open(f);
    await c.dispatch({ type: 'chat/send', text: '第一问' }); await finish(c);
    f.files.set('article.explainweave.sessions.json', '{"external":true}');
    await expect(c.dispatch({ type: 'chat/send', text: '不能丢掉别人的内容' })).rejects.toThrow('外部');
    expect(f.requests).toHaveLength(1);
    expect(f.files.get('article.explainweave.sessions.json')).toBe('{"external":true}');
    await c.close();
  });
  it('keeps a child branch stable when its parent has later discussion', async () => {
    const f = fixture(); const c = await open(f); const parent = await question(c);
    await c.dispatch({ type: 'chat/send', questionId: parent.id, text: '父问题第一轮' }); await finish(c);
    await c.dispatch({ type: 'question/add', nodeId: parent.nodeId, parentQuestionId: parent.id, text: '子问题' });
    const child = c.document.questions.at(-1)!;
    await c.dispatch({ type: 'chat/send', questionId: child.id, text: '子问题第一轮' }); await finish(c);
    const oldChildMessages = buildTaskMessages(f.requests[1]);
    await c.dispatch({ type: 'chat/send', questionId: parent.id, text: '这条父问题新消息不应插入旧子分支' }); await finish(c);
    await c.dispatch({ type: 'chat/send', questionId: child.id, text: '子问题第二轮' }); await finish(c);
    expect(buildTaskMessages(f.requests[3]).slice(0, oldChildMessages.length)).toEqual(oldChildMessages);
    expect(f.requests[3].history?.some(turn => turn.content.includes('这条父问题新消息'))).toBe(false);
    await c.close();
  });

  it('handles a long article without embedding the whole article in a version field', async () => {
    const f = fixture(); f.files.set('article.md', original + '这是长文章里的解释段落。'.repeat(1000));
    const c = await open(f);
    await c.dispatch({ type: 'chat/send', text: '讨论长文章' }); await finish(c);
    expect(c.session.discussions[0].turns[1].basedOn?.length).toBe(64);
    expect(f.requests).toHaveLength(1); await c.close();
  });

  it('revalidates restored AI plans before any document write', async () => {
    const f = fixture(); const c = await open(f); const q = await question(c);
    await c.dispatch({ type: 'draft/request', nodeId: q.nodeId }); await finish(c); await c.close();
    const path = 'article.explainweave.drafts.json';
    const saved = JSON.parse(f.files.get(path)!);
    saved.drafts[0].deferred = [{ questionId: q.id, nodeId: 'missing-node' }];
    f.files.set(path, JSON.stringify(saved));
    const reopened = await open(f); const before = f.files.get('article.md');
    await expect(reopened.dispatch({ type: 'draft/accept', draftId: reopened.drafts[0].id })).rejects.toThrow('位置无效');
    expect(f.files.get('article.md')).toBe(before); expect(reopened.drafts).toHaveLength(1);
    await reopened.close();
  });

  it('keeps streaming turn references alive while the user plans a later answer', async () => {
    const f = fixture(); let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.backend.generate = async function* () {
      yield { type: 'text', text: '开始' }; started(); await gate;
      yield { type: 'text', text: '继续到结尾' };
    };
    const c = await open(f); const q = await question(c);
    await c.dispatch({ type: 'chat/send', questionId: q.id, text: q.text }); await ready;
    await c.dispatch({ type: 'question/defer', questionId: q.id, nodeId: c.document.nodes[1].id });
    release(); await finish(c); await c.close();
    const reopened = await open(f);
    expect(reopened.session.discussions[0].turns[1].markdown).toBe('开始继续到结尾');
    expect(reopened.session.discussions[0].transcript?.at(-1)?.content).toBe('开始继续到结尾');
    await reopened.close();
  });

  it('deduplicates the shared parent discussion in a batch of carried questions', async () => {
    const f = fixture(task => task.mode === 'chat' ? '这条父回答只应出现一次。' : JSON.stringify({ markdown: '补充解释', explanations: [], deferred: [] }));
    const c = await open(f); const parent = await question(c);
    await c.dispatch({ type: 'chat/send', questionId: parent.id, text: parent.text }); await finish(c);
    await c.dispatch({ type: 'question/add', nodeId: parent.nodeId, parentQuestionId: parent.id, text: '子问题' });
    const child = c.document.questions.at(-1)!;
    await c.dispatch({ type: 'draft/request', nodeId: c.document.nodes[1].id, questionIds: [parent.id, child.id] }); await finish(c);
    const reference = f.requests[1].history!.find(turn => turn.content.startsWith('Related question discussions'))!.content;
    expect(reference.match(/这条父回答只应出现一次。/g)).toHaveLength(1);
    await c.close();
  });

  it('preserves adoption of unchanged 0.1 plain Markdown drafts', async () => {
    const f = fixture(); const c = await open(f);
    const legacyVersion = JSON.stringify({ nodes: c.document.nodes, questions: c.document.questions, prefix: c.document.prefix });
    f.files.set('article.explainweave.drafts.json', JSON.stringify({ schemaVersion: 1, drafts: [{
      id: 'legacy-draft', nodeId: c.document.nodes[0].id, markdown: '旧版本保留的候选解释。',
      basedOn: legacyVersion, reason: '旧草稿', stale: false, simulated: true,
    }] }));
    await c.close(); const reopened = await open(f);
    expect(reopened.viewModel.drafts?.[0].stale).toBe(false);
    await reopened.dispatch({ type: 'draft/accept', draftId: 'legacy-draft' });
    expect(reopened.document.nodes[1].markdown).toContain('旧版本保留的候选解释');
    expect(reopened.document.links).toHaveLength(0); await reopened.close();
  });

});
