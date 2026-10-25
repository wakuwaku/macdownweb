import { describe, expect, it } from 'vitest';
import {
  INITIAL_SPLIT,
  editorVisible,
  leftRatio,
  previewToggleHidden,
  previewVisible,
  setLeftRatio,
  togglePane,
} from '../../src/layout/split';
import { alignmentFraction, buildScrollMap, computePreviewScrollTop, mapEditorToPreview } from '../../src/layout/scrollSync';
import { countText, wordCountLabel } from '../../src/render';
import { parsePrefOverrides, PreferencesStore, DEFAULT_PREFERENCES } from '../../src/prefs';

describe('split view (F-01, F-04–F-08, F-10)', () => {
  it('starts at 1:1 with both panes visible', () => {
    expect(leftRatio(INITIAL_SPLIT, false)).toBe(0.5);
    expect(editorVisible(INITIAL_SPLIT) && previewVisible(INITIAL_SPLIT)).toBe(true);
  });
  it('hides and restores the preview with the previous ratio', () => {
    const s1 = setLeftRatio(INITIAL_SPLIT, 0.25, false);
    const hidden = togglePane(s1, false);
    expect(previewVisible(hidden)).toBe(false);
    expect(leftRatio(hidden, false)).toBe(1);
    expect(leftRatio(togglePane(hidden, false), false)).toBe(0.25);
  });
  it('switches from 100% editor to 100% preview without losing the ratio', () => {
    const s = togglePane(setLeftRatio(INITIAL_SPLIT, 0.75, false), false); // hide preview
    const s2 = togglePane(s, true); // hide editor
    expect(editorVisible(s2)).toBe(false);
    expect(togglePane(s2, true).editorFraction).toBe(0.75);
  });
  it('falls back to 0.5 when there is nothing to restore', () => {
    const collapsed = setLeftRatio(INITIAL_SPLIT, 1, false);
    expect(previewToggleHidden(collapsed)).toBe(true);
    expect(togglePane(collapsed, false).editorFraction).toBe(0.5);
  });
  it('mirrors the ratio when the editor is on the right (P-03)', () => {
    const s = setLeftRatio(INITIAL_SPLIT, 0.25, true);
    expect(s.editorFraction).toBe(0.75);
    expect(leftRatio(togglePane(s, true), true)).toBe(1); // editor hidden → preview fills
  });
  it('clamps the divider position', () => {
    expect(setLeftRatio(INITIAL_SPLIT, -3, false).editorFraction).toBe(0);
    expect(setLeftRatio(INITIAL_SPLIT, 7, false).editorFraction).toBe(1);
  });
});

