# 浏览器打印预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「下载 PDF」旁提供仅打印当前简历的浏览器原生打印预览。
**Architecture:** 复用 Preview 的 DOM 与现有分页；前端打印准备函数等待资源及分页稳定后调用 window.print()，由打印媒体样式隔离工作台界面。
**Tech Stack:** React 19、TypeScript、现有 HTML/CSS 模板、Node test、Playwright；不增加依赖。
**Spec:** ../specs/2026-11-23-browser-print-preview-design.md

## Global Constraints
- 打印最新本地编辑内容，不依赖自动保存与 PDF worker，不修改后端契约。
- A4 210mm × 297mm，外边距 0；打印恢复 100% 比例，仅输出主简历分页。
- 不提交、推送或发布代码；本会话直接执行与自查。
- 实现前检查工作树和分支，保留其他修改；优先复用适合的隔离环境。若无可复用环境，拟在原仓库建立 feat/browser-print-preview 功能分支，以便现有 localhost 开发服务看到修改；不直接在 main 实现。

## Review Focus
- 字体和照片慢加载或失败：准备完成后才打印，失败可恢复。
- 快速重复点击、取消打印：单次触发，之后可再次使用。
- 深色模式、预览缩放、窗口较窄：纸张尺寸与内容颜色不受工作台样式影响。
- 多页及侧栏模板：无截断、重复或额外空白页；溢出有提示。
- 未保存编辑与保存失败：打印仍反映本地内容，后台下载路径保持原有行为。

### Task 1：打印入口与准备流程
**Files:**
- Create: apps/web/src/printPreview.ts
- Modify: apps/web/src/EditorPage.tsx、apps/web/src/Preview.tsx
- Test: apps/web/tests/printPreview.test.ts、apps/web/tests/printPreview.e2e.ts

**Interfaces:**
- printResumePreview(root: HTMLElement, target: Window = window): Promise<void>：等待字体和图片就绪、分页稳定，确认主预览无溢出，再调用目标窗口 print；错误交由 EditorPage 展示。
- Preview 复用现有 onPageCount(count, overflow)，为主预览提供明确定位和可检查的准备/溢出状态，避免匹配模板弹窗中的预览。
- EditorPage 管理 preparingPrint 状态，按钮在下载入口旁，try/finally 恢复可操作状态。

- [ ] 写失败测试：入口位置；资源未完成时不打印；最新本地编辑进入打印内容；重复点击仅一次；溢出/资源失败不打印且可重试；不调用导出 API。
- [ ] 运行 `node --import tsx --test apps/web/tests/printPreview.test.ts`；build 后运行新增 e2e，确认因缺失功能而失败。
- [ ] 实现最小打印准备函数与按钮接线；图片失败显示提示；字体完成后等待 React 分页重测稳定；用有界等待避免永久卡住。
- [ ] 重跑新增单元与 e2e，确认准备、失败恢复和再次打印路径通过。

### Task 2：打印样式、回归与说明
**Files:**
- Modify: apps/web/src/styles.css、README.MD
- Test: apps/web/tests/printPreview.e2e.ts

**Interfaces:**
- 打印专用主预览选择器配合 @media print；解除祖先的固定高度、overflow、布局及缩放约束，隐藏所有非简历内容，重置纸张间距与阴影；沿用模板 @page 与分页规则。

- [ ] 先补失败浏览器测试：print 媒体下仅主简历可见，纸张尺寸和 zoom 正确；多页无空白尾页；深浅主题、60%/100% 缩放、照片与侧栏模板均覆盖。通过 Chromium 打印 PDF 检查实际页数和内容，避免只检查 CSS 字符串。
- [ ] 实现打印样式，更新 README 的使用说明和浏览器设置提示；后端与 OpenAPI 无变化。
- [ ] 运行 `npm run typecheck`、`npm test -w @resume-do/web`、`npm test -w @resume-do/templates`、`npm run build -w @resume-do/web`。
- [ ] 运行 `node --import tsx --test apps/web/tests/printPreview.e2e.ts apps/web/tests/export.e2e.ts`；使用本机 Chrome 实际点击并确认原生打印预览，取消后验证编辑器仍可用。
- [ ] 逐行审查 diff，报告实际测试结果及浏览器设置带来的限制；保留改动供用户查看，不自动提交或发布。

## 计划自查
设计中的入口、资源准备、本地最新内容、A4 分页、主题与缩放隔离、取消恢复均有任务和验证对应。只改前端及使用文档，无依赖、数据模型或接口变更。
