// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Notebook } from './Notebook';
import type { NotebookDocument } from './Notebook';
import { MarkdownEditor } from './editor';

beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(cleanup);

function fixture(extra: Partial<NotebookDocument> = {}): NotebookDocument {
  return {
    title: '平均数与中位数',
    sourcePath: '文章/统计直觉.md',
    nodes: [
      { id: 'n1', title: '平均数', markdown: '平均数会使用每一个数值。' },
      { id: 'n2', title: '极端值', markdown: '一个数值变大，会抬高总和，从而抬高平均数。' },
    ],
    cursorNodeId: 'n1',
    questions: [{ id: 'q1', nodeId: 'n1', text: '为什么一个极端值会影响结果？', status: 'unexplained', futureAnswerCount: 1 }],
    coverage: [{ id: 'c1', questionId: 'q1', nodeId: 'n2', quote: '一个数值变大，会抬高总和', degree: 'full' }],
    ...extra,
  };
}

describe('Notebook interactions', () => {
  it('distinguishes current explanation status from a future explanation, and opens a branch with a return position', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture()} onAction={onAction} />);
    expect(screen.getByText('未解释')).toBeTruthy();
    expect(screen.getByText('后文有解释 ↗')).toBeTruthy();
    expect(screen.queryByText('我理解了')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /为什么一个极端值会影响结果/ }));
    expect(onAction).toHaveBeenCalledWith({ type: 'branch/open', questionId: 'q1', returnNodeId: 'n1' });
    await waitFor(() => expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy());
  });

  it('collects a question in place and does not call a model', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture()} onAction={onAction} />);
    const first = within(screen.getByRole('region', { name: '平均数' }));
    fireEvent.click(first.getByRole('button', { name: '对此提问' }));
    const submit = first.getByRole('button', { name: '记录问题' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(first.getByRole('textbox', { name: '读到这里，你有什么疑问？' }), { target: { value: '平均数为什么要除以个数？' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'question/add', nodeId: 'n1', text: '平均数为什么要除以个数？' }));
    expect(onAction.mock.calls).toHaveLength(1);
    await waitFor(() => expect(first.queryByRole('textbox')).toBeNull());
  });

  it('keeps a question draft when persistence fails and displays the failure', async () => {
    const onAction = vi.fn().mockRejectedValue(new Error('保存冲突，请重新加载正文。'));
    render(<Notebook document={fixture()} onAction={onAction} />);
    const first = within(screen.getByRole('region', { name: '平均数' }));
    fireEvent.click(first.getByRole('button', { name: '对此提问' }));
    fireEvent.change(first.getByRole('textbox'), { target: { value: '这一步为什么成立？' } });
    fireEvent.click(first.getByRole('button', { name: '记录问题' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存冲突'));
    expect((first.getByRole('textbox') as HTMLTextAreaElement).value).toBe('这一步为什么成立？');
  });

  it('adds follow-up questions without creating nested editing panels', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ activeQuestionId: 'q1', branchReturnNodeId: 'n1' })} onAction={onAction} />);
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    fireEvent.click(panel.getByRole('button', { name: '继续追问' }));
    fireEvent.change(panel.getByRole('textbox', { name: '从这个问题继续追问' }), { target: { value: '如果所有值都翻倍呢？' } });
    fireEvent.click(panel.getByRole('button', { name: '记录追问' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'question/add', nodeId: 'n1', parentQuestionId: 'q1', text: '如果所有值都翻倍呢？' }));
    await waitFor(() => expect(panel.queryByRole('textbox', { name: '从这个问题继续追问' })).toBeNull());
    fireEvent.click(panel.getByRole('button', { name: '回到主线 ↩' }));
    expect(onAction).toHaveBeenLastCalledWith({ type: 'branch/close' });
  });

  it('requires an exact source quote when associating an explanation', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture()} onAction={onAction} />);
    const second = within(screen.getByRole('region', { name: '极端值' }));
    fireEvent.click(second.getByText('更多'));
    fireEvent.click(second.getByRole('button', { name: '关联前文问题的解释' }));
    const quote = second.getByRole('textbox', { name: '具体解释原文' });
    fireEvent.change(quote, { target: { value: '不在原文中的推断' } });
    expect((second.getByRole('button', { name: '关联解释' }) as HTMLButtonElement).disabled).toBe(true);
    expect(second.getByText('这段文字不在当前节点原文中，请重新选择或粘贴原文。')).toBeTruthy();
    fireEvent.change(quote, { target: { value: '会抬高总和' } });
    fireEvent.click(second.getByRole('button', { name: '关联解释' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'coverage/add', questionId: 'q1', nodeId: 'n2', quote: '会抬高总和', degree: 'partial' }));
  });

  it('keeps edits available during generation and exposes cancellation separately', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ generatingNodeId: 'n1' })} onAction={onAction} />);
    const first = within(screen.getByRole('region', { name: '平均数' }));
    expect((first.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(false);
    expect((first.getByRole('button', { name: '补充解释（模拟）' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(first.getByRole('button', { name: '取消生成' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'draft/cancel' }));
  });

  it('labels simulated drafts and prevents adoption after the context changes', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ drafts: [{ id: 'd1', nodeId: 'n1', markdown: '这是演示草稿。', stale: true }] })} onAction={onAction} />);
    expect(screen.getByText('演示内容 · 未调用模型')).toBeTruthy();
    expect((screen.getByRole('button', { name: '采用为后续解释' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'draft/discard', draftId: 'd1' }));
  });

  it('supports a continuous article view without losing questions', () => {
    render(<Notebook document={fixture()} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '连续文章' }));
    expect(screen.getByRole('button', { name: '连续文章' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: '＋ 在这里添加节点' })).toBeNull();
    expect(screen.getByRole('button', { name: /为什么一个极端值会影响结果/ })).toBeTruthy();
  });

  it('does not discard a local editor draft when parent state rerenders', async () => {
    const onAction = vi.fn();
    const { rerender } = render(<Notebook document={fixture()} onAction={onAction} />);
    const first = within(screen.getByRole('region', { name: '平均数' }));
    fireEvent.click(first.getByRole('button', { name: '编辑' }));
    const editorElement = first.getByRole('textbox', { name: '编辑 平均数' });
    const view = EditorView.findFromDOM(editorElement)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '这是中文输入。' } }));
    rerender(<Notebook document={fixture({ canUndo: true })} onAction={onAction} />);
    expect(first.getByRole('textbox', { name: '编辑 平均数' })).toBe(editorElement);
    expect(view.state.doc.toString()).toBe('平均数会使用每一个数值。这是中文输入。');
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(first.getByRole('button', { name: '保存正文' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'node/update', nodeId: 'n1', markdown: '平均数会使用每一个数值。这是中文输入。' }));
  });

  it('passes an exact CodeMirror source selection into a question', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture()} onAction={onAction} />);
    const first = within(screen.getByRole('region', { name: '平均数' }));
    fireEvent.click(first.getByRole('button', { name: '编辑' }));
    const view = EditorView.findFromDOM(first.getByRole('textbox', { name: '编辑 平均数' }))!;
    act(() => view.dispatch({ selection: { anchor: 0, head: 3 } }));
    fireEvent.click(first.getByRole('button', { name: '对选中的原文提问' }));
    fireEvent.change(first.getByRole('textbox', { name: '读到这里，你有什么疑问？' }), { target: { value: '它是什么？' } });
    fireEvent.click(first.getByRole('button', { name: '记录问题' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'question/add', nodeId: 'n1', text: '它是什么？', quote: '平均数' }));
  });

  it('uses disabled actions for unavailable features rather than clickable placeholders', () => {
    render(<Notebook document={fixture()} onAction={vi.fn()} disabledActions={['draft/request', 'node/delete']} />);
    expect(screen.getAllByRole('button', { name: '补充解释（模拟）' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('identifies the selected real backend and each draft source without claiming a simulation', () => {
    render(<Notebook document={fixture({
      backendLabel: 'DeepSeek', simulatedBackend: false,
      drafts: [{ id: 'd1', nodeId: 'n1', markdown: '来自模型的解释草稿。', simulated: false, providerLabel: 'DeepSeek' }],
      latestUsage: { inputTokens: 120, outputTokens: 40 },
    })} onAction={vi.fn()} />);
    expect(screen.getByRole('button', { name: '后端：DeepSeek' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '补充解释' })).toHaveLength(2);
    expect(screen.getByText('来源：DeepSeek')).toBeTruthy();
    expect(screen.queryByText('演示内容 · 未调用模型')).toBeNull();
    expect(screen.getByText('最近一次用量：输入 120 token · 输出 40 token · 缓存读取 未提供')).toBeTruthy();
    expect(screen.getByText('当前后端：DeepSeek')).toBeTruthy();
  });

  it('keeps a draft source independent of the current backend and distinguishes zero from unknown usage', () => {
    render(<Notebook document={fixture({
      backendLabel: 'Claude', simulatedBackend: false,
      drafts: [{ id: 'd1', nodeId: 'n1', markdown: '先前的离线演示。' },
        { id: 'd2', nodeId: 'n2', markdown: '从外部导入的草稿。', simulated: false, providerLabel: 'Cowork 导入' }],
      latestUsage: { inputTokens: 0 },
    })} onAction={vi.fn()} />);
    expect(screen.getByText('演示内容 · 未调用模型')).toBeTruthy();
    expect(screen.getByText('来源：Cowork 导入')).toBeTruthy();
    expect(screen.getByText('最近一次用量：输入 0 token · 输出 未提供 · 缓存读取 未提供')).toBeTruthy();
  });

  it('delegates backend settings, external import, and Cowork handoff to the host', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ activeQuestionId: 'q1' })} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '后端：离线演示' }));
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith({ type: 'backend/settings' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '导入外部草稿' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '导入外部草稿' }));
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith({ type: 'handoff/import' }));
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    await waitFor(() => expect((panel.getByRole('button', { name: '交给 Cowork' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(panel.getByRole('button', { name: '交给 Cowork' }));
    await waitFor(() => expect(onAction).toHaveBeenLastCalledWith({ type: 'handoff/cowork', nodeId: 'n1', questionId: 'q1' }));
  });

  it('disables host integrations when unavailable', () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture()} onAction={onAction} disabledActions={['backend/settings', 'handoff/import', 'handoff/cowork']} />);
    expect((screen.getByRole('button', { name: '后端：离线演示' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '导入外部草稿' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('button', { name: '交给 Cowork' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('article discussions, question plans and proposed explanations', () => {
  it('shows an article discussion and sends another turn without changing the reading position', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ discussions: [{ id: 'article-chat', turns: [
      { id: 'u1', role: 'user', markdown: '文章少了什么？', status: 'complete' },
      { id: 'a1', role: 'assistant', markdown: '需要解释平均数如何受总和影响。', status: 'complete', simulated: false, providerLabel: 'Claude' },
    ] }] })} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '讨论这篇文章' }));
    const panel = within(screen.getByRole('complementary', { name: '文章讨论面板' }));
    expect(panel.getByText('文章少了什么？')).toBeTruthy();
    expect(panel.getByText('需要解释平均数如何受总和影响。')).toBeTruthy();
    fireEvent.change(panel.getByRole('textbox', { name: '讨论这篇文章' }), { target: { value: '请换个更直观的例子。' } });
    fireEvent.click(panel.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'chat/send', text: '请换个更直观的例子。' }));
    await waitFor(() => expect((panel.getByRole('textbox', { name: '讨论这篇文章' }) as HTMLTextAreaElement).value).toBe(''));
    fireEvent.click(panel.getByRole('button', { name: '收起讨论' }));
    expect(screen.getByText('阅读位置：1 / 2')).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('shows inherited question context, streaming text, and cancellation without locking article edits', async () => {
    const onAction = vi.fn();
    const base = fixture();
    render(<Notebook document={fixture({
      questions: [...base.questions, { id: 'q2', nodeId: 'n1', text: '那中位数呢？', parentQuestionId: 'q1', status: 'unexplained' }],
      activeQuestionId: 'q2', generating: true, generatingDiscussionId: 'child-chat',
      discussions: [
        { id: 'parent-chat', questionId: 'q1', turns: [{ id: 'a1', role: 'assistant', markdown: '父问题的已有讨论。', status: 'complete' }] },
        { id: 'child-chat', questionId: 'q2', inheritedTurnIds: ['a1'], turns: [{ id: 'a2', role: 'assistant', markdown: '中位数关注位置', status: 'streaming' }] },
      ],
    })} onAction={onAction} />);
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    expect(panel.getByText('继承父问题讨论 · 1 条记录')).toBeTruthy();
    expect(panel.getByText('中位数关注位置')).toBeTruthy();
    expect((panel.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByRole('region', { name: '平均数' })).getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(panel.getByRole('button', { name: '取消回答' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'draft/cancel' }));
  });

  it('converts discussion into a preview at a chosen insertion position', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ discussions: [{ id: 'article-chat', turns: [
      { id: 'a1', role: 'assistant', markdown: '这段讨论可以整理为解释。', status: 'complete' },
    ] }] })} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '讨论这篇文章' }));
    const panel = within(screen.getByRole('complementary', { name: '文章讨论面板' }));
    fireEvent.click(panel.getByRole('button', { name: '整理成正文节点' }));
    fireEvent.change(panel.getByRole('combobox', { name: '插入到哪个节点之后？' }), { target: { value: 'n2' } });
    fireEvent.change(panel.getByRole('textbox', { name: '整理要求（可选）' }), { target: { value: '保留刚才的例子。' } });
    fireEvent.click(panel.getByRole('button', { name: '生成正文草稿' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'chat/compose', nodeId: 'n2', instruction: '保留刚才的例子。' }));
    expect(screen.getByText('2 个节点 · 1 个问题')).toBeTruthy();
  });

  it('lets an insertion start with an AI writing intention instead of manually written content', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture()} onAction={onAction} />);
    const first = within(screen.getByRole('region', { name: '平均数' }));
    fireEvent.click(first.getByRole('button', { name: '用 AI 写节点' }));
    fireEvent.change(first.getByRole('textbox', { name: '希望这里解释什么？' }), { target: { value: '用三个数解释求平均。' } });
    fireEvent.click(first.getByRole('button', { name: '生成节点草稿' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'draft/request', nodeId: 'n1', instruction: '用三个数解释求平均。' }));
  });

  it('offers only later nodes for a question plan and records a pending intention', async () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ activeQuestionId: 'q1' })} onAction={onAction} />);
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    fireEvent.click(panel.getByRole('button', { name: '安排在后续节点解释' }));
    const target = panel.getByRole('combobox', { name: '安排在哪个后续节点？' });
    expect(within(target).getAllByRole('option').map(option => option.textContent)).toEqual(['极端值']);
    fireEvent.change(panel.getByRole('textbox', { name: '安排原因（可选）' }), { target: { value: '先引入总和，再解释影响。' } });
    fireEvent.click(panel.getByRole('button', { name: '保存安排' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'question/defer', questionId: 'q1', nodeId: 'n2', reason: '先引入总和，再解释影响。' }));
    expect(panel.getByText('未解释')).toBeTruthy();
  });

  it('collects planned questions at the target node and flags plans after a question changes', async () => {
    const onAction = vi.fn();
    const base = fixture();
    const document = fixture({ questions: [{ ...base.questions[0], revision: 1 }], plans: [{ questionId: 'q1', questionRevision: 1, nodeId: 'n2' }] });
    const { rerender } = render(<Notebook document={document} onAction={onAction} />);
    const second = within(screen.getByRole('region', { name: '极端值' }));
    expect(second.getByText('待处理')).toBeTruthy();
    fireEvent.click(second.getByRole('button', { name: '解释这些问题' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'draft/request', nodeId: 'n2', questionIds: ['q1'] }));
    rerender(<Notebook document={{ ...document, questions: [{ ...document.questions[0], revision: 2 }] }} onAction={onAction} />);
    expect(second.getByText('安排待检查')).toBeTruthy();
    expect((second.getByRole('button', { name: '解释这些问题' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks a reordered plan stale even when the question revision is unchanged', () => {
    const base = fixture();
    render(<Notebook document={fixture({
      nodes: [base.nodes[1], base.nodes[0]], activeQuestionId: 'q1',
      questions: [{ ...base.questions[0], revision: 3 }],
      plans: [{ questionId: 'q1', questionRevision: 3, nodeId: 'n2', reason: '先讲完前置背景。' }],
    })} onAction={vi.fn()} />);
    const target = within(screen.getByRole('region', { name: '极端值' }));
    expect(target.getByText('安排待检查')).toBeTruthy();
    expect((target.getByRole('button', { name: '解释这些问题' }) as HTMLButtonElement).disabled).toBe(true);
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    expect(panel.getByText('安排待检查：问题或节点位置已改变，请重新安排。')).toBeTruthy();
    expect(panel.getByText('后面还没有节点，可以先添加一个后续节点。')).toBeTruthy();
    expect(panel.getByText('未解释')).toBeTruthy();
    expect((panel.getByRole('button', { name: '取消安排' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('returns from a child question to the original answer while preserving the main return position', async () => {
    const onAction = vi.fn();
    const base = fixture();
    const document = fixture({
      questions: [...base.questions, { id: 'q2', nodeId: 'n1', text: '如果样本有权重呢？', parentQuestionId: 'q1', status: 'unexplained' }],
      activeQuestionId: 'q2', branchReturnNodeId: 'n2', cursorNodeId: 'n2',
      discussions: [
        { id: 'parent-chat', questionId: 'q1', turns: [{ id: 'a1', role: 'assistant', markdown: '最初的回答仍然留在父问题中。', status: 'complete' }] },
        { id: 'child-chat', questionId: 'q2', inheritedTurnIds: ['a1'], turns: [{ id: 'a2', role: 'assistant', markdown: '加权平均的独立讨论。', status: 'complete' }] },
      ],
    });
    const { rerender } = render(<Notebook document={document} onAction={onAction} />);
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    expect(panel.getByText('加权平均的独立讨论。')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: /上一个问题：为什么一个极端值会影响结果/ }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'branch/open', questionId: 'q1', returnNodeId: 'n2' }));
    rerender(<Notebook document={{ ...document, activeQuestionId: 'q1' }} onAction={onAction} />);
    const returnedPanel = within(screen.getByRole('complementary', { name: '问题支线' }));
    expect(returnedPanel.getByText('最初的回答仍然留在父问题中。')).toBeTruthy();
    expect(returnedPanel.queryByText('加权平均的独立讨论。')).toBeNull();
    expect(screen.getByText('阅读位置：2 / 2')).toBeTruthy();
  });

  it('keeps inherited context frozen when the parent later adds turns, but allows returning to read them', async () => {
    const onAction = vi.fn();
    const base = fixture();
    const document = fixture({
      questions: [...base.questions, { id: 'q2', nodeId: 'n1', text: '继续解释中位数。', parentQuestionId: 'q1', status: 'unexplained' }],
      activeQuestionId: 'q2', branchReturnNodeId: 'n2',
      discussions: [
        { id: 'parent-chat', questionId: 'q1', turns: [{ id: 'a1', role: 'assistant', markdown: '分支创建时的父回答。', status: 'complete' }] },
        { id: 'child-chat', questionId: 'q2', inheritedTurnIds: ['a1'], turns: [{ id: 'a2', role: 'assistant', markdown: '已有的子分支回答。', status: 'complete' }] },
      ],
    });
    const { rerender } = render(<Notebook document={document} onAction={onAction} />);
    fireEvent.click(screen.getByText('继承父问题讨论 · 1 条记录'));
    expect(screen.getByText('分支创建时的父回答。')).toBeTruthy();
    const updated: NotebookDocument = { ...document, discussions: [
      { ...document.discussions![0], turns: [...document.discussions![0].turns,
        { id: 'a3', role: 'assistant', markdown: '父讨论后来新增的回答。', status: 'complete' }] },
      document.discussions![1],
    ] };
    rerender(<Notebook document={updated} onAction={onAction} />);
    expect(screen.getByText('继承父问题讨论 · 1 条记录')).toBeTruthy();
    expect(screen.queryByText('父讨论后来新增的回答。')).toBeNull();
    const panel = within(screen.getByRole('complementary', { name: '问题支线' }));
    fireEvent.click(panel.getByRole('button', { name: /上一个问题：为什么一个极端值会影响结果/ }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'branch/open', questionId: 'q1', returnNodeId: 'n2' }));
    rerender(<Notebook document={{ ...updated, activeQuestionId: 'q1' }} onAction={onAction} />);
    expect(screen.getByText('父讨论后来新增的回答。')).toBeTruthy();
  });

  it('previews ancestors before a first send but does not invent inheritance for an empty snapshot', () => {
    const base = fixture();
    const document = fixture({
      questions: [...base.questions, { id: 'q2', nodeId: 'n1', text: '新的支线。', parentQuestionId: 'q1', status: 'unexplained' }],
      activeQuestionId: 'q2', discussions: [{ id: 'parent-chat', questionId: 'q1', turns: [
        { id: 'a1', role: 'assistant', markdown: '当前可继承的父回答。', status: 'complete' },
      ] }],
    });
    const { rerender } = render(<Notebook document={document} onAction={vi.fn()} />);
    expect(screen.getByText('继承父问题讨论 · 1 条记录')).toBeTruthy();
    rerender(<Notebook document={{ ...document, discussions: [...document.discussions!, {
      id: 'child-chat', questionId: 'q2', inheritedTurnIds: [], turns: [],
    }] }} onAction={vi.fn()} />);
    expect(screen.queryByText('继承父问题讨论 · 1 条记录')).toBeNull();
    expect(screen.queryByText('当前可继承的父回答。')).toBeNull();
  });

  it('describes AI coverage as a proposal and blocks malformed drafts', () => {
    const onAction = vi.fn();
    render(<Notebook document={fixture({ drafts: [{
      id: 'd1', nodeId: 'n1', markdown: '抬高总和会影响平均数。',
      explanations: [{ questionId: 'q1', quote: '抬高总和会影响平均数。', coverage: 'full' }],
      validationError: '草稿返回格式不完整，请重新生成。',
    }] })} onAction={onAction} />);
    expect(screen.getByText('拟完整解释')).toBeTruthy();
    expect(screen.getByText('采用正文时会同时建立这些解释关联；草稿尚未改变问题状态。')).toBeTruthy();
    expect(screen.getByText('未解释')).toBeTruthy();
    expect((screen.getByRole('button', { name: '采用为后续解释' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '采用为后续解释' }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('hides incomplete structured output while composing instead of displaying JSON as an answer', () => {
    render(<Notebook document={fixture({ generating: true, generatingNodeId: 'n1', generatingDiscussionId: 'article-chat',
      drafts: [{ id: 'd1', nodeId: 'n1', markdown: '{"markdown":"unfinished' }],
      discussions: [{ id: 'article-chat', turns: [{ id: 'a1', role: 'assistant', kind: 'compose', markdown: '{"markdown":"unfinished', status: 'streaming' }] }],
    })} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '讨论这篇文章' }));
    expect(screen.queryByText('{"markdown":"unfinished')).toBeNull();
    expect(screen.getByText('正在组织候选节点与解释关联…')).toBeTruthy();
    expect(screen.getByText('正在组织候选正文与解释关联…')).toBeTruthy();
  });
});

describe('MarkdownEditor lifecycle', () => {
  it('preserves the editor instance across rerenders while using updated callbacks', () => {
    const firstChange = vi.fn();
    const secondChange = vi.fn();
    const { rerender } = render(<MarkdownEditor initialValue="原文" label="原文编辑器" onChange={firstChange} />);
    const element = screen.getByRole('textbox', { name: '原文编辑器' });
    const view = EditorView.findFromDOM(element)!;
    act(() => view.dispatch({ changes: { from: 2, insert: '中文' } }));
    rerender(<MarkdownEditor initialValue="不会替换现有草稿" label="原文编辑器" onChange={secondChange} />);
    act(() => view.dispatch({ changes: { from: 4, insert: '输入' } }));
    expect(screen.getByRole('textbox', { name: '原文编辑器' })).toBe(element);
    expect(firstChange).toHaveBeenCalledWith('原文中文');
    expect(secondChange).toHaveBeenCalledWith('原文中文输入');
  });
});
