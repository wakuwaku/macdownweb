/** Additional M2 unit tests (test-engineer): gaps found when reviewing the existing suites. */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderDocument, renderTemplate, getStyleCss, STYLE_NAMES, countText } from '../../src/render';
import { withDefaults } from '../../src/prefs';
import { INITIAL_SPLIT, togglePane, setLeftRatio, leftRatio, editorVisible, previewVisible, previewToggleHidden } from '../../src/layout/split';
import { matchesShortcut } from '../../src/components/shortcuts';

const r = (md: string, o = {}) => renderMarkdown(md, withDefaults(o));

describe('F-110 core Markdown', () => {
  it('F-110 renders hr, images, reference links and two-space hard breaks', () => {
    const h = r('a  \nb\n\n---\n\n![alt](http://x/y.png)\n\n[ref][1]\n\n[1]: http://x.test/ "T"');
    expect(h).toContain('<br>');
    expect(h).toContain('<hr>');
    expect(h).toContain('<img src="http://x/y.png" alt="alt">');
    expect(h).toContain('<a href="http://x.test/" title="T">ref</a>');
  });
  it('F-110 empty document renders to an empty body', () => {
    expect(r('').trim()).toBe('');
  });
  it('F-110 escapes < and & in text', () => {
    expect(r('1 < 2 & 3')).toContain('1 &lt; 2 &amp; 3');
  });
});

describe('F-111 tables', () => {
  it('F-111 header-only table (no body rows) still renders a table', () => {
    expect(r('| a | b |\n|---|---|')).toContain('<table>');
  });
  it('F-111 table alignment markers produce text-align on th and td', () => {
    const h = r('|:-|:-:|-:|\n|:-|:-:|-:|\n|a|b|c|').replace(/\s+/g, ' ');
    expect(h).toMatch(/text-align: ?left/);
    expect(h).toMatch(/text-align: ?center/);
    expect(h).toMatch(/text-align: ?right/);
  });
});

describe('F-112 fenced code edge cases', () => {
  it('F-112 empty fence renders an empty code element', () => {
    const h = r('```\n```');
    expect(h).toContain('<pre');
    expect(h).toContain('<code');
  });
  it('F-112 escapes HTML inside code and keeps one internal newline structure', () => {
    const h = r('```\n<b>&\nx\n```');
    expect(h).toContain('&lt;b&gt;&amp;\nx');
    expect(h).not.toMatch(/x\n<\/code>/); // trailing newline stripped (hoedown_html_patch.c)
  });
  it('F-112 unterminated fence runs to the end of the document', () => {
    expect(r('```js\nvar a')).toContain('var a');
  });
});

describe('F-113 / F-114 toggles', () => {
  it('F-113 www. and bare e-mail autolink only with P-09 on', () => {
    expect(r('www.example.com a@b.co')).not.toContain('<a');
    const h = r('www.example.com a@b.co', { extensionAutolink: true });
    expect(h).toContain('href="http://www.example.com"');
    expect(h).toContain('href="mailto:a@b.co"');
  });
  it('F-114 ~~x~~ stays literal when P-10 is off, <del> when on', () => {
    expect(r('~~x~~')).toContain('~~x~~');
    expect(r('~~x~~', { extensionStrikethough: true })).toContain('<del>x</del>');
  });
});

describe('F-122 header ids', () => {
  it('F-122 every header level 1-6 gets a sequential toc id', () => {
    const h = r('# 1\n## 2\n### 3\n#### 4\n##### 5\n###### 6');
    for (let i = 0; i < 6; i++) expect(h).toContain(`<h${i + 1} id="toc_${i}">`);
  });
  it('F-122 headers with inline markup keep the id', () => {
    expect(r('# a *b*')).toContain('<h1 id="toc_0">a <em>b</em></h1>');
  });
  it('F-122 headers inside blockquotes and lists are numbered too', () => {
    const h = r('# A\n\n> ## B\n\n* ### C');
    expect(h).toContain('id="toc_0"');
    expect(h).toContain('id="toc_1"');
    expect(h).toContain('id="toc_2"');
  });
});

