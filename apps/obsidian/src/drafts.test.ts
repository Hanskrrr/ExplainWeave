import { expect, it } from 'vitest';
import { DraftFile } from './drafts';
import type { FileIO } from './storage';

it('preserves unknown draft data instead of silently replacing it', async () => {
  let raw = '{broken';
  const io: FileIO = { read: async () => raw, write: async (_path, text) => { raw = text; }, remove: async () => {} };
  const file = new DraftFile(io, 'article.md');
  await expect(file.load()).rejects.toThrow('损坏');
  await expect(file.save([])).rejects.toThrow('尚未成功载入');
  expect(raw).toBe('{broken');
});

it('rejects overwriting externally modified drafts', async () => {
  let raw: string | null = null;
  const io: FileIO = { read: async () => raw, write: async (_path, text) => { raw = text; }, remove: async () => {} };
  const file = new DraftFile(io, 'article.md');
  await file.load();
  raw = '{"external":true}';
  await expect(file.save([])).rejects.toThrow('外部改变');
  expect(raw).toBe('{"external":true}');
});
