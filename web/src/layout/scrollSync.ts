/**
 * F-11 editor → preview scroll sync.
 *
 * Deliberate web deviation (issue #2): the original pairs editor lines that
 * match header and image regexes with `h1–h6, img:only-child` in the preview
 * [vendor/macdown/MacDown/Code/Document/MPDocument.m:1717–1835]. A `# comment`
 * inside a code fence matched the header regex but has no `<h1>` in the
 * preview, so the pairs shifted and the preview jumped. The web version takes
 * the pairs from the parse: every preview block carries the source lines it
 * came from (`data-line`, `data-line-end`, render/markdown.ts), so the start
 * and end of each block (headers, paragraphs, images, code, lists, tables)
 * and the space between blocks line up in both panes. The mid-screen
 * alignment, tapered at the top and bottom of the document, is kept.
 */
import type { EditorView } from '@codemirror/view';

/** Selector of the preview blocks that carry their source lines. */
export const PREVIEW_ANCHOR_SELECTOR = '[data-line]';

/** A preview position (document coordinates) that belongs to the top of a source line. */
export interface PreviewAnchor {
  /** 0-based source line. */
  line: number;
  y: number;
}

/** A matching pair of positions in the editor and the preview (content coordinates). */
export interface ScrollPoint {
  editor: number;
  preview: number;
}

/**
 * Start and end of every preview block: the top of a block belongs to its
 * first line, its bottom to the line after it.
 */
export function previewAnchors(doc: Document): PreviewAnchor[] {
  const offset = doc.defaultView?.scrollY ?? 0;
  const out: PreviewAnchor[] = [];
  for (const el of Array.from(doc.querySelectorAll(PREVIEW_ANCHOR_SELECTOR))) {
    if (el.getClientRects().length === 0) continue; // not rendered (display: none)
    const rect = el.getBoundingClientRect();
    const line = Number(el.getAttribute('data-line'));
    const end = Number(el.getAttribute('data-line-end'));
    if (Number.isFinite(line)) out.push({ line, y: rect.top + offset });
    if (Number.isFinite(end) && end > line) out.push({ line: end, y: rect.bottom + offset });
  }
  return out;
}

/**
 * Sorts the pairs by editor position and keeps only pairs that move forward
 * in both panes, so the mapping is monotonic (no jumping back). The start and
 * the end of both documents are always pairs.
 */
export function buildScrollMap(points: ScrollPoint[], editorEnd: number, previewEnd: number): ScrollPoint[] {
  const sorted = [...points].sort((a, b) => a.editor - b.editor || a.preview - b.preview);
  const out: ScrollPoint[] = [{ editor: 0, preview: 0 }];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (p.editor > last.editor && p.preview >= last.preview && p.editor < editorEnd && p.preview <= previewEnd) {
      out.push(p);
    }
  }
  out.push({ editor: Math.max(editorEnd, out[out.length - 1].editor), preview: Math.max(previewEnd, out[out.length - 1].preview) });
  return out;
}

/** Preview position of an editor position, linear between the pairs of `map`. */
export function mapEditorToPreview(map: ScrollPoint[], y: number): number {
  if (y <= map[0].editor) return map[0].preview;
  for (let k = 1; k < map.length; k++) {
    const a = map[k - 1];
    const b = map[k];
    if (y <= b.editor) {
      const span = b.editor - a.editor;
      return span > 0 ? a.preview + ((b.preview - a.preview) * (y - a.editor)) / span : b.preview;
    }
  }
  return map[map.length - 1].preview;
}

export interface SyncInput {
  editorScrollTop: number;
  editorContentHeight: number;
  editorVisibleHeight: number;
  previewContentHeight: number;
  previewVisibleHeight: number;
  /** Matching editor/preview positions, in any order. */
  points: ScrollPoint[];
}

/**
 * Where in the visible area the panes are aligned, as a fraction of its
 * height: 0 (top edge) at the top of the document, 0.5 (mid-screen) in the
 * middle, 1 (bottom edge) at the end, tapered over one screen at either end.
 */
export function alignmentFraction(scrollTop: number, maxScroll: number, visibleHeight: number): number {
  if (maxScroll <= 0) return 0;
  const taper = Math.min(visibleHeight, maxScroll / 2);
  if (taper <= 0) return 0.5;
  if (scrollTop < taper) return (0.5 * Math.max(0, scrollTop)) / taper;
  if (scrollTop > maxScroll - taper) return 0.5 + (0.5 * Math.min(taper, scrollTop - (maxScroll - taper))) / taper;
  return 0.5;
}

/** Returns the preview scrollTop that matches the editor position. */
export function computePreviewScrollTop(i: SyncInput): number {
  const editorMaxScroll = Math.max(0, i.editorContentHeight - i.editorVisibleHeight);
  const previewMaxScroll = Math.max(0, i.previewContentHeight - i.previewVisibleHeight);
  const f = alignmentFraction(i.editorScrollTop, editorMaxScroll, i.editorVisibleHeight);
  const map = buildScrollMap(i.points, i.editorContentHeight, i.previewContentHeight);
  const preview = mapEditorToPreview(map, i.editorScrollTop + f * i.editorVisibleHeight);
  return Math.max(0, Math.min(previewMaxScroll, preview - f * i.previewVisibleHeight));
}

/** Pairs every preview anchor with the top of its source line in the editor. */
export function scrollPoints(view: EditorView, anchors: PreviewAnchor[]): ScrollPoint[] {
  const doc = view.state.doc;
  const offset = view.documentPadding.top;
  const contentHeight = view.scrollDOM.scrollHeight;
  const tops = new Map<number, number>();
  const editorY = (line: number) => {
    let y = tops.get(line);
    if (y === undefined) {
      y = line >= doc.lines ? contentHeight : offset + view.lineBlockAt(doc.line(line + 1).from).top;
      tops.set(line, y);
    }
    return y;
  };
  return anchors.map((a) => ({ editor: editorY(a.line), preview: a.y }));
}

/** Where the last sync put each preview (to tell it apart from a link jump or a manual scroll). */
const syncedTop = new WeakMap<Document, number>();

/**
 * After the preview layout changed (an image loaded), syncs again only if the
 * preview is still where the last sync put it, so a jump to an in-page link
 * (F-18) or a manual scroll of the preview is kept.
 */
export function resyncAfterLayoutChange(view: EditorView, previewDoc: Document): void {
  const last = syncedTop.get(previewDoc);
  const win = previewDoc.defaultView;
  if (last === undefined || !win || Math.abs(win.scrollY - last) > 1) return;
  syncScroll(view, previewDoc);
}

/** Scrolls the preview document to follow the editor. */
export function syncScroll(view: EditorView, previewDoc: Document): void {
  const win = previewDoc.defaultView;
  if (!win) return;
  const scroller = view.scrollDOM;
  const root = previewDoc.scrollingElement ?? previewDoc.documentElement;
  const y = computePreviewScrollTop({
    editorScrollTop: scroller.scrollTop,
    editorContentHeight: scroller.scrollHeight,
    editorVisibleHeight: scroller.clientHeight,
    previewContentHeight: root.scrollHeight,
    previewVisibleHeight: win.innerHeight,
    points: scrollPoints(view, previewAnchors(previewDoc)),
  });
  win.scrollTo(0, y);
  syncedTop.set(previewDoc, win.scrollY);
}
