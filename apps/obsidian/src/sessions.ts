import { pathsFor, type FileIO } from './storage';
import type { ChatTurn, Discussion, QuestionPlan, SessionData } from './session-types';

/** Limits reject new writes; existing files are never truncated or silently reset. */
export const SESSION_LIMITS = {
  fileBytes: 8_000_000,
  discussions: 512,
  turnsPerDiscussion: 512,
  totalTurns: 10_000,
  transcriptMessages: 10_000,
  transcriptContentChars: 2_000_000,
  plans: 2_000,
  markdownChars: 200_000,
  contextJournalChars: 2_000_000,
  basedOnChars: 512,
  providerLabelChars: 256,
  reasonChars: 4_000,
} as const;

export type SessionErrorCode = 'invalid-data' | 'unsupported-schema' | 'document-mismatch' | 'not-loaded' | 'conflict' | 'too-large';

export class SessionFileError extends Error {
  constructor(readonly code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'SessionFileError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ROLES = new Set(['user', 'assistant']);
const STATUSES = new Set(['complete', 'streaming', 'cancelled', 'error']);

function check(condition: unknown, message: string, code: SessionErrorCode = 'invalid-data'): asserts condition {
  if (!condition) throw new SessionFileError(code, message);
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), '会话数据含有无效对象，未覆盖原文件。');
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  check(required.every(key => Object.hasOwn(record, key)) && Object.keys(record).every(key => allowed.has(key)),
    '会话数据缺少必要字段或含有未知字段，未覆盖原文件。');
  return record;
}

function identifier(value: unknown): string {
  check(typeof value === 'string' && ID_PATTERN.test(value), '会话标识无效，未覆盖原文件。');
  return value;
}

function text(value: unknown, maximum: number): string {
  check(typeof value === 'string' && !value.includes('\0'), '会话文字字段无效，未覆盖原文件。');
  check(value.length <= maximum, '会话文字超过保存上限，原文件已保留。', 'too-large');
  return value;
}

function collection(value: unknown, maximum: number): unknown[] {
  check(Array.isArray(value), '会话集合格式无效，未覆盖原文件。');
  check(value.length <= maximum, '会话记录数量超过保存上限，原文件已保留。', 'too-large');
  return value;
}

