import { build, context } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { watchFile } from 'node:fs';

const outdir = 'dist/explainweave';
await mkdir(outdir, { recursive: true });
for (const file of ['manifest.json', 'styles.css']) {
  await copyFile(`apps/obsidian/${file}`, `${outdir}/${file}`);
}
const config = {
  entryPoints: ['apps/obsidian/src/main.tsx'],
  outfile: `${outdir}/main.js`,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['obsidian', 'electron', 'node:*', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands'],
  sourcemap: 'external',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.argv.includes('--watch') ? 'development' : 'production') },
};
if (process.argv.includes('--watch')) {
  const ctx = await context(config);
  await ctx.watch();
  for (const file of ['manifest.json', 'styles.css']) {
    watchFile(`apps/obsidian/${file}`, { interval: 500 }, () => {
      void copyFile(`apps/obsidian/${file}`, `${outdir}/${file}`).catch(error => console.error(error.message));
    });
  }
} else {
  await build(config);
  const manifest = JSON.parse(await readFile(`${outdir}/manifest.json`, 'utf8'));
  console.log(`Built ${manifest.name} ${manifest.version} in ${outdir}`);
}