describe('F-134 / F-135', () => {
  it('F-134 hard wrap produces <br> for single newlines; off keeps them', () => {
    expect(r('a\nb', { htmlHardWrap: true })).toContain('a<br>\nb');
    expect(r('a\nb')).not.toContain('<br');
  });
  it('F-135 inline raw HTML and script tags pass through unescaped', () => {
    const h = r('x <i onclick="1">y</i>\n\n<script>1</script>');
    expect(h).toContain('<i onclick="1">y</i>');
    expect(h).toContain('<script>1</script>');
  });
  it('F-135 HTML comments pass through', () => {
    expect(r('<!-- c -->')).toContain('<!-- c -->');
  });
});

describe('F-136 / F-139', () => {
  it('F-136 default style name is GitHub2 and its CSS is in the page', () => {
    const css = getStyleCss('GitHub2')!;
    expect(css.length).toBeGreaterThan(500);
    expect(renderDocument('x', withDefaults({})).html).toContain(css);
  });
  it('F-136 empty or unknown style name gives an unstyled page', () => {
    expect(getStyleCss('')).toBeUndefined();
    expect(getStyleCss('Nope')).toBeUndefined();
    expect(renderDocument('x', withDefaults({ htmlStyleName: '' })).html).not.toContain('<style');
  });
  it('F-136 every listed style exists and is non-empty', () => {
    for (const n of STYLE_NAMES) expect(getStyleCss(n)!.length).toBeGreaterThan(0);
  });
  it('F-139 title is escaped and the body is placed between head and end of the page', () => {
    const html = renderTemplate({ title: 'a<b>&"', styleTags: [], body: '<p>x</p>', scriptTags: [] });
    expect(html).toContain('<title>a&lt;b&gt;&amp;&quot;</title>');
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<p>x</p>'));
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});

describe('F-04..F-08, F-10 layout state', () => {
  it('F-07 hiding the preview then showing it restores the previous ratio after a 1:3 preset', () => {
    let s = setLeftRatio(INITIAL_SPLIT, 0.25, false);
    s = togglePane(s, false);
    expect(previewVisible(s)).toBe(false);
    s = togglePane(s, false);
    expect(s.editorFraction).toBe(0.25);
  });
  it('F-08 hiding the editor sets the fraction to 0 and hides the editor', () => {
    const s = togglePane(INITIAL_SPLIT, true);
    expect(s.editorFraction).toBe(0);
    expect(editorVisible(s)).toBe(false);
  });
  it('F-07 restore-preview item is hidden only when collapsed with no previous ratio', () => {
    expect(previewToggleHidden(INITIAL_SPLIT)).toBe(false);
    expect(previewToggleHidden(setLeftRatio(INITIAL_SPLIT, 1, false))).toBe(true);
    expect(previewToggleHidden(togglePane(INITIAL_SPLIT, false))).toBe(false);
  });
  it('F-10 with the editor on the right, left ratio 0.25 gives the editor 0.75 and round-trips', () => {
    const s = setLeftRatio(INITIAL_SPLIT, 0.25, true);
    expect(s.editorFraction).toBe(0.75);
    expect(leftRatio(s, true)).toBe(0.25);
  });
  it('F-01 ratios outside 0..1 are clamped', () => {
    expect(setLeftRatio(INITIAL_SPLIT, -3, false).editorFraction).toBe(0);
    expect(setLeftRatio(INITIAL_SPLIT, 3, false).editorFraction).toBe(1);
  });
});

describe('F-11 source-line anchors', () => {
  const lines = (md: string, o = {}) =>
    [...renderDocument(md, withDefaults(o), { sourceLines: true }).body.matchAll(/<(\w+)[^>]*? data-line="(\d+)" data-line-end="(\d+)"/g)].map(
      (m) => `${m[1]}:${m[2]}-${m[3]}`,
    );
  it('F-11 marks headings, paragraphs, images and code blocks with their source lines', () => {
    expect(lines('# A\n\ntext\n\n![x](y.png)\n\n```sh\n# comment\nnpm ci\n```\n\n## B\n')).toEqual([
      'h1:0-1',
      'p:2-3',
      'p:4-5',
      'div:6-10',
      'h2:11-12',
    ]);
  });
  it('F-11 a # comment inside a code fence is not a heading anchor (issue #2)', () => {
    expect(lines('```bash\n# install\nnpm ci\n```\n').filter((l) => l.startsWith('h'))).toEqual([]);
  });
  it('F-11 lists, list items, quotes, tables, hr and indented code get anchors', () => {
    const got = lines('- a\n- b\n\n> q\n\n| x |\n|---|\n| 1 |\n\n---\n\n    code\n');
    expect(got).toEqual(expect.arrayContaining(['ul:0-3', 'li:0-1', 'li:1-3', 'blockquote:3-4', 'table:5-8', 'tr:7-8', 'hr:9-10', 'div:11-12']));
  });
  it('F-11 front matter shifts the lines; its table is the first anchor', () => {
    expect(lines('---\ntitle: t\n---\n# H\n', { htmlDetectFrontMatter: true })).toEqual(['table:0-3', 'h1:3-4']);
  });
  it('F-11 footnote definitions (rendered at the end) get no anchors', () => {
    const got = lines('a[^1]\n\n[^1]: note\n\nb\n', { extensionFootnotes: true });
    expect(got).toEqual(['p:0-1', 'p:4-5']);
  });
  it('F-11 Copy HTML and export bodies carry no source lines', () => {
    expect(renderDocument('# A\n\n```\nx\n```\n', withDefaults({})).body).not.toContain('data-line');
    expect(r('# A\n\ntext\n')).not.toContain('data-line');
  });
});

describe('F-12 word count edge cases', () => {
  const doc = (body: string) => new DOMParser().parseFromString(`<html><head></head><body>${body}</body></html>`, 'text/html');
  it('F-12 empty body counts zero', () => {
    expect(countText(doc(''))).toEqual({ words: 0, characters: 0, charactersNoSpaces: 0 });
  });
  it('F-12 each text node is counted separately: **foo**bar is 2 words', () => {
    expect(countText(doc('<p><strong>foo</strong>bar</p>')).words).toBe(2);
  });
  it('F-12 script and style content is ignored', () => {
    expect(countText(doc('<p>a</p><script>one two three</script><style>x{}</style>')).words).toBe(1);
  });
  it('F-12 newlines are excluded from characters but code blocks keep their characters', () => {
    const c = countText(doc('<pre><code>ab\ncd</code></pre>'));
    expect(c.words).toBe(0);
    expect(c.characters).toBe(4);
  });
});

describe('Shortcut matching (F-05, F-07, F-08, F-13, F-81..F-88)', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
  const cmd = isMac ? { metaKey: true } : { ctrlKey: true };
  it('F-07 Shift+Cmd+H matches, plain Cmd+H does not', () => {
    expect(matchesShortcut(ev({ key: 'H', shiftKey: true, ...cmd }), { key: 'h', cmd: true, shift: true })).toBe(true);
    expect(matchesShortcut(ev({ key: 'h', ...cmd }), { key: 'h', cmd: true, shift: true })).toBe(false);
  });
  it('F-13 Opt+Cmd+T matches through the physical key code', () => {
    expect(matchesShortcut(ev({ key: '†', code: 'KeyT', altKey: true, ...cmd }), { key: 't', code: 'KeyT', cmd: true, alt: true })).toBe(true);
  });
  it('F-05 Shift+Cmd+0 matches through Digit0', () => {
    expect(matchesShortcut(ev({ key: ')', code: 'Digit0', shiftKey: true, ...cmd }), { key: '0', code: 'Digit0', cmd: true, shift: true })).toBe(true);
  });
});
