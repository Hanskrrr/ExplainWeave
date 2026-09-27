import { Modal, Setting, type App } from 'obsidian';

export type BackendChoice = 'demo' | 'deepseek' | 'claude';
export interface BackendSettings {
  selected: BackendChoice;
  models: { deepseek: string; claude: string };
  baseUrls: { deepseek: string; claude: string };
}
export const defaultBackendSettings: BackendSettings = {
  selected: 'demo', models: { deepseek: '', claude: '' },
  baseUrls: { deepseek: 'https://api.deepseek.com', claude: 'https://api.anthropic.com' },
};
export function readBackendSettings(value: unknown): BackendSettings {
  const config = structuredClone(defaultBackendSettings);
  if (!value || typeof value !== 'object') return config;
  const raw = value as Partial<BackendSettings>;
  if (['demo', 'deepseek', 'claude'].includes(raw.selected ?? '')) config.selected = raw.selected!;
  for (const id of ['deepseek', 'claude'] as const) {
    if (typeof raw.models?.[id] === 'string') config.models[id] = raw.models[id];
    if (typeof raw.baseUrls?.[id] === 'string') config.baseUrls[id] = raw.baseUrls[id];
  }
  return config;
}

export class BackendSettingsModal extends Modal {
  private readonly config: BackendSettings;
  private readonly keys: Map<BackendChoice, string>;
  constructor(app: App, settings: BackendSettings, keys: Map<BackendChoice, string>, private readonly save: (settings: BackendSettings, keys: Map<BackendChoice, string>) => Promise<void>) {
    super(app); this.config = structuredClone(settings); this.keys = new Map(keys);
  }
  onOpen(): void { this.render(); }
  private render(): void {
    this.setTitle('ExplainWeave · AI 后端');
    this.contentEl.empty();
    new Setting(this.contentEl).setName('生成方式').addDropdown(dropdown => dropdown
      .addOption('demo', '离线演示（不调用模型）').addOption('deepseek', 'DeepSeek API').addOption('claude', 'Claude API')
      .setValue(this.config.selected).onChange(value => { this.config.selected = value as BackendChoice; this.render(); }));
    const selected = this.config.selected;
    if (selected !== 'demo') {
      new Setting(this.contentEl).setName('模型名称').setDesc('填写你账号可用的模型 ID。').addText(text => text.setValue(this.config.models[selected]).onChange(value => { this.config.models[selected] = value.trim(); }));
      new Setting(this.contentEl).setName('API 地址').addText(text => text.setValue(this.config.baseUrls[selected]).onChange(value => { this.config.baseUrls[selected] = value.trim(); }));
      new Setting(this.contentEl).setName('API 密钥').setDesc('只保留在本次 Obsidian 会话，不写入 Vault。').addText(text => {
        text.inputEl.type = 'password'; text.inputEl.autocomplete = 'off';
        text.setValue(this.keys.get(selected) ?? '').onChange(value => { this.keys.set(selected, value.trim()); });
      });
      this.contentEl.createEl('p', { text: '生成时会把当前文章正文和附属问题发送给上面的模型服务。配置保存不代表服务已连接。' });
    } else this.contentEl.createEl('p', { text: '用于验证草稿流程，不需要密钥，也不会判断问题是否已解释。' });
    this.contentEl.createEl('p', { text: 'Cowork 使用文章中的“交给 Cowork”入口，在 Claude 客户端完成任务。Codex 适配器尚未接通。' });
    const error = this.contentEl.createEl('p', { cls: 'ew-warning', attr: { role: 'alert' } });
    const buttons = this.contentEl.createEl('div', { cls: 'ew-actions' });
    buttons.createEl('button', { text: '取消' }).onclick = () => this.close();
    const button = buttons.createEl('button', { text: '保存配置', cls: 'mod-cta' });
    button.onclick = async () => {
      if (selected !== 'demo' && (!this.config.models[selected] || !this.keys.get(selected))) { error.textContent = '请填写模型名称和本次会话使用的 API 密钥。'; return; }
      if (selected !== 'demo') {
        try {
          const url = new URL(this.config.baseUrls[selected]);
          const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
          if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error();
        } catch { error.textContent = '请填写不含密钥、查询参数或片段的 HTTPS API 根地址；本机服务可使用 HTTP。'; return; }
      }
      button.disabled = true;
      try { await this.save(this.config, this.keys); this.close(); }
      catch { error.textContent = '配置保存失败，请重试。'; button.disabled = false; }
    };
  }
  onClose(): void { this.contentEl.empty(); }
}