function validateData(input: unknown, documentId: string, recoverStreaming: boolean): SessionData {
  const data = object(input, ['schemaVersion', 'documentId', 'discussions', 'plans', 'contextJournal']);
  check(data.schemaVersion === 1, '会话格式版本不受支持，已保留原文件。', 'unsupported-schema');
  const savedDocumentId = identifier(data.documentId);
  check(savedDocumentId === documentId, '会话属于其他文章，未覆盖原文件。', 'document-mismatch');
  const discussionIds = new Set<string>();
  const questionAssociations = new Set<string>();
  const turnIds = new Set<string>();
  let articleDiscussionSeen = false;
  let turnCount = 0;
  let transcriptMessageCount = 0;
  const discussions: Discussion[] = collection(data.discussions, SESSION_LIMITS.discussions).map(value => {
    const entry = object(value, ['id', 'turns'], ['questionId', 'transcript', 'contextJournal', 'inheritedTurnIds']);
    const id = identifier(entry.id);
    check(!discussionIds.has(id), '会话讨论标识重复，未覆盖原文件。');
    discussionIds.add(id);
    const questionId = entry.questionId === undefined ? undefined : identifier(entry.questionId);
    if (questionId === undefined) {
      check(!articleDiscussionSeen, '文章主讨论重复，未覆盖原文件。');
      articleDiscussionSeen = true;
    } else {
      check(!questionAssociations.has(questionId), '同一问题关联了多个讨论，未覆盖原文件。');
      questionAssociations.add(questionId);
    }
    const rawTurns = collection(entry.turns, SESSION_LIMITS.turnsPerDiscussion);
    turnCount += rawTurns.length;
    check(turnCount <= SESSION_LIMITS.totalTurns, '会话消息总数超过保存上限，原文件已保留。', 'too-large');
    const turns: ChatTurn[] = rawTurns.map(value => {
      const turn = object(value, ['id', 'role', 'markdown', 'status'], ['basedOn', 'simulated', 'providerLabel', 'kind']);
      const turnId = identifier(turn.id);
      check(!turnIds.has(turnId), '会话消息标识重复，未覆盖原文件。');
      turnIds.add(turnId);
      check(typeof turn.role === 'string' && ROLES.has(turn.role), '会话消息角色无效，未覆盖原文件。');
      check(typeof turn.status === 'string' && STATUSES.has(turn.status), '会话消息状态无效，未覆盖原文件。');
      check(turn.simulated === undefined || typeof turn.simulated === 'boolean', '会话模拟标志无效，未覆盖原文件。');
      check(turn.kind === undefined || turn.kind === 'chat' || turn.kind === 'compose', '会话消息用途无效，未覆盖原文件。');
      return {
        id: turnId,
        role: turn.role as ChatTurn['role'],
        markdown: text(turn.markdown, SESSION_LIMITS.markdownChars),
        status: recoverStreaming && turn.status === 'streaming' ? 'cancelled' : turn.status as ChatTurn['status'],
        ...(turn.basedOn !== undefined ? { basedOn: text(turn.basedOn, SESSION_LIMITS.basedOnChars) } : {}),
        ...(turn.simulated !== undefined ? { simulated: turn.simulated } : {}),
        ...(turn.providerLabel !== undefined ? { providerLabel: text(turn.providerLabel, SESSION_LIMITS.providerLabelChars) } : {}),
        ...(turn.kind !== undefined ? { kind: turn.kind } : {}),
      };
    });
    let transcript: Discussion['transcript'];
    if (entry.transcript !== undefined) {
      const messages = collection(entry.transcript, SESSION_LIMITS.transcriptMessages);
      transcriptMessageCount += messages.length;
      check(transcriptMessageCount <= SESSION_LIMITS.transcriptMessages,
        '会话原始消息总数超过保存上限，原文件已保留。', 'too-large');
      transcript = messages.map(value => {
        const message = object(value, ['role', 'content']);
        check(typeof message.role === 'string' && ROLES.has(message.role), '会话原始消息角色无效，未覆盖原文件。');
        return { role: message.role as 'user' | 'assistant', content: text(message.content, SESSION_LIMITS.transcriptContentChars) };
      });
    }
    const inheritedTurnIds = entry.inheritedTurnIds === undefined ? undefined : collection(entry.inheritedTurnIds, SESSION_LIMITS.totalTurns).map(identifier);
    if (inheritedTurnIds) check(new Set(inheritedTurnIds).size === inheritedTurnIds.length, '继承讨论记录重复，未覆盖原文件。');
    return {
      id, ...(questionId !== undefined ? { questionId } : {}), turns,
      ...(inheritedTurnIds !== undefined ? { inheritedTurnIds } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      ...(entry.contextJournal !== undefined ? { contextJournal: text(entry.contextJournal, SESSION_LIMITS.contextJournalChars) } : {}),
    };
  });
  // Plans intentionally validate syntax only. The controller resolves references
  // and outdated revisions against the current document instead of dropping them.
  const plannedQuestionIds = new Set<string>();
  const plans: QuestionPlan[] = collection(data.plans, SESSION_LIMITS.plans).map(value => {
    const plan = object(value, ['questionId', 'questionRevision', 'nodeId'], ['reason']);
    const questionId = identifier(plan.questionId);
    check(!plannedQuestionIds.has(questionId), '同一问题的后续安排重复，未覆盖原文件。');
    plannedQuestionIds.add(questionId);
    check(typeof plan.questionRevision === 'number' && Number.isSafeInteger(plan.questionRevision) && plan.questionRevision >= 1,
      '问题安排的版本无效，未覆盖原文件。');
    return {
      questionId, questionRevision: plan.questionRevision, nodeId: identifier(plan.nodeId),
      ...(plan.reason !== undefined ? { reason: text(plan.reason, SESSION_LIMITS.reasonChars) } : {}),
    };
  });
  return {
    schemaVersion: 1, documentId: savedDocumentId, discussions, plans,
    // The journal's entry schema belongs to ContextJournal.restore, not this file.
    contextJournal: text(data.contextJournal, SESSION_LIMITS.contextJournalChars),
  };
}

function checkFileSize(raw: string): void {
  check(new TextEncoder().encode(raw).byteLength <= SESSION_LIMITS.fileBytes,
    '会话文件超过读取或保存上限，原文件已保留。', 'too-large');
}

export function emptySession(documentId: string): SessionData {
  return { schemaVersion: 1, documentId: identifier(documentId), discussions: [], plans: [], contextJournal: '' };
}

/**
 * One instance serializes both loads and saves. The raw source is compared before
 * writing; a failed load or uncertain write blocks writes until a successful reload.
 * FileIO cannot provide atomic CAS against another process between read and write.
 * Hosts should supply atomic file replacement and retain a single active writer.
 */
export class SessionFile {
  readonly path: string;
  private expected: string | null = null;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly io: FileIO, documentPath: string, private readonly documentId: string) {
    pathsFor(documentPath);
    identifier(documentId);
    this.path = documentPath.replace(/\.md$/i, '.explainweave.sessions.json');
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  load(): Promise<SessionData> {
    return this.serialized(async () => {
      this.loaded = false;
      const raw = await this.io.read(this.path);
      if (raw === null) {
        this.expected = null;
        this.loaded = true;
        return emptySession(this.documentId);
      }
      checkFileSize(raw);
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { throw new SessionFileError('invalid-data', '会话文件损坏，已保留原文件并停止写入。'); }
      const session = validateData(value, this.documentId, true);
      this.expected = raw;
      this.loaded = true;
      return session;
    });
  }

  save(data: SessionData): Promise<void> {
    let next: string;
    try {
      // Snapshot synchronously so later UI mutations cannot change a queued save.
      next = JSON.stringify(validateData(data, this.documentId, false), null, 2) + '\n';
      checkFileSize(next);
    } catch (error) { return Promise.reject(error); }
    return this.serialized(async () => {
      check(this.loaded, '会话尚未成功载入，不能覆盖；请重新打开文章。', 'not-loaded');
      const actual = await this.io.read(this.path);
      if (actual !== this.expected) {
        this.loaded = false;
        throw new SessionFileError('conflict', '会话文件已从外部改变，未覆盖；请重新打开文章。');
      }
      if (actual === next) return;
      try {
        await this.io.write(this.path, next);
        check(await this.io.read(this.path) === next, '会话写入后文件又发生改变，已停止后续写入；请重新打开文章。', 'conflict');
        this.expected = next;
      } catch (error) {
        this.loaded = false;
        throw error;
      }
    });
  }
}
