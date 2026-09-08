import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_DISPLAY_MODES, isAppWindow } from '../src/content/appwindow.ts';

/*
 * PWA 視窗要整個排除(§ED):網域狀態跟著 profile 走,瀏覽器啟用過的
 * 網域,同網域的 PWA 一開就自動翻 —— 而那個視窗沒有工具列,關都關不掉。
 */

test('安裝的 PWA 視窗三種 display-mode 都認得', () => {
  for (const m of APP_DISPLAY_MODES) {
    assert.ok(
      isAppWindow((q) => q === `(display-mode: ${m})`),
      `${m} 沒被認出來 —— 這種 PWA 視窗會照翻`,
    );
  }
});

test('普通分頁(display-mode: browser)不是 PWA', () => {
  assert.equal(isAppWindow((q) => q === '(display-mode: browser)'), false);
  assert.equal(isAppWindow(() => false), false);
});

test('fullscreen 刻意不算 —— 普通分頁按 F11 或影片全螢幕時它也成立', () => {
  /*
   * 把全螢幕看影片的人的翻譯靜悄悄關掉,比漏掉極少數 display: fullscreen
   * 的 PWA(遊戲那類)更糟。這是決定,不是遺漏 —— 改動前先讀 §ED。
   */
  assert.equal(isAppWindow((q) => q === '(display-mode: fullscreen)'), false);
});