describe('scroll sync (F-11)', () => {
  const base = { editorContentHeight: 2000, editorVisibleHeight: 500, previewContentHeight: 4000, previewVisibleHeight: 500 };
  const points = [
    { editor: 100, preview: 200 },
    { editor: 900, preview: 1800 },
  ];
  it('maps the top of the document to the top of the preview', () => {
    expect(computePreviewScrollTop({ ...base, editorScrollTop: 0, points })).toBe(0);
  });
  it('maps the bottom of the editor to the bottom of the preview', () => {
    expect(computePreviewScrollTop({ ...base, editorScrollTop: 1500, points })).toBe(3500);
  });
  it('aligns matching blocks at mid-screen and interpolates between them', () => {
    // scrollTop 650: mid-screen at 900 (a pair) → preview 1800 at its mid-screen.
    expect(computePreviewScrollTop({ ...base, editorScrollTop: 650, points })).toBe(1550);
    // scrollTop 250 is in the top taper (alignment 0.25 of the screen): editor 375 lies
    // between the pairs 100→200 and 900→1800, so the preview point is 750, shown 125 px down.
    expect(computePreviewScrollTop({ ...base, editorScrollTop: 250, points })).toBe(200 + 1600 * (275 / 800) - 125);
  });
  it('a tall preview block (an image) scrolls through while the editor passes its one line', () => {
    // editor: image line 400–420, next block at 440; preview: image 400–1400, next block 1430.
    const img = [
      { editor: 400, preview: 400 },
      { editor: 440, preview: 1400 },
      { editor: 460, preview: 1430 },
    ];
    const map = buildScrollMap(img, 2000, 4000);
    expect(mapEditorToPreview(map, 420)).toBe(900);
    expect(mapEditorToPreview(map, 450)).toBe(1415);
  });
  it('drops pairs that would move the preview backwards (the mapping is monotonic)', () => {
    const map = buildScrollMap(
      [
        { editor: 100, preview: 300 },
        { editor: 200, preview: 250 }, // out of order: dropped
        { editor: 200, preview: 260 }, // same editor y as a dropped pair: also backwards
        { editor: 300, preview: 600 },
        { editor: 300, preview: 700 }, // same editor y: the first one is kept
      ],
      1000,
      2000,
    );
    expect(map).toEqual([
      { editor: 0, preview: 0 },
      { editor: 100, preview: 300 },
      { editor: 300, preview: 600 },
      { editor: 1000, preview: 2000 },
    ]);
  });
  it('alignment moves from the top edge to mid-screen to the bottom edge', () => {
    expect(alignmentFraction(0, 1500, 500)).toBe(0);
    expect(alignmentFraction(250, 1500, 500)).toBe(0.25);
    expect(alignmentFraction(750, 1500, 500)).toBe(0.5);
    expect(alignmentFraction(1500, 1500, 500)).toBe(1);
    expect(alignmentFraction(0, 0, 500)).toBe(0); // nothing to scroll
    expect(alignmentFraction(100, 200, 500)).toBe(0.5); // short document: tapers over half the scroll range
  });
});

describe('word count (F-12)', () => {
  it('counts words, characters and characters without spaces from the DOM', () => {
    const doc = new DOMParser().parseFromString(
      '<html><head><title>ignored words</title><style>p{}</style></head><body><p>Hello big world</p><p>use <code>a b</code></p><div><pre><code>not counted</code></pre></div></body></html>',
      'text/html',
    );
    const c = countText(doc);
    expect(c.words).toBe(5); // Hello big world use + inline code = 1
    expect(c.characters).toBe('Hello big worlduse a bnot counted'.length);
    expect(c.charactersNoSpaces).toBe('Hellobigworlduseabnotcounted'.length);
  });
  it('uses the Localizable.strings labels with singular/plural forms', () => {
    const c = { words: 1, characters: 2, charactersNoSpaces: 1 };
    expect(wordCountLabel(0, c)).toBe('1 word');
    expect(wordCountLabel(1, c)).toBe('2 characters');
    expect(wordCountLabel(2, c)).toBe('1 character (no spaces)');
    expect(wordCountLabel(0, { ...c, words: 1234 })).toBe('1234 words');
  });
});

describe('preferences (§8)', () => {
  it('has the spec defaults', () => {
    expect(DEFAULT_PREFERENCES.extensionTables).toBe(true);
    expect(DEFAULT_PREFERENCES.extensionFencedCode).toBe(true);
    expect(DEFAULT_PREFERENCES.extensionAutolink).toBe(false);
    expect(DEFAULT_PREFERENCES.extensionStrikethough).toBe(false);
    expect(DEFAULT_PREFERENCES.editorSyncScrolling).toBe(true);
    expect(DEFAULT_PREFERENCES.editorShowWordCount).toBe(false);
    expect(DEFAULT_PREFERENCES.htmlStyleName).toBe('GitHub2');
    expect(DEFAULT_PREFERENCES.markdownManualRender).toBe(false);
  });
  it('parses ?pref.key=value overrides and ignores unknown keys', () => {
    expect(parsePrefOverrides('?pref.editorShowWordCount=true&pref.htmlStyleName=Clearness&pref.bogus=1&x=2')).toEqual({
      editorShowWordCount: true,
      htmlStyleName: 'Clearness',
    });
  });
  it('notifies subscribers on set', () => {
    const store = new PreferencesStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ editorOnRight: true });
    expect(store.get().editorOnRight).toBe(true);
    expect(calls).toBe(1);
  });
});
