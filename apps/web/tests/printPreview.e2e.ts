import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { createDefaultAppearance, createDefaultDocument, type ResumeAppearance } from '@resume-do/schema';

const base = 'http://localhost:4198';
const dist = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwaDgAAAKEAYEml6crAAAAAElFTkSuQmCC';

async function setup(page: Page, templateId: ResumeAppearance['templateId'] = '2170') {
  const resumeDocument = createDefaultDocument();
  resumeDocument.basic.name = '打印测试';
  resumeDocument.basic.photo = photo;
  resumeDocument.sections = [{ id: 'evaluation', type: 'rich', title: '自我评价', visible: true,
    items: [{ id: 'body', title: '', role: '', startMonth: '', endMonth: '', ongoing: false,
      body: Array.from({ length: 65 }, (_, i) => `<p>打印段落 ${i + 1}：验证多页简历完整呈现。</p>`).join('') }] }];
  const record = { id: 'print-test', kind: 'structured', title: '打印回归', revision: 1,
    document: resumeDocument, appearance: { ...createDefaultAppearance(), templateId },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const state = { exports: 0 };
  await page.route(`${base}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) return route.fallback();
    const file = path.resolve(dist, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(dist + path.sep)) throw new Error('Invalid asset path');
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    await route.fulfill({ body: await readFile(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') return route.fulfill({ json: { id: 99, email: 'print@example.com', displayName: '打印测试', themePreference: 'dark' } });
    if (pathname === '/api/resumes') return route.fulfill({ json: [record] });
    if (pathname === '/api/resumes/print-test') {
      // Printing must work even when autosave fails.
      if (route.request().method() === 'PATCH') return route.fulfill({ status: 503, json: { message: '保存暂不可用' } });
      return route.fulfill({ json: record });
    }
    if (pathname.includes('/exports')) state.exports++;
    return route.fulfill({ status: 404, json: {} });
  });
  await page.addInitScript(() => {
    (window as any).__printed = [];
    window.print = () => { (window as any).__printed.push(document.querySelector('.canvas .pages')?.textContent); };
  });
  await page.goto(base);
  await page.locator('.resume-card .card-open').first().click();
  await page.getByLabel('姓名', { exact: true }).waitFor();
  return state;
}

const printed = (page: Page) => page.evaluate(() => (window as any).__printed as string[]);

test('print button uses latest local edits, prevents duplicate clicks, and recovers after print and overflow', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const state = await setup(page);
    const button = page.getByRole('button', { name: '打印预览', exact: true });
    assert.equal(await button.count(), 1, 'provide a print entry beside PDF download');
    assert.equal(await button.evaluate(el => el.nextElementSibling?.textContent?.trim()), '↓ 下载 PDF');
    const failedSave = page.waitForResponse(response => response.url().endsWith('/api/resumes/print-test') && response.request().method() === 'PATCH' && response.status() === 503);
    await page.getByLabel('姓名', { exact: true }).fill('最新未保存内容');
    // Keep a real font readiness promise pending to exercise the preparation boundary.
    await page.evaluate(() => {
      Object.defineProperty(document.fonts, 'ready', { configurable: true, value: new Promise<void>(resolve => { (window as any).__releaseFonts = resolve; }) });
    });
    await button.click();
    assert.equal(await page.getByRole('button', { name: '正在准备…', exact: true }).isDisabled(), true);
    assert.equal((await printed(page)).length, 0);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('.print-preview-button')?.click());
    await page.evaluate(() => (window as any).__releaseFonts());
    await page.waitForFunction(() => (window as any).__printed.length === 1);
    assert.match((await printed(page))[0], /最新未保存内容/);
    await failedSave;
    await page.locator('.save-state.error').waitFor();
    await button.waitFor();
    await button.click();
    await page.waitForFunction(() => (window as any).__printed.length === 2);
    assert.match((await printed(page))[1], /最新未保存内容/, 'printing also works after a confirmed save failure');
    assert.equal(state.exports, 0);
    await page.getByRole('tab', { name: /自我评价/ }).click();
    await page.getByRole('textbox', { name: '自我评价正文', exact: true }).fill('超长段落'.repeat(2500));
    await page.locator('.canvas .overflow-warning').waitFor();
    await button.click();
    await page.getByText(/内容超过单页高度，请先调整/).waitFor();
    assert.equal((await printed(page)).length, 2);
    await page.getByRole('textbox', { name: '自我评价正文', exact: true }).fill('恢复后的正文');
    await button.click();
    await page.waitForFunction(() => (window as any).__printed.length === 3);
    assert.match((await printed(page))[2], /恢复后的正文/);
  } finally { await browser.close(); }
});

for (const templateId of ['2170', '1015'] as const) {
  test(`print media keeps A4 pages and only resume content for ${templateId}`, { timeout: 60_000 }, async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await setup(page, templateId);
      await page.locator('.canvas .r-page').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const count = await page.locator('.canvas .r-page').count();
      assert.ok(count >= 2, 'fixture must cover more than one A4 page');
      for (const [theme, zoom, width] of [['dark', '0.6', 1440], ['light', '1', 1440], ['dark', '0.6', 390]] as const) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await page.getByLabel('预览显示比例').selectOption(zoom);
        const screenZoom = await page.locator('.canvas .pages').evaluate(el => getComputedStyle(el).zoom);
        await page.emulateMedia({ media: 'print' });
        const metrics = await page.evaluate(() => {
          const pages = document.querySelector<HTMLElement>('.canvas .pages')!;
          const paper = pages.querySelector<HTMLElement>('.r-page')!;
          return { zoom: getComputedStyle(pages).zoom, width: paper.getBoundingClientRect().width,
            height: paper.getBoundingClientRect().height, margin: getComputedStyle(paper).marginBottom,
            shadow: getComputedStyle(paper).boxShadow, background: getComputedStyle(paper).backgroundColor };
        });
        assert.equal(metrics.zoom, '1');
        assert.ok(Math.abs(metrics.width - 793.7) < 1, JSON.stringify(metrics));
        assert.ok(Math.abs(metrics.height - 1122.52) < 1, JSON.stringify(metrics));
        assert.equal(metrics.margin, '0px');
        assert.equal(metrics.shadow, 'none');
        for (const selector of ['.topbar', '.toolbar', '.editor', '.canvas-head', '.page-badge', '.download-fab', '.measure-host']) {
          assert.equal(await page.locator(selector).first().isVisible(), false, `${selector} is not printed`);
        }
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
        // PDF page dictionaries are independent of our application paginator.
        const actualCount = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;
        assert.equal(actualCount, count, 'no clipped pages or trailing blank page');
        if (process.env.RESUME_DO_PRINT_ARTIFACTS) {
          await writeFile(path.join(process.env.RESUME_DO_PRINT_ARTIFACTS, `${templateId}-${theme}-${zoom}-${width}.pdf`), pdf);
        }
        await page.emulateMedia({ media: 'screen' });
        assert.equal(await page.locator('.canvas .pages').evaluate(el => getComputedStyle(el).zoom), screenZoom);
        assert.equal(await page.locator('.editor').isVisible(), true);
      }
    } finally { await browser.close(); }
  });
}
