import { describe, expect, it } from 'vitest';
import { ContextJournal, ContextJournalError, type WritingTask } from './index';

const task: WritingTask = { id: 'random-task-id', instruction: 'private current request', targetNodeId: 'a',
  context: [{ id: 'a', revision: '1', text: '原文' }, { id: 'b', revision: '1', text: '后文' }] };
const lines = (serialized: string) => serialized.trim().split('\n').map(line => JSON.parse(line));

describe('durable context journal', () => {
  it('only appends changed context; instruction and task IDs never enter the document log', () => {
    const journal = new ContextJournal();
    const first = journal.append(task);
    expect(first).not.toContain(task.id);
    expect(first).not.toContain(task.instruction);
    expect(journal.append({ ...task, instruction: 'another question' })).toBe(first);
    const second = journal.append({ ...task, context: [{ ...task.context[0]!, text: '正文变化但revision未变' }, task.context[1]!] });
    expect(second.startsWith(first)).toBe(true);
    expect(lines(second)[1].blocks).toEqual([{ id: 'a', revision: '1', text: '正文变化但revision未变' }]);
    expect(lines(second)[1]).not.toHaveProperty('order');
  });

  it('restores exact earlier bytes, emits tombstones, and can reintroduce a deleted ID', () => {
    const first = new ContextJournal().append(task);
    const formatted = first.replace('"sequence":1', '"sequence": 1');
    const restored = new ContextJournal(formatted);
    expect(restored.serialize()).toBe(formatted);
    const deleted = restored.append({ ...task, context: [task.context[1]!] });
    expect(deleted.startsWith(formatted)).toBe(true);
    expect(lines(deleted)[1]).toEqual({ version: 1, sequence: 2, blocks: [], deleted: ['a'], order: ['b'] });
    const again = new ContextJournal(deleted).append(task);
    expect(lines(again)[2]).toMatchObject({ sequence: 3, blocks: [task.context[0]], deleted: [], order: ['a', 'b'] });
  });

  it('records pure reorder and caller-supplied route blocks without rewriting earlier entries', () => {
    const route = { id: 'article-route', revision: '1', text: '["a","b"]' };
    const journal = new ContextJournal();
    const initial = journal.append({ ...task, context: [...task.context, route] });
    const reordered = journal.append({ ...task, context: [task.context[1]!, task.context[0]!, route] });
    expect(reordered.startsWith(initial)).toBe(true);
    expect(lines(reordered)[1]).toEqual({ version: 1, sequence: 2, blocks: [], deleted: [], order: ['b', 'a', 'article-route'] });
    const routeChanged = journal.append({ ...task, context: [task.context[1]!, task.context[0]!, { ...route, text: '["b","a"]' }] });
    expect(lines(routeChanged)[2].blocks).toEqual([{ ...route, text: '["b","a"]' }]);
    expect(new ContextJournal(routeChanged).serialize()).toBe(routeChanged);
  });

  it('copies caller data and checkpoints only after a full valid replacement exists', () => {
    const localTask = structuredClone(task);
    const journal = new ContextJournal();
    const initial = journal.append(localTask);
    localTask.context[0]!.text = 'external mutation';
    expect(journal.serialize()).toBe(initial);
    const changed = journal.append(localTask);
    expect(lines(changed)[1].blocks[0].text).toBe('external mutation');
    const invalid = { ...task, context: [task.context[0]!, task.context[0]!] };
    expect(() => journal.append(invalid)).toThrow(ContextJournalError);
    expect(() => journal.checkpoint(invalid)).toThrow(ContextJournalError);
    expect(journal.serialize()).toBe(changed);
    const checkpoint = journal.checkpoint(localTask);
    expect(lines(checkpoint)).toHaveLength(1);
    expect(checkpoint).not.toContain('原文');
    expect(journal.checkpoint({ ...task, context: [] })).toBe('');
  });

  it('rejects corrupt, partial, duplicate and out-of-order persisted journals', () => {
    const first = new ContextJournal().append(task);
    const sample = lines(first)[0];
    const encoded = (value: unknown) => JSON.stringify(value) + '\n';
    const invalid = [
      first.trimEnd(), first + '\n', '{broken}\n',
      encoded({ ...sample, version: 2 }), encoded({ ...sample, sequence: 2 }),
      encoded({ ...sample, instruction: 'must not be persisted' }),
      encoded({ ...sample, blocks: [task.context[0], task.context[0]] }),
      encoded({ ...sample, order: ['a', 'a'] }), encoded({ ...sample, order: ['a', 'unknown'] }),
      encoded({ ...sample, deleted: ['unknown'] }),
      first + encoded({ version: 1, sequence: 2, blocks: [task.context[0]], deleted: ['a'] }),
      first + encoded({ version: 1, sequence: 2, blocks: [], deleted: ['a'] }),
      first + encoded({ version: 1, sequence: 2, blocks: [], deleted: ['a', 'a'], order: ['b'] }),
      first.replace('"sequence":1', '"sequence":99,"sequence":1'),
      ' '.repeat(8_000_001),
    ];
    for (const serialized of invalid) expect(() => new ContextJournal(serialized)).toThrow(ContextJournalError);
  });
});
