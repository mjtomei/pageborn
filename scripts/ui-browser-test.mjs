import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { speedToSlider } from '../src/reader.js';
import { showLibrary, showTool, showDockOptions, chooseMode, showSettings, hideSettings } from './ui-helpers.mjs';

const dir = path.resolve(process.env.UI_RESULTS || 'test-results/ui-browser');
await mkdir(dir, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const cache = path.join(os.homedir(), '.cache/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name));
const candidates = [process.env.CHROME_PATH, chromium.executablePath(), ...cached.flatMap(name =>
  [path.join(cache, name, 'chrome-linux/chrome'), path.join(cache, name, 'chrome-linux64/chrome')])].filter(Boolean);
const executablePath = (await Promise.all(candidates.map(async file => { try { await access(file); return file; } catch { return null; } }))).find(Boolean);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const result = { errors: [], passed: false };
let page;
try {
  page = await browser.newPage({ viewport: { width: 430, height: 844 } });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator('#import')).toBeEnabled();
  // A fresh install follows the host's preference, including changes while open.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('#theme-system')).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  const systemDarkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  const systemLightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(systemLightBg, systemDarkBg);
  await expect(page.locator('#library-panel')).toHaveAttribute('data-open', 'true');
  await page.locator('#file-picker').setInputFiles([
    { name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Remote UI guide\n\n' + Array.from({ length: 40 }, (_, i) => `## Chapter ${i + 1}\n\nA passage to find and follow on your glasses.\n\n`).join('')) },
    { name: 'other.md', mimeType: 'text/markdown', buffer: Buffer.from('# Another document\n\nA new reading position.') },
    { name: 'layout.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    { name: 'blank.pdf', mimeType: 'application/pdf', buffer: pdfFixture('blank') },
  ]);
  await expect(page.locator('#doc-count')).toHaveText('4');
  // A finished import tray folds to its summary; details stay one tap away.
  await expect(page.locator('#imports')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.locator('#imports-details')).toBeVisible();
  await expect(page.locator('#import-jobs .import-job[data-phase=done]').first()).toBeHidden();
  await page.locator('#imports-details').click(); await expect(page.locator('#import-jobs .import-job[data-phase=done]').first()).toBeVisible();
  await expect(page.locator('.first-run')).toHaveCount(0);
  const open = async id => { await showLibrary(page); await page.locator(`[data-document-id="${id}"] .document-card`).click(); await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 }); };
  await open('guide.md');
  const setTextSize = async size => { await showSettings(page); await page.locator('#font-size').selectOption(size); await hideSettings(page); };
  await expect(page.locator('#font-size')).toHaveValue('12');
  await expect(page.locator('#passage button').first()).toHaveCSS('font-size', '12px');
  // A new default must not overwrite an explicitly chosen size on reload.
  await setTextSize('22');
  await page.reload(); await expect(page.locator('#font-size')).toBeEnabled();
  await expect(page.locator('#font-size')).toHaveValue('22');
  await expect(page.locator('#passage button').first()).toHaveCSS('font-size', '14.4px');
  await setTextSize('12');
  await expect(page.locator('#library-panel')).toHaveAttribute('data-open', 'false');
  await expect(page.locator('#tool-panel')).toBeHidden();
  await showTool(page, 'search'); await page.locator('#search').fill('Chapter 30');
  await expect(page.locator('#search-results button').first()).toContainText('Chapter 30');
  await page.locator('#search-results button').first().click();
  await page.locator('#tool-close').click(); await expect(page.locator('#tab-search')).toBeFocused();
  await page.locator('#passage').evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = 0; });
  await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'false');
  const before = await page.locator('#position').inputValue();
  await page.locator('#passage-current').click();
  await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#position')).toHaveValue(before);

  const canvas = () => page.locator('#preview').evaluate(el => el.toDataURL());
  const browseAway = async selector => {
    await page.locator(selector).evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = 0; });
    await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'false');
  };
  const dragPosition = async (fraction, selector) => {
    await browseAway(selector);
    const oldCanvas = await canvas();
    const rail = await page.locator('#position').boundingBox();
    assert.ok(rail.height >= 44, 'position has a finger-sized hit area');
    await page.mouse.move(rail.x + rail.width * .2, rail.y + rail.height / 2);
    await page.mouse.down();
    await page.mouse.move(rail.x + 14 + (rail.width - 28) * fraction, rail.y + rail.height / 2, { steps: 8 });
    // Keep the pointer held: the document pane and glasses mirror must both
    // update during scrubbing, without waiting for release or a separate click.
    await expect(page.locator('#position-value')).toHaveText(`${fraction * 100}%`);
    await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.locator(selector).evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    if (selector === '#passage') await expect(page.locator('#scrub-label')).toHaveText(/^Chapter \d+$/);
    await expect.poll(canvas).not.toBe(oldCanvas);
    if (selector === '#passage') assert.ok(await page.locator(selector).evaluate(el => {
      const row = el.querySelector('[aria-current=true]')?.getBoundingClientRect();
      return row && Math.abs(row.top - el.getBoundingClientRect().top) < 3;
    }), 'selected text aligns with the top of the document preview');
    await page.mouse.up();
    await expect(page.locator('#scrub-label')).toBeHidden();
  };
  await dragPosition(.6, '#passage');
  // The transparent space above the visible track should also accept a tap.
  const positionBox = await page.locator('#position').boundingBox();
  await page.mouse.click(positionBox.x + positionBox.width / 2, positionBox.y + 3);
  await expect(page.locator('#position-value')).toHaveText('50%');

  const enterValue = async (kind, value) => {
    if (kind !== 'position') await showDockOptions(page);
    if (kind !== 'position') await showDockOptions(page); await page.locator(`#${kind}-value`).click();
    await expect(page.locator('#value-input')).toBeFocused();
    await page.locator('#value-input').fill(String(value));
    await page.locator('#value-input').press('Enter');
    await expect(page.locator('#value-dialog')).toBeHidden();
    await expect(page.locator(`#${kind}-value`)).toBeFocused();
  };
  await browseAway('#passage');
  await enterValue('position', 37.5);
  await expect(page.locator('#position')).toHaveValue('375');
  await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('#passage').evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await page.locator('#position-value').click();
  for (const value of ['', '-1', '101']) {
    await page.locator('#value-input').fill(value); await page.locator('#value-apply').click();
    await expect(page.locator('#value-dialog')).toBeVisible();
    await expect(page.locator('#position')).toHaveValue('375');
  }
  await page.locator('#value-input').fill('80'); await page.locator('#value-cancel').click();
  await expect(page.locator('#position')).toHaveValue('375');
  for (const percent of [0, 100, 50]) {
    await enterValue('position', percent); await expect(page.locator('#position')).toHaveValue(String(percent * 10));
  }

  await expect(page.locator('#overlap-control, #page-overlap')).toHaveCount(0);
  const currentRow = () => page.locator('#passage button[aria-current=true]').evaluate(el => Number(el.dataset.row));
  const beforePage = await currentRow();
  await page.locator('#next').click(); await expect.poll(currentRow).toBe(beforePage + 9);
  await page.locator('#previous').click(); await expect.poll(currentRow).toBe(beforePage);
  // An existing nonzero browser preference cannot revive overlap.
  await page.evaluate(() => {
    const key = 'even-reader:preferences:v1', saved = JSON.parse(localStorage.getItem(key));
    saved.pageOverlap = 8; localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload(); await expect(page.locator('#next')).toBeEnabled();
  await expect(page.locator('#overlap-control, #page-overlap')).toHaveCount(0);
  const restoredRow = await currentRow();
  await page.locator('#next').click(); await expect.poll(currentRow).toBe(restoredRow + 9);
  await enterValue('position', 50);

  await chooseMode(page, 'auto');
  const speed = async value => page.locator('#speed').evaluate((el, value) => { el.value = String(value); el.dispatchEvent(new Event('input')); }, speedToSlider(value));
  await speed(6); await expect(page.locator('#speed-down')).toBeDisabled();
  await showDockOptions(page); await page.locator('#speed-up').click(); await expect(page.locator('#speed')).toHaveValue(String(speedToSlider(7)));
  await speed(200); await expect(page.locator('#speed-up')).toBeDisabled();
  await enterValue('speed', 100); await showDockOptions(page); await page.locator('#speed-up').click();
  await expect(page.locator('#speed-value')).toHaveText('120 l/min');
  await showDockOptions(page); await page.locator('#speed-down').click(); await expect(page.locator('#speed-value')).toHaveText('100 l/min');
  await showDockOptions(page); const speedBox = await page.locator('#speed').boundingBox();
  await page.mouse.click(speedBox.x + speedBox.width / 2, speedBox.y + 3);
  await expect(page.locator('#speed-value')).toHaveText('35 l/min');
  await showDockOptions(page); await page.locator('#speed').press('Home'); await expect(page.locator('#speed-value')).toHaveText('6 l/min');
  await showDockOptions(page); await page.locator('#speed').press('ArrowRight'); await expect(page.locator('#speed-value')).toHaveText('7 l/min');
  await showDockOptions(page); await page.locator('#speed').press('End'); await expect(page.locator('#speed-value')).toHaveText('200 l/min');
  await showDockOptions(page); await page.locator('#speed').press('ArrowLeft'); await expect(page.locator('#speed-value')).toHaveText('167 l/min');
  await showDockOptions(page); await page.locator('#speed-value').click();
  for (const value of ['5', '201', '10.5']) {
    await page.locator('#value-input').fill(value); await page.locator('#value-apply').click();
    await expect(page.locator('#value-dialog')).toBeVisible();
    await expect(page.locator('#speed-value')).toHaveText('167 l/min');
  }
  await page.keyboard.press('Escape'); await expect(page.locator('#value-dialog')).toBeHidden();
  await page.locator('#play').click();
  await showDockOptions(page); await page.locator('#speed-value').click(); await page.locator('#value-input').fill('83');
  const positionWhileEditing = await page.locator('#position').inputValue();
  await expect(page.locator('#position')).not.toHaveValue(positionWhileEditing);
  await expect(page.locator('#value-input')).toHaveValue('83');
  await page.locator('#value-apply').click(); await expect(page.locator('#speed-value')).toHaveText('83 l/min');
  await expect(page.locator('#play')).toHaveText('Pause');
  await showLibrary(page); await expect(page.locator('#library-heading')).toBeFocused();
  await page.locator('#position-value').click(); await page.keyboard.press('Escape');
  await expect(page.locator('#value-dialog')).toBeHidden();
  await expect(page.locator('#library-panel')).toHaveAttribute('data-open', 'true');
  await expect(page.locator('#passage')).toHaveAttribute('inert', '');
  await expect(page.locator('#reader-controls')).not.toHaveAttribute('inert', '');
  const playingPosition = await page.locator('#position').inputValue();
  await expect(page.locator('#position')).not.toHaveValue(playingPosition, { timeout: 5000 });
  await page.locator('#play').click(); await expect(page.locator('#play')).toHaveText('Start autoscroll');
  await page.locator('#library-heading').focus();
  const pausedPosition = await page.locator('#position').inputValue();
  await page.keyboard.press('End'); await expect(page.locator('#position')).toHaveValue(pausedPosition);
  await page.keyboard.press('Escape'); await expect(page.locator('#library-toggle')).toBeFocused();
  await expect(page.locator('#passage')).not.toHaveAttribute('inert', '');

  const layouts = [];
  const checkDockSpace = async () => {
    const bounds = await page.evaluate(() => ({
      content: document.querySelector('.reader-content').getBoundingClientRect().toJSON(),
      dock: document.querySelector('#reader-controls').getBoundingClientRect().toJSON(),
      height: innerHeight, pageHeight: document.documentElement.scrollHeight,
    }));
    assert.ok(bounds.content.bottom <= bounds.dock.top + 1, 'reading area ends above the controls');
    assert.ok(bounds.dock.bottom <= bounds.height + 1, 'all controls fit in the viewport');
    assert.ok(bounds.pageHeight <= bounds.height + 1, 'the outer page does not scroll the controls off screen');
  };
  for (const width of [360, 390, 400, 430, 480, 768, 1000, 1200, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const mode of ['page', 'auto', 'speed']) {
      await chooseMode(page, mode);
      await checkDockSpace();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px ${mode} overflow`);
      assert.ok(await page.locator('#speed-control').evaluate(el => el.hidden || el.scrollWidth <= el.clientWidth + 1), `${width}px speed controls overflow`);
      assert.ok(await page.locator('#speed-control').evaluate(el => el.hidden || [...el.children].filter(child => child.getClientRects().length)
        .every(child => child.getBoundingClientRect().left >= el.getBoundingClientRect().left - 1)), `${width}px speed controls overlap the mode selector`);
      await showLibrary(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px drawer overflow`);
      assert.ok(await page.locator('#play').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'dock remains reachable with the library open');
      if (width < 1000) await page.locator('#library-close').click();
      layouts.push({ width, mode });
    }
  }
  // Reproduce a document's final row being hidden behind the dock. Check actual
  // hit testing after scrolling, including short screens and extra footer inset.
  for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 1000) await expect(page.locator('#library-panel')).toBeHidden();
    for (const size of ['12', '22', '26']) {
      await setTextSize(size);
      await page.locator('#passage').evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = el.scrollHeight; });
      await expect.poll(() => page.locator('#passage').evaluate(el => el.lastElementChild.style.height)).toBe('0px');
      const lastRow = page.locator('#passage button').last();
      await expect(lastRow).toHaveText('A passage to find and follow on your glasses.');
      await page.locator('#passage').evaluate(el => el.scrollIntoView({ block: 'end' }));
      await expect.poll(() => lastRow.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), { message: `${viewport.width}x${viewport.height} ${size}px final row is uncovered` }).toBe(true);
      await checkDockSpace();
    }
    await page.locator('.settings summary').click();
    await page.locator('#debug-export').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#debug-export').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'Diagnostics remains reachable above the dock');
    await page.locator('.settings summary').click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await setTextSize('12');
  await page.locator('#reader-controls').evaluate(el => { el.style.paddingBottom = '46px'; });
  await checkDockSpace();
  await page.locator('#reader-controls').evaluate(el => { el.style.paddingBottom = ''; });
  await page.setViewportSize({ width: 390, height: 844 });
  await open('layout.pdf');
  await chooseMode(page, 'page'); await expect(page.locator('#overlap-control')).toHaveCount(0);
  await chooseMode(page, 'auto');
  await dragPosition(.6, '#pdf-passage');
  await enterValue('position', 37.5); await expect(page.locator('#position-value')).toHaveText('37.5%');
  await showDockOptions(page); await page.locator('#speed-value').click(); await expect(page.locator('#value-label')).toHaveText('Steps per minute');
  await page.locator('#value-cancel').click();
  await page.locator('#pdf-passage').evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = el.scrollHeight; });
  await page.locator('#pdf-passage').evaluate(el => el.scrollIntoView({ block: 'end' }));
  await checkDockSpace();
  assert.ok(await page.locator('#pdf-passage').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.bottom - 4)); }), 'bottom of the PDF preview is uncovered');
  await page.screenshot({ path: path.join(dir, 'pdf-bottom.png') });
  await showTool(page, 'pdf');
  await page.locator('#pdf-reflow').check(); await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 });
  await open('other.md'); await expect(page.locator('#tab-pdf')).toBeHidden(); await expect(page.locator('#tool-panel')).toBeHidden();
  await expect(page.locator('#passage-current')).toHaveAttribute('aria-pressed', 'true');
  await showLibrary(page); await page.locator('[data-document-id="blank.pdf"] .document-card').click();
  await expect(page.locator('#notice')).toContainText('no visible content');
  await showLibrary(page); await expect(page.locator('#library-panel #notice')).toBeVisible();
  await page.locator('#library-close').click(); await expect(page.locator('.reader-sticky #notice')).toBeVisible();
  await open('guide.md'); await chooseMode(page, 'page'); await page.locator('#start').click();
  await expect(page.locator('#position')).toHaveValue('0');
  await expect(page.locator('#library-panel')).toBeHidden();
  await page.locator('.reader-content').evaluate(el => { el.scrollTop = 0; }); await page.screenshot({ path: path.join(dir, 'phone-reader.png') });
  await page.locator('#passage').evaluate(el => { el.dispatchEvent(new Event('wheel')); el.scrollTop = el.scrollHeight; });
  await expect.poll(() => page.locator('#passage').evaluate(el => el.lastElementChild.style.height)).toBe('0px');
  await page.locator('#passage').evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.screenshot({ path: path.join(dir, 'text-bottom.png') });
  // Appearance: System follows the device; Light/Dark are saved like other shared settings.
  await page.setViewportSize({ width: 390, height: 844 });
  await showTool(page, 'settings');
  await page.locator('#theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#theme-light')).toHaveAttribute('aria-pressed', 'true');
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', lightBg);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.reload(); await expect(page.locator('#import')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', lightBg);
  await showTool(page, 'settings'); await page.locator('#theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), lightBg, 'themes change the page colors');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', systemDarkBg);
  await page.locator('#theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('body')).toHaveCSS('background-color', systemLightBg);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', systemDarkBg);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.reload(); await expect(page.locator('#import')).toBeEnabled();
  await expect(page.locator('#theme-system')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('body')).toHaveCSS('background-color', systemDarkBg);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', systemLightBg);
  await showTool(page, 'settings');
  // Page entry uses the same numeric dialog as the other values.
  await hideSettings(page);
  await page.locator('#mode-page').evaluate(el => el.click());
  const pageCount = Number(await page.locator('#page-number').getAttribute('max'));
  assert.ok(pageCount > 3, 'test document has several pages');
  await page.locator('#page-value').click();
  await expect(page.locator('#value-label')).toHaveText('Page number');
  for (const value of ['0', String(pageCount + 1), '1.5']) {
    await page.locator('#value-input').fill(value); await page.locator('#value-apply').click();
    await expect(page.locator('#value-dialog')).toBeVisible();
  }
  await page.locator('#value-input').fill('3'); await page.locator('#value-input').press('Enter');
  await expect(page.locator('#value-dialog')).toBeHidden(); await expect(page.locator('#page-value')).toBeFocused();
  await expect(page.locator('#page-number')).toHaveValue('3');
  await expect(page.locator('#page-value')).toHaveText(`Page 3 of ${pageCount}`);
  await page.locator('#start').click(); await expect(page.locator('#page-value')).toHaveText(`Page 1 of ${pageCount}`);
  // Help is hidden on every launch and appears in a dismissible popup.
  await expect(page.locator('#glasses-hints')).toBeHidden();
  await page.locator('#hints-toggle').click(); await expect(page.locator('#glasses-hints')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#glasses-hints')).toBeHidden();
  await expect(page.locator('#hints-toggle')).toBeFocused();
  await page.reload(); await expect(page.locator('#import')).toBeEnabled();
  await expect(page.locator('#glasses-hints')).toBeHidden();
  // Settings moved out of the document tools into the library.
  await expect(page.locator('#tab-settings')).toHaveCount(0);
  await showSettings(page); await expect(page.locator('#settings-heading')).toBeFocused();
  await expect(page.locator('#library-body')).toBeHidden();
  await page.locator('#settings-done').click(); await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#settings-toggle')).toBeFocused();
  // Recently read documents come first.
  await expect(page.locator('#documents .document-entry').first()).toHaveAttribute('data-document-id', 'guide.md');
  await hideSettings(page);
  // Short connection state; Reconnect only when it can help.
  await expect(page.locator('#connection-state')).toHaveText('Preview');
  await expect(page.locator('#reconnect')).toBeHidden();
  // Header bookmark adds without opening Marks; marks and headings appear on the slider.
  const marksBefore = Number((await page.locator('#bookmark-count').textContent()) || 0);
  await page.locator('#bookmark-quick').click();
  await expect(page.locator('#bookmark-count')).toHaveText(` ${marksBefore + 1}`);
  await expect(page.locator('#tool-panel')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('Bookmarked');
  assert.ok(await page.locator('#position-landmarks .landmark.heading').count() > 5, 'headings mark the slider');
  await expect(page.locator('#position-landmarks .landmark.mark')).toHaveCount(marksBefore + 1);
  // Long-press a line to bookmark it without moving the glasses.
  const positionBeforePress = await page.locator('#position').inputValue();
  await page.locator('#passage').scrollIntoViewIfNeeded();
  const paneBox = await page.locator('#passage').boundingBox();
  await page.mouse.move(paneBox.x + 30, paneBox.y + Math.min(80, paneBox.height / 2)); await page.mouse.down();
  await page.waitForTimeout(800); await page.mouse.up();
  await expect(page.locator('#bookmark-count')).toHaveText(` ${marksBefore + 2}`);
  await expect(page.locator('#position')).toHaveValue(positionBeforePress);
  // Step through search results.
  await showTool(page, 'search'); await page.locator('#search').fill('Chapter');
  await expect(page.locator('#search-step')).toBeVisible(); await expect(page.locator('#search-count')).toHaveText(/matches/);
  await page.locator('#search').press('Enter'); await expect(page.locator('#search-count')).toHaveText(/^1 of /);
  const firstHit = await page.locator('#position').inputValue();
  await page.locator('#search-next').click(); await expect(page.locator('#search-count')).toHaveText(/^2 of /);
  assert.notEqual(await page.locator('#position').inputValue(), firstHit, 'next match moves the reading position');
  await page.locator('#search-prev').click(); await expect(page.locator('#search-count')).toHaveText(/^1 of /);
  await page.locator('#tool-close').click();
  // The mirror works like the glasses touchpad with mode-specific reading taps.
  await page.locator('#mode-page').evaluate(el => el.click()); await page.locator('#start').click();
  await expect(page.locator('#page-value')).toHaveText(/^Page 1 of/);
  await page.locator('.reader-content').evaluate(el => { el.scrollTop = 0; });
  const mirror = await page.locator('#preview').boundingBox();
  await page.mouse.click(mirror.x + mirror.width / 2, mirror.y + mirror.height / 2);
  await expect(page.locator('#page-value')).toHaveText(/^Page 2 of/);
  await page.mouse.move(mirror.x + mirror.width * .8, mirror.y + mirror.height / 2); await page.mouse.down();
  await page.mouse.move(mirror.x + mirror.width * .2, mirror.y + mirror.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('#page-value')).toHaveText(/^Page 3 of/);
  await page.mouse.move(mirror.x + mirror.width * .2, mirror.y + mirror.height / 2); await page.mouse.down();
  await page.mouse.move(mirror.x + mirror.width * .8, mirror.y + mirror.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('#page-value')).toHaveText(/^Page 2 of/);
  // The floating dock folds modes and pace behind a summary button on phones.
  const toggle = page.locator('#dock-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  await expect(page.locator('#mode-page')).toBeHidden();
  await expect(page.locator('#dock-summary')).toHaveText(/Pages|Autoscroll|Speed/);
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#mode-page')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toggle).toBeHidden(); await page.locator('#dock-toggle').evaluate(el => el.click());
  await expect(page.locator('#mode-page')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(result.errors, []); Object.assign(result, { passed: true, themes: true, systemThemeDefault: true, liveSystemTheme: true, themeOverrides: true, foldingDock: true, librarySettings: true, quickBookmarks: true, landmarks: true, searchStepping: true, mirrorTouchpad: true, steppers: true, foldingImports: true, pageEntry: true, glassesHints: true, layouts, smallDefault: true, savedFontSize: true, unobscuredReader: true, drawerAndDock: true, followIndicator: true, liveScrubbing: true, numericEntry: true, zeroPageOverlap: true, logarithmicSpeed: true, speedLimits: true, noticeVisibility: true, pdfTools: true });
  console.log('PASS: Small default and saved size; unobscured text/PDF/Diagnostics on narrow, short and wide screens; zero-overlap pages, numeric position/rate, scrubbing, logarithmic speed, drawer/dock, focus and PDF tools.');
} catch (error) {
  result.error = error.stack;
  await page?.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
