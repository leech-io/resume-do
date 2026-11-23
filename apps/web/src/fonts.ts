import type { FontId } from '@resume-do/schema';

export const FONT_OPTIONS: Array<{ id: FontId; label: string }> = [
  { id: 'sans', label: '系统黑体（PingFang / 微软雅黑）' },
  { id: 'serif', label: '系统宋体' },
  { id: 'arial', label: 'Arial' },
  { id: 'noto-sans', label: '思源黑体（Noto Sans SC）' },
  { id: 'noto-serif', label: '思源宋体（Noto Serif SC）' },
  { id: 'lxgw-wenkai', label: '霞鹜文楷（LXGW WenKai）' },
];

const WEB_FONT_FAMILIES: Partial<Record<FontId, string>> = {
  'noto-sans': 'Noto Sans SC',
  'noto-serif': 'Noto Serif SC',
  'lxgw-wenkai': 'LXGW WenKai',
};

// Each entry is a dynamic import so a font's CSS and woff2 slices only load
// after the user picks it; unicode-range inside those stylesheets keeps the
// download limited to the glyph slices a resume actually uses.
const WEB_FONT_LOADERS: Partial<Record<FontId, () => Promise<unknown>>> = {
  'noto-sans': () => Promise.all([
    import('@fontsource/noto-sans-sc/400.css'),
    import('@fontsource/noto-sans-sc/700.css'),
  ]),
  'noto-serif': () => Promise.all([
    import('@fontsource/noto-serif-sc/400.css'),
    import('@fontsource/noto-serif-sc/700.css'),
  ]),
  'lxgw-wenkai': () => Promise.all([
    import('lxgw-wenkai-webfont/lxgwwenkai-regular.css'),
    import('lxgw-wenkai-webfont/lxgwwenkai-bold.css'),
  ]),
};

const loaded = new Set<FontId>();
const pending = new Map<FontId, Promise<void>>();

export function loadFont(fontId: FontId, strict = false): Promise<void> {
  const loader = WEB_FONT_LOADERS[fontId];
  if (!loader || loaded.has(fontId)) return Promise.resolve();
  const existing = pending.get(fontId);
  if (existing) return strict ? existing : existing.catch(() => undefined);
  const family = WEB_FONT_FAMILIES[fontId];
  const task = loader()
    .then(() => globalThis.document.fonts?.load(`14px "${family}"`, '简历Aa'))
    .then(() => {
      loaded.add(fontId);
    })
    .finally(() => pending.delete(fontId));
  pending.set(fontId, task);
  return strict ? task : task.catch(() => undefined);
}
