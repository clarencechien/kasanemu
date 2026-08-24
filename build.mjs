// Build: esbuild bundles the entry points, everything else is copied.
// content script 必須是 classic script(MV3 的 content script 不吃 ESM),
// worker / options / popup 走 module。
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

/**
 * Chrome 的 manifest.version 只吃 1–4 段數字,所以 build number 當第四段:
 * 0.1.0.<commit 數>。version_name 可以是任意字串,放人看的資訊
 * (short sha + 日期 + 工作區是否乾淨)。
 *
 * 為什麼要有:每一包都叫 0.1.0 的話,回報問題時沒人知道手上那包
 * 含不含某個修正 —— 診斷 log 的第一行就會是騙人的。
 */
function buildStamp(baseVersion) {
  const git = (args, fallback = '') => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return fallback;
    }
  };
  const count = Number(git(['rev-list', '--count', 'HEAD'], '0')) || 0;
  const sha = git(['rev-parse', '--short=7', 'HEAD'], 'nogit');
  const dirty = git(['status', '--porcelain']).length > 0;
  // 沒有 git(例如從 zip 解出來重建)就退回日期序號,至少單調遞增
  const build = count > 0 ? count : Math.floor(Date.now() / 86_400_000);
  const day = new Date().toISOString().slice(0, 10);
  return {
    version: `${baseVersion}.${build}`,
    versionName: `${baseVersion} build ${build} · ${sha}${dirty ? '+dirty' : ''} · ${day}`,
  };
}

async function writeManifest() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  const stamp = buildStamp(pkg.version);
  manifest.version = stamp.version;
  manifest.version_name = stamp.versionName;
  await mkdir('dist', { recursive: true });
  await writeFile('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`version ${stamp.versionName}`);
}

async function copyStatic() {
  await writeManifest();
  const files = [
    ['src/options/options.html', 'dist/options.html'],
    ['src/options/options.css', 'dist/options.css'],
    ['src/popup/popup.html', 'dist/popup.html'],
    ['src/popup/popup.css', 'dist/popup.css'],
    // 封測手冊跟著一起打包:拿到 zip 的人解開就能先讀說明,不必另外傳一份
    ['docs/manual.html', 'dist/manual.html'],
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
