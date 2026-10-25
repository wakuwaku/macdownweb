import { useEffect, useRef } from 'react';
import { runPreviewScripts, type ScriptId } from '../render';
import type { MacDownPreferences } from '../prefs';

export interface PreviewProps {
  /** Full HTML page from the template (§7.4). */
  html: string;
  /** Page scripts of §6.10, run from the app window after the page is written. */
  scripts: ScriptId[];
  /** Preferences the page scripts read (MathJax delimiters). */
  scriptPrefs: Pick<MacDownPreferences, 'htmlMathJaxInlineDollar'>;
  /**
   * Called after each page is written and its scripts ran, with the preview
   * document and the scrollTop it had before the re-render
   * (`lastPreviewScrollTop`). Synchronous when every script asset is already
   * loaded; otherwise called again once the asynchronous scripts finished
   * (the original also waits for MathJax before syncing, MPDocument.m:852).
   */
  onRendered: (doc: Document, lastScrollTop: number) => void;
  /** Called when an image (or other resource) in the page finished loading and may have moved the content below it. */
  onLayoutChange?: (doc: Document) => void;
  /** Keydown inside the preview (so app shortcuts still work there). */
  onKeyDown: (e: KeyboardEvent) => void;
  /** F-17 (P-29): preview zoom (`pageSizeMultiplier`); 1 = none. */
  zoom?: number;
}

/**
 * F-37 / E-05 / E-06 print layout [MPDocument.m:607-620]: margins 50 pt top
 * and bottom, 0 pt left and right. Adopted by the preview document (not a
 * `<style>` element, so the page's own style list stays as §6.10 says).
 */
export const PRINT_CSS = '@page { margin: 50pt 0pt; }';

/** F-17: `pageSizeMultiplier` as CSS zoom on the preview's root element. */
export function applyZoom(doc: Document, zoom: number): void {
  const root = doc.documentElement;
  if (!root) return;
  if (zoom === 1) root.style.removeProperty('zoom');
  else root.style.setProperty('zoom', String(zoom));
}

function adoptPrintSheet(doc: Document): void {
  const win = doc.defaultView as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null;
  if (!win || !('adoptedStyleSheets' in doc)) return;
  try {
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(PRINT_CSS);
    doc.adoptedStyleSheets = [sheet];
  } catch {
    /* older engines: the print margins fall back to the browser's */
  }
}

const EXTERNAL = /^(https?|ftp|mailto):/i;

/** HTML "find a potential indicated element": the element with that id, else the first `<a name>` (D-15). */
function indicatedElement(doc: Document, fragment: string): Element | null {
  return doc.getElementById(fragment) ?? Array.from(doc.getElementsByName(fragment)).find((e) => e.localName === 'a') ?? null;
}

/**
 * Percent-decoding as the URL standard does it (D-16): a `%` that is not
 * followed by two hex digits stays as is (no URIError), and the bytes are
 * decoded as UTF-8 with replacement characters for invalid sequences.
 */
export function percentDecode(s: string): string {
  if (!s.includes('%')) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      bytes.push(...enc.encode(ch));
      i += ch.length - 1;
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

/**
 * F-18 in-page links, as WebKit scrolls to a fragment (HTML "scroll to the
 * fragment"): an empty fragment or `top` goes to the top; otherwise the
 * element whose id is the fragment, or the first `<a name>` with it, first
 * as written and then percent-decoded. No target: nothing happens.
 */
export function scrollToFragment(doc: Document, fragment: string): void {
  const top = () => doc.defaultView?.scrollTo(0, 0);
  if (!fragment) return top();
  let target = indicatedElement(doc, fragment);
  if (!target) {
    const decoded = percentDecode(fragment);
    target = indicatedElement(doc, decoded);
    if (!target && decoded.toLowerCase() === 'top') return top();
  }
  target?.scrollIntoView();
}

/**
 * The preview pane: a sandboxed iframe. No script runs inside it, so raw HTML
 * in the Markdown (`<script>`, `onerror=…`, `javascript:` links) cannot run.
 * The app manipulates the document from outside, which `allow-same-origin`
 * permits, and runs Prism, tasklist.js, Mermaid/Graphviz (through an isolated
 * runner) and MathJax against it (render/postprocess.ts).
 * The page is written with document.open/write so the update is synchronous
 * and the scroll position can be restored without a flash (F-02).
 */
export function Preview({ html, scripts, scriptPrefs, onRendered, onLayoutChange, onKeyDown, zoom = 1 }: PreviewProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const cb = useRef({ onRendered, onLayoutChange, onKeyDown });
  cb.current = { onRendered, onLayoutChange, onKeyDown };
  const generation = useRef(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const iframe = frame.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;
    const lastScrollTop = iframe.contentWindow?.scrollY ?? 0;
    doc.open();
    doc.write(html);
    doc.close();

    // F-18: links never navigate the preview. In-page anchors (id or `<a name>`) scroll, external
    // URLs open in a new browser tab, anything else (relative paths, F-20) is
    // ignored for now.
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        scrollToFragment(doc, href.slice(1));
      } else if (EXTERNAL.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    });
    doc.addEventListener('keydown', (e) => cb.current.onKeyDown(e));
    // Load events do not bubble; capture them so an image that loads late re-syncs the scroll (F-11).
    let layoutFrame = 0;
    doc.addEventListener(
      'load',
      () => {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          if (iframe.contentDocument === doc) cb.current.onLayoutChange?.(doc);
        });
      },
      true,
    );
    // F-18: dragging onto the preview is disabled (MPDocument.m:944-950).
    doc.addEventListener('dragover', (e) => e.preventDefault());
    doc.addEventListener('drop', (e) => e.preventDefault());
    adoptPrintSheet(doc);
    applyZoom(doc, zoomRef.current);

    const gen = ++generation.current;
    const isCurrent = () => generation.current === gen && iframe.contentDocument === doc;
    const pending = runPreviewScripts(doc, scripts, scriptPrefs, isCurrent);
    // Testing aid: <html data-macdown-scripts="pending|done"> in the preview.
    doc.documentElement.dataset.macdownScripts = pending ? 'pending' : 'done';
    cb.current.onRendered(doc, lastScrollTop);
    if (pending) {
      void pending.finally(() => {
        if (!isCurrent()) return;
        doc.documentElement.dataset.macdownScripts = 'done';
        cb.current.onRendered(doc, lastScrollTop);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scriptPrefs only matters with scripts
  }, [html, scripts.join(' '), scriptPrefs.htmlMathJaxInlineDollar]);

  // F-17: re-applied when the base font or P-29 changes.
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (doc) applyZoom(doc, zoom);
  }, [zoom]);

  return (
    <iframe
      ref={frame}
      className="preview-frame"
      title="Preview"
      data-testid="preview-iframe"
      // allow-modals only lets the app call print() on the preview (F-36, F-37); no script runs in it.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"
    />
  );
}
