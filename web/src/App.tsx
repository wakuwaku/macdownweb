import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { Editor } from './editor/Editor';
import { MenuBar, type Menu, type MenuItem } from './components/MenuBar';
import { Preview } from './components/Preview';
import { CustomizeToolbarDialog, Toolbar } from './components/Toolbar';
import { AboutDialog, AlertDialog, EmptyState, ExportHtmlDialog, RevertPrompt, SavePrompt, type SaveChoice } from './components/Dialogs';
import { PreferencesWindow } from './components/PreferencesWindow';
import { matchesShortcut } from './components/shortcuts';
import {
  clipboardCommand,
  deleteSelection,
  findNextCommand,
  findPreviousCommand,
  jumpToSelection,
  openFindAndReplace,
  pasteCommand,
  runFormatCommand,
  transformCommand,
  useSelectionForFind,
  type FormatCommandId,
} from './editor/commands';
import { buildTheme } from './editor/themes';
import { preferences, usePreferences, type MacDownPreferences, type WordCountType } from './prefs';
import { renderDocument, countText, wordCountLabel, type TextCount } from './render';
import {
  INITIAL_SPLIT,
  SPLIT_PRESETS,
  editorVisible as isEditorVisible,
  previewVisible as isPreviewVisible,
  leftRatio,
  previewToggleHidden,
  setLeftRatio,
  togglePane,
  type SplitState,
} from './layout/split';
import { resyncAfterLayoutChange, syncScroll } from './layout/scrollSync';
import { useUserAssetsVersion } from './prefs/userAssets';
import {
  UNTITLED,
  displayName,
  htmlTitle,
  isEdited,
  isMarkdownFileName,
  newlineInsertionPoint,
  presumedFileName,
  suggestedSaveName,
  windowTitle,
  type DocumentInfo,
} from './document/document';
import {
  HTML_PICKER_TYPES,
  MARKDOWN_PICKER_TYPES,
  OPEN_ACCEPT,
  canOpenWithPicker,
  canSaveWithPicker,
  downloadText,
  pickFileToOpen,
  pickSaveHandle,
  readFileText,
  safeFileName,
  withExtension,
  writeToHandle,
  type FsFileHandle,
} from './document/files';
import { clearDraft, detectFreshInstall, draftToInfo, loadDraft, loadSplitRatio, saveDraft, saveSplitRatio } from './document/draft';
import { normalizeLineBreaks } from './editor/lineBreaks';
import { buildExportHtml, exportDefaults } from './document/export';
import { CONTRIBUTE_DOCUMENT, HELP_DOCUMENT, type BundledDocument } from './document/help';

/**
 * Debounce for live preview (F-02). The original coalesces renders with a
 * maximum delay of 0.5 s; M2's acceptance criterion is < 300 ms after typing
 * stops, so the web app waits 150 ms of inactivity.
 */
export const RENDER_DEBOUNCE_MS = 150;

const DIVIDER_PX = 1;
/** Edit-menu items whose shortcuts CodeMirror and the browser handle natively. */
const NATIVE_SHORTCUTS = new Set(['undo', 'redo', 'select-all', 'find', 'cut', 'copy', 'paste']);
/** Keyboard step of the split divider (D-03). */
const DIVIDER_KEY_STEP = 0.02;

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** One open document (spec §2.2). `id` changes whenever the editor gets a new text and undo history. */
interface DocState {
  id: number;
  info: DocumentInfo;
  /** File System Access handle of a saved or opened file (null after a reload or in the download fallback). */
  handle: FsFileHandle | null;
  initialText: string;
}

/** The document behind a help document (F-153: help opens "in another window"). */
interface Stashed {
  doc: DocState;
  text: string;
}

type Prompt =
  | { kind: 'save'; name: string; resolve: (c: SaveChoice) => void }
  | { kind: 'revert'; name: string; resolve: (revert: boolean) => void }
  | { kind: 'alert'; message: string; info?: string; resolve: () => void }
  | { kind: 'export'; fileName: string; defaults: { styles: boolean; highlighting: boolean }; resolve: (o: { styles: boolean; highlighting: boolean } | null) => void };

let nextDocId = 1;
const newDoc = (info: DocumentInfo, text: string, handle: FsFileHandle | null = null): DocState => ({ id: nextDocId++, info, handle, initialText: text });
const helpDoc = (b: BundledDocument) => newDoc({ kind: 'help', name: b.name, savedText: b.text }, b.text);

/** Draft autosave delay (F-29). */
const DRAFT_DELAY_MS = 250;

/**
 * Launch state (F-32 / U-12, F-155): with P-02 checked the last draft or a
 * blank document, otherwise no document (empty state). On the first visit
 * the help document opens in front of it.
 */
function initialDocuments(ensureOpen: boolean): { doc: DocState | null; stash: Stashed | null } {
  const fresh = detectFreshInstall();
  const draft = loadDraft();
  const base = ensureOpen ? (draft ? newDoc(draftToInfo(draft), draft.text) : newDoc(UNTITLED, '')) : null;
  if (fresh) return { doc: helpDoc(HELP_DOCUMENT), stash: base ? { doc: base, text: base.initialText } : null };
  return { doc: base, stash: null };
}

