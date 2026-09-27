import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { MarkdownEditor } from './editor';

export type QuestionStatus = 'unexplained' | 'partial' | 'explained' | 'review';
export interface NotebookNode { id: string; title: string; markdown: string }
export interface NotebookQuestion {
  id: string; nodeId: string; text: string; parentQuestionId?: string; quote?: string;
  status: QuestionStatus; futureAnswerCount?: number;
}
export interface NotebookCoverage {
  id: string; questionId: string; nodeId: string; quote: string;
  degree: 'partial' | 'full'; stale?: boolean;
}
export interface NotebookDraft {
  id: string; nodeId: string; markdown: string; questionId?: string; reason?: string; stale?: boolean;
  simulated?: boolean; providerLabel?: string;
}
export interface NotebookDocument {
  title: string; sourcePath?: string; nodes: NotebookNode[]; questions: NotebookQuestion[];
  coverage: NotebookCoverage[]; cursorNodeId?: string; branchReturnNodeId?: string;
  activeQuestionId?: string; drafts?: NotebookDraft[]; canUndo?: boolean; warning?: string;
  generatingNodeId?: string;
  backendLabel?: string; simulatedBackend?: boolean;
  latestUsage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
}
export type NotebookAction =
  | { type: 'node/read'; nodeId: string }
  | { type: 'node/update'; nodeId: string; markdown: string }
  | { type: 'node/insert'; afterNodeId?: string; markdown: string }
  | { type: 'node/move'; nodeId: string; direction: 'up' | 'down' }
  | { type: 'node/delete'; nodeId: string }
  | { type: 'node/split'; nodeId: string; offset: number }
  | { type: 'node/merge-next'; nodeId: string }
  | { type: 'question/add'; nodeId: string; text: string; quote?: string; parentQuestionId?: string }
  | { type: 'question/update'; questionId: string; text: string }
  | { type: 'branch/open'; questionId: string; returnNodeId: string }
  | { type: 'branch/close' }
  | { type: 'coverage/add'; questionId: string; nodeId: string; quote: string; degree: 'partial' | 'full' }
  | { type: 'coverage/remove'; coverageId: string }
  | { type: 'draft/request'; nodeId: string; questionId?: string }
  | { type: 'draft/cancel' }
  | { type: 'draft/accept'; draftId: string }
  | { type: 'draft/discard'; draftId: string }
  | { type: 'backend/settings' }
  | { type: 'handoff/cowork'; nodeId: string; questionId?: string }
  | { type: 'handoff/import' }
  | { type: 'history/undo' };
export interface NotebookProps {
  document: NotebookDocument;
  onAction: (action: NotebookAction) => void | Promise<void>;
  renderMarkdown?: (markdown: string, element: HTMLElement) => void | (() => void) | Promise<void>;
  busy?: boolean;
  disabledActions?: NotebookAction['type'][];
}
type Act = (action: NotebookAction) => Promise<boolean>;
type Enabled = (type: NotebookAction['type']) => boolean;
const statusLabels: Record<QuestionStatus, string> = {
  unexplained: '未解释', partial: '部分解释', explained: '已解释', review: '待检查',
};

function Status({ question }: { question: NotebookQuestion }) {
  return <span className={`ew-status ew-status-${question.status}`}>{statusLabels[question.status]}</span>;
}

