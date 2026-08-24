import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, maskKey } from '../src/shared/report.ts';
import { clip } from '../src/shared/diag.ts';
import { DEFAULT_SETTINGS } from '../src/shared/types.ts';

/**
 * 診斷報告是要拿去貼給別人的,所以「不能外洩什麼」比「有多少資訊」重要。
 */

test('API key 絕不進報告,只留長度與前後兩碼', () => {
  assert.equal(maskKey(''), '(未設定)');
  assert.equal(maskKey('AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), 'AI…xx(長度 38)');
  // 太短的不給前後碼,免得整把露出來
  assert.equal(maskKey('abc'), '(長度 3)');
});

test('報告內容不含完整 key', () => {
  const key = 'AIzaSyD-SECRET-VALUE-000111222333';
  const md = buildReport({
    version: '0.1.0',
    url: 'https://example.com/post',
    userAgent: 'test',
    settings: { ...DEFAULT_SETTINGS, apiKey: key },
    domain: null,
    stats: null,
    modelCheck: undefined,
    events: [],
    now: 0,
  });
  assert.ok(!md.includes(key));
  assert.ok(!md.includes('SECRET'));
  assert.ok(md.includes('(長度 33)'));
});

test('長字串一律截斷,log 不是原文備份', () => {
  const long = 'x'.repeat(200);
  const out = clip(long) as string;
  assert.ok(out.length < 80);
  assert.ok(out.endsWith('(200)'));
  // 巢狀物件也要跟著截
  const nested = clip({ a: { b: long } }) as { a: { b: string } };
  assert.ok(nested.a.b.length < 80);
});

test('事件列出來的格式看得懂:時間、層級、來源、訊息', () => {
  const md = buildReport({
    version: '0.1.0',
    url: 'https://example.com/',
    userAgent: 'test',
    settings: DEFAULT_SETTINGS,
    domain: { enabled: true, mode: 'full', tier: 'free', pipeline: 'progressive' },
    stats: null,
    modelCheck: { problems: [{ tier: 'free', modelId: 'gemma-4-31b-it', issue: 'missing' }] },
    events: [
      { at: 0, scope: 'content', level: 'warn', msg: 'scan', data: { found: 0 } },
      { at: 1, scope: 'worker', level: 'error', msg: 'api-failed', data: { status: 404 } },
    ],
    now: 0,
  });
  assert.match(md, /\[content\] scan \{"found":0\}/);
  assert.match(md, /✗ \[worker\] api-failed/);
  assert.match(md, /gemma-4-31b-it/);
  assert.match(md, /progressive/);
});

test('沒有 content script 的頁面也要出得了報告', () => {
  const md = buildReport({
    version: '0.1.0',
    url: 'chrome://extensions',
    userAgent: 'test',
    settings: DEFAULT_SETTINGS,
    domain: null,
    stats: null,
    modelCheck: undefined,
    events: [],
    now: 0,
  });
  assert.match(md, /這一頁沒有 content script/);
  assert.match(md, /沒有記錄/);
});