export function App() {
  const prefs = usePreferences();
  const [launch] = useState(() => initialDocuments(!preferences.get().supressesUntitledDocumentOnLaunch));
  const [doc, setDocState] = useState<DocState | null>(launch.doc);
  const stashRef = useRef<Stashed | null>(launch.stash);
  const [text, setText] = useState(launch.doc?.initialText ?? '');
  const [renderedText, setRenderedText] = useState(launch.doc?.initialText ?? '');
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const openInput = useRef<HTMLInputElement>(null);
  // D-19 (F-16): the remembered ratio of the named document restored at launch.
  const [split, setSplit] = useState<SplitState>(() => {
    const name = launch.doc?.info.name;
    const r = name ? loadSplitRatio(name) : null;
    return r === null ? INITIAL_SPLIT : setLeftRatio(INITIAL_SPLIT, r, preferences.get().editorOnRight);
  });
  const [customizing, setCustomizing] = useState(false);
  const [previewBackground, setPreviewBackground] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [count, setCount] = useState<TextCount | null>(null);
  const [dragging, setDragging] = useState(false);

  const viewRef = useRef<EditorView | null>(null);
  const previewDocRef = useRef<Document | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const textRef = useRef(text);
  textRef.current = text;
  const docRef = useRef(doc);
  docRef.current = doc;

  // F-16: window title is the file name or "Untitled", with " — Edited" while edited (F-34).
  const edited = doc ? isEdited(doc.info, text) : false;
  useDocumentTitle(doc ? windowTitle(doc.info, text) : 'MacDown');

  // ---- Rendering (F-02, F-03) -------------------------------------------
  useEffect(() => {
    if (prefs.markdownManualRender) return; // P-01 off: only Render Markdown updates.
    if (text === renderedText) return;
    const t = window.setTimeout(() => setRenderedText(text), RENDER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [text, renderedText, prefs.markdownManualRender]);

  const renderNow = useCallback(() => setRenderedText(textRef.current), []);

  // F-141: any preference change re-renders (the memo depends on prefs).
  const previewTitle = doc ? htmlTitle(doc.info) : '';
  const assetsVersion = useUserAssetsVersion(); // F-138: imported or reloaded styles re-render the preview
  const rendered = useMemo(
    // The renderer gets "\n" line breaks, as Hoedown makes of CR and CRLF (D-13).
    () => renderDocument(normalizeLineBreaks(renderedText), prefs, { title: previewTitle, sourceLines: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assetsVersion invalidates the style lookup
    [renderedText, prefs, previewTitle, assetsVersion],
  );
  // F-17 (P-29): zoom = base font size / 14; 1 when off (U-19).
  const previewZoom = prefs.previewZoomRelativeToBaseFontSize ? prefs.editorBaseFontInfo.size / 14 : 1;
  const scriptPrefs = useMemo(
    () => ({ htmlMathJaxInlineDollar: prefs.htmlMathJaxInlineDollar }),
    [prefs.htmlMathJaxInlineDollar],
  );

  const onRendered = useCallback((doc: Document, lastScrollTop: number) => {
    previewDocRef.current = doc;
    const p = prefsRef.current;
    // F-165: the divider takes the preview body colour while the editor is collapsed.
    if (doc.body) setPreviewBackground(doc.defaultView?.getComputedStyle(doc.body).backgroundColor ?? null);
    const view = viewRef.current;
    if (p.editorSyncScrolling && view) syncScroll(view, doc);
    else doc.defaultView?.scrollTo(0, lastScrollTop);
    if (p.editorShowWordCount) setCount(countText(doc));
  }, []);

  // Word count needs a fresh count when it is switched on.
  useEffect(() => {
    if (prefs.editorShowWordCount && previewDocRef.current) setCount(countText(previewDocRef.current));
  }, [prefs.editorShowWordCount]);

  // F-11: images that load after the render move the blocks below them.
  const onPreviewLayoutChange = useCallback((doc: Document) => {
    const view = viewRef.current;
    if (prefsRef.current.editorSyncScrolling && view) resyncAfterLayoutChange(view, doc);
  }, []);

  const onEditorScroll = useCallback((view: EditorView) => {
    const doc = previewDocRef.current;
    if (prefsRef.current.editorSyncScrolling && doc) syncScroll(view, doc); // F-11
  }, []);

  // ---- Layout (F-01, F-04–F-10) -----------------------------------------
  const editorOnRight = prefs.editorOnRight;
  const editorVisible = isEditorVisible(split);
  const previewVisible = isPreviewVisible(split);
  const left = leftRatio(split, editorOnRight);

  const setRatio = useCallback((r: number) => {
    setSplit((s) => setLeftRatio(s, r, prefsRef.current.editorOnRight));
    // F-16: remembered per named document.
    const name = docRef.current?.info.name;
    if (name && r > 0 && r < 1) saveSplitRatio(name, Math.min(1, Math.max(0, r)));
  }, []);
  const toggleEditor = useCallback(() => setSplit((s) => togglePane(s, true)), []);
  const togglePreview = useCallback(() => setSplit((s) => togglePane(s, false)), []);

  // Editor is not editable while collapsed (`editor.editable = editorVisible`).
  useEffect(() => {
    if (!editorVisible) viewRef.current?.contentDOM.blur();
  }, [editorVisible]);

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    setRatio((e.clientX - rect.left) / (rect.width - DIVIDER_PX));
  };
  const onDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };
  // D-03: the divider is a focusable separator; Left/Right move it by 2 %.
  const onDividerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -DIVIDER_KEY_STEP : e.key === 'ArrowRight' ? DIVIDER_KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setRatio(Math.round((left + step) * 100) / 100);
  };

  // ---- Full screen (F-15) -----------------------------------------------
  useEffect(() => {
    const onChange = () => setFullScreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  // ---- Commands (M4) -------------------------------------------------------
  const toolbarVisible = prefs.toolbarVisible; // F-13
  const withView = (fn: (v: EditorView) => unknown) => () => {
    const v = viewRef.current;
    if (v) {
      fn(v);
      v.focus();
    }
  };
  /** Format menu and toolbar commands (F-40 to F-61) act on the editor selection. */
  const format = useCallback((id: FormatCommandId) => {
    const v = viewRef.current;
    if (!v) return;
    const r = runFormatCommand(v, id);
    if (r instanceof Promise) void r.then(() => v.hasFocus || v.focus());
    else v.focus();
  }, []);
  /**
   * F-39 Copy HTML: the body HTML of the current text (without template, CSS
   * or scripts). It is rendered from the editor text, so a hidden or manual
   * preview (MPDocument.m:1228-1246) still gets the current HTML.
   */
  const copyHtml = useCallback(() => {
    const body = renderDocument(normalizeLineBreaks(textRef.current), prefsRef.current).body;
    void navigator.clipboard?.writeText(body).catch(() => undefined);
  }, []);
  const onToolbarCommand = useCallback(
    (command: string) => (command === 'copy-html' ? copyHtml() : format(command as FormatCommandId)),
    [copyHtml, format],
  );

  // D-01: Edit > Find… must leave the focus in the search field, so the editor
  // is focused first and the panel takes the focus afterwards.
  const openFind = () => {
    const v = viewRef.current;
    if (!v) return;
    v.focus();
    openSearchPanel(v);
    const field = v.dom.querySelector<HTMLInputElement>('.cm-search input[main-field]');
    if (field && document.activeElement !== field) {
      field.focus();
      field.select();
    }
  };
  const openFindReplace = () => {
    const v = viewRef.current;
    if (v) openFindAndReplace(v);
  };


  // ---- Documents (spec §2.2, §2.3, §2.8) ----------------------------------
  /** Shows a sheet and resolves with the user's answer. */
  const ask = useCallback(<T,>(make: (resolve: (v: T) => void) => Prompt) => new Promise<T>((resolve) => {
    setPrompt(make((v: T) => {
      setPrompt(null);
      resolve(v);
    }));
  }), []);
  const alertUser = useCallback((message: string, info?: string) => ask<void>((resolve) => ({ kind: 'alert', message, info, resolve })), [ask]);

  /**
   * O-03: the save panel. NSSavePanel always appears, whatever name is
   * suggested; `showSaveFilePicker` may instead reject a suggested name (a
   * front-matter title is used as is, F-31). Then the panel is asked again
   * with a name safe for file systems, and if that fails too the user gets
   * an error sheet instead of nothing. Resolves null when cancelled or failed.
   */
  const chooseSaveHandle = useCallback(async (suggested: string, types: typeof MARKDOWN_PICKER_TYPES, failure: string): Promise<FsFileHandle | null> => {
    try {
      return await pickSaveHandle(suggested, types);
    } catch {
      /* the browser refused the suggested name: retry below */
    }
    try {
      return await pickSaveHandle(safeFileName(suggested), types);
    } catch {
      await alertUser(failure, 'The save panel could not be shown.');
      return null;
    }
  }, [alertUser]);

  /**
   * D-20: after a document command the new document's editor gets the
   * keyboard focus once it is mounted (AppKit makes a new document's text
   * view the first responder). See `focusAfterSwitch`.
   */
  const focusPendingRef = useRef(false);

  /** Makes `next` the open document (new editor and undo history). */
  const switchTo = useCallback((next: DocState | null) => {
    focusPendingRef.current = true;
    docRef.current = next;
    const t = next?.initialText ?? '';
    textRef.current = t;
    // D-20: rendered at once (these commands finish after an await, outside
    // the click), so the new editor exists and has the focus before the next
    // key event arrives.
    flushSync(() => {
      setDocState(next);
      setText(t);
      setRenderedText(t);
      // F-16: split ratio remembered per named document.
      const name = next?.info.name;
      const r = name ? loadSplitRatio(name) : null;
      if (r !== null) setSplit((sp) => setLeftRatio(sp, r, prefsRef.current.editorOnRight));
    });
  }, []);

  // F-29: autosave the draft (never a help copy, F-153).
  useEffect(() => {
    if (!doc || doc.info.kind === 'help') return;
    const t = window.setTimeout(() => saveDraft(doc.info, text), DRAFT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [doc, text]);
  useEffect(() => {
    const flush = () => {
      const d = docRef.current;
      if (d && d.info.kind !== 'help') saveDraft(d.info, textRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  /** F-30 (P-41): "\n" appended in the editor before writing, selection kept. */
  const ensureNewline = useCallback((): string => {
    const t = textRef.current;
    if (!prefsRef.current.editorEnsuresNewlineAtEndOfFile) return t;
    const at = newlineInsertionPoint(t);
    if (at === null) return t;
    const v = viewRef.current;
    // `at` is the end of the file text, which is the end of the editor document (D-13).
    if (v) v.dispatch({ changes: { from: v.state.doc.length, insert: '\n' }, selection: v.state.selection, userEvent: 'input' });
    const next = t + '\n';
    textRef.current = next;
    setText(next);
    return next;
  }, []);

  /**
   * F-26 Save / F-27 Save As. A saved file with a handle is written in
   * place; otherwise the save panel (showSaveFilePicker) or, without the
   * File System Access API, a download with the suggested name.
   */
  const saveDocument = useCallback(async (saveAs: boolean): Promise<boolean> => {
    const cur = docRef.current;
    if (!cur) return false;
    let handle = saveAs ? null : cur.handle;
    let name = cur.info.name;
    if (!handle) {
      const suggested =
        cur.info.kind === 'file' && cur.info.name ? cur.info.name : suggestedSaveName(cur.info, textRef.current, prefsRef.current.htmlDetectFrontMatter);
      if (canSaveWithPicker()) {
        handle = await chooseSaveHandle(suggested, MARKDOWN_PICKER_TYPES, `The document “${displayName(cur.info)}” could not be saved.`);
        if (!handle) return false;
        name = handle.name || suggested;
      } else {
        name = withExtension(suggested, 'md', ['markdown']);
      }
    }
    const t = ensureNewline();
    try {
      if (handle) await writeToHandle(handle, t);
      else downloadText(name!, t);
    } catch {
      await alertUser(`The document “${displayName(cur.info)}” could not be saved.`);
      return false;
    }
    const latest = docRef.current;
    if (!latest || latest.id !== cur.id) return true;
    // Same id: the editor keeps its text, selection and undo history.
    const saved: DocState = { ...latest, info: { kind: 'file', name: name!, savedText: t }, handle };
    docRef.current = saved;
    setDocState(saved);
    return true;
  }, [alertUser, chooseSaveHandle, ensureNewline]);

  /** Closes the current document after the save prompt (F-25, F-34). False = cancelled. */
  const confirmClose = useCallback(async (): Promise<boolean> => {
    const cur = docRef.current;
    if (!cur || !isEdited(cur.info, textRef.current)) return true;
    const c = await ask<SaveChoice>((resolve) => ({ kind: 'save', name: displayName(cur.info), resolve }));
    if (c === 'cancel') return false;
    if (c === 'save') return saveDocument(false);
    return true;
  }, [ask, saveDocument]);

  /** Closes the current document and, behind a help document, the user's document too. */
  const confirmCloseAll = useCallback(async (): Promise<boolean> => {
    if (!(await confirmClose())) return false;
    const st = stashRef.current;
    if (st) {
      stashRef.current = null;
      switchTo({ ...st.doc, id: nextDocId++, initialText: st.text });
      if (!(await confirmClose())) return false;
    }
    return true;
  }, [confirmClose, switchTo]);

  /** Replaces everything with `next` (New, Open, drop), after the prompts. */
  const replaceWith = useCallback(async (next: DocState): Promise<boolean> => {
    if (!(await confirmCloseAll())) return false;
    stashRef.current = null;
    switchTo(next);
    return true;
  }, [confirmCloseAll, switchTo]);

  /** F-21 New. */
  const newDocument = useCallback(() => void replaceWith(newDoc(UNTITLED, '')), [replaceWith]);

  const openFileObject = useCallback(async (file: File, handle: FsFileHandle | null = null) => {
    const t = await readFileText(file);
    if (t === null) {
      await alertUser(`The document “${file.name}” could not be opened.`, 'MacDown reads documents as UTF-8 text.');
      return;
    }
    await replaceWith(newDoc({ kind: 'file', name: file.name, savedText: t }, t, handle));
  }, [alertUser, replaceWith]);

  /** F-22 Open: the open panel first, then the save prompt for the current document. */
  const openDocument = useCallback(async () => {
    if (!canOpenWithPicker()) {
      openInput.current?.click();
      return;
    }
    let picked;
    try {
      picked = await pickFileToOpen();
    } catch {
      picked = null;
    }
    if (!picked) return;
    if (picked.text === null) {
      await alertUser(`The document “${picked.name}” could not be opened.`, 'MacDown reads documents as UTF-8 text.');
      return;
    }
    await replaceWith(newDoc({ kind: 'file', name: picked.name, savedText: picked.text }, picked.text, picked.handle));
  }, [alertUser, replaceWith]);

  /** F-25 Close: after a help document the user's document comes back; otherwise P-02 decides (U-12). */
  const closeDocument = useCallback(async () => {
    const closing = docRef.current;
    if (!closing) return;
    if (!(await confirmClose())) return;
    const st = stashRef.current;
    stashRef.current = null;
    if (st) switchTo({ ...st.doc, id: nextDocId++, initialText: st.text });
    else if (prefsRef.current.supressesUntitledDocumentOnLaunch) {
      // D-14: with P-02 off no document is left, so the closed document's
      // draft goes too (a help copy is never the draft and leaves it alone).
      if (closing?.info.kind !== 'help') clearDraft();
      switchTo(null);
    } else switchTo(newDoc(UNTITLED, ''));
  }, [confirmClose, switchTo]);

  /** F-28 Revert to Saved (enabled for an edited saved document). */
  const canRevert = !!doc && doc.info.savedText !== null && edited;
  const revertDocument = useCallback(async () => {
    const cur = docRef.current;
    if (!cur || cur.info.savedText === null || !isEdited(cur.info, textRef.current)) return;
    const ok = await ask<boolean>((resolve) => ({ kind: 'revert', name: displayName(cur.info), resolve }));
    if (!ok) return;
    let t = cur.info.savedText;
    if (cur.handle) {
      try {
        t = (await readFileText(await cur.handle.getFile())) ?? t;
      } catch {
        /* keep the saved text */
      }
    }
    switchTo({ ...cur, id: nextDocId++, info: { ...cur.info, savedText: t }, initialText: t });
  }, [ask, switchTo]);

  /** F-153 / F-154: the help document opens in front of the user's document, which is kept. */
  const showBundled = useCallback(async (b: BundledDocument) => {
    const cur = docRef.current;
    if (cur?.info.kind === 'help') {
      if (!(await confirmClose())) return;
    } else {
      if (cur) saveDraft(cur.info, textRef.current);
      stashRef.current = cur ? { doc: cur, text: textRef.current } : null;
    }
    switchTo(helpDoc(b));
  }, [confirmClose, switchTo]);

  /** F-35 Export HTML: accessory options, then the save panel. */
  const exportHtml = useCallback(async () => {
    const cur = docRef.current;
    if (!cur) return;
    const p = prefsRef.current;
    const fileName = withExtension(presumedFileName(cur.info, textRef.current, p.htmlDetectFrontMatter), 'html');
    const o = await ask<{ styles: boolean; highlighting: boolean } | null>((resolve) => ({ kind: 'export', fileName, defaults: exportDefaults(p), resolve }));
    if (!o) return;
    let handle: FsFileHandle | null = null;
    if (canSaveWithPicker()) {
      handle = await chooseSaveHandle(fileName, HTML_PICKER_TYPES, `The file “${fileName}” could not be exported.`);
      if (!handle) return;
    }
    try {
      const html = await buildExportHtml(normalizeLineBreaks(textRef.current), prefsRef.current, { ...o, title: htmlTitle(cur.info) });
      if (handle) await writeToHandle(handle, html);
      else downloadText(fileName, html, 'text/html;charset=utf-8');
    } catch {
      await alertUser(`The file “${fileName}” could not be exported.`);
    }
  }, [ask, alertUser, chooseSaveHandle]);

  /**
   * F-37 Print / F-36 Export PDF: the browser print dialog for the preview
   * document only (print margins in Preview.tsx). For PDF the page title is
   * the presumed file name, which the browser offers as the PDF name.
   */
  const printPreview = useCallback((asPdf: boolean) => {
    const pdoc = previewDocRef.current;
    const win = pdoc?.defaultView;
    const cur = docRef.current;
    if (!pdoc || !win || !cur) return;
    const oldTitle = pdoc.title;
    const hadTitle = !!pdoc.querySelector('title');
    if (asPdf) pdoc.title = presumedFileName(cur.info, textRef.current, prefsRef.current.htmlDetectFrontMatter);
    try {
      win.focus();
      win.print();
    } finally {
      if (asPdf) {
        if (hadTitle) pdoc.title = oldTitle;
        else pdoc.querySelector('title')?.remove();
      }
    }
  }, []);

  // Drag and drop: a Markdown file opens as the document; a JPEG dropped on
  // the editor is inserted as a data URI at the selection start (F-33).
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation(); // before CodeMirror, which would insert the file's text
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const v = viewRef.current;
      const inEditor = !!v && v.dom.contains(e.target as Node);
      if (inEditor && file.type === 'image/jpeg') {
        void file.arrayBuffer().then((buf) => {
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const at = v.state.selection.main.from;
          v.dispatch({ changes: { from: at, insert: `![](data:image/jpeg;base64,${btoa(bin)})` }, userEvent: 'input.drop' });
        });
        return;
      }
      if (isMarkdownFileName(file.name) || file.type === 'text/markdown' || file.type === 'text/plain') void openFileObject(file);
    };
    window.addEventListener('dragover', over, true);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('drop', drop, true);
    };
  }, [openFileObject]);

  // Testing aid: the document state.
  useEffect(() => {
    (window as unknown as { macdownDocument: unknown }).macdownDocument = {
      info: () => (docRef.current ? { ...docRef.current.info, hasHandle: !!docRef.current.handle } : null),
      edited: () => (docRef.current ? isEdited(docRef.current.info, textRef.current) : false),
      stashed: () => (stashRef.current ? { ...stashRef.current.doc.info } : null),
    };
  }, []);

  const hasDoc = !!doc;

  /** Format menu item for a command id (the id doubles as the testid suffix). */
  const fmt = (id: FormatCommandId, label: string, shortcut: MenuItem['shortcut'], extra: Partial<MenuItem> = {}): MenuItem => ({
    id,
    label,
    shortcut,
    action: () => format(id),
    ...extra,
  });

  // ---- Menus (§3). Items without an action are greyed out (later milestones). ----
  const docAction = (fn: () => unknown) => (hasDoc ? () => void fn() : undefined);
  const menus: Menu[] = [
    {
      // MacDown (application) menu: the in-scope items only (F-142, F-140).
      id: 'app',
      label: 'MacDown',
      items: [
        { id: 'about', label: 'About MacDown', action: () => setShowAbout(true) },
        { id: 'preferences', label: 'Preferences…', shortcut: { key: ',', code: 'Comma', cmd: true }, action: () => setShowPrefs(true), separatorBefore: true },
      ],
    },
    {
      id: 'file',
      label: 'File',
      items: [
        // Cmd+N and Cmd+W are reserved by browsers: menu only (spec §3 web note).
        { id: 'new', label: 'New', shortcut: { key: 'n', cmd: true }, menuOnly: true, action: newDocument },
        { id: 'open', label: 'Open…', shortcut: { key: 'o', cmd: true }, action: () => void openDocument() },
        { id: 'close', label: 'Close', shortcut: { key: 'w', cmd: true }, menuOnly: true, action: docAction(closeDocument), separatorBefore: true },
        { id: 'save', label: 'Save…', shortcut: { key: 's', cmd: true }, action: docAction(() => saveDocument(false)) },
        { id: 'save-as', label: 'Save As…', shortcut: { key: 's', cmd: true, shift: true }, action: docAction(() => saveDocument(true)) },
        { id: 'revert', label: 'Revert to Saved', action: canRevert ? () => void revertDocument() : undefined },
        { id: 'export-html', label: 'Export HTML…', shortcut: { key: 'e', code: 'KeyE', cmd: true, alt: true }, action: docAction(exportHtml), separatorBefore: true },
        { id: 'export-pdf', label: 'Export PDF…', shortcut: { key: 'p', code: 'KeyP', cmd: true, alt: true }, action: docAction(() => printPreview(true)) },
        { id: 'print', label: 'Print…', shortcut: { key: 'p', cmd: true }, action: docAction(() => printPreview(false)), separatorBefore: true },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: 'undo', label: 'Undo', shortcut: { key: 'z', cmd: true }, action: withView(undo) },
        { id: 'redo', label: 'Redo', shortcut: { key: 'z', cmd: true, shift: true }, action: withView(redo) },
        { id: 'cut', label: 'Cut', shortcut: { key: 'x', cmd: true }, action: withView((v) => clipboardCommand(v, 'cut')), separatorBefore: true },
        { id: 'copy', label: 'Copy', shortcut: { key: 'c', cmd: true }, action: withView((v) => clipboardCommand(v, 'copy')) },
        { id: 'paste', label: 'Paste', shortcut: { key: 'v', cmd: true }, action: withView((v) => void pasteCommand(v)) },
        { id: 'delete', label: 'Delete', action: withView(deleteSelection) },
        { id: 'select-all', label: 'Select All', shortcut: { key: 'a', cmd: true }, action: withView(selectAll) },
        // Find ▸ (flattened)
        { id: 'find', label: 'Find…', shortcut: { key: 'f', cmd: true }, action: openFind, separatorBefore: true },
        { id: 'find-replace', label: 'Find and Replace…', shortcut: { key: 'f', code: 'KeyF', cmd: true, alt: true }, action: openFindReplace },
        { id: 'find-next', label: 'Find Next', shortcut: { key: 'g', cmd: true }, action: withView(findNextCommand) },
        { id: 'find-previous', label: 'Find Previous', shortcut: { key: 'g', cmd: true, shift: true }, action: withView(findPreviousCommand) },
        { id: 'use-selection-for-find', label: 'Use Selection for Find', shortcut: { key: 'e', cmd: true }, action: withView(useSelectionForFind) },
        { id: 'jump-to-selection', label: 'Jump to Selection', shortcut: { key: 'j', cmd: true }, action: withView(jumpToSelection) },
        // Spelling and Grammar ▸ (only the in-scope toggle, F-96 / P-46)
        {
          id: 'check-spelling',
          label: 'Check Spelling While Typing',
          checked: prefs.editorContinuousSpellCheckingEnabled,
          action: () => preferences.set({ editorContinuousSpellCheckingEnabled: !prefsRef.current.editorContinuousSpellCheckingEnabled }),
          separatorBefore: true,
        },
        // Transformations ▸ (F-105 to F-107)
        { id: 'make-upper-case', label: 'Make Upper Case', action: withView((v) => transformCommand(v, 'upper')), separatorBefore: true },
        { id: 'make-lower-case', label: 'Make Lower Case', action: withView((v) => transformCommand(v, 'lower')) },
        { id: 'capitalize', label: 'Capitalize', action: withView((v) => transformCommand(v, 'capitalize')) },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'render', label: 'Render Markdown', shortcut: { key: 'r', cmd: true }, action: renderNow },
        { id: 'split-1-3', label: 'Left 1:3 Right', action: () => setRatio(SPLIT_PRESETS.oneQuarter), separatorBefore: true },
        { id: 'split-1-1', label: 'Left 1:1 Right', shortcut: { key: '0', code: 'Digit0', cmd: true, shift: true }, action: () => setRatio(SPLIT_PRESETS.equal) },
        { id: 'split-3-1', label: 'Left 3:1 Right', action: () => setRatio(SPLIT_PRESETS.threeQuarters) },
        {
          id: 'toggle-preview',
          label: previewVisible ? 'Hide Preview Pane' : 'Restore Preview Pane',
          shortcut: { key: 'h', cmd: true, shift: true },
          action: togglePreview,
          hidden: previewToggleHidden(split),
          separatorBefore: true,
        },
        {
          id: 'toggle-editor',
          label: editorVisible ? 'Hide Editor Pane' : 'Restore Editor Pane',
          shortcut: { key: 'e', cmd: true, shift: true },
          action: toggleEditor,
        },
        {
          id: 'toggle-toolbar',
          label: toolbarVisible ? 'Hide Toolbar' : 'Show Toolbar',
          shortcut: { key: 't', code: 'KeyT', cmd: true, alt: true },
          action: () => preferences.set({ toolbarVisible: !prefsRef.current.toolbarVisible }),
          separatorBefore: true,
        },
        // F-14 (AppKit adds "Customize Toolbar…" under the toolbar item).
        { id: 'customize-toolbar', label: 'Customize Toolbar…', action: () => setCustomizing(true), hidden: !toolbarVisible },
        {
          id: 'full-screen',
          label: fullScreen ? 'Exit Full Screen' : 'Enter Full Screen',
          shortcut: { key: 'f', code: 'KeyF', cmd: true, ctrl: true },
          action: toggleFullScreen,
        },
      ],
    },
    {
      id: 'format',
      label: 'Format',
      items: [
        { id: 'copy-html', label: 'Copy HTML', shortcut: { key: 'c', code: 'KeyC', cmd: true, alt: true }, action: copyHtml },
        fmt('strong', 'Strong', { key: 'b', cmd: true }, { separatorBefore: true }),
        fmt('emphasize', 'Emphasize', { key: 'i', cmd: true }),
        // F-162: hidden (and so without a working shortcut) unless the extension is on.
        fmt('underline', 'Underline', { key: 'u', cmd: true }, { hidden: !prefs.extensionUnderline }),
        fmt('strikethrough', 'Strikethrough', { key: '-', code: 'Minus', cmd: true }, { hidden: !prefs.extensionStrikethough }),
        fmt('highlight', 'Highlight', { key: '=', code: 'Equal', cmd: true }, { hidden: !prefs.extensionHighlight }),
        fmt('inline-code', 'Inline Code', { key: 'k', cmd: true }),
        fmt('comment', 'Comment', { key: '/', code: 'Slash', cmd: true }),
        // Convert To ▸ (flattened)
        fmt('header-1', 'Header 1', { key: '1', code: 'Digit1', cmd: true }, { separatorBefore: true }),
        fmt('header-2', 'Header 2', { key: '2', code: 'Digit2', cmd: true }),
        fmt('header-3', 'Header 3', { key: '3', code: 'Digit3', cmd: true }),
        fmt('header-4', 'Header 4', { key: '4', code: 'Digit4', cmd: true }),
        fmt('header-5', 'Header 5', { key: '5', code: 'Digit5', cmd: true }),
        fmt('header-6', 'Header 6', { key: '6', code: 'Digit6', cmd: true }),
        fmt('paragraph', 'Paragraph', { key: '0', code: 'Digit0', cmd: true }),
        fmt('ordered-list', 'Ordered List', { key: 'o', cmd: true, shift: true }, { separatorBefore: true }),
        fmt('unordered-list', 'Unordered List', { key: 'u', cmd: true, shift: true }),
        fmt('blockquote', 'Blockquote', { key: 'b', cmd: true, shift: true }),
        fmt('shift-right', 'Shift Right', { key: ']', code: 'BracketRight', cmd: true }, { separatorBefore: true }),
        fmt('shift-left', 'Shift Left', { key: '[', code: 'BracketLeft', cmd: true }),
        fmt('link', 'Link', { key: 'k', cmd: true, shift: true }, { separatorBefore: true }),
        fmt('image', 'Image', { key: 'i', cmd: true, shift: true }),
        fmt('new-paragraph', 'New Paragraph', { key: 'Enter', cmd: true }, { separatorBefore: true }),
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        { id: 'help', label: 'MacDown Help', action: () => void showBundled(HELP_DOCUMENT) },
        { id: 'contributing', label: 'Contributing to MacDown', action: () => void showBundled(CONTRIBUTE_DOCUMENT) },
      ],
    },
  ];
  const menusRef = useRef(menus);
  menusRef.current = menus;

  // ---- Keyboard shortcuts for menu items that have an action -------------
  const blockingRef = useRef(false);
  blockingRef.current = !!prompt || showAbout;
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    // A document sheet is up: key equivalents do not reach the menus.
    if (blockingRef.current) return;
    const items: MenuItem[] = menusRef.current.flatMap((m) => m.items);
    for (const it of items) {
      if (!it.action || it.hidden || !it.shortcut || it.menuOnly) continue;
      // Edit-menu commands are handled natively by CodeMirror when it has focus.
      // (Cut, Copy and Paste stay native so the browser's clipboard events run.)
      if (NATIVE_SHORTCUTS.has(it.id)) continue;
      if (matchesShortcut(e, it.shortcut)) {
        e.preventDefault();
        e.stopPropagation();
        it.action();
        return;
      }
    }
  }, []);
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onKeyDown]);

  // ---- Focus after document commands (D-20) -------------------------------
  const editorVisibleRef = useRef(editorVisible);
  editorVisibleRef.current = editorVisible;
  /**
   * The editor of the new document is mounted: give it the focus. With the
   * editor pane collapsed (not editable) the preview gets it instead, so the
   * keyboard scrolls the visible pane and the app shortcuts keep working.
   */
  const onEditorReady = useCallback((v: EditorView | null) => {
    viewRef.current = v;
    if (v && focusPendingRef.current) focusNewDocument();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusNewDocument only reads refs
  }, []);
  /**
   * Focuses the new document's editor at once (so typing right after the
   * command works). The request stays open until the next frame because
   * React's StrictMode mounts a new editor twice in development: the second
   * editor view must get the focus too.
   */
  const focusNewDocument = () => {
    const v = viewRef.current;
    if (!docRef.current) {
      // No document (P-02 off): the empty state's New button gets the focus.
      document.querySelector<HTMLElement>('[data-testid="empty-state-new"]')?.focus();
    } else if (v && editorVisibleRef.current) v.focus();
    else splitRef.current?.querySelector<HTMLIFrameElement>('[data-testid="preview-iframe"]')?.contentWindow?.focus();
    requestAnimationFrame(() => (focusPendingRef.current = false));
  };
  useEffect(() => {
    if (!doc && focusPendingRef.current) focusNewDocument();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusNewDocument only reads refs
  }, [doc]);

  // ---- Panes --------------------------------------------------------------
  const editorPane = (
    <div
      className="pane editor-pane"
      key="editor"
      style={{ flexBasis: `calc((100% - ${DIVIDER_PX}px) * ${split.editorFraction})`, order: editorOnRight ? 2 : 0 }}
      data-testid="editor-pane"
      aria-hidden={!editorVisible}
    >
      <Editor
        key={doc?.id ?? 0}
        initialText={doc?.initialText ?? ''}
        prefs={prefs}
        editable={editorVisible}
        // O-01: textRef is current at once, so a Save or Export in the same
        // task as a change (before React re-renders) uses the new text.
        onChange={(t) => {
          textRef.current = t;
          setText(t);
        }}
        onScroll={onEditorScroll}
        onReady={onEditorReady}
        // F-74: a theme that fails to parse resets editorStyleName (MPDocument.m:1559-1569).
        // Only a named theme can fail, so the reset never repeats itself.
        onThemeError={() => prefsRef.current.editorStyleName && preferences.set({ editorStyleName: '' })}
      />
      {prefs.editorShowWordCount && (
        <WordCount
          count={count}
          type={prefs.editorWordCountType}
          onChange={(t) => preferences.set({ editorWordCountType: t })}
        />
      )}
    </div>
  );
  const previewPane = (
    <div
      className="pane preview-pane"
      key="preview"
      style={{ flexBasis: `calc((100% - ${DIVIDER_PX}px) * ${1 - split.editorFraction})`, order: editorOnRight ? 0 : 2 }}
      data-testid="preview-pane"
      aria-hidden={!previewVisible}
    >
      <Preview
        html={rendered.html}
        scripts={rendered.scripts}
        scriptPrefs={scriptPrefs}
        onRendered={onRendered}
        onLayoutChange={onPreviewLayoutChange}
        onKeyDown={onKeyDown}
        zoom={previewZoom}
      />
    </div>
  );
  // F-165: the divider takes the colour of the visible pane when one is collapsed.
  const editorBackground = useMemo(
    () => buildTheme(prefs.editorStyleName, { baseFontSize: prefs.editorBaseFontInfo.size, lineSpacing: prefs.editorLineSpacing }).background,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assetsVersion invalidates the theme lookup
    [prefs.editorStyleName, prefs.editorBaseFontInfo.size, prefs.editorLineSpacing, assetsVersion],
  );
  const dividerColor = !editorVisible && previewVisible ? previewBackground : !previewVisible && editorVisible ? editorBackground : null;
  const divider = (
    <div
      key="divider"
      style={{ order: 1, ...(dividerColor ? { background: dividerColor } : {}) }}
      className={`split-divider${!editorVisible || !previewVisible ? ' collapsed' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(left * 100)}
      aria-label="Resize editor and preview"
      tabIndex={0}
      onKeyDown={onDividerKeyDown}
      data-testid="split-divider"
      onPointerDown={onDividerPointerDown}
      onPointerMove={onDividerPointerMove}
      onPointerUp={onDividerPointerUp}
      onPointerCancel={onDividerPointerUp}
    />
  );

  return (
    <div className="app">
      <MenuBar menus={menus} />
      {toolbarVisible && (
        <Toolbar
          items={prefs.toolbarItemIdentifiers}
          onCommand={onToolbarCommand}
          onCustomize={() => setCustomizing(true)}
          editorVisible={editorVisible}
          previewVisible={previewVisible}
          previewToggleHidden={previewToggleHidden(split)}
          onToggleEditor={toggleEditor}
          onTogglePreview={togglePreview}
        />
      )}
      {!hasDoc && <EmptyState onNew={newDocument} onOpen={() => void openDocument()} />}
      <div
        hidden={!hasDoc}
        className={`split${dragging ? ' dragging' : ''}`}
        ref={splitRef}
        data-testid="split"
        data-left-ratio={left.toFixed(4)}
        data-editor-visible={editorVisible}
        data-preview-visible={previewVisible}
      >
        {/* F-10: panes are swapped with CSS `order`, never re-parented, so the
            iframe is not reloaded and the editor keeps its state. */}
        {editorPane}
        {divider}
        {previewPane}
      </div>
      {customizing && (
        <CustomizeToolbarDialog
          items={prefs.toolbarItemIdentifiers}
          onChange={(items) => preferences.set({ toolbarItemIdentifiers: items })}
          onClose={() => {
            setCustomizing(false);
            viewRef.current?.focus();
          }}
        />
      )}
      {showPrefs && <PreferencesWindow onClose={() => setShowPrefs(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {prompt?.kind === 'save' && <SavePrompt name={prompt.name} onChoice={prompt.resolve} />}
      {prompt?.kind === 'revert' && <RevertPrompt name={prompt.name} onChoice={prompt.resolve} />}
      {prompt?.kind === 'alert' && <AlertDialog message={prompt.message} info={prompt.info} onClose={prompt.resolve} />}
      {prompt?.kind === 'export' && (
        <ExportHtmlDialog fileName={prompt.fileName} defaults={prompt.defaults} onExport={prompt.resolve} onCancel={() => prompt.resolve(null)} />
      )}
      {/* F-22 fallback without the File System Access API. */}
      <input
        ref={openInput}
        type="file"
        accept={OPEN_ACCEPT}
        hidden
        data-testid="open-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openFileObject(f);
        }}
      />
    </div>
  );
}

/** F-12 word-count pop-up (bottom of the editor area). */
function WordCount({
  count,
  type,
  onChange,
}: {
  count: TextCount | null;
  type: MacDownPreferences['editorWordCountType'];
  onChange: (t: WordCountType) => void;
}) {
  const c = count ?? { words: 0, characters: 0, charactersNoSpaces: 0 };
  return (
    <select
      className="word-count"
      data-testid="word-count"
      aria-label="Word count"
      value={type}
      disabled={!count}
      onChange={(e) => onChange(Number(e.target.value) as WordCountType)}
    >
      <option value={0}>{wordCountLabel(0, c)}</option>
      <option value={1}>{wordCountLabel(1, c)}</option>
      <option value={2}>{wordCountLabel(2, c)}</option>
    </select>
  );
}
