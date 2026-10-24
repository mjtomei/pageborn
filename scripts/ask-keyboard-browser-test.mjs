// Real Chromium/WebKit layout, with a simulated software-keyboard viewport.
// Playwright cannot open the physical iOS keyboard; verify that on the phone.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, backToReading } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://keyboard.test';
const out = 'test-results/ask-keyboard'; await mkdir(out, { recursive: true });
const vite = await createServer({ cacheDir: '.state/vite-keyboard', server: { host: '127.0.0.1', port: 0 }, clearScreen: false, optimizeDeps: { include: ['@huggingface/transformers', 'wasm-feature-detect'] } }); await vite.listen();
const results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { executablePath: '/usr/bin/google-chrome', headless: true } : { headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const errors = []; const prompts = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'provider', provider: 'openai-compatible', baseUrl: 'https://keyboard.test', model: 'fixture' } }));
        const viewport = new EventTarget();
        Object.assign(viewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { value: viewport });
      });
      await page.route('https://keyboard.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
        prompts.push(route.request().postDataJSON());
        await route.fulfill({ json: { choices: [{ message: { content: 'Answer to your question.\n\n'.repeat(35) } }] }, headers: { 'Access-Control-Allow-Origin': '*' } });
      });
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles({ name: 'keyboard.md', mimeType: 'text/markdown', buffer: Buffer.from('# Keyboard\n\nA passage for testing.') });
      await showLibrary(page); await page.locator('[data-document-id="keyboard.md"] .document-card').click();
      await page.locator('#ask-open').click();
      const input = page.locator('#ask-question'); const panel = page.locator('#ask-panel');
      await expect(input).toHaveAttribute('enterkeyhint', 'send');
      await expect(input).toHaveAttribute('rows', '1');
      const emptyHeight = (await input.boundingBox()).height; assert(emptyHeight <= 44);
      await input.fill('First line\nSecond line\nThird line');
      await expect.poll(async () => (await input.boundingBox()).height).toBeGreaterThan(emptyHeight + 25);
      await input.fill('A shorter question'); await expect.poll(async () => (await input.boundingBox()).height).toBe(emptyHeight);
      await input.fill('');
      await expect(page.locator('#ask-voice .ask-mic-icon')).toBeVisible();
      await expect(page.locator('#ask-voice')).toHaveAccessibleName('Start dictation');
      await input.focus();
      const focusStyle = await input.evaluate(el => {
        const style = getComputedStyle(el);
        return { outline: style.outlineStyle, shadow: style.boxShadow, border: style.borderTopWidth, caret: style.caretColor, text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() };
      });
      assert.equal(focusStyle.outline, 'none'); assert.equal(focusStyle.shadow, 'none'); assert.equal(focusStyle.border, '0px');
      assert.notEqual(focusStyle.caret, 'transparent'); assert.notEqual(focusStyle.caret, 'rgba(0, 0, 0, 0)');
      const resize = async (height, top = 0) => page.evaluate(({ height, top }) => {
        Object.assign(window.visualViewport, { height, offsetTop: top }); window.visualViewport.dispatchEvent(new Event('resize'));
      }, { height, top });
      for (const [height, top] of [[480, 0], [360, 70], [260, 40]]) {
        await resize(height, top); await expect(panel).toHaveAttribute('data-keyboard', 'true');
        const p = await panel.boundingBox(), composer = await page.locator('#ask-form').boundingBox();
        assert(Math.abs(p.y - top) <= 1 && Math.abs(p.height - height) <= 1, JSON.stringify(p));
        assert(composer.y >= top && composer.y + composer.height <= top + height, JSON.stringify(composer));
        assert(await page.locator('#ask-history').evaluate(el => el.clientHeight > 30));
      }
      await resize(440, 20); await input.fill('Keyboard send'); await input.press('Enter');
      await expect.poll(() => prompts.length).toBe(1); await expect(page.locator('#ask-answer')).toContainText('Answer to your question');
      await input.fill('Two lines'); await input.press('Shift+Enter');
      await expect(input).toHaveValue('Two lines\n'); assert.equal(prompts.length, 1);
      await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true }); assert.equal(prompts.length, 1);
      await input.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak', isComposing: true }))); assert.equal(prompts.length, 1);
      await input.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak' }))); await expect.poll(() => prompts.length).toBe(2);
      await expect(page.locator('#ask-send')).toBeEnabled();
      await input.fill('Paragraph-style keyboard send');
      await input.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' })));
      await expect.poll(() => prompts.length).toBe(3);
      await expect(page.locator('#ask-send')).toBeEnabled();
      // The custom rail remains visible in mobile WebViews. Dragging must keep
      // keyboard focus in the composer and leave the selected history in place.
      await input.focus();
      const rail = page.locator('#ask-scrollbar'); await expect(rail).toBeVisible();
      await expect(rail).toHaveAttribute('aria-disabled', 'false');
      const track = await rail.boundingBox();
      await page.mouse.click(track.x + track.width / 2, track.y + 1);
      await expect.poll(() => page.locator('#ask-history').evaluate(el => el.scrollTop)).toBe(0);
      await expect(input).toBeFocused(); await expect(page.locator('#ask-latest')).toBeVisible();
      const thumb = await page.locator('.ask-scroll-thumb').boundingBox();
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2); await page.mouse.down();
      await page.mouse.move(track.x + track.width / 2, track.y + track.height - 1, { steps: 6 }); await page.mouse.up();
      await expect(rail).toHaveAttribute('aria-valuenow', '100'); await expect(input).toBeFocused();
      await expect(page.locator('#ask-latest')).toBeHidden();
      await rail.focus(); await rail.press('Home'); await expect(rail).toHaveAttribute('aria-valuenow', '0');
      await rail.press('End'); await expect(rail).toHaveAttribute('aria-valuenow', '100');
      await page.locator('#ask-history').evaluate(el => el.scrollTop = 0);
      await page.screenshot({ path: `${out}/${engine.name()}-keyboard.png` });
      await resize(844); await expect(panel).toHaveAttribute('data-keyboard', 'false');
      await input.focus(); await resize(440);
      // The phone no longer has a Back control inside the chat. Dismiss the
      // software keyboard, then use a document tab to leave Ask.
      await input.blur(); await resize(844); await backToReading(page); await expect(panel).toBeHidden();
      await expect(panel).toHaveAttribute('data-keyboard', 'false');
      assert.deepEqual(errors, []);
      results.push({ engine: engine.name(), keyboardLayout: true, send: true, shiftEnter: true, compositionProtected: true, conversationScrollbar: true, scrollPreservesInputFocus: true, caretWithoutFocusBorder: true, closesCleanly: true, physicalKeyboardTested: false });
    } finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
