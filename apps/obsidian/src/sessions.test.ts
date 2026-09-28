import { describe, expect, it } from 'vitest';
import { emptySession, SESSION_LIMITS, SessionFile } from './sessions';
import type { SessionData } from './session-types';
import type { FileIO } from './storage';

function memory(initial: string | null = null) {
  const state = { raw: initial, writes: [] as string[] };
  const io: FileIO = {
    read: async () => state.raw,
    write: async (_path, raw) => { state.raw = raw; state.writes.push(raw); },
    remove: async () => { state.raw = null; },
  };
  return { state, io };
}

function example(): SessionData {
  return {
    schemaVersion: 1, documentId: 'doc_1',
    discussions: [
      { id: 'article', turns: [{ id: 'turn_1', role: 'user', markdown: '文章主线应怎样展开？', status: 'complete' }] },
      { id: 'discussion_q1', questionId: 'question_1', turns: [
        { id: 'turn_2', role: 'user', markdown: '为什么必须小步更新？', status: 'complete' },
        { id: 'turn_3', role: 'assistant', markdown: '先考虑当前位置的局部近似。', status: 'complete',
          basedOn: 'source_fingerprint', simulated: false, providerLabel: 'Example provider' },
      ] },
    ],
    plans: [{ questionId: 'question_1', questionRevision: 2, nodeId: 'future_node', reason: '在步长一节接着说明。' }],
    contextJournal: '{"sequence":1,"blocks":[],"instruction":"Explain"}\n',
  };
}

