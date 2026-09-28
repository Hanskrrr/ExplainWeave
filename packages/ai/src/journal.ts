import type { ContextBlock, WritingTask } from './index';
import { boundedString, identifier, keys, record, strictJson } from './validation';

interface JournalEntry {
  version: 1;
  sequence: number;
  blocks: ContextBlock[];
  /** Tombstones explicitly invalidate all earlier versions of these IDs. */
  deleted: string[];
  /** Present only when the current context order changes. */
  order?: string[];
}
const MAX_SERIALIZED = 8_000_000;
const MAX_BLOCKS = 10_000;

export class ContextJournalError extends Error {
  constructor() { super('Invalid or oversized context journal. Rebuild a checkpoint from the current document.'); this.name = 'ContextJournalError'; }
}

function block(value: unknown): ContextBlock {
  if (!record(value) || !keys(value, ['id', 'revision', 'text']) || !identifier(value.id)
    || !identifier(value.revision) || !boundedString(value.text, 2_000_000, false)) throw new ContextJournalError();
  return { id: value.id, revision: value.revision, text: value.text };
}
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/** Append-only application data, not a promise of server-side KV-cache reuse. */
export class ContextJournal {
  private serialized = '';
  private sequence = 0;
  private blocks = new Map<string, ContextBlock>();
  private order: string[] = [];

  constructor(serialized = '') {
    try {
      if (typeof serialized !== 'string' || serialized.length > MAX_SERIALIZED) throw new Error();
      if (!serialized) return;
      // A terminated JSONL record is the durable unit. Reject partial writes.
      if (!serialized.endsWith('\n')) throw new Error();
      const lines = serialized.slice(0, -1).split('\n');
      if (lines.length > 10_000) throw new Error();
      for (const line of lines) {
        const entry = strictJson(line, MAX_SERIALIZED);
        if (!record(entry) || !keys(entry, ['version', 'sequence', 'blocks', 'deleted'], ['order'])
          || entry.version !== 1 || entry.sequence !== this.sequence + 1
          || !Array.isArray(entry.blocks) || entry.blocks.length > MAX_BLOCKS
          || !Array.isArray(entry.deleted) || entry.deleted.length > MAX_BLOCKS) throw new Error();
        const upserts = entry.blocks.map(block);
        const touched = new Set<string>();
        for (const next of upserts) {
          if (touched.has(next.id)) throw new Error();
          touched.add(next.id);
        }
        for (const id of entry.deleted) {
          if (!identifier(id) || touched.has(id) || !this.blocks.has(id)) throw new Error();
          touched.add(id); this.blocks.delete(id);
        }
        for (const next of upserts) this.blocks.set(next.id, next);
        if (this.blocks.size > MAX_BLOCKS) throw new Error();
        if (Object.hasOwn(entry, 'order')) {
          if (!Array.isArray(entry.order) || entry.order.length !== this.blocks.size
            || entry.order.some(id => !identifier(id) || !this.blocks.has(id))
            || new Set(entry.order).size !== entry.order.length) throw new Error();
          this.order = [...entry.order] as string[];
        }
        if (this.order.length !== this.blocks.size || this.order.some(id => !this.blocks.has(id))) throw new Error();
        this.sequence++;
      }
      // Preserve validated bytes exactly; restore must not rewrite old prefixes.
      this.serialized = serialized;
    } catch { throw new ContextJournalError(); }
  }

  /** Context is a complete current snapshot; omitted IDs become tombstones. */
  append(task: WritingTask): string {
    if (!Array.isArray(task.context) || task.context.length > MAX_BLOCKS) throw new ContextJournalError();
    const current = task.context.map(block);
    const order = current.map(entry => entry.id);
    if (new Set(order).size !== order.length) throw new ContextJournalError();
    const nextIds = new Set(order);
    const changed = current.filter(next => {
      const previous = this.blocks.get(next.id);
      return !previous || previous.revision !== next.revision || previous.text !== next.text;
    });
    const deleted = this.order.filter(id => !nextIds.has(id));
    const reordered = !sameOrder(this.order, order);
    if (!changed.length && !deleted.length && !reordered) return this.serialized;
    const entry: JournalEntry = { version: 1, sequence: this.sequence + 1, blocks: changed, deleted,
      ...(reordered ? { order } : {}) };
    const appended = JSON.stringify(entry) + '\n';
    if (this.sequence >= 10_000 || this.serialized.length + appended.length > MAX_SERIALIZED) throw new ContextJournalError();
    // All checks precede mutation; failed appends preserve the old checkpoint.
    this.serialized += appended;
    this.blocks = new Map(current.map(next => [next.id, next]));
    this.order = order;
    this.sequence++;
    return this.serialized;
  }

  serialize(): string { return this.serialized; }

  checkpoint(task: WritingTask): string {
    const replacement = new ContextJournal();
    const serialized = replacement.append(task);
    this.serialized = serialized;
    this.sequence = replacement.sequence;
    this.blocks = replacement.blocks;
    this.order = replacement.order;
    return serialized;
  }
}
