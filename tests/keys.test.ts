import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAltKey, keyDownAct, keyUpAct } from '../src/content/keys.ts';

/*
 * 這個檔案守的是**按鍵這條路**,不是 layer 的機制(§EB)。
 *
 * probe 驗過 `setHiddenAll` 會把黑窗裡的加註掀開 —— 但它是直接呼叫
 * layer 驗的。真正壞掉的是 wiring:「放大檢視開著就提前 return」寫在
 * Alt 前面,黑窗印著「按住 Alt 看原圖」而 Alt 根本走不到。
 * 使用者在 Windows 和 Chromebook 上都按不出來。
 */

test('黑窗開著按 Alt 要掀加註 —— 不能被 zoom 的守門吃掉(§EB)', () => {
  const act = keyDownAct('Alt', false, { zoomOpen: true, hiddenAll: false });
  assert.equal(act, 'hide-keep-zoom', '黑窗印著「按住 Alt 看原圖」,這是 UI 給的承諾');
  // Windows 的右 Alt 也是同一顆鍵
  assert.equal(keyDownAct('AltGraph', false, { zoomOpen: true, hiddenAll: false }), 'hide-keep-zoom');
});

test('黑窗開著放開 Alt 要放回來 —— keyup 不能被守門吃掉', () => {
  assert.equal(keyUpAct('Alt', { zoomOpen: true, hiddenAll: true }), 'restore');
  assert.equal(keyUpAct('AltGraph', { zoomOpen: true, hiddenAll: true }), 'restore');
  assert.equal(keyUpAct('Alt', { zoomOpen: true, hiddenAll: false }), 'none');
});

test('沒開黑窗按 Alt = 收整層;放開 = 回來', () => {
  assert.equal(keyDownAct('Alt', false, { zoomOpen: false, hiddenAll: false }), 'hide');
  assert.equal(keyDownAct('AltGraph', false, { zoomOpen: false, hiddenAll: false }), 'hide');
  assert.equal(keyUpAct('Alt', { zoomOpen: false, hiddenAll: true }), 'restore');
});

test('黑窗開著 Esc 關窗;其他鍵一律不動', () => {
  assert.equal(keyDownAct('Escape', false, { zoomOpen: true, hiddenAll: false }), 'close-zoom');
  // Alt 按住中(加註掀著)按 Esc:關窗優先,keyup 的 restore 之後自己來
  assert.equal(keyDownAct('Escape', false, { zoomOpen: true, hiddenAll: true }), 'close-zoom');
  assert.equal(keyDownAct('r', false, { zoomOpen: true, hiddenAll: false }), 'none');
});

test('Alt 加上別的鍵 = 和弦,不是「我想看原文」', () => {
  // Shift+Alt 不收層(Alt+Shift+D / H 那些和弦要用)
  assert.equal(keyDownAct('Alt', true, { zoomOpen: false, hiddenAll: false }), 'none');
  // Alt 按住中來了第二個鍵:放回去
  assert.equal(keyDownAct('r', false, { zoomOpen: false, hiddenAll: true }), 'restore');
  // 重複的 Alt keydown(按住不放會連發)不是第二個鍵
  assert.equal(keyDownAct('Alt', false, { zoomOpen: false, hiddenAll: true }), 'none');
});

test('isAltKey 兩顆都認', () => {
  assert.ok(isAltKey('Alt'));
  assert.ok(isAltKey('AltGraph'));
  assert.ok(!isAltKey('Escape'));
});
