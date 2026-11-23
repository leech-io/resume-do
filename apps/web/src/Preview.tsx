import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ResumeAppearance, ResumeDocument } from '@resume-do/schema';
import {
  RESUME_CSS,
  buildBlocks,
  getPageMetrics,
  getTemplateLayout,
  paginateBlocks,
  renderAsideMeasureFragment,
  renderMeasureFragment,
  renderPagesFragment,
  splitBlocks,
} from '@resume-do/templates';

interface PreviewProps {
  document: ResumeDocument;
  appearance: ResumeAppearance;
  zoom: number;
  onPageCount?: (count: number, overflow: boolean) => void;
}

export default function Preview({ document, appearance, zoom, onPageCount }: PreviewProps) {
  const measureRef = useRef<HTMLDivElement>(null);
  const asideMeasureRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onPageCount);
  callbackRef.current = onPageCount;

  const [pagesHtml, setPagesHtml] = useState('');
  const [pageCount, setPageCount] = useState(1);
  const [overflow, setOverflow] = useState(false);
  const [fontEpoch, setFontEpoch] = useState(0);

  const blocks = useMemo(
    () => buildBlocks({ document, appearance }),
    [document, appearance],
  );
  const { aside, main } = useMemo(
    () => splitBlocks(blocks, getTemplateLayout(appearance.templateId)),
    [blocks, appearance.templateId],
  );

  useEffect(() => {
    const id = 'resume-page-css';
    if (globalThis.document.getElementById(id)) return;
    const style = globalThis.document.createElement('style');
    style.id = id;
    style.textContent = RESUME_CSS;
    globalThis.document.head.appendChild(style);
  }, []);

  useEffect(() => {
    let alive = true;
    const fonts = globalThis.document.fonts;
    void fonts?.ready.then(() => {
      if (alive) setFontEpoch((value) => value + 1);
    });
    const onLoadingDone = () => {
      if (alive) setFontEpoch((value) => value + 1);
    };
    fonts?.addEventListener('loadingdone', onLoadingDone);
    return () => {
      alive = false;
      fonts?.removeEventListener('loadingdone', onLoadingDone);
    };
  }, []);

  useLayoutEffect(() => {
    const host = measureRef.current;
    if (!host) return;

    host.innerHTML = renderMeasureFragment({ document, appearance }, main);
    const elements = Array.from(host.querySelectorAll<HTMLElement>('[data-block]'));
    const heights = elements.map((element) => element.getBoundingClientRect().height);
    const metrics = getPageMetrics(appearance);
    const result = paginateBlocks(main, heights, metrics.contentHeightPx);
    const pages = result.pages.map((page) => page.map((index) => main[index]));

    let asideOverflow = false;
    const asideHost = asideMeasureRef.current;
    if (asideHost) {
      asideHost.innerHTML = '';
      if (aside.length > 0) {
        asideHost.innerHTML = renderAsideMeasureFragment({ document, appearance }, aside);
        const asideHeight = Array.from(
          asideHost.querySelectorAll<HTMLElement>('[data-block]'),
        ).reduce((total, element) => total + element.getBoundingClientRect().height, 0);
        asideOverflow = asideHeight > metrics.asideContentHeightPx + 1;
      }
    }

    const hasOverflow = result.overflow.length > 0 || asideOverflow;
    setPagesHtml(renderPagesFragment({ document, appearance }, pages, aside));
    setPageCount(pages.length);
    setOverflow(hasOverflow);
    callbackRef.current?.(pages.length, hasOverflow);
  }, [blocks, appearance, document, fontEpoch, aside, main]);

  return (
    <div className="preview-root" data-overflow={overflow} data-font-id={appearance.fontId}>
      <div ref={measureRef} className="measure-host" aria-hidden="true" />
      <div ref={asideMeasureRef} className="measure-host" aria-hidden="true" />
      {overflow && (
        <div className="overflow-warning" role="alert">
          正文、标题与首段组合，或侧栏内容超过单页高度。请拆分长段落、缩短侧栏，或调小字号 / 行距后导出。
        </div>
      )}
      <div
        className="pages"
        style={{ zoom } as CSSProperties}
        aria-label={`简历预览，共 ${pageCount} 页`}
        dangerouslySetInnerHTML={{ __html: pagesHtml }}
      />
    </div>
  );
}
