// The 0.7 phone layout keeps the library in a drawer and document tools in an
// on-demand panel. Browser checks open them the way a person would before
// using controls inside; on desktop widths the library is always visible.
export async function waitForPdfReady(page, timeout = 30000) {
  await page.waitForFunction(() => !document.querySelector('#bookmark').disabled
    && JSON.parse(localStorage.getItem('even-reader:diagnostics:v1') || '{}').pdf?.stage === 'ready', null, { timeout });
}
export async function showLibrary(page) {
  // A viewport change delivers its matchMedia callback on the next frame.
  // Let it settle before deciding whether the drawer already needs opening.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const toggle = page.locator('#library-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('#library-panel[data-open="true"]').waitFor({ state: 'visible' });
  // Wait for the slide-in to finish so clicks land on settled rows.
  await page.waitForFunction(() => { const r = document.querySelector('#library-panel').getBoundingClientRect(); return r.top >= -1 && r.left >= -1; });
  // Settings share the library space; return to the document list.
  if (await page.locator('#settings-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#settings-done').click();
}
export async function showTool(page, name) {
  if (name === 'settings') return showSettings(page);
  await hideSettings(page);
  if (await page.locator(`#tab-${name}`).getAttribute('aria-pressed') !== 'true') await page.locator(`#tab-${name}`).click();
}
// Device-wide settings live in the library (a drawer on phones, a column on desktop).
export async function showSettings(page) {
  await showLibrary(page);
  if (await page.locator('#settings-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settings-toggle').click();
  await page.locator('#shared-settings').waitFor({ state: 'visible' });
  // Connection and Voice are collapsible sections; checks use their controls directly.
  await page.evaluate(() => { for (const section of document.querySelectorAll('#shared-settings .settings-section')) section.open = true; });
}
// Leave settings and, on phones, close the drawer so the reader is usable again.
export async function hideSettings(page) {
  if (await page.locator('#settings-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#settings-done').click();
  const drawer = await page.evaluate(() => matchMedia('(max-width: 999px)').matches);
  if (drawer && await page.locator('#library-panel').getAttribute('data-open') === 'true') await page.locator('#library-close').click();
  if (drawer) await page.locator('#library-panel').waitFor({ state: 'hidden' });
}
// Phones fold pace (speed, words per group) behind the pace button in the
// transport row; open it before using those controls. Desktop always shows them.
export async function showDockOptions(page) {
  const toggle = page.locator('#pace-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
// Phones choose the reading mode from the mode chip's menu; desktop shows the modes inline.
export async function chooseMode(page, mode) {
  const button = page.locator(`#mode-${mode}`);
  if (!await button.isVisible()) {
    const chip = page.locator('#dock-toggle');
    if (await chip.getAttribute('aria-expanded') !== 'true') await chip.click();
  }
  await button.click();
}
// Document tabs leave phone Ask; glasses navigation remains in the preview.
export async function backToReading(page) {
  await page.locator('#ask-question').blur();
  await page.locator('#tab-outline').click();
  await page.locator('#tool-close').click();
}
