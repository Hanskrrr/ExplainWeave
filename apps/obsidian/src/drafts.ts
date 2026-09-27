import type { FileIO } from './storage';

export interface SavedDraft {
  id: string; nodeId: string; markdown: string; questionId?: string;
  basedOn: string; reason: string; stale: boolean;
  simulated?: boolean; providerLabel?: string;
}

export class DraftFile {
  readonly path: string;
  private expected: string | null = null;
  private loaded = false;
  private queue = Promise.resolve();
  constructor(private readonly io: FileIO, documentPath: string) {
    this.path = documentPath.replace(/\.md$/i, '.explainweave.drafts.json');
  }
  async load(): Promise<SavedDraft[]> {
    const raw = await this.io.read(this.path);
    if (raw === null) { this.loaded = true; return []; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('草稿文件损坏，已保留原文件并停止写入。'); }
    if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('drafts' in value) || !Array.isArray(value.drafts)) throw new Error('草稿格式不受支持。');
    const drafts = value.drafts;
    for (const draft of drafts) {
      if (!draft || typeof draft !== 'object' || ['id', 'nodeId', 'markdown', 'basedOn', 'reason'].some(key => typeof draft[key] !== 'string') || typeof draft.stale !== 'boolean' || (draft.questionId !== undefined && typeof draft.questionId !== 'string') || (draft.simulated !== undefined && typeof draft.simulated !== 'boolean') || (draft.providerLabel !== undefined && typeof draft.providerLabel !== 'string')) throw new Error('草稿数据无效，未覆盖原文件。');
    }
    if (new Set(drafts.map(draft => draft.id)).size !== drafts.length) throw new Error('草稿标识重复，未覆盖原文件。');
    this.expected = raw;
    this.loaded = true;
    return drafts as SavedDraft[];
  }
  save(drafts: readonly SavedDraft[]): Promise<void> {
    const next = JSON.stringify({ schemaVersion: 1, drafts }, null, 2) + '\n';
    const task = this.queue.then(async () => {
      if (!this.loaded) throw new Error('草稿尚未成功载入，不能覆盖。');
      if (await this.io.read(this.path) !== this.expected) throw new Error('草稿文件已从外部改变，未覆盖；请重新打开文章。');
      await this.io.write(this.path, next);
      this.expected = next;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