describe('session file persistence', () => {
  it('loads a missing file as an independent empty session and uses the correct sidecar path', async () => {
    const { io } = memory();
    const file = new SessionFile(io, 'notes/article.MD', 'doc_1');
    expect(file.path).toBe('notes/article.explainweave.sessions.json');
    expect(await file.load()).toEqual(emptySession('doc_1'));
    const first = emptySession('doc_1');
    first.plans.push({ questionId: 'question_1', questionRevision: 1, nodeId: 'node_1' });
    expect(emptySession('doc_1').plans).toEqual([]);
  });

  it('saves article/question history, plans, and the exact context journal across restart', async () => {
    const { io } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    const session = example();
    await file.save(session);
    expect(await new SessionFile(io, 'article.md', 'doc_1').load()).toEqual(session);
  });

  it('recovers streaming turns as cancelled without discarding partial content or rewriting on load', async () => {
    const { io, state } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    const session = example();
    const reply = session.discussions[1]!.turns[1]!;
    reply.status = 'streaming'; reply.markdown = '已经收到的部分解释';
    await file.save(session);
    expect(JSON.parse(state.raw!).discussions[1].turns[1].status).toBe('streaming');
    const rawBeforeRestart = state.raw;
    const restarted = new SessionFile(io, 'article.md', 'doc_1');
    const loaded = await restarted.load();
    expect(loaded.discussions[1]!.turns[1]).toEqual({ ...reply, status: 'cancelled' });
    expect(state.raw).toBe(rawBeforeRestart);
    await restarted.save(loaded);
    expect(JSON.parse(state.raw!).discussions[1].turns[1].status).toBe('cancelled');
  });

  it('preserves an explicitly cancelled or errored partial response on restart', async () => {
    const session = example();
    session.discussions[1]!.turns[1]!.status = 'cancelled';
    session.discussions[1]!.turns.push({ id: 'turn_error', role: 'assistant', markdown: '部分内容', status: 'error' });
    const { io } = memory(JSON.stringify(session));
    expect(await new SessionFile(io, 'article.md', 'doc_1').load()).toEqual(session);
  });

  it('keeps chat/compose purpose while recovering interrupted composition', async () => {
    const session = example();
    Object.assign(session.discussions[0]!.turns[0]!, { kind: 'chat' });
    Object.assign(session.discussions[1]!.turns[1]!, { kind: 'compose', status: 'streaming', markdown: '{"partial":' });
    const { io } = memory(JSON.stringify(session));
    const loaded = await new SessionFile(io, 'article.md', 'doc_1').load();
    expect(loaded.discussions[0]!.turns[0]).toHaveProperty('kind', 'chat');
    expect(loaded.discussions[1]!.turns[1]).toEqual(expect.objectContaining({ kind: 'compose', status: 'cancelled', markdown: '{"partial":' }));
  });

  it('validates plan syntax but keeps references for the controller to resolve', async () => {
    const session = emptySession('doc_1');
    session.plans = [{ questionId: 'missing_question', questionRevision: 999, nodeId: 'missing_node' }];
    const { io } = memory(JSON.stringify(session));
    expect((await new SessionFile(io, 'article.md', 'doc_1').load()).plans).toEqual(session.plans);
  });

  it('preserves exact provider messages separately from display markdown across restart', async () => {
    const { io } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    const session = example();
    session.discussions[1]!.transcript = [
      { role: 'user', content: 'Document snapshot\n  first request\n' },
      { role: 'assistant', content: '{"markdown":"正文解释","claims":[]}' },
    ];
    session.discussions[1]!.contextJournal = '{"block":"v1"}\n{"block":"v2"}\n';
    await file.save(session);
    expect(await new SessionFile(io, 'article.md', 'doc_1').load()).toEqual(session);
  });

  it('keeps an interrupted raw assistant reply unchanged when recovering its UI turn', async () => {
    const session = example();
    session.discussions[1]!.transcript = [{ role: 'assistant', content: '{"markdown":"partial' }];
    session.discussions[1]!.turns[1]!.status = 'streaming';
    const { io } = memory(JSON.stringify(session));
    const loaded = await new SessionFile(io, 'article.md', 'doc_1').load();
    expect(loaded.discussions[1]!.turns[1]!.status).toBe('cancelled');
    expect(loaded.discussions[1]!.transcript).toEqual(session.discussions[1]!.transcript);
  });

  it('serializes saves and snapshots inputs before awaiting IO', async () => {
    const { io, state } = memory();
    const originalWrite = io.write;
    let announceStart!: () => void;
    const started = new Promise<void>(resolve => { announceStart = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let count = 0; let active = 0; let maximumActive = 0;
    io.write = async (path, raw) => {
      active++; maximumActive = Math.max(maximumActive, active);
      if (count++ === 0) { announceStart(); await gate; }
      await originalWrite(path, raw);
      active--;
    };
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    const first = example();
    const savingFirst = file.save(first);
    await started;
    first.discussions[0]!.turns[0]!.markdown = 'A later mutation';
    const second = example(); second.discussions[0]!.turns[0]!.markdown = 'The second save';
    const savingSecond = file.save(second);
    release();
    await Promise.all([savingFirst, savingSecond]);
    expect(maximumActive).toBe(1);
    expect(JSON.parse(state.writes[0]!).discussions[0].turns[0].markdown).toBe('文章主线应怎样展开？');
    expect(JSON.parse(state.raw!).discussions[0].turns[0].markdown).toBe('The second save');
  });

  it('serializes a reload after pending saves instead of changing their expected baseline', async () => {
    const { io } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    const saving = file.save(example());
    const loading = file.load();
    await saving;
    expect(await loading).toEqual(example());
  });
});

describe('conflicts and damaged data', () => {
  it('refuses writes before a successful load', async () => {
    const { io, state } = memory();
    await expect(new SessionFile(io, 'article.md', 'doc_1').save(emptySession('doc_1'))).rejects.toThrow('尚未成功载入');
    expect(state.writes).toEqual([]);
  });

  it('refuses overwriting external content including formatting-only changes', async () => {
    const { io, state } = memory(JSON.stringify(example()));
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    state.raw = JSON.stringify(example(), null, 4);
    const external = state.raw;
    await expect(file.save(example())).rejects.toThrow('外部改变');
    expect(state.raw).toBe(external); expect(state.writes).toEqual([]);
    await expect(file.save(example())).rejects.toThrow('尚未成功载入');
  });

  it('refuses overwriting an externally deleted session file until explicitly reloaded', async () => {
    const { io, state } = memory(JSON.stringify(example()));
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load(); state.raw = null;
    await expect(file.save(example())).rejects.toThrow('外部改变');
    expect(await file.load()).toEqual(emptySession('doc_1'));
    await file.save(emptySession('doc_1'));
    expect(JSON.parse(state.raw!)).toEqual(emptySession('doc_1'));
  });

  it.each(['{broken', 'null', '[]', '{"schemaVersion":99}'])(
    'preserves malformed/unsupported data and blocks writes: %s', async raw => {
      const { io, state } = memory(raw);
      const file = new SessionFile(io, 'article.md', 'doc_1');
      await expect(file.load()).rejects.toThrow();
      await expect(file.save(emptySession('doc_1'))).rejects.toThrow('尚未成功载入');
      expect(state.raw).toBe(raw); expect(state.writes).toEqual([]);
    },
  );

  it('blocks writes after a failed reload even if an older load succeeded', async () => {
    const { io, state } = memory(JSON.stringify(example()));
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load(); state.raw = '{damaged later';
    await expect(file.load()).rejects.toThrow('损坏');
    await expect(file.save(example())).rejects.toThrow('尚未成功载入');
    expect(state.raw).toBe('{damaged later');
  });

  it('blocks subsequent writes after an uncertain failed write', async () => {
    const { io, state } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    io.write = async () => { state.raw = '{partial write'; throw new Error('disk error'); };
    await expect(file.save(example())).rejects.toThrow('disk error');
    await expect(file.save(example())).rejects.toThrow('尚未成功载入');
    expect(state.raw).toBe('{partial write');
  });

  it('rejects another document on load and save', async () => {
    const other = { ...example(), documentId: 'doc_other' };
    const { io, state } = memory(JSON.stringify(other));
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await expect(file.load()).rejects.toThrow('其他文章');
    state.raw = null; await file.load();
    await expect(file.save(other)).rejects.toThrow('其他文章');
    expect(state.writes).toEqual([]);
  });

  it('rejects an unknown version without erasing valid-shaped fields', async () => {
    const { io, state } = memory(JSON.stringify({ ...example(), schemaVersion: 2 }));
    const raw = state.raw;
    await expect(new SessionFile(io, 'article.md', 'doc_1').load()).rejects.toThrow('版本不受支持');
    expect(state.raw).toBe(raw);
  });

  it.each([
    ['discussion id', (session: SessionData) => { session.discussions[1]!.id = session.discussions[0]!.id; }],
    ['question association', (session: SessionData) => { session.discussions.push({ id: 'another', questionId: 'question_1', turns: [] }); }],
    ['article discussion', (session: SessionData) => { session.discussions.push({ id: 'another', turns: [] }); }],
    ['global turn id', (session: SessionData) => { session.discussions[1]!.turns[0]!.id = session.discussions[0]!.turns[0]!.id; }],
    ['question plan', (session: SessionData) => { session.plans.push({ questionId: 'question_1', questionRevision: 2, nodeId: 'another_node' }); }],
  ] as const)('rejects duplicate %s without writing', async (_label, mutate) => {
    const { io, state } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load(); const invalid = example(); mutate(invalid);
    await expect(file.save(invalid)).rejects.toThrow(); expect(state.writes).toEqual([]);
    state.raw = JSON.stringify(invalid);
    await expect(file.load()).rejects.toThrow();
  });

  it('rejects unknown fields, invalid enums and invalid plan syntax', async () => {
    const changes = [
      (data: any) => { data.extra = 'unknown'; },
      (data: any) => { data.discussions[0].title = 'unsupported'; },
      (data: any) => { data.discussions[0].turns[0].role = 'system'; },
      (data: any) => { data.discussions[0].turns[0].status = 'done'; },
      (data: any) => { data.discussions[0].turns[0].kind = 'execute'; },
      (data: any) => { data.discussions[0].turns[0].simulated = 'false'; },
      (data: any) => { data.discussions[0].transcript = [{ role: 'system', content: 'unsupported' }]; },
      (data: any) => { data.discussions[0].transcript = [{ role: 'user', content: 42 }]; },
      (data: any) => { data.discussions[0].transcript = [{ role: 'user', content: 'valid', extra: 'unknown' }]; },
      (data: any) => { data.discussions[0].transcript = {}; },
      (data: any) => { data.discussions[0].contextJournal = []; },
      (data: any) => { data.plans[0].questionRevision = 0; },
      (data: any) => { data.plans[0].nodeId = '../file'; },
      (data: any) => { data.plans[0].path = '/arbitrary'; },
      (data: any) => { data.contextJournal = []; },
    ];
    for (const mutate of changes) {
      const invalid = example(); mutate(invalid);
      const { io, state } = memory(JSON.stringify(invalid));
      const raw = state.raw;
      await expect(new SessionFile(io, 'article.md', 'doc_1').load()).rejects.toThrow();
      expect(state.raw).toBe(raw);
    }
  });

  it('rejects excessive text, collections and raw file size while preserving data', async () => {
    const { io, state } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1'); await file.load();
    const longMessage = example(); longMessage.discussions[0]!.turns[0]!.markdown = '字'.repeat(SESSION_LIMITS.markdownChars + 1);
    await expect(file.save(longMessage)).rejects.toThrow('超过');
    const longJournal = example(); longJournal.contextJournal = 'x'.repeat(SESSION_LIMITS.contextJournalChars + 1);
    await expect(file.save(longJournal)).rejects.toThrow('超过');
    const manyPlans = example(); manyPlans.plans = Array.from({ length: SESSION_LIMITS.plans + 1 }, () => ({ questionId: 'q', questionRevision: 1, nodeId: 'n' }));
    await expect(file.save(manyPlans)).rejects.toThrow('超过');
    expect(state.writes).toEqual([]);
    state.raw = ' '.repeat(SESSION_LIMITS.fileBytes + 1);
    await expect(file.load()).rejects.toThrow('超过');
    expect(state.raw.length).toBe(SESSION_LIMITS.fileBytes + 1);
  });

  it('rejects oversized transcripts and discussion journals without truncation or writes', async () => {
    const { io, state } = memory();
    const file = new SessionFile(io, 'article.md', 'doc_1'); await file.load();
    const longMessage = example();
    longMessage.discussions[0]!.transcript = [{ role: 'user', content: 'x'.repeat(SESSION_LIMITS.transcriptContentChars + 1) }];
    await expect(file.save(longMessage)).rejects.toThrow('超过');
    const manyMessages = example();
    manyMessages.discussions[0]!.transcript = Array.from({ length: SESSION_LIMITS.transcriptMessages }, () => ({ role: 'user', content: '' }));
    manyMessages.discussions[1]!.transcript = [{ role: 'assistant', content: '' }];
    await expect(file.save(manyMessages)).rejects.toThrow('超过');
    const longJournal = example();
    longJournal.discussions[0]!.contextJournal = 'x'.repeat(SESSION_LIMITS.contextJournalChars + 1);
    await expect(file.save(longJournal)).rejects.toThrow('超过');
    expect(state.writes).toEqual([]);
  });

  it('does not poison later valid saves after invalid caller data', async () => {
    const { io } = memory(); const file = new SessionFile(io, 'article.md', 'doc_1');
    await file.load();
    await expect(file.save({ ...emptySession('doc_1'), schemaVersion: 2 } as unknown as SessionData)).rejects.toThrow();
    await file.save(example());
    expect(await file.load()).toEqual(example());
  });
});
