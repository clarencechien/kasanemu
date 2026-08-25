import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTerms,
  glossaryFingerprint,
  hostMatches,
  includesTerm,
  matchedGlossaries,
  parseTerms,
  promptTerms,
  resolveGlossary,
  type Term,
} from '../src/shared/glossary.ts';

const SRC = {
  globalGlossary: [{ from: 'Kasanemu' }] as Term[],
  glossaries: {
    tech: { name: '技術', terms: [{ from: 'embedding', to: '嵌入向量' }, { from: 'Go' }] },
    fin: { name: '財經', terms: [{ from: 'Go', to: '前進' }] },
  },
  glossaryBinding: { '*.qiita.com': ['tech'], 'money.example': ['fin'] },
};

test('host pattern:完全相同 / 子網域(含主網域)/ 全部', () => {
  assert.equal(hostMatches('example.com', 'example.com'), true);
  assert.equal(hostMatches('example.com', 'www.example.com'), false);
  // 使用者寫 `*.` 的意思幾乎不會是「只要子網域、不要主網域」
  assert.equal(hostMatches('*.example.com', 'example.com'), true);
  assert.equal(hostMatches('*.example.com', 'a.b.example.com'), true);
  assert.equal(hostMatches('*.example.com', 'notexample.com'), false);
  assert.equal(hostMatches('*', 'anything.test'), true);
  assert.equal(hostMatches('', 'x.test'), false);
});

test('解析:全域一律生效,命中的具名詞表疊上去', () => {
  const got = resolveGlossary('a.qiita.com', SRC);
  assert.deepEqual(got.map((t) => t.from).sort(), ['Go', 'Kasanemu', 'embedding']);
  // 沒命中的網域只有全域
  assert.deepEqual(resolveGlossary('news.example', SRC).map((t) => t.from), ['Kasanemu']);
});

test('同一個 from 出現兩次:後面的贏(具體的覆蓋全域)', () => {
  const src = {
    ...SRC,
    globalGlossary: [{ from: 'Go' }] as Term[],
    glossaryBinding: { '*': ['fin'] },
  };
  const got = resolveGlossary('money.example', src);
  assert.equal(got.find((t) => t.from === 'Go')?.to, '前進');
});

test('大小寫敏感與不敏感是兩條不同的規則,不互相覆蓋', () => {
  const src = {
    globalGlossary: [
      { from: 'it', to: '它' },
      { from: 'IT', to: '資訊科技', cs: true },
    ] as Term[],
    glossaries: {},
    glossaryBinding: {},
  };
  assert.equal(resolveGlossary('x.test', src).length, 2);
});

test('解析結果依長度由長到短 —— 否則短詞會先把長片語切碎', () => {
  const src = {
    globalGlossary: [
      { from: 'attention', to: '注意' },
      { from: 'attention mechanism', to: '注意力機制' },
    ] as Term[],
    glossaries: {},
    glossaryBinding: {},
  };
  assert.deepEqual(
    resolveGlossary('x.test', src).map((t) => t.from),
    ['attention mechanism', 'attention'],
  );
});

test('詞表被刪掉但綁定沒清 —— 忽略,不要壞掉', () => {
  const src = { ...SRC, glossaryBinding: { '*': ['gone', 'tech'] } };
  assert.deepEqual(resolveGlossary('x.test', src).map((t) => t.from).sort(), [
    'Go',
    'Kasanemu',
    'embedding',
  ]);
});

test('設定頁格式:箭頭、半形箭頭、不翻、大小寫敏感、註解', () => {
  const got = parseTerms(
    [
      '# 註解',
      '',
      'attention mechanism → 注意力機制',
      'embedding -> 嵌入向量',
      'Go',
      'API! ',
      '   ',
    ].join('\n'),
  );
  assert.deepEqual(got, [
    { from: 'attention mechanism', to: '注意力機制' },
    { from: 'embedding', to: '嵌入向量' },
    { from: 'Go' },
    { from: 'API', cs: true },
  ]);
  // 來回一趟不掉東西
  assert.deepEqual(parseTerms(formatTerms(got)), got);
});

test('指紋只算真的命中的詞 —— 加一個無關的詞不該讓整站快取失效', () => {
  const terms: Term[] = [
    { from: 'embedding', to: '嵌入向量' },
    { from: 'kubernetes', to: 'K8s' },
  ];
  const a = glossaryFingerprint('Embedding lookup is slow.', terms);
  const b = glossaryFingerprint('Embedding lookup is slow.', [...terms, { from: 'zzz', to: 'ZZZ' }]);
  assert.equal(a, b, '沒命中的詞不進指紋');
  // 完全沒命中 → 空字串 → 快取 key 與「沒有詞表」時完全相同
  assert.equal(glossaryFingerprint('Nothing here.', terms), '');
  // 改了譯法就要換 key
  assert.notEqual(a, glossaryFingerprint('Embedding lookup is slow.', [{ from: 'embedding', to: '別的' }]));
});

test('大小寫:預設不敏感,cs 開了才敏感', () => {
  assert.equal(includesTerm('The Embedding table', { from: 'embedding' }), true);
  assert.equal(includesTerm('The Embedding table', { from: 'embedding', cs: true }), false);
  assert.equal(includesTerm('An IT department', { from: 'IT', cs: true }), true);
});

test('prompt 詞表:只放有 to 的、只放這一批用得到的,並受上限夾', () => {
  const terms: Term[] = [
    { from: 'embedding', to: '嵌入向量' },
    { from: 'Go' }, // 沒有 to → 佔位符處理掉了,不該進 prompt
    { from: 'unused', to: '沒用到' },
  ];
  const got = promptTerms(['Embedding lookup dominates.'], terms);
  assert.deepEqual(got.terms.map((t) => t.from), ['embedding']);
  assert.equal(got.dropped, 0);

  // 上限:40 條都用得到,只放得下 30
  const many: Term[] = Array.from({ length: 40 }, (_, i) => ({ from: `t${i}`, to: `譯${i}` }));
  const big = promptTerms(['t0 t1 t2 ' + many.map((t) => t.from).join(' ')], many);
  assert.equal(big.terms.length, 30);
  assert.equal(big.dropped, 10);
});

test('命中的詞表名字要說得出來 —— 「我明明設了」與「pattern 沒對上」看起來一樣', () => {
  assert.deepEqual(matchedGlossaries('a.qiita.com', SRC), ['技術']);
  assert.deepEqual(matchedGlossaries('news.example', SRC), []);
});
