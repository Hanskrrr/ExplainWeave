import { mkdir, cp, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const vault = resolve('dev-vault');
await mkdir(`${vault}/.obsidian/plugins/explainweave`, { recursive: true });
await cp('dist/explainweave', `${vault}/.obsidian/plugins/explainweave`, { recursive: true });
await writeFile(`${vault}/.obsidian/community-plugins.json`, JSON.stringify(['explainweave']));
const sample = `${vault}/从平均值到中位数.md`;
try { await access(sample); }
catch { await cp('fixtures/average-median.md', sample); }
console.log(`Development vault ready: ${vault}\nOpen it in Obsidian and run “ExplainWeave: 打开解释笔记”.`);
