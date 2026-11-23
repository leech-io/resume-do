import type { FontId } from '@resume-do/schema';
import { loadFont } from './fonts';

const PREPARE_TIMEOUT_MS = 15_000;

/** Print the live editor preview; never start a server export or wait for autosave. */
export async function printResumePreview(root: HTMLElement, target: Window = window): Promise<void> {
  function previewState() {
    if (!root.isConnected) throw new Error('简历编辑器已关闭，请重新打开后打印。');
    const preview = root.querySelector<HTMLElement>('.preview-root');
    if (!preview) throw new Error('简历预览尚未就绪，请稍后重试。');
    if (preview.dataset.overflow === 'true') {
      throw new Error('内容超过单页高度，请先调整字号、行距或拆分长段落后打印。');
    }
    const pages = preview.querySelector<HTMLElement>('.pages');
    if (!pages?.querySelector('.r-page')) throw new Error('简历预览尚未就绪，请稍后重试。');
    return { preview, pages };
  }

  previewState();
  const deadline = Date.now() + PREPARE_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const frame = () => new Promise<void>(resolve => target.requestAnimationFrame(() => resolve()));
  async function prepare() {
    const fonts = root.ownerDocument.fonts;
    while (Date.now() < deadline) {
      const fontId = previewState().preview.dataset.fontId as FontId;
      await loadFont(fontId, true);
      await fonts?.ready;
      const { pages } = previewState();
      const snapshot = pages.innerHTML;
      // Load every glyph used in the selected face, including unicode-range slices.
      const paper = pages.querySelector<HTMLElement>('.r-page')!;
      if (fonts) {
        const style = target.getComputedStyle(paper);
        await Promise.all(['400', '700'].map(weight => fonts.load(
          `${weight} ${style.fontSize} ${style.fontFamily}`, pages.textContent || '简历',
        )));
      }
      await Promise.all(Array.from(pages.querySelectorAll('img')).map(async image => {
        try { await image.decode(); }
        catch { throw new Error('简历图片加载失败，请检查照片后重试。'); }
      }));
      // Fonts can cause React's measurement effect to rebuild the page fragment.
      await frame();
      await frame();
      const latest = previewState();
      if (latest.preview.dataset.fontId === fontId && latest.pages.innerHTML === snapshot
          && (!fonts || fonts.status === 'loaded')) return;
    }
    throw new Error('打印准备超时，请等待字体和图片加载完成后重试。');
  }

  try {
    await Promise.race([
      prepare(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('打印准备超时，请等待字体和图片加载完成后重试。')), PREPARE_TIMEOUT_MS);
      }),
    ]);
    // Recheck after asynchronous preparation: the user may have changed the resume.
    previewState();
    target.print();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
