import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  BasicFieldKey,
  IntentFieldKey,
  ResumeAppearance,
  ResumeDocument,
  ResumeRecordItem,
  ResumeSection,
} from '@resume-do/schema';
import {
  basicFieldOrder,
  createDefaultAppearance,
  createDefaultDocument,
  createSampleDocument,
  emptyRecordItem,
  emptyRichItem,
  ensureCanonicalSections,
  intentFieldOrder,
  isBlankDocument,
  stripTags,
  ageFromBirthMonth,
} from '@resume-do/schema';
import { api, ApiError, type ResumeResponse, type ResumeSummary, type User } from './api';
import Preview from './Preview';
import RichEditor from './RichEditor';
import OriginalResumeView from './OriginalResumeView';
import OriginalImportButton from './OriginalImportButton';
import ThemeToggle from './ThemeToggle';
import { loadFont } from './fonts';
import { printResumePreview } from './printPreview';
import { resumeViewKind, confirmResumeDelete } from './originalResume';
import {
  AppearanceDialog,
  ConflictDialog,
  ExportDialog,
  Modal,
  type AppearanceDialogKind,
} from './Dialogs';

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
type DialogState =
  | { kind: 'appearance'; which: AppearanceDialogKind }
  | { kind: 'export' }
  | null;

const MAX_SECTION_TEXT = 20_000;
const FIXED_TABS = [
  { id: 'basic', name: '基本信息' },
  { id: 'intent', name: '求职意向' },
] as const;

function sectionFieldLabels(sectionId: string): { title: string; role: string } {
  if (sectionId === 'education') return { title: '学校名称', role: '专业与学历' };
  if (sectionId === 'project') return { title: '项目名称', role: '参与角色' };
  if (sectionId === 'campus') return { title: '组织或学校', role: '角色' };
  if (sectionId === 'intern') return { title: '公司名称', role: '实习岗位' };
  return { title: '机构或公司名称', role: '职位或角色' };
}

const BASIC_FIELD_LABELS: Record<BasicFieldKey, string> = {
  gender: '性别',
  city: '所在城市',
  experienceYears: '工作年限',
  phone: '联系电话',
  email: '联系邮箱',
  birthMonth: '出生年月',
  age: '年龄',
  nativePlace: '籍贯',
  ethnicity: '民族',
  maritalStatus: '婚姻状况',
  politicalStatus: '政治面貌',
  height: '身高',
  weight: '体重',
};

const INTENT_FIELD_LABELS: Record<IntentFieldKey, string> = {
  role: '意向职位',
  city: '意向城市',
  salary: '期望薪资',
  arrival: '到岗时间',
};

function textLength(html: string): number {
  return stripTags(html).length;
}

