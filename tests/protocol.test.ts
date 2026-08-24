import { test } from 'node:test';
import assert from 'node:assert/strict';
import { echoMatches, echoOf, estimateTokens, parseBatch, repairJsonArray } from '../src/worker/protocol.ts';

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

/* ---------------------------------------- §6.4 第二層:echo 比對的鬆緊 */

test('同一句話的等價寫法算過:全形、大小寫、彎引號、空白', () => {
  assert.ok(echoMatches("Anthropic's", "Anthropic’s"));
  assert.ok(echoMatches('Roughly ', 'roughly'));
  assert.ok(echoMatches('ＡＩ ｉｓ', 'AI is'));
  assert.ok(echoMatches('Well - known', 'Well — known'));
});

test('模型回短一截的 echo 算過(前綴且夠長)', () => {
  assert.ok(echoMatches('Roughly', 'Roughly '));
  assert.ok(echoMatches('Claude', 'Claude A'));
});

test('前綴太短不算 —— 那不足以證明是同一句', () => {
  assert.equal(echoMatches('Ro', 'Roughly '), false);
  assert.equal(echoMatches('', 'Roughly '), false);
});

test('batch 內 id 對滑仍然抓得到:不同句子的 echo 對不上', () => {
  assert.equal(echoMatches('Roughly ', 'Claude A'), false);
  assert.equal(echoMatches('The quick', 'A slow do'), false);
});

test('對滑的整批仍然全數丟棄,不是修復', () => {
  const sent = [
    { id: 'u1', src: 'Roughly 99 percent of traffic', maxChars: 40, role: 'body' as const },
    { id: 'u2', src: 'Claude Academy gives users', maxChars: 40, role: 'body' as const },
  ];
  // 兩筆的譯文互換(echo 跟著對滑)
  const raw = JSON.stringify([
    { id: 'u1', echo: 'Claude A', t: '克勞德學院…' },
    { id: 'u2', echo: 'Roughly ', t: '全球資料流量…' },
  ]);
  const out = parseBatch(raw, sent, false);
  assert.equal(out.results.length, 0);
  assert.equal(out.stats.echoMismatch, 2);
  // detail 要能看出期待與收到,不然使用者貼 log 過來也判斷不了
  assert.match(out.failures[0]!.detail ?? '', /want .*got /);
});

/* ------------------------------- 小模型的格式容忍(id 紀律不放寬) */

test('只送一筆時模型回單一物件,包成 array 收下', () => {
  const sent = [{ id: 'u94', src: 'Mindsets matter', maxChars: 20, role: 'heading' as const }];
  const raw = JSON.stringify({ id: 'u94', echo: 'Mindsets', t: '心態至關重要' });
  const out = parseBatch(raw, sent, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.t, '心態至關重要');
});

test('回 {results: [...]} 這種包裝也收', () => {
  const sent = [{ id: 'u94', src: 'Mindsets matter', maxChars: 20, role: 'heading' as const }];
  const raw = JSON.stringify({ results: [{ id: 'u94', echo: 'Mindsets', t: '心態至關重要' }] });
  assert.equal(parseBatch(raw, sent, false).results.length, 1);
});

test('容忍格式不等於容忍對錯:包裝過的單筆一樣要通過 echo 對位', () => {
  const sent = [{ id: 'u94', src: 'Mindsets matter', maxChars: 20, role: 'heading' as const }];
  const raw = JSON.stringify({ id: 'u94', echo: 'Something', t: '完全不同的句子' });
  const out = parseBatch(raw, sent, false);
  assert.equal(out.results.length, 0);
  assert.equal(out.stats.echoMismatch, 1);
});

test('真的回空陣列時,那一筆仍然算 missing 並標記失敗', () => {
  const sent = [{ id: 'u94', src: 'Mindsets matter', maxChars: 20, role: 'heading' as const }];
  const out = parseBatch('[]', sent, false);
  assert.equal(out.stats.missing, 1);
  assert.equal(out.failures[0]!.reason, 'missing-id');
});
