import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hidePinnedWhileScrolling, motionGuard } from '../src/content/motion.ts';

/*
 * 「捲動時先藏起來」是為 Gmail 加的,而同一條規則套在長文上只換來閃爍。
 * 使用者的原話:「在非 gmail 的長文中 就會有一直閃的感覺」。
 */

test('自動:一般長文不藏', () => {
  assert.equal(
    motionGuard({ stability: 'auto', appShell: false, innerScroll: false }),
    false,
  );
});

test('自動:document 自己不捲的應用程式外殼要藏', () => {
  assert.equal(motionGuard({ stability: 'auto', appShell: true, innerScroll: false }), true);
});

test('自動:收到過內層捲動就從此開啟 —— 證據比推測強', () => {
  assert.equal(motionGuard({ stability: 'auto', appShell: false, innerScroll: true }), true);
});

test('一直顯示:任何頁面都不藏,連 Gmail 也是(使用者說了不在意)', () => {
  assert.equal(motionGuard({ stability: 'always', appShell: true, innerScroll: true }), false);
  assert.equal(hidePinnedWhileScrolling('always'), false);
});

test('嚴格:一般長文也藏 —— 版面很動態的頁面才需要', () => {
  assert.equal(motionGuard({ stability: 'strict', appShell: false, innerScroll: false }), true);
});

test('釘住的單元和頁面策略無關 —— 它的座標在任何頁面上都會隨捲動改變', () => {
  assert.equal(hidePinnedWhileScrolling('auto'), true);
  assert.equal(hidePinnedWhileScrolling('strict'), true);
});