function FieldMoves({ label, canUp, canDown, onMove }: {
  label: string;
  canUp: boolean;
  canDown: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const arrow = (direction: -1 | 1) => (
    <button
      type="button"
      className="field-move"
      aria-label={`${label}${direction < 0 ? '上移' : '下移'}`}
      title={direction < 0 ? '上移' : '下移'}
      disabled={direction < 0 ? !canUp : !canDown}
      onMouseDown={event => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMove(direction);
      }}
    >
      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
        <path
          d={direction < 0 ? 'm4 12 6-6 6 6' : 'm4 8 6 6 6-6'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
  return <span className="field-moves">{arrow(-1)}{arrow(1)}</span>;
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  type = 'text',
  placeholder,
  readOnly,
  actions,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  maxLength?: number;
  type?: string;
  placeholder?: string;
  readOnly?: boolean;
  actions?: ReactNode;
}) {
  const control = (
    <label>
      {label}
      <input
        type={type}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
  if (!actions) return control;
  return (
    <div className="field-cell">
      {control}
      {actions}
    </div>
  );
}

export default function EditorPage({ user, resumeId, onBack, onLogout }: {
  user: User;
  resumeId?: string;
  onBack?: () => void;
  onLogout: () => void;
}) {
  const [booted, setBooted] = useState(false);
  const [activeResume, setActiveResume] = useState<ResumeResponse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [actionError, setActionError] = useState('');
  const [resumeList, setResumeList] = useState<ResumeSummary[]>([]);
  const [originalView, setOriginalView] = useState(false);
  const [activeResumeId, setActiveResumeId] = useState('');
  const [bootError, setBootError] = useState('');
  const [title, setTitle] = useState('');
  const [doc, setDoc] = useState<ResumeDocument | null>(null);
  const [appearance, setAppearance] = useState<ResumeAppearance | null>(null);

  const [selected, setSelected] = useState('basic');
  const [itemIndex, setItemIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [preparingPrint, setPreparingPrint] = useState(false);
  const printingRef = useRef(false);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveErrorMessage, setSaveErrorMessage] = useState('');
  const [conflict, setConflict] = useState<{ currentRevision: number; updatedAt: string } | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [appearanceDraft, setAppearanceDraft] = useState<ResumeAppearance | null>(null);
  const [toast, setToast] = useState('');
  const [toastTone, setToastTone] = useState<'default' | 'success'>('default');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [removeTarget, setRemoveTarget] = useState<ResumeSection | null>(null);
  const renameCancelledRef = useRef(false);

  const docRef = useRef<ResumeDocument | null>(null);
  const appearanceRef = useRef<ResumeAppearance | null>(null);
  const titleRef = useRef('');
  const resumeIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const versionRef = useRef(0);
  const savedVersionRef = useRef(0);
  const statusRef = useRef<SaveStatus>('saved');
  const mutationRef = useRef<string | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);
  const dirtySinceRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const bootRef = useRef(false);
  const mountedRef = useRef(true);
  const canvasRef = useRef<HTMLElement | null>(null);

  function setStatusBoth(next: SaveStatus) {
    statusRef.current = next;
    setSaveStatus(next);
  }

  function showToast(message: string, tone: 'default' | 'success' = 'default') {
    setToast(message);
    setToastTone(tone);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2_600);
  }

  useEffect(() => {
    if (!actionError) return;
    showToast(actionError);
    setActionError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionError]);

  const loadedFontId = appearance?.fontId;
  useEffect(() => {
    if (loadedFontId) void loadFont(loadedFontId);
  }, [loadedFontId]);

  function activateResume(resume: ResumeResponse, original = false) {
    const viewOriginal = resume.kind === 'original' || (original && !!resume.source);
    setOriginalView(viewOriginal);
    localStorage.setItem(`resume-do:view:${user.id}`, viewOriginal ? `${resume.id}:original` : resume.id);
    setActiveResume(resume); setActionError('');
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    if (retryRef.current) { window.clearTimeout(retryRef.current); retryRef.current = null; }
    dirtySinceRef.current = null;
    setConflict(null); setConflictOpen(false); setSaveErrorMessage('');
    setSelected('basic'); setItemIndex(0); setAppearanceDraft(null);
    setActiveResumeId(resume.id);
    localStorage.setItem(`resume-do:active:${user.id}`, resume.id);
    if (resumeViewKind(resume) === 'structured') {
      localStorage.setItem(`resume-do:last-editable:${user.id}`, resume.id);
    }
    resumeIdRef.current = resume.id;
    revisionRef.current = resume.revision;
    versionRef.current = 0;
    savedVersionRef.current = 0;
    titleRef.current = resume.title || '我的简历';
    const document = ensureCanonicalSections(resume.document);
    docRef.current = document;
    appearanceRef.current = resume.appearance;
    mutationRef.current = null;

    setTitle(resume.title || '我的简历');
    setDoc(document);
    setAppearance(resume.appearance);
    setLastSavedAt(new Date(resume.updatedAt));
    setStatusBoth('saved');
    setBooted(true);
  }

  async function boot() {
    try {
      const list = await api.listResumes();
      let resume: ResumeResponse;
      setResumeList(list);
      const preferred = resumeId ?? localStorage.getItem(`resume-do:active:${user.id}`);
      const target = list.find(item => item.id === preferred)?.id ?? list[0]?.id;
      if (!target) {
        setActiveResume(null); setBooted(true); return;
      }
      resume = await api.getResume(target);
      if (!mountedRef.current) return;

      activateResume(resume, localStorage.getItem(`resume-do:view:${user.id}`) === `${resume.id}:original`);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) {
        onLogout();
        return;
      }
      setBootError(err instanceof ApiError ? err.message : '加载简历失败，请确认 API 服务已启动。');
    }
  }

  function scheduleSave() {
    if (statusRef.current === 'conflict') return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (retryRef.current) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    dirtySinceRef.current ??= Date.now();
    const elapsed = Date.now() - dirtySinceRef.current;
    const delay = Math.max(0, Math.min(800, 5_000 - elapsed));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void saveNow();
    }, delay);
  }

  function markChanged() {
    versionRef.current += 1;
    if (statusRef.current === 'conflict') return;
    if (statusRef.current !== 'saving') setStatusBoth('dirty');
    scheduleSave();
  }

  async function saveNow(): Promise<boolean> {
    if (!activeResume || resumeViewKind(activeResume) === 'original') return true;
    const resumeId = resumeIdRef.current;
    if (!resumeId) return false;

    for (;;) {
      const inflight = savePromiseRef.current;
      if (inflight) {
        await inflight;
        continue;
      }
      break;
    }

    if (statusRef.current === 'conflict') return false;
    if (versionRef.current === savedVersionRef.current) {
      if (statusRef.current === 'dirty' || statusRef.current === 'error') setStatusBoth('saved');
      return true;
    }

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const startVersion = versionRef.current;
    const payload = {
      baseRevision: revisionRef.current,
      clientMutationId: mutationRef.current ?? crypto.randomUUID(),
      title: titleRef.current,
      document: structuredClone(docRef.current!),
      appearance: structuredClone(appearanceRef.current!),
    };
    mutationRef.current = payload.clientMutationId;
    setStatusBoth('saving');

    const promise = (async (): Promise<boolean> => {
      try {
        const saved = await api.saveResume(resumeId, payload);
        revisionRef.current = saved.revision;
        mutationRef.current = null;
        savedVersionRef.current = startVersion;
        dirtySinceRef.current = null;
        if (!mountedRef.current) return true;
        setLastSavedAt(new Date(saved.updatedAt));
        setSaveErrorMessage('');
        if (versionRef.current === startVersion) {
          setStatusBoth('saved');
          showToast(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 保存成功！`, 'success');
        } else if (statusRef.current !== 'conflict') {
          setStatusBoth('dirty');
        }
        return true;
      } catch (err) {
        mutationRef.current = null;
        if (!mountedRef.current) return false;
        if (err instanceof ApiError && err.status === 409) {
          const details = err.details as { currentRevision?: number; updatedAt?: string };
          setConflict({
            currentRevision: Number(details.currentRevision ?? 0),
            updatedAt: String(details.updatedAt ?? ''),
          });
          setConflictOpen(true);
          setStatusBoth('conflict');
          return false;
        }
        setSaveErrorMessage(err instanceof ApiError ? err.message : '网络异常，稍后自动重试');
        setStatusBoth('error');
        return false;
      } finally {
        savePromiseRef.current = null;
        if (mountedRef.current) {
          if (statusRef.current === 'error' && versionRef.current !== savedVersionRef.current) {
            retryRef.current = window.setTimeout(() => {
              retryRef.current = null;
              void saveNow();
            }, 3_000);
          } else if (statusRef.current === 'dirty') {
            scheduleSave();
          }
        }
      }
    })();

    savePromiseRef.current = promise;
    return promise;
  }

  async function ensureSaved(): Promise<number | null> {
    if (!activeResume || resumeViewKind(activeResume) === 'original') return revisionRef.current;
    if (statusRef.current === 'conflict') return null;
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ok = await saveNow();
      if (!ok) return null;
      if (versionRef.current === savedVersionRef.current) return revisionRef.current;
    }
    return null;
  }

  function updateDocument(mutator: (draft: ResumeDocument) => void) {
    if (!docRef.current) return;
    const next = structuredClone(docRef.current);
    mutator(next);
    docRef.current = next;
    setDoc(next);
    markChanged();
  }

  function previewAppearance(next: ResumeAppearance) {
    setAppearanceDraft(next);
  }

  async function uploadPhoto(file?: File) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      showToast('请选择 PNG、JPEG 或 WebP 图片');
      return;
    }
    if (file.size > 288 * 1024) {
      showToast('照片过大，请压缩到 288KB 以内后重试');
      return;
    }
    try {
      const photo = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.src = photo;
      await image.decode();
      updateDocument(draft => { draft.basic.photo = photo; draft.basic.showPhoto = true; });
      showToast('照片已更新，正在保存');
    } catch {
      showToast('无法读取照片，请选择有效图片');
    }
  }

  function updateTitle(next: string) {
    titleRef.current = next;
    setTitle(next);
    markChanged();
  }

  function selectTab(id: string) {
    setCollapsed(false);
    setSelected(id);
    setItemIndex(0);
  }

  function toggleSection(section: ResumeSection) {
    const nextVisible = !section.visible;
    updateDocument((draft) => {
      const target = draft.sections.find((entry) => entry.id === section.id);
      if (target) target.visible = nextVisible;
    });
    showToast(nextVisible ? `已显示“${section.title}”` : `已隐藏“${section.title}”，内容已保留`);
  }

  function moveModule(sectionId: string, delta: number) {
    const current = docRef.current;
    if (!current) return;
    const from = current.sections.findIndex((entry) => entry.id === sectionId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.sections.length) return;
    updateDocument((draft) => {
      [draft.sections[from], draft.sections[to]] = [draft.sections[to], draft.sections[from]];
    });
  }

  function moveBasicField(key: BasicFieldKey, direction: -1 | 1) {
    updateDocument((draft) => {
      const keys = basicFieldOrder(draft.basic);
      const from = keys.indexOf(key);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= keys.length) return;
      [keys[from], keys[to]] = [keys[to], keys[from]];
      draft.basic.fieldOrder = keys;
    });
  }

  function moveIntentField(key: IntentFieldKey, direction: -1 | 1) {
    updateDocument((draft) => {
      const keys = intentFieldOrder(draft.intent);
      const from = keys.indexOf(key);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= keys.length) return;
      [keys[from], keys[to]] = [keys[to], keys[from]];
      draft.intent.fieldOrder = keys;
    });
  }

  function startRename(entry: ResumeSection) {
    renameCancelledRef.current = false;
    setRenamingId(entry.id);
    setRenameDraft(entry.title);
  }

  function commitRename(entry: ResumeSection) {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      setRenamingId(null);
      return;
    }
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === entry.title) return;
    if (next.length > 20) {
      showToast('模块名称最多 20 个字符');
      return;
    }
    updateDocument((draft) => {
      const target = draft.sections.find((section) => section.id === entry.id);
      if (target) target.title = next;
    });
    showToast('模块名称已更新');
  }

  function addSection() {
    const current = docRef.current;
    if (!current) return;
    if (current.sections.length >= 30) {
      showToast('模块数量已达上限');
      return;
    }
    let suffix = 2;
    while (current.sections.some((entry) => entry.id === `custom-${suffix}`)) suffix += 1;
    const id = `custom-${suffix}`;
    updateDocument((draft) => {
      draft.sections.push({ id, type: 'rich', title: '自定义模块', visible: true, items: [emptyRichItem()] });
    });
    setCollapsed(false);
    setSelected(id);
    setItemIndex(0);
    renameCancelledRef.current = false;
    setRenamingId(id);
    setRenameDraft('自定义模块');
    showToast('已添加自定义模块，可直接修改名称');
  }

  function removeSection(entry: ResumeSection) {
    updateDocument((draft) => {
      draft.sections = draft.sections.filter((section) => section.id !== entry.id);
    });
    if (selected === entry.id) {
      setSelected('basic');
      setItemIndex(0);
    }
    setRemoveTarget(null);
    showToast(`已删除“${entry.title}”`);
  }

  function addItem() {
    if (!section) return;
    const nextIndex = section.items.length;
    updateDocument((draft) => {
      const target = draft.sections.find((entry) => entry.id === section.id);
      if (target) target.items.push(emptyRecordItem());
    });
    setItemIndex(nextIndex);
  }

  function updateItem(item: ResumeRecordItem, patch: Partial<ResumeRecordItem>) {
    if (!section) return;
    if (patch.body !== undefined && textLength(patch.body) > MAX_SECTION_TEXT) {
      showToast('单模块正文最多 20,000 字，请精简后再继续');
      return;
    }
    updateDocument((draft) => {
      const target = draft.sections.find((entry) => entry.id === section.id);
      const record = target?.items.find((entry) => entry.id === item.id);
      if (record) Object.assign(record, patch);
    });
  }

  function updateRichBody(sectionId: string, body: string) {
    if (textLength(body) > MAX_SECTION_TEXT) {
      showToast('单模块正文最多 20,000 字，请精简后再继续');
      return;
    }
    updateDocument((draft) => {
      const target = draft.sections.find((entry) => entry.id === sectionId);
      if (!target) return;
      if (!target.items[0]) target.items.push(emptyRichItem());
      target.items[0].body = body;
    });
  }

  function moveItem(delta: number) {
    if (!section) return;
    const target = section.items[itemIndex + delta];
    if (!target) return;
    const from = itemIndex;
    const to = itemIndex + delta;
    updateDocument((draft) => {
      const current = draft.sections.find((entry) => entry.id === section.id);
      if (!current) return;
      [current.items[from], current.items[to]] = [current.items[to], current.items[from]];
    });
    setItemIndex(to);
  }

  function deleteItem() {
    if (!section) return;
    const item = section.items[itemIndex];
    if (!item) return;
    const label = item.title.trim() || '未命名经历';
    if (!window.confirm(`确定删除“${label}”吗？删除后该条内容将从简历中移除。`)) return;
    updateDocument((draft) => {
      const target = draft.sections.find((entry) => entry.id === section.id);
      if (target) target.items.splice(itemIndex, 1);
    });
    setItemIndex(Math.max(0, itemIndex - 1));
    showToast('已删除该条经历');
  }

  function openAppearance(which: AppearanceDialogKind) {
    if (!appearanceRef.current) return;
    setAppearanceDraft(structuredClone(appearanceRef.current));
    setDialog({ kind: 'appearance', which });
  }

  function cancelAppearance() {
    setAppearanceDraft(null);
    setDialog(null);
  }

  function applyAppearance() {
    const seedSample = dialog?.kind === 'appearance'
      && dialog.which === 'template'
      && docRef.current !== null
      && isBlankDocument(docRef.current);
    const appearanceChanged = appearanceDraft !== null
      && JSON.stringify(appearanceDraft) !== JSON.stringify(appearanceRef.current);
    if (appearanceChanged && appearanceDraft) {
      appearanceRef.current = appearanceDraft;
      setAppearance(appearanceDraft);
    }
    if (seedSample) {
      const seeded = createSampleDocument();
      docRef.current = seeded;
      setDoc(seeded);
    }
    if (appearanceChanged || seedSample) {
      markChanged();
      showToast(seedSample ? '已填入示例内容，可直接修改' : '排版设置已应用，正在保存');
    }
    setAppearanceDraft(null);
    setDialog(null);
  }

  function downloadLocalCopy() {
    if (!docRef.current || !appearanceRef.current) return;
    const payload = {
      title: titleRef.current,
      document: docRef.current,
      appearance: appearanceRef.current,
      savedAt: new Date().toISOString(),
      note: '本地冲突副本，仅包含本窗口尚未保存的内容',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(titleRef.current || '简历').replace(/[\\/:*?"<>|]/g, '_')}-本地副本.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
    showToast('本地副本已下载');
  }

  async function reloadRemote() {
    const resumeId = resumeIdRef.current;
    if (!resumeId) return;
    const remote = await api.getResume(resumeId);

    revisionRef.current = remote.revision;
    versionRef.current += 1;
    savedVersionRef.current = versionRef.current;
    mutationRef.current = null;
    dirtySinceRef.current = null;
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (retryRef.current) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }

    titleRef.current = remote.title || '我的简历';
    const document = ensureCanonicalSections(remote.document);
    docRef.current = document;
    appearanceRef.current = remote.appearance;
    setTitle(remote.title || '我的简历');
    setDoc(document);
    setAppearance(remote.appearance);
    setAppearanceDraft(null);
    setDialog(null);
    setLastSavedAt(new Date(remote.updatedAt));
    setConflict(null);
    setConflictOpen(false);
    setSaveErrorMessage('');
    setStatusBoth('saved');
    showToast('已重新加载远端版本');
  }

  async function goBack() {
    if (!onBack) return;
    const revision = await ensureSaved();
    if (revision == null && !window.confirm('当前修改尚未保存，仍要返回简历库吗？')) return;
    onBack();
  }

  async function logout() {
    if (statusRef.current === 'conflict') {
      if (!window.confirm('当前存在版本冲突，本窗口的修改尚未保存。仍要退出吗？')) return;
    } else if (statusRef.current !== 'saved') {
      await saveNow();
    }
    try {
      await api.logout();
    } finally {
      onLogout();
    }
  }

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (retryRef.current) window.clearTimeout(retryRef.current);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function handler(event: BeforeUnloadEvent) {
      if (statusRef.current !== 'saved') {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    function online() {
      if (statusRef.current === 'error' || statusRef.current === 'dirty') void saveNow();
    }
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function update() {
      const pages = canvas!.querySelectorAll('.pages .r-page');
      if (!pages.length) return;
      const limit = canvas!.getBoundingClientRect().top + 96;
      let visible = 1;
      pages.forEach((page, index) => {
        if (page.getBoundingClientRect().top <= limit) visible = index + 1;
      });
      setCurrentPage(visible);
    }
    update();
    canvas.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => {
      canvas.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [doc, pageCount, zoom]);

  const sectionTabs = doc?.sections ?? [];
  const section = doc?.sections.find((entry) => entry.id === selected) ?? null;
  const record = section && section.type === 'records' ? section.items[itemIndex] : undefined;

  const statusText = (() => {
    switch (saveStatus) {
      case 'saved':
        return lastSavedAt
          ? `已保存 · ${lastSavedAt.toLocaleTimeString('zh-CN', { hour12: false })}`
          : '已保存';
      case 'dirty':
        return '未保存';
      case 'saving':
        return '保存中…';
      case 'error':
        return `保存失败：${saveErrorMessage || '网络异常'} · 内容已保留`;
      case 'conflict':
        return '存在版本冲突，暂不能保存';
    }
  })();

  const defaultFilename = useMemo(
    () => {
      const name = title.replace(/[\u0000-\u001f\u007f-\u009f\\/:*?"<>|]/g, '_').trim().replace(/\.pdf$/i, '').trim();
      return `${name || '简历'}.pdf`;
    },
    [title],
  );

  async function originalCreated(resume: ResumeResponse) {
    // Preserve any edits made while the upload was in flight.
    if (await ensureSaved() == null) {
      setResumeList(await api.listResumes());
      setActionError('新简历已创建，但当前修改尚未保存，请处理保存问题后切换');
      return;
    }
    activateResume(resume);
    setResumeList(await api.listResumes());
  }
  async function switchResume(value: string) {
    const [id, view] = value.split(':');
    try {
      if (await ensureSaved() == null) return;
      if (id === activeResume?.id && activeResume.kind !== 'original') {
        setOriginalView(view === 'original' && !!activeResume.source);
        localStorage.setItem(`resume-do:view:${user.id}`, value);
      } else activateResume(await api.getResume(id), view === 'original');
    } catch (e) { setActionError(e instanceof Error ? e.message : '切换失败'); }
  }
  function resumeOptions() {
    return resumeList.flatMap(entry => {
      const name = entry.id === activeResumeId ? title : entry.title;
      const options = entry.kind === 'original' ? [] : [<option key={entry.id} value={entry.id}>{name} · 可编辑</option>];
      if (entry.source || entry.kind === 'original') options.push(<option key={`${entry.id}:original`} value={`${entry.id}:original`}>{name} · 原件</option>);
      return options;
    });
  }
  async function openEditor() {
    if (activeResume?.kind !== 'original' && activeResume) {
      await switchResume(activeResume.id); return;
    }
    if (openingEditor || deleting) return;
    setOpeningEditor(true); setActionError('');
    try {
      if(activeResume?.kind === 'original') {
        const editable=await api.openLegacyEditor(activeResume.id);
        activateResume(editable);
        setResumeList(await api.listResumes());
      } else {
        await originalCreated(await api.createResume({title:'我的简历',document:createDefaultDocument(),appearance:createDefaultAppearance()}));
      }
    } catch (e) { setActionError(e instanceof Error ? e.message : '打开编辑器失败，请重试'); }
    finally { setOpeningEditor(false); }
  }
  async function deleteCurrent() {
    if (!activeResume || deleting) return;
    setActionError(''); setDeleting(true);
    try {
      await confirmResumeDelete(title, window.confirm.bind(window), async () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        if (retryRef.current) window.clearTimeout(retryRef.current);
        // A save response for the old resume must not overwrite the next resume's state.
        if (savePromiseRef.current) await savePromiseRef.current;
        if (timerRef.current) window.clearTimeout(timerRef.current);
        if (retryRef.current) window.clearTimeout(retryRef.current);
        await api.deleteResume(activeResume.id);
        const list = await api.listResumes(); setResumeList(list);
        localStorage.removeItem(`resume-do:active:${user.id}`);
        if (onBack) { onBack(); return; }
        if (list.length) activateResume(await api.getResume(list[0].id));
        else {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          if (retryRef.current) window.clearTimeout(retryRef.current);
          setActiveResume(null); setDoc(null); setAppearance(null); resumeIdRef.current = null;
          versionRef.current = savedVersionRef.current = 0; setStatusBoth('saved');
        }
      });
    } catch (e) { setActionError(e instanceof Error ? e.message : '删除失败'); }
    finally { setDeleting(false); }
  }

  async function openPrintPreview() {
    if (printingRef.current || !canvasRef.current) return;
    printingRef.current = true;
    setPreparingPrint(true);
    try {
      await printResumePreview(canvasRef.current);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法打开打印预览，请重试。');
    } finally {
      printingRef.current = false;
      if (mountedRef.current) setPreparingPrint(false);
    }
  }

  function openExportDialog() {
    if (!doc) return;
    if (!doc.basic.name.trim() && !window.confirm('姓名为空，导出将使用占位姓名。是否继续？')) return;
    setDialog({ kind: 'export' });
  }

  async function clearCurrent() {
    if (!activeResume || clearing) return;
    setClearing(true);
    try {
      if (await ensureSaved() == null) throw new Error('当前修改尚未保存，请处理保存问题后再清空');
      if (!appearanceRef.current) throw new Error('简历数据缺失，请刷新重试');
      const updated = await api.saveResume(activeResume.id, {
        baseRevision: revisionRef.current,
        clientMutationId: crypto.randomUUID(),
        title: titleRef.current,
        document: createDefaultDocument(),
        appearance: appearanceRef.current,
      });
      activateResume(updated);
      setConfirmClear(false);
      showToast('已清空当前简历内容');
    } catch (e) {
      setConfirmClear(false);
      showToast(e instanceof Error ? e.message : '清空失败，请重试');
    } finally { setClearing(false); }
  }

  if (bootError) {
    return (
      <div className="boot">
        <div className="boot-card">
          <h1>无法加载工作台</h1>
          <div className="error" role="alert">
            {bootError}
          </div>
          <div className="boot-actions">
            <button type="button" onClick={() => window.location.reload()}>
              重试
            </button>
            <button type="button" onClick={onLogout}>
              退出登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!booted) return <div className="boot">正在加载简历…</div>;
  if (!activeResume || originalView || resumeViewKind(activeResume) === 'original') {
    return <div className="app-shell original-shell">
      <header className="topbar">
        {onBack && (
          <button type="button" className="back-button" onClick={() => void goBack()} aria-label="返回简历库" title="返回简历库">
            ‹
          </button>
        )}
        <div className="logo">Resume Do · 简历工作台</div>
        <select aria-label="切换简历" value={originalView ? `${activeResumeId}:original` : activeResumeId} disabled={!resumeList.length || deleting} onChange={e => void switchResume(e.target.value)}>
          {!resumeList.length && <option value="">暂无简历</option>}
          {resumeOptions()}
        </select>
        <OriginalImportButton beforeUpload={async () => !deleting} onCreated={originalCreated} />
        <button type="button" disabled={deleting || openingEditor} onClick={() => void openEditor()}>
          {openingEditor ? '正在打开…' : activeResume ? '返回编辑器' : '新建可编辑简历'}
        </button>
        {activeResume && <>
          <button type="button" className="primary" onClick={() => {
            void api.downloadSource(activeResume.id, activeResume.source?.filename ?? `${title}.pdf`).catch(e => setActionError(e.message));
          }}>下载原件</button>
          <button type="button" disabled={deleting} onClick={() => void deleteCurrent()}>删除简历</button>
        </>}
        <ThemeToggle />
        <button onClick={() => void logout()}>退出</button>
        {actionError && <span role="alert">{actionError}</span>}
      </header>
      {activeResume ? <OriginalResumeView key={activeResume.id} resume={activeResume} /> : <main className="original-empty">
        <h1>还没有简历</h1><p>点击“导入简历”上传 PDF / DOCX，解析后直接进入编辑器，并保留原件。</p>
        <button onClick={() => { void api.createResume({ title: '我的简历', document: createDefaultDocument(), appearance: createDefaultAppearance() }).then(originalCreated).catch(e => setActionError(e.message)); }}>创建可编辑简历</button>
      </main>}
    </div>;
  }
  if (!doc || !appearance) return <div className="boot">简历数据缺失，请刷新重试。</div>;

  const dateInvalid = Boolean(
    record &&
      record.startMonth &&
      record.endMonth &&
      !record.ongoing &&
      record.startMonth > record.endMonth,
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        {onBack && (
          <button type="button" className="back-button" onClick={() => void goBack()} aria-label="返回简历库" title="返回简历库">
            ‹
          </button>
        )}
        <div className="logo">
          <span>简</span>Resume Do · 简历工作台
        </div>
        <div className="head-title">
          <input
            className="title-input"
            value={title}
            maxLength={100}
            aria-label="简历名称"
            placeholder="请设置导出文件名"
            onChange={(event) => updateTitle(event.target.value)}
          />
          <small className={`save-state ${saveStatus}`} role="status" title={saveErrorMessage}>
            {statusText}
          </small>
        </div>
        {conflict && (
          <button type="button" className="conflict-button" onClick={() => setConflictOpen(true)}>
            ⚠ 版本冲突
          </button>
        )}
        <OriginalImportButton beforeUpload={async () => !deleting && await ensureSaved() != null} onCreated={originalCreated} targetId={activeResumeId} />
        {activeResume.source && (
          <button type="button" disabled={deleting} onClick={() => void switchResume(`${activeResumeId}:original`)}>
            查看原件
          </button>
        )}
        <button type="button" className="danger-text" disabled={deleting} onClick={() => void deleteCurrent()}>
          删除
        </button>
        <button type="button" disabled={deleting} onClick={() => setConfirmClear(true)}>清空内容</button>
        <ThemeToggle />
        <span className="user-chip" title={user.email}>
          {user.displayName || user.email}
        </span>
        <button type="button" className="print-preview-button" disabled={preparingPrint || deleting}
          onClick={() => void openPrintPreview()}>
          {preparingPrint ? '正在准备…' : '打印预览'}
        </button>
        <button type="button" className="primary" onClick={openExportDialog}>
          ↓ 下载 PDF
        </button>
        <button type="button" onClick={() => void logout()}>
          退出
        </button>
      </header>

      <nav className="toolbar" aria-label="排版工具">
        <button type="button" onClick={() => openAppearance('spacing')}>
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h10M4 17h16" /></svg>
          </span>
          间距设置
        </button>
        <button type="button" onClick={() => openAppearance('font')}>
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 6h14M12 6v13" /></svg>
          </span>
          字体 / 语言
        </button>
        <button type="button" onClick={() => openAppearance('color')}>
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M9 4 4 7l2 4 2-1v10h8V10l2 1 2-4-5-3-3 2-3-2z" /></svg>
          </span>
          皮肤设置
        </button>
        <button type="button" onClick={() => openAppearance('template')}>
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16M9 9h11" /></svg>
          </span>
          更换模板
        </button>
      </nav>

      <div className="workspace">
        <div className="stage">
          <main className="canvas resume-print-root" ref={canvasRef}>
            <div className="canvas-head">
              <span id="page-info">
                A4 预览 · 共 {pageCount} 页
                {saveStatus === 'error' && ' · 保存未完成'}
              </span>
              <label>
                显示比例{' '}
                <select
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                  aria-label="预览显示比例"
                >
                  <option value={0.6}>60%</option>
                  <option value={0.72}>72%</option>
                  <option value={0.9}>90%</option>
                  <option value={1}>100%</option>
                </select>
              </label>
            </div>
            <Preview
              document={doc}
              appearance={appearanceDraft ?? appearance}
              zoom={zoom}
              onPageCount={(count) => setPageCount(count)}
            />
            <div className="page-badge">
              第{currentPage}页（共{pageCount}页）
            </div>
            <button type="button" className="download-fab" onClick={openExportDialog}>
              ↓ 下载 / 导出简历
            </button>
          </main>
        </div>

        <section className={`editor ${collapsed ? 'collapsed' : ''}`} aria-label="简历编辑区">
          <button
            type="button"
            className="editor-toggle"
            aria-label={collapsed ? '展开编辑区' : '收起编辑区'}
            aria-expanded={!collapsed}
            aria-controls="resume-editing-panel"
            title={collapsed ? '展开编辑区' : '收起编辑区'}
            onClick={() => setCollapsed(value => !value)}
          >
            <svg viewBox="0 0 32 32" width="30" height="30" fill="none" aria-hidden="true">
              <path d="m8 9 8 8 8-8M8 17l8 8 8-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="module-tabs" role="tablist" aria-label="简历模块">
            {FIXED_TABS.map((tab) => (
              <div
                key={tab.id}
                className={`tab fixed ${selected === tab.id ? 'selected' : ''}`}
                role="tab"
                aria-selected={selected === tab.id}
                tabIndex={0}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectTab(tab.id);
                  }
                }}
              >
                <div className="tab-controls"><span className="tab-fixed-mark" /></div>
                <div className="tab-name"><span className="tab-label">{tab.name}</span></div>
              </div>
            ))}
            {sectionTabs.map((entry, index) => (
              <div
                key={entry.id}
                className={`tab ${selected === entry.id ? 'selected' : ''} ${entry.visible ? '' : 'off'}`}
                role="tab"
                aria-selected={selected === entry.id}
                tabIndex={0}
                title={entry.title}
                onClick={() => selectTab(entry.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectTab(entry.id);
                  }
                }}
              >
                <div className="tab-controls">
                  <button
                    type="button"
                    className="module-move"
                    aria-label={`${entry.title}左移`}
                    title="模块左移"
                    disabled={index === 0}
                    onClick={event => { event.stopPropagation(); moveModule(entry.id, -1); }}
                  >
                    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                      <path d="m12 4-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={entry.visible}
                    aria-label={`${entry.visible ? '隐藏' : '显示'}${entry.title}`}
                    className={`module-switch ${entry.visible ? 'on' : ''}`}
                    title={entry.visible ? '隐藏模块（内容保留）' : '显示模块'}
                    onClick={event => { event.stopPropagation(); toggleSection(entry); }}
                  />
                  <button
                    type="button"
                    className="module-move"
                    aria-label={`${entry.title}右移`}
                    title="模块右移"
                    disabled={index === sectionTabs.length - 1}
                    onClick={event => { event.stopPropagation(); moveModule(entry.id, 1); }}
                  >
                    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                      <path d="m8 4 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
                <div className="tab-name">
                  {renamingId === entry.id ? (
                    <input
                      className="tab-rename"
                      value={renameDraft}
                      maxLength={20}
                      autoFocus
                      aria-label={`${entry.title}新名称`}
                      onClick={event => event.stopPropagation()}
                      onChange={event => setRenameDraft(event.target.value)}
                      onBlur={() => commitRename(entry)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          renameCancelledRef.current = true;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <span className="tab-label">{entry.title}</span>
                  )}
                  {renamingId !== entry.id && (
                    <>
                      <button
                        type="button"
                        className="module-rename"
                        aria-label={`重命名${entry.title}`}
                        title="修改模块名称"
                        onClick={event => { event.stopPropagation(); startRename(entry); }}
                      >
                        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
                          <path d="M4 13.5V16h2.5l7.6-7.6-2.5-2.5L4 13.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                          <path d="m12.4 4.6 1.4-1.4a1.2 1.2 0 0 1 1.7 0l1.3 1.3a1.2 1.2 0 0 1 0 1.7l-1.4 1.4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        </svg>
                      </button>
                      {!entry.visible && (
                        <button
                          type="button"
                          className="module-remove"
                          aria-label={`删除${entry.title}`}
                          title="删除模块"
                          onClick={event => { event.stopPropagation(); setRemoveTarget(entry); }}
                        >
                          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
                            <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
                            <path d="M6.5 10h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
            <button type="button" className="tab-add" onClick={addSection} title="添加模块" aria-label="添加模块">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
                <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div id="resume-editing-panel" className="editing" hidden={collapsed}>
            {section?.type === 'records' && (
              <aside className="item-list">
                <strong>{section.title}列表</strong>
                {section.items.length === 0 && <p className="note">暂无内容，点击下方按钮开始填写。</p>}
                {section.items.map((item, index) => (
                  <div
                    key={item.id}
                    className={`row ${index === itemIndex ? 'active' : ''}`}
                    onClick={() => setItemIndex(index)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setItemIndex(index);
                      }
                    }}
                  >
                    {item.title.trim() || '未命名经历'}
                    <small>{item.role.trim() || '请补充信息'}</small>
                  </div>
                ))}
                <button type="button" className="add-item" onClick={addItem}>
                  ＋ 新增{section.title}
                </button>
              </aside>
            )}

            <div className="fields">
              {(selected === 'basic' || selected === 'intent') && (
                <p className="module-hint">
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <circle cx="8" cy="8" r="7" fill="#f0a020" />
                    <path d="M8 7v4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
                    <circle cx="8" cy="4.8" r="0.9" fill="#fff" />
                  </svg>
                  {selected === 'basic'
                    ? '填写的信息会自动排版在简历上，不需要的信息可以选择不填或删除内容。'
                    : '求职意向会显示在简历顶部，全部字段均可留空。'}
                </p>
              )}
              {selected === 'basic' && (
                <div className="field-grid">
                  <div className="photo-field">
                    <span className="photo-label">照片设置</span>
                    <div className="photo-actions">
                      {doc.basic.photo && <img className="photo-preview" src={doc.basic.photo} alt="简历照片" />}
                      <label className="photo-upload">
                        <input id="resume-photo" type="file" accept="image/png,image/jpeg,image/webp"
                          onChange={event => {
                            void uploadPhoto(event.target.files?.[0]);
                            event.target.value = '';
                          }} />
                        {doc.basic.photo ? '更换照片' : '上传照片'}
                      </label>
                      {doc.basic.photo && <button type="button" className="photo-remove" onClick={() => updateDocument(draft => { draft.basic.photo = ''; })}>移除照片</button>}
                      <label className="photo-toggle">
                        <input type="checkbox" checked={doc.basic.showPhoto !== false} onChange={event => updateDocument(draft => { draft.basic.showPhoto = event.target.checked; })} />
                        展示照片
                      </label>
                    </div>
                    <p className="note">PNG、JPEG 或 WebP，288KB 以内。导入的原件没有照片时不会生成头像；其他模板未上传照片时显示姓名首字。关闭“展示照片”后预览与编辑版导出均隐藏，照片数据保留。</p>
                  </div>
                  <Field
                    label="姓名"
                    value={doc.basic.name}
                    maxLength={50}
                    onChange={(value) =>
                      updateDocument((draft) => {
                        draft.basic.name = value;
                      })
                    }
                  />
                  {basicFieldOrder(doc.basic).map((key, index, keys) => {
                    const label = BASIC_FIELD_LABELS[key];
                    const actions = (
                      <FieldMoves
                        label={label}
                        canUp={index > 0}
                        canDown={index < keys.length - 1}
                        onMove={direction => moveBasicField(key, direction)}
                      />
                    );
                    if (key === 'birthMonth') {
                      return (
                        <Field key={key} label={label} type="month" value={doc.basic.birthMonth ?? ''} actions={actions}
                          onChange={value => updateDocument(draft => { draft.basic.birthMonth = value; })} />
                      );
                    }
                    if (key === 'age') {
                      return doc.basic.birthMonth ? (
                        <Field key={key} label="年龄（自动计算）" value={ageFromBirthMonth(doc.basic.birthMonth)}
                          placeholder="由出生年月自动计算" readOnly actions={actions} />
                      ) : (
                        <Field key={key} label={label} value={doc.basic.age ?? ''} maxLength={30}
                          placeholder="选填，留空则简历不展示" actions={actions}
                          onChange={value => updateDocument(draft => { draft.basic.age = value; })} />
                      );
                    }
                    return (
                      <Field
                        key={key}
                        label={label}
                        type={key === 'email' ? 'email' : 'text'}
                        value={doc.basic[key] ?? ''}
                        maxLength={key === 'gender' ? 10 : key === 'email' ? 120 : key === 'experienceYears' ? 30 : 50}
                        placeholder={key === 'experienceYears' ? '例如：5 年经验' : undefined}
                        actions={actions}
                        onChange={value => updateDocument(draft => { draft.basic[key] = value; })}
                      />
                    );
                  })}
                  <div className="wide">
                    {(doc.basic.customFields ?? []).map((pair,index) => <div className="field-grid" key={index}>
                      <Field label="自定义名称" value={pair.label} maxLength={30} onChange={value => updateDocument(draft => { draft.basic.customFields![index].label = value; })} />
                      <Field label="自定义内容" value={pair.value} maxLength={100} onChange={value => updateDocument(draft => { draft.basic.customFields![index].value = value; })} />
                      <button onClick={() => updateDocument(draft => { draft.basic.customFields!.splice(index,1); })}>删除此信息</button>
                    </div>)}
                    <button disabled={(doc.basic.customFields?.length ?? 0) >= 20} onClick={() => updateDocument(draft => { (draft.basic.customFields ??= []).push({label:'',value:''}); })}>添加自定义信息</button>
                  </div>
                  <p className="note wide">
                    邮箱填写后会进行格式校验；电话仅限制为 30 个字符，请自行核对号码。姓名为空时导出前会提醒。年龄可留空，留空后预览与导出不展示；填写出生年月则改为自动计算并锁定。
                  </p>
                </div>
              )}

              {selected === 'intent' && (
                <div className="field-grid">
                  {intentFieldOrder(doc.intent).map((key, index, keys) => (
                    <Field
                      key={key}
                      label={INTENT_FIELD_LABELS[key]}
                      value={doc.intent[key]}
                      maxLength={key === 'role' ? 100 : 50}
                      placeholder={key === 'salary' ? '例如：面议' : key === 'arrival' ? '例如：一个月内到岗' : undefined}
                      actions={(
                        <FieldMoves
                          label={INTENT_FIELD_LABELS[key]}
                          canUp={index > 0}
                          canDown={index < keys.length - 1}
                          onMove={direction => moveIntentField(key, direction)}
                        />
                      )}
                      onChange={value => updateDocument(draft => { draft.intent[key] = value; })}
                    />
                  ))}
                </div>
              )}

              {section && (
                <>
                  {section.type === 'records' && !record && (
                    <p className="note">暂无经历，点击左侧“新增经历”开始填写。</p>
                  )}

                  {section.type === 'records' && record && (
                    <>
                      <div className="field-grid">
                        <Field
                          label={sectionFieldLabels(section.id).title}
                          value={record.title}
                          maxLength={100}
                          onChange={(value) => updateItem(record, { title: value })}
                        />
                        <Field
                          label={sectionFieldLabels(section.id).role}
                          value={record.role}
                          maxLength={100}
                          onChange={(value) => updateItem(record, { role: value })}
                        />
                        <label>
                          时间范围
                          <div className="date-range">
                            <input
                              type="month"
                              aria-label="开始年月"
                              value={record.startMonth}
                              onChange={(event) =>
                                updateItem(record, { startMonth: event.target.value })
                              }
                            />
                            <span>至</span>
                            <input
                              type="month"
                              aria-label="结束年月"
                              value={record.endMonth}
                              disabled={record.ongoing}
                              onChange={(event) =>
                                updateItem(record, { endMonth: event.target.value })
                              }
                            />
                          </div>
                          <span className="checkbox-line">
                            <input
                              type="checkbox"
                              checked={record.ongoing}
                              onChange={(event) =>
                                updateItem(record, { ongoing: event.target.checked })
                              }
                            />
                            至今
                          </span>
                        </label>
                      </div>
                      {dateInvalid && (
                        <p className="field-error" role="alert">
                          开始年月不能晚于结束年月，修正后才能保存。
                        </p>
                      )}

                      <div className="block-label">
                        正文
                        <span>{(textLength(record.body) / MAX_SECTION_TEXT * 100).toFixed(1)}%</span>
                      </div>
                      <RichEditor
                        key={`${activeResume?.id ?? ''}-${section.id}-${record.id}`}
                        value={record.body}
                        onChange={(body) => updateItem(record, { body })}
                        label={`${section.title}正文`}
                        aiSection={section.id}
                        aiTargetRole={doc.intent.role}
                      />

                      <div className="section-actions item-actions">
                        <button
                          type="button"
                          disabled={itemIndex === 0}
                          onClick={() => moveItem(-1)}
                        >
                          ↑ 经历上移
                        </button>
                        <button
                          type="button"
                          disabled={itemIndex >= section.items.length - 1}
                          onClick={() => moveItem(1)}
                        >
                          经历下移 ↓
                        </button>
                        <button type="button" className="danger" onClick={deleteItem}>
                          删除本条
                        </button>
                      </div>
                    </>
                  )}

                  {section.type === 'rich' && (
                    <>
                      <div className="block-label">
                        正文
                        <span>
                          {(textLength(section.items[0]?.body ?? '') / MAX_SECTION_TEXT * 100).toFixed(1)}%
                        </span>
                      </div>
                      <RichEditor
                        key={`${activeResume?.id ?? ''}-${section.id}-rich`}
                        value={section.items[0]?.body ?? ''}
                        onChange={(body) => updateRichBody(section.id, body)}
                        label={`${section.title}正文`}
                        aiSection={section.id}
                        aiTargetRole={doc.intent.role}
                      />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className={`toast ${toast ? 'show' : ''} ${toastTone}`} role="status">
        {toast}
      </div>

      {confirmClear && (
        <Modal title="清空简历内容" onClose={() => { if (!clearing) setConfirmClear(false); }}>
          <div className="import-warning">
            <p className="import-warning-title">清空后，当前简历的全部内容将被移除！</p>
            <p className="note">此操作无法撤销，建议先导出一份 PDF 备份。</p>
          </div>
          <footer>
            <button type="button" disabled={clearing} onClick={() => setConfirmClear(false)}>取消</button>
            <button type="button" className="primary" disabled={clearing} onClick={() => void clearCurrent()}>
              {clearing ? '正在清空…' : '确认清空'}
            </button>
          </footer>
        </Modal>
      )}

      {dialog?.kind === 'appearance' && (
        <AppearanceDialog
          kind={dialog.which}
          document={doc}
          appearance={appearanceDraft ?? appearance}
          onChange={previewAppearance}
          onApply={applyAppearance}
          onCancel={cancelAppearance}
        />
      )}

      {removeTarget && (
        <Modal title="删除模块" onClose={() => setRemoveTarget(null)}>
          <div className="import-warning">
            <p className="import-warning-title">删除“{removeTarget.title}”后，该模块内容将一并移除！</p>
            <p className="note">此操作无法撤销，需要保留内容可先导出 PDF 备份。</p>
          </div>
          <footer>
            <button type="button" onClick={() => setRemoveTarget(null)}>取消</button>
            <button type="button" className="primary" onClick={() => removeSection(removeTarget)}>确认删除</button>
          </footer>
        </Modal>
      )}

      {dialog?.kind === 'export' && resumeIdRef.current && (
        <ExportDialog
          resumeId={resumeIdRef.current}
          defaultFilename={defaultFilename}
          pageCount={pageCount}
          ensureSaved={ensureSaved}
          onClose={() => setDialog(null)}
        />
      )}

      {conflictOpen && conflict && (
        <ConflictDialog
          currentRevision={conflict.currentRevision}
          updatedAt={conflict.updatedAt}
          onReload={reloadRemote}
          onCopyLocal={downloadLocalCopy}
          onClose={() => setConflictOpen(false)}
        />
      )}
    </div>
  );
}