function usageLabel(usage: NonNullable<NotebookDocument['latestUsage']>): string {
  const tokens = (value?: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${value.toLocaleString('zh-CN')} token` : '未提供';
  return `最近一次用量：输入 ${tokens(usage.inputTokens)} · 输出 ${tokens(usage.outputTokens)} · 缓存读取 ${tokens(usage.cacheReadInputTokens)}`;
}

function MarkdownContent({ text, renderMarkdown }: {
  text: string; renderMarkdown?: NotebookProps['renderMarkdown'];
}) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = mount.current;
    if (!element || !renderMarkdown) return;
    element.replaceChildren();
    let dispose: (() => void) | undefined;
    let cancelled = false;
    try {
      const result = renderMarkdown(text, element);
      if (typeof result === 'function') dispose = result;
      else if (result) void result.catch(() => { if (!cancelled) element.textContent = text; });
    } catch { element.textContent = text; }
    return () => { cancelled = true; dispose?.(); };
  }, [text, renderMarkdown]);
  return <div className={`ew-prose markdown-rendered${renderMarkdown ? '' : ' ew-plain-markdown'}`} ref={mount}>
    {renderMarkdown ? null : text}
  </div>;
}

function Composer({ label, placeholder, initialValue = '', submitLabel, onSubmit, onCancel, children, disabled = false }: {
  label: string; placeholder?: string; initialValue?: string; submitLabel: string;
  onSubmit: (value: string) => Promise<boolean>; onCancel: () => void; children?: ReactNode; disabled?: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim() || saving || disabled) return;
    setSaving(true);
    try { if (await onSubmit(value)) onCancel(); } finally { setSaving(false); }
  }
  return <form className="ew-composer" onSubmit={submit}>
    <label htmlFor={id}>{label}</label>
    <textarea id={id} autoFocus value={value} onChange={event => setValue(event.target.value)}
      rows={3} placeholder={placeholder} disabled={saving} />
    {children}
    <div className="ew-actions"><button type="submit" className="mod-cta" disabled={!value.trim() || saving || disabled}>
      {saving ? '保存中…' : submitLabel}</button>
      <button type="button" onClick={onCancel} disabled={saving}>取消</button></div>
  </form>;
}

function NodeEditor({ node, act, enabled, onClose, onQuestionSelection }: {
  node: NotebookNode; act: Act; enabled: Enabled; onClose: () => void; onQuestionSelection: (quote: string) => void;
}) {
  const original = useRef(node.markdown);
  const [value, setValue] = useState(node.markdown);
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  const cursor = selection.from;
  const [saving, setSaving] = useState(false);
  const changedElsewhere = original.current !== node.markdown;
  const dirty = value !== original.current;
  async function save() {
    if (saving || changedElsewhere || !enabled('node/update')) return;
    setSaving(true);
    try { if (await act({ type: 'node/update', nodeId: node.id, markdown: value })) onClose(); }
    finally { setSaving(false); }
  }
  return <div className="ew-editor-panel">
    <MarkdownEditor initialValue={original.current} label={`编辑 ${node.title}`}
      onChange={setValue} onSelectionChange={setSelection} onSave={() => void save()} />
    {changedElsewhere && <p className="ew-warning" role="alert">正文已在别处更新。你的草稿仍保留在这里；请复制需要的内容，再关闭编辑重新打开。</p>}
    <div className="ew-actions">
      <button className="mod-cta" onClick={() => void save()} disabled={saving || changedElsewhere || !enabled('node/update')}>保存正文</button>
      <button onClick={onClose} disabled={saving}>取消编辑</button>
      <button disabled={saving || dirty || changedElsewhere || selection.from === selection.to || !enabled('question/add')}
        onClick={() => onQuestionSelection(value.slice(selection.from, selection.to))}>对选中的原文提问</button>
      <button disabled={saving || dirty || changedElsewhere || cursor === 0 || cursor >= value.length || !enabled('node/split')}
        title={dirty ? '先保存正文，再把光标放到拆分位置' : '在编辑器光标所在位置拆分'}
        onClick={() => void act({ type: 'node/split', nodeId: node.id, offset: cursor }).then(ok => { if (ok) onClose(); })}>
        从光标处拆成两段</button>
    </div>
    <p className="ew-hint">修改保留为草稿，保存后写入正文。⌘ / Ctrl + Enter 保存。{dirty ? '拆分前请先保存。' : '可在段落边界放置光标后拆分。'}</p>
  </div>;
}

function CoverageComposer({ node, questions, initialQuote, act, onClose }: {
  node: NotebookNode; questions: NotebookQuestion[]; initialQuote: string; act: Act; onClose: () => void;
}) {
  const id = useId();
  const [questionId, setQuestionId] = useState(questions[0]?.id ?? '');
  const [quote, setQuote] = useState(initialQuote);
  const [degree, setDegree] = useState<'partial' | 'full'>('partial');
  const [saving, setSaving] = useState(false);
  const valid = Boolean(questionId && quote.trim() && node.markdown.includes(quote.trim()));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try { if (await act({ type: 'coverage/add', questionId, nodeId: node.id, quote: quote.trim(), degree })) onClose(); }
    finally { setSaving(false); }
  }
  return <form className="ew-composer" onSubmit={submit}>
    <label htmlFor={`${id}-question`}>这段正文解释了哪个问题？</label>
    <select id={`${id}-question`} value={questionId} onChange={event => setQuestionId(event.target.value)}>
      {questions.map(question => <option key={question.id} value={question.id}>{question.text}</option>)}
    </select>
    <label htmlFor={`${id}-quote`}>具体解释原文</label>
    <textarea id={`${id}-quote`} value={quote} onChange={event => setQuote(event.target.value)} rows={3}
      placeholder="粘贴本节点中实际回答问题的一段原文" />
    {quote.trim() && !node.markdown.includes(quote.trim()) && <p className="ew-warning">这段文字不在当前节点原文中，请重新选择或粘贴原文。</p>}
    <label htmlFor={`${id}-degree`}>解释覆盖范围</label>
    <select id={`${id}-degree`} value={degree} onChange={event => setDegree(event.target.value as 'partial' | 'full')}>
      <option value="partial">解释了一部分</option><option value="full">解释了整个问题</option>
    </select>
    <p className="ew-hint">这里关联的是正文提供的解释。阅读位置与正文变化会影响问题状态。</p>
    <div className="ew-actions"><button className="mod-cta" type="submit" disabled={!valid || saving}>关联解释</button>
      <button type="button" onClick={onClose} disabled={saving}>取消</button></div>
  </form>;
}

function QuestionLine({ question, onOpen }: { question: NotebookQuestion; onOpen: () => void }) {
  return <button className="ew-question-line" onClick={onOpen}>
    <span className="ew-question-text">{question.parentQuestionId && <span className="ew-muted">追问 · </span>}{question.text}</span>
    <span className="ew-question-meta"><Status question={question} />
      {!!question.futureAnswerCount && <span className="ew-future">后文有解释 ↗</span>}</span>
  </button>;
}

function DraftCard({ draft, act, enabled, renderMarkdown, generating }: {
  draft: NotebookDraft; act: Act; enabled: Enabled; renderMarkdown?: NotebookProps['renderMarkdown']; generating: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const simulated = draft.simulated ?? true;
  return <aside className="ew-draft" aria-label={simulated ? '模拟 AI 草稿' : 'AI 草稿'}>
    <div className="ew-draft-header"><strong>{simulated ? '模拟 AI 草稿' : 'AI 草稿'}</strong>
      <span>{simulated ? '演示内容 · 未调用模型' : `来源：${draft.providerLabel ?? '未记录'}`}</span>
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起预览' : '展开预览'}</button></div>
    {draft.reason && <p className="ew-hint">{draft.reason}</p>}
    {expanded && <MarkdownContent text={draft.markdown} renderMarkdown={renderMarkdown} />}
    {draft.stale && <p className="ew-warning">生成草稿后，相关正文已经改变。请重新生成，避免采用过期内容。</p>}
    <div className="ew-actions"><button className="mod-cta" disabled={generating || !draft.markdown.trim() || draft.stale || !enabled('draft/accept')}
      title={generating ? '等待生成完成，或先取消生成' : undefined}
      onClick={() => void act({ type: 'draft/accept', draftId: draft.id })}>采用为后续解释</button>
      <button disabled={generating || !enabled('draft/discard')} title={generating ? '请先取消生成' : undefined}
        onClick={() => void act({ type: 'draft/discard', draftId: draft.id })}>丢弃草稿</button></div>
  </aside>;
}

function NodeCard({ node, index, document, mode, act, enabled, renderMarkdown, openQuestion, register }: {
  node: NotebookNode; index: number; document: NotebookDocument; mode: 'notebook' | 'article';
  act: Act; enabled: Enabled; renderMarkdown?: NotebookProps['renderMarkdown'];
  openQuestion: (question: NotebookQuestion) => void; register: (element: HTMLElement | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [composer, setComposer] = useState<'question' | 'insert' | 'coverage' | null>(null);
  const [quote, setQuote] = useState('');
  const [questionsOpen, setQuestionsOpen] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const questions = document.questions.filter(question => question.nodeId === node.id);
  const earlier = new Set(document.nodes.slice(0, index + 1).map(item => item.id));
  const candidates = document.questions.filter(question => earlier.has(question.nodeId));
  const coverage = document.coverage.filter(item => item.nodeId === node.id);
  const isCurrent = document.cursorNodeId === node.id;
  const simulated = document.simulatedBackend ?? true;
  function captureSelection() {
    const selection = window.getSelection();
    if (selection && body.current?.contains(selection.anchorNode) && body.current.contains(selection.focusNode)) {
      setQuote(selection.toString().trim());
    }
  }
  return <section ref={register} tabIndex={-1} className={`ew-node${isCurrent ? ' ew-node-current' : ''}`} aria-label={node.title}>
    <header className="ew-node-header">
      <span className="ew-node-number">{String(index + 1).padStart(2, '0')}</span>
      <h2>{node.title}</h2>
      {isCurrent ? <span className="ew-reading-marker">读到这里</span> :
        <button className="ew-quiet" disabled={!enabled('node/read')} onClick={() => void act({ type: 'node/read', nodeId: node.id })}>记住此处</button>}
    </header>
    {editing ? <NodeEditor node={node} act={act} enabled={enabled} onClose={() => setEditing(false)}
      onQuestionSelection={selected => { setQuote(selected); setEditing(false); setComposer('question'); }} /> :
      <div ref={body} onMouseUp={captureSelection} onKeyUp={captureSelection}>
        <MarkdownContent text={node.markdown} renderMarkdown={renderMarkdown} />
      </div>}
    {!editing && <div className="ew-node-tools">
      <button disabled={!enabled('question/add')} onClick={() => setComposer(composer === 'question' ? null : 'question')}>
        {quote ? '对选中文字提问' : '对此提问'}</button>
      <button disabled={!enabled('node/update')} onClick={() => { setEditing(true); setComposer(null); }}>编辑</button>
      <button disabled={!enabled('draft/request')} title={simulated ? '预览演示草稿，不会调用真实模型' : `使用${document.backendLabel ?? '当前后端'}补充解释`}
        onClick={() => void act({ type: 'draft/request', nodeId: node.id })}>{simulated ? '补充解释（模拟）' : '补充解释'}</button>
      <button disabled={!enabled('handoff/cowork')} onClick={() => void act({ type: 'handoff/cowork', nodeId: node.id })}>交给 Cowork</button>
      {mode === 'notebook' && <details className="ew-more"><summary aria-label={`${node.title} 的更多操作`}>更多</summary>
        <div className="ew-more-menu">
          <button disabled={index === 0 || !enabled('node/move')} onClick={() => void act({ type: 'node/move', nodeId: node.id, direction: 'up' })}>移到上面</button>
          <button disabled={index === document.nodes.length - 1 || !enabled('node/move')} onClick={() => void act({ type: 'node/move', nodeId: node.id, direction: 'down' })}>移到下面</button>
          <button disabled={index === document.nodes.length - 1 || !enabled('node/merge-next')} onClick={() => void act({ type: 'node/merge-next', nodeId: node.id })}>与下一节点合并</button>
          <button disabled={!candidates.length || !enabled('coverage/add')} onClick={() => setComposer('coverage')}>关联前文问题的解释</button>
          <button className="ew-danger" disabled={!enabled('node/delete')} onClick={() => void act({ type: 'node/delete', nodeId: node.id })}>删除节点</button>
        </div>
      </details>}
    </div>}
    {composer === 'question' && <Composer label="读到这里，你有什么疑问？" placeholder="可以先记下来，继续沿主线阅读。"
      submitLabel="记录问题" onCancel={() => setComposer(null)} disabled={Boolean(quote && !node.markdown.includes(quote))}
      onSubmit={text => act({ type: 'question/add', nodeId: node.id, text, ...(quote ? { quote } : {}) })}>
      {quote && <blockquote className="ew-selection">{quote}<button type="button" className="ew-quiet" onClick={() => setQuote('')}>去掉引用</button></blockquote>}
      {quote && !node.markdown.includes(quote) && <p className="ew-warning">展示文本与 Markdown 原文不同。请在编辑器中选取原文，或去掉引用后记录问题。</p>}
    </Composer>}
    {composer === 'coverage' && <CoverageComposer node={node} questions={candidates} initialQuote={quote} act={act} onClose={() => setComposer(null)} />}
    {!!coverage.length && <div className="ew-coverage-list">
      <p className="ew-eyebrow">这一节点提供的解释</p>
      {coverage.map(item => <div key={item.id} className={`ew-coverage${item.stale ? ' ew-coverage-stale' : ''}`}>
        <span>{item.stale ? '待检查' : item.degree === 'full' ? '解释了' : '部分解释了'}：</span>
        <span>{document.questions.find(question => question.id === item.questionId)?.text ?? '原问题暂不可用'}</span>
        <details><summary>查看解释依据</summary><blockquote>{item.quote}</blockquote>
          <button disabled={!enabled('coverage/remove')} onClick={() => void act({ type: 'coverage/remove', coverageId: item.id })}>移除关联</button></details>
      </div>)}
    </div>}
    {!!questions.length && <div className="ew-node-questions">
      <button className="ew-section-toggle" aria-expanded={questionsOpen} onClick={() => setQuestionsOpen(!questionsOpen)}>
        <span>{questionsOpen ? '▾' : '▸'} 这里的疑问</span><span>{questions.length}</span></button>
      {questionsOpen && questions.map(question => <QuestionLine key={question.id} question={question} onOpen={() => openQuestion(question)} />)}
    </div>}
    {(document.drafts ?? []).filter(draft => draft.nodeId === node.id).map(draft =>
      <DraftCard key={draft.id} draft={draft} act={act} enabled={enabled} renderMarkdown={renderMarkdown} generating={Boolean(document.generatingNodeId)} />)}
    {document.generatingNodeId === node.id && <div className="ew-generation" role="status"><span>{simulated ? '正在准备模拟解释…' : '正在生成解释…'} 你可以继续编辑。</span>
      <button disabled={!enabled('draft/cancel')} onClick={() => void act({ type: 'draft/cancel' })}>取消生成</button></div>}
    {composer === 'insert' ? <Composer label="添加一段解释" placeholder="支持 Markdown。写下连接前后文的一步。" submitLabel="添加节点"
      onSubmit={markdown => act({ type: 'node/insert', afterNodeId: node.id, markdown })} onCancel={() => setComposer(null)} /> :
      mode === 'notebook' && <button className="ew-insert" disabled={!enabled('node/insert')} onClick={() => setComposer('insert')}>＋ 在这里添加节点</button>}
  </section>;
}

function QuestionPanel({ question, document, act, enabled, openQuestion, returnToMain, jumpTo }: {
  question: NotebookQuestion; document: NotebookDocument; act: Act; enabled: Enabled;
  openQuestion: (question: NotebookQuestion) => void; returnToMain: () => void; jumpTo: (nodeId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [following, setFollowing] = useState(false);
  const parent = document.questions.find(item => item.id === question.parentQuestionId);
  const children = document.questions.filter(item => item.parentQuestionId === question.id);
  const answers = document.coverage.filter(item => item.questionId === question.id);
  return <aside className="ew-question-panel" aria-label="问题支线">
    <div className="ew-panel-top"><span className="ew-eyebrow">问题支线</span><button onClick={returnToMain}>回到主线 ↩</button></div>
    {parent && <button className="ew-parent-question" onClick={() => openQuestion(parent)}>← 上一个问题：{parent.text}</button>}
    <Status question={question} />
    {editing ? <Composer label="修改问题" initialValue={question.text} submitLabel="保存问题" onCancel={() => setEditing(false)}
      onSubmit={text => act({ type: 'question/update', questionId: question.id, text })} /> : <h3>{question.text}</h3>}
    {question.quote && <blockquote>{question.quote}</blockquote>}
    <div className="ew-actions">
      <button onClick={() => jumpTo(question.nodeId)}>查看提问位置</button>
      <button disabled={!enabled('question/update')} onClick={() => setEditing(!editing)}>修改问题</button>
    </div>
    <p className="ew-hint">状态表示截至当前阅读位置，正文提供了多少解释。</p>
    {!!question.futureAnswerCount && <p className="ew-future-notice">后文有解释。继续沿主线读到那里时，会计入已解释。</p>}
    {answers.length ? <div className="ew-answer-list"><h4>正文中的解释</h4>{answers.map(answer =>
      <div className="ew-answer" key={answer.id}>
        <span className="ew-eyebrow">{answer.stale ? '待检查 · 正文或问题发生变化' : answer.degree === 'full' ? '完整解释' : '部分解释'}</span>
        <blockquote>{answer.quote}</blockquote>
        <button onClick={() => jumpTo(answer.nodeId)}>前往解释位置 ↗</button>
      </div>)}</div> : <p className="ew-empty-hint">暂时还没有关联到具体解释。这个问题会留在这里，可以继续阅读。</p>}
    <div className="ew-actions"><button disabled={!enabled('question/add')} onClick={() => setFollowing(!following)}>继续追问</button>
      <button disabled={!enabled('draft/request')} onClick={() => void act({ type: 'draft/request', nodeId: question.nodeId, questionId: question.id })}>
        {(document.simulatedBackend ?? true) ? '生成演示解释' : '生成解释'}</button>
      <button disabled={!enabled('handoff/cowork')} onClick={() => void act({ type: 'handoff/cowork', nodeId: question.nodeId, questionId: question.id })}>交给 Cowork</button></div>
    {following && <Composer label="从这个问题继续追问" placeholder="把新的疑问留在这条支线上。" submitLabel="记录追问" onCancel={() => setFollowing(false)}
      onSubmit={text => act({ type: 'question/add', nodeId: question.nodeId, parentQuestionId: question.id, text })} />}
    {!!children.length && <div className="ew-followups"><h4>由此产生的追问</h4>{children.map(child =>
      <QuestionLine key={child.id} question={child} onOpen={() => openQuestion(child)} />)}</div>}
  </aside>;
}

export function Notebook({ document, onAction, renderMarkdown, busy = false, disabledActions = [] }: NotebookProps) {
  const [mode, setMode] = useState<'notebook' | 'article'>('notebook');
  const [showQuestions, setShowQuestions] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [addingFirst, setAddingFirst] = useState(false);
  const pendingRef = useRef(false);
  const nodes = useRef(new Map<string, HTMLElement>());
  const enabled: Enabled = type => !busy && !pending && !disabledActions.includes(type)
    && !(type === 'draft/request' && document.generatingNodeId);
  const act: Act = async action => {
    if (busy || pendingRef.current || disabledActions.includes(action.type)) return false;
    const background = action.type === 'draft/request';
    if (!background) { pendingRef.current = true; setPending(true); }
    setError('');
    try { await onAction(action); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成，你的输入仍保留。请重试。'); return false; }
    finally { if (!background) { pendingRef.current = false; setPending(false); } }
  };
  const jumpTo = (nodeId: string) => {
    const element = nodes.current.get(nodeId);
    element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    element?.focus({ preventScroll: true });
    void act({ type: 'node/read', nodeId });
  };
  const openQuestion = (question: NotebookQuestion) => {
    void act({ type: 'branch/open', questionId: question.id,
      returnNodeId: document.branchReturnNodeId ?? document.cursorNodeId ?? question.nodeId });
  };
  const returnToMain = async () => {
    const destination = document.branchReturnNodeId ?? document.cursorNodeId;
    if (await act({ type: 'branch/close' })) {
      const element = destination ? nodes.current.get(destination) : undefined;
      element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      element?.focus({ preventScroll: true });
    }
  };
  const activeQuestion = document.questions.find(question => question.id === document.activeQuestionId);
  const openQuestions = document.questions.filter(question => question.status !== 'explained');
  const currentIndex = document.nodes.findIndex(node => node.id === document.cursorNodeId);
  const simulated = document.simulatedBackend ?? true;
  const backendLabel = document.backendLabel ?? (simulated ? '离线演示' : '模型后端');
  return <div className={`explainweave ew-mode-${mode}`} aria-busy={busy || pending}>
    <header className="ew-app-header">
      <div className="ew-brand"><span className="ew-brand-mark" aria-hidden="true">↳</span><div><span className="ew-eyebrow">EXPLAINWEAVE</span><h1>{document.title}</h1></div></div>
      <div className="ew-header-actions">
        <div className="ew-segmented" role="group" aria-label="阅读视图">
          <button aria-pressed={mode === 'notebook'} onClick={() => setMode('notebook')}>Notebook</button>
          <button aria-pressed={mode === 'article'} onClick={() => setMode('article')}>连续文章</button>
        </div>
        <button aria-pressed={showQuestions} onClick={() => setShowQuestions(!showQuestions)}>待解释 <span className="ew-count">{openQuestions.length}</span></button>
        <button disabled={!enabled('backend/settings')} title="打开后端设置" onClick={() => void act({ type: 'backend/settings' })}>后端：{backendLabel}</button>
        <button disabled={!enabled('handoff/import')} onClick={() => void act({ type: 'handoff/import' })}>导入外部草稿</button>
        <button title="撤销上一次文档操作" disabled={!document.canUndo || !enabled('history/undo')} onClick={() => void act({ type: 'history/undo' })}>撤销</button>
      </div>
    </header>
    {document.sourcePath && <p className="ew-source" title={document.sourcePath}>{document.sourcePath}</p>}
    <div className="ew-session-bar"><span>{document.nodes.length} 个节点 · {document.questions.length} 个问题</span>
      <span>{currentIndex >= 0 ? `阅读位置：${currentIndex + 1} / ${document.nodes.length}` : '选择一处，继续解释的主线'}</span></div>
    {document.warning && <div className="ew-warning ew-banner" role="status">{document.warning}</div>}
    {error && <div className="ew-error ew-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误提示">×</button></div>}
    <div className={`ew-workspace${activeQuestion || showQuestions ? ' ew-has-panel' : ''}`}>
      <nav className="ew-outline" aria-label="解释节点目录"><p className="ew-eyebrow">文章主线</p>
        {document.nodes.map((node, index) => <button key={node.id} aria-current={node.id === document.cursorNodeId ? 'location' : undefined}
          onClick={() => jumpTo(node.id)}><span className="ew-outline-number">{index + 1}</span><span>{node.title}</span>
          {document.questions.some(question => question.nodeId === node.id) && <span className="ew-outline-dot" title="此处有问题" />}</button>)}
        {!document.nodes.length && <p className="ew-hint">从第一个解释节点开始。</p>}
      </nav>
      <main className="ew-article" aria-label="解释文章">
        {!document.nodes.length && <div className="ew-empty"><span className="ew-brand-mark" aria-hidden="true">↳</span><h2>让每一步解释，都有来处。</h2>
          <p>添加正文，再把阅读时产生的问题留在相应位置。</p>
          {!addingFirst && <button className="mod-cta" disabled={!enabled('node/insert')} onClick={() => setAddingFirst(true)}>添加第一个节点</button>}
          {addingFirst && <Composer label="第一个节点" submitLabel="添加节点" onCancel={() => setAddingFirst(false)} onSubmit={markdown => act({ type: 'node/insert', markdown })} />}
        </div>}
        {document.nodes.map((node, index) => <NodeCard key={node.id} node={node} index={index} document={document} mode={mode} act={act} enabled={enabled}
          renderMarkdown={renderMarkdown} openQuestion={openQuestion} register={element => { if (element) nodes.current.set(node.id, element); else nodes.current.delete(node.id); }} />)}
        {!!document.nodes.length && <p className="ew-endnote">主线暂时到这里。问题可以继续留在原处，等待后续解释。</p>}
      </main>
      {activeQuestion ? <QuestionPanel key={activeQuestion.id} question={activeQuestion} document={document} act={act} enabled={enabled}
        openQuestion={openQuestion} returnToMain={() => void returnToMain()} jumpTo={jumpTo} /> : showQuestions &&
        <aside className="ew-question-panel" aria-label="待解释的问题"><div className="ew-panel-top"><h3>待解释的问题</h3><button onClick={() => setShowQuestions(false)}>收起</button></div>
          <p className="ew-hint">依据当前阅读位置计算；后文的解释会单独提示。</p>
          {openQuestions.length ? openQuestions.map(question => <QuestionLine key={question.id} question={question} onOpen={() => openQuestion(question)} />) :
            <p className="ew-empty-hint">当前没有待解释的问题。</p>}
        </aside>}
    </div>
    <footer className="ew-app-footer"><span>正文与问题一起保存</span>
      {document.latestUsage && <span>{usageLabel(document.latestUsage)}</span>}
      <span>{simulated ? '当前后端为模拟演示' : `当前后端：${backendLabel}`}</span></footer>
  </div>;
}
