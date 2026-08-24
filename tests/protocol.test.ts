import { test } from 'node:test';
import assert from 'node:assert/strict';
import { echoOf, estimateTokens, parseBatch, repairJsonArray } from '../src/worker/protocol.ts';

const sent = [
  { id: 'u1', src: 'Roughly 99 percent of traffic goes undersea.', maxChars: 40, role: 'body' as const },
  { id: 'u2', src: 'Getting Started', maxChars: 12, role: 'heading' as const },
];

test('echoOf 取前 8 個字元(以 code point 計)', () => {
  assert.equal(echoOf('Roughly 99 percent'), 'Roughly ');
  assert.equal(echoOf('短'), '短');
  assert.equal(echoOf('👍👍👍👍👍👍👍👍👍'), '👍👍👍👍👍👍👍👍');
});

test('乾淨的 JSON 直接解析', () => {
  const arr = repairJsonArray('[{"id":"u1","echo":"Roughly ","t":"約九成九"}]');
  assert.equal(arr?.length, 1);
});

test('markdown 圍籬與前置雜訊會被剝掉', () => {
  const arr = repairJsonArray('```json\n[{"id":"u1","echo":"Roughly ","t":"約"}]\n```');
  assert.equal(arr?.length, 1);
});

test('§6.6 截斷修復:丟掉最後一筆不完整項目並補上括號', () => {
  const truncated = '[{"id":"u1","echo":"Roughly ","t":"約九成九的流量走海底電纜"},{"id":"u2","echo":"Getting ","t":"入';
  const arr = repairJsonArray(truncated);
  assert.equal(arr?.length, 1);
  assert.equal((arr?.[0] as { id: string }).id, 'u1');
});

test('修復不出東西時回 null,而不是猜', () => {
  assert.equal(repairJsonArray('抱歉,我無法翻譯這段內容。'), null);
  assert.equal(repairJsonArray('[{"id":"u1"'), null);
});

test('§6.4 第二層:echo 對不上就丟棄該筆,不修復', () => {
  const raw = JSON.stringify([
    { id: 'u1', echo: 'Roughly ', t: '約九成九的流量走海底電纜' },
    { id: 'u2', echo: 'Roughly ', t: '入門' }, // 對滑:拿了 u1 的原文
  ]);
  const out = parseBatch(raw, sent, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]?.id, 'u1');
  assert.equal(out.stats.echoMismatch, 1);
  assert.ok(out.failures.some((f) => f.id === 'u2' && f.reason === 'echo-mismatch'));
});

test('§6.4 第一層:重複 id 只取第一筆,多出來的 id 直接丟', () => {
  const raw = JSON.stringify([
    { id: 'u1', echo: 'Roughly ', t: '甲' },
    { id: 'u1', echo: 'Roughly ', t: '乙' },
    { id: 'u9', echo: 'Roughly ', t: '不存在的 id' },
    { id: 'u2', echo: 'Getting ', t: '入門' },
  ]);
  const out = parseBatch(raw, sent, false);
  assert.deepEqual(
    out.results.map((r) => r.t),
    ['甲', '入門'],
  );
  assert.equal(out.stats.dupe, 1);
  assert.equal(out.stats.unknown, 1);
});

test('缺 id 一律標記,不靜默略過 (§6.5)', () => {
  const raw = JSON.stringify([{ id: 'u1', echo: 'Roughly ', t: '甲' }]);
  const out = parseBatch(raw, sent, false);
  assert.equal(out.stats.missing, 1);
  assert.deepEqual(out.failures, [{ id: 'u2', reason: 'missing-id' }]);
});

test('空譯文算失敗', () => {
  const raw = JSON.stringify([{ id: 'u1', echo: 'Roughly ', t: '   ' }]);
  const out = parseBatch(raw, sent, false);
  assert.equal(out.results.length, 0);
  assert.ok(out.failures.some((f) => f.reason === 'empty'));
});

test('整份 JSON 壞掉時,整批標記為 truncated 或 api-error', () => {
  const out = parseBatch('我不能這樣做', sent, true);
  assert.equal(out.results.length, 0);
  assert.equal(out.failures.length, 2);
  assert.ok(out.failures.every((f) => f.reason === 'truncated'));
});

test('token 估算:中文比拉丁貴', () => {
  const zh = estimateTokens('全球資料流量約有九成九走海底電纜');
  const en = estimateTokens('Roughly 99 percent of data traffic goes undersea');
  assert.ok(zh > 10);
  assert.ok(en < zh * 2);
});
