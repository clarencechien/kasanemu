// Build: esbuild bundles the entry points, everything else is copied.
// content script 必須是 classic script(MV3 的 content script 不吃 ESM),
// worker / options / popup 走 module。
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  outdir,
  target: ['chrome120'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: { content: 'src/content/index.ts' }, format: 'iife' }),
  esbuild.context({
    ...common,
    entryPoints: {
      worker: 'src/worker/index.ts',
      options: 'src/options/options.ts',
      popup: 'src/popup/popup.ts',
    },
    format: 'esm',
  }),
]);

async function copyStatic() {
  const files = [
    ['src/manifest.json', 'dist/manifest.json'],
    ['src/options/options.html', 'dist/options.html'],
    ['src/options/options.css', 'dist/options.css'],
    ['src/popup/popup.html', 'dist/popup.html'],
    ['src/popup/popup.css', 'dist/popup.css'],
  ];
  for (const [from, to] of files) await cp(from, to);
  if (existsSync('assets/fonts')) {
    const fonts = (await readdir('assets/fonts')).filter((f) => f.endsWith('.woff2'));
    if (fonts.length > 0) {
      await mkdir('dist/fonts', { recursive: true });
      for (const f of fonts) await cp(path.join('assets/fonts', f), path.join('dist/fonts', f));
    } else {
      console.warn('!! assets/fonts 沒有 woff2:譯文會退回系統中文字型。跑 npm run fonts 打包 Noto。');
    }
  }
  if (existsSync('assets/icons')) await cp('assets/icons', 'dist/icons', { recursive: true });
}

async function report() {
  let total = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  await walk(outdir);
  const mb = total / 1024 / 1024;
  console.log(`bundle size: ${mb.toFixed(2)} MB  (§10.2 預算 1.5 MB)`);
  if (mb > 1.5) console.warn('!! 超出體積預算');
}

if (watch) {
  for (const c of contexts) await c.watch();
  await copyStatic();
  console.log('watching…');
} else {
  for (const c of contexts) await c.rebuild();
  await copyStatic();
  for (const c of contexts) await c.dispose();
  await report();
}
