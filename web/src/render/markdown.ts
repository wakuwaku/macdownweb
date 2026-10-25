/**
 * Markdown → body HTML, spec §6.1 (pipeline), §6.2/§6.3 (extensions) and
 * §6.4 (code blocks).
 *
 * Pipeline (same order as `MPRenderer parseMarkdown:` / `MPHTMLFromMarkdown`
 * [vendor/macdown/MacDown/Code/Document/MPRenderer.m:96-145, 586-617]):
 *   1. front matter (P-28) is detected and removed;
 *   2. markdown-it renders with the extension flags;
 *   3. SmartyPants (P-16) post-processes the HTML;
 *   4. the TOC (P-27) replaces every `[TOC]` paragraph (after SmartyPants);
 *   5. body = front-matter table + "\n" + html.
 *
 * Extension mapping: F-110 core, F-111 tables (P-07), F-112 fenced code
 * (P-08), F-113 autolink (P-09), F-114 strikethrough (P-10), F-115 underline
 * (P-11), F-116 highlight (P-12), F-117 footnotes (P-13), F-118 superscript
 * (P-14), F-119 quote (P-15), F-120 SmartyPants (P-16), F-121 intra-word
 * emphasis (P-17), F-122 header ids, F-123 TOC (P-27), F-125/F-127 code-block
 * HTML (P-22, P-23), F-130/F-131 math (P-18, P-19), F-132 task lists (P-26),
 * F-133 front matter (P-28), F-134 hard wrap (P-29b), F-135 raw HTML.
 */
import markdownit, { type Env, type MarkdownIt } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import type { MacDownPreferences } from '../prefs/defaults';
import syntaxHighlighting from './syntax_highlighting.json';
import prismComponentsSource from './assets/prism-components.js?raw';
import { escapeHtml } from './hoedown';
import {
  autolinkPlugin,
  hoedownFootnotes,
  intraEmphasisPlugin,
  mathPlugin,
  quotePlugin,
  superscriptPlugin,
  taskListPlugin,
  underlinePlugin,
} from './extensions';
import { smartypants } from './smartypants';
import { collectHeaders, insertToc, renderToc } from './toc';
import { detectFrontMatter, htmlTable } from './frontMatter';

/** Preferences that change the parse (spec §6.1: "parse-affecting"). */
export type RenderPreferences = Pick<
  MacDownPreferences,
  | 'extensionTables'
  | 'extensionFencedCode'
  | 'extensionAutolink'
  | 'extensionStrikethough'
  | 'extensionUnderline'
  | 'extensionHighlight'
  | 'extensionFootnotes'
  | 'extensionSuperscript'
  | 'extensionQuote'
  | 'extensionSmartyPants'
  | 'extensionIntraEmphasis'
  | 'htmlMathJax'
  | 'htmlMathJaxInlineDollar'
  | 'htmlTaskList'
  | 'htmlRendersTOC'
  | 'htmlDetectFrontMatter'
  | 'htmlHardWrap'
  | 'htmlLineNumbers'
  | 'htmlCodeBlockAccessory'
>;

/** Keys that change the markdown-it instance (the rest are applied around it). */
const INSTANCE_KEYS: (keyof RenderPreferences)[] = [
  'extensionTables',
  'extensionFencedCode',
  'extensionAutolink',
  'extensionStrikethough',
  'extensionUnderline',
  'extensionHighlight',
  'extensionFootnotes',
  'extensionSuperscript',
  'extensionQuote',
  'extensionIntraEmphasis',
  'htmlMathJax',
  'htmlMathJaxInlineDollar',
  'htmlTaskList',
  'htmlHardWrap',
  'htmlLineNumbers',
  'htmlCodeBlockAccessory',
];

const LANGUAGE_ALIASES: Record<string, string> = syntaxHighlighting.aliases;

/**
 * Maps a fence language through `syntax_highlighting.json` aliases.
 * The original looks the alias up with `-[NSDictionary objectForKey:]`, which
 * is case-sensitive [vendor/macdown/MacDown/Code/Document/MPRenderer.m:292].
 */
export function mapLanguage(lang: string): string {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, lang) ? LANGUAGE_ALIASES[lang] : lang;
}

interface PrismComponent {
  require?: string | string[];
}

/** `languages` of the bundled `Prism/components.js` (Prism 1.4.1). */
export const PRISM_LANGUAGES: Record<string, PrismComponent> = (() => {
  const components = new Function(`${prismComponentsSource}\nreturn components;`)() as {
    languages: Record<string, PrismComponent>;
  };
  return components.languages;
})();

/**
 * `add_to_languages` [MPRenderer.m:243-268]: moves `lang` to the front and
 * then adds its `require` dependencies in front of it, recursively, so that
 * dependencies end up before the languages that need them.
 */
export function addToLanguages(lang: string, languages: string[]): void {
  const index = languages.indexOf(lang);
  if (index >= 0) languages.splice(index, 1);
  languages.unshift(lang);
  const require = Object.prototype.hasOwnProperty.call(PRISM_LANGUAGES, lang) ? PRISM_LANGUAGES[lang].require : undefined;
  if (typeof require === 'string') addToLanguages(require, languages);
  else if (Array.isArray(require)) for (const r of require) addToLanguages(r, languages);
}

/** Render environment shared by the custom rules of one parse. */
export type RenderEnv = Env & {
  /** Languages used by code blocks, in Prism load order (`currentLanguages`). */
  languages: string[];
  /** F-11: write `data-line`/`data-line-end` source lines on blocks (preview only). */
  sourceLines?: boolean;
  /** Editor lines before the parsed text (the removed front matter). */
  lineOffset?: number;
};

/** `data-line="A" data-line-end="B"` for a token map, or '' when not wanted. */
function sourceLineAttrs(map: [number, number] | null, env?: RenderEnv): string {
  if (!env?.sourceLines || !map) return '';
  const offset = env.lineOffset ?? 0;
  return ` data-line="${map[0] + offset}" data-line-end="${map[1] + offset}"`;
}

/**
 * Hoedown code block HTML, ported from `hoedown_patch_render_blockcode`
 * [vendor/macdown/MacDown/Code/Extension/hoedown_html_patch.c:22]:
 *   <div><pre[ class="line-numbers"][ data-information="INFO"]><code class="language-LANG">CODE</code></pre></div>
 * - The info string is split at the first ':' only when the accessory is
 *   Custom (HOEDOWN_HTML_BLOCKCODE_INFORMATION, P-23 = 2).
 * - `data-information` is written raw (not escaped), as in the original.
 * - One trailing newline is removed from the code.
 * - Each language is recorded for Prism (`language_addition`).
 */
export function renderCodeBlock(
  code: string,
  info: string,
  prefs: Pick<RenderPreferences, 'htmlLineNumbers' | 'htmlCodeBlockAccessory'>,
  env?: RenderEnv,
  map: [number, number] | null = null,
): string {
  // Hoedown takes the first word of the fence info string as the language.
  let lang = info.trim().split(/\s+/)[0] ?? '';
  let information = '';
  if (lang && prefs.htmlCodeBlockAccessory === 2) {
    const colon = lang.indexOf(':');
    if (colon >= 0) {
      information = lang.slice(colon + 1);
      lang = lang.slice(0, colon);
    }
  }
  if (lang) {
    lang = mapLanguage(lang);
    if (env) addToLanguages(lang, env.languages);
  }
  const body = code.endsWith('\n') ? code.slice(0, -1) : code;
  let html = `<div${sourceLineAttrs(map, env)}><pre`;
  if (prefs.htmlLineNumbers) html += ' class="line-numbers"';
  if (information) html += ` data-information="${information}"`;
  html += `><code class="language-${lang ? escapeHtml(lang) : 'none'}">`;
  html += escapeHtml(body);
  html += '</code></pre></div>\n';
  return html;
}

/**
 * Hoedown `parse_codefence` [document.c:1472-1475], "avoid parsing a codespan
 * as a fence": an opening line whose text after the fence (from the info
 * string on) contains three fence characters in a row is not a fence. So
 * `~~~b~~~` is a paragraph, as in the original. markdown-it applies a similar
 * rule only to backtick fences.
 */
function hoedownFencePlugin(md: MarkdownIt): void {
  const rule = md.block.ruler.__rules__.find((r) => r.name === 'fence');
  if (!rule) return;
  const orig = rule.fn;
  md.block.ruler.at(
    'fence',
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const ch = state.src[start];
      if (ch === '~' || ch === '`') {
        let pos = start;
        while (pos < max && state.src[pos] === ch) pos++;
        while (pos < max && (state.src[pos] === ' ' || state.src[pos] === '\n')) pos++;
        if (state.src.slice(pos, max).includes(ch.repeat(3))) return false;
      }
      return orig(state, startLine, endLine, silent);
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  );
}

/** F-122: every header gets `id="toc_N"` (0-based, document order). */
function headerIdsPlugin(md: MarkdownIt): void {
  md.core.ruler.push('macdown_header_ids', (state) => {
    let n = 0;
    for (const token of state.tokens) {
      if (token.type === 'heading_open') token.attrSet('id', `toc_${n++}`);
    }
  });
}

/**
 * F-11 (web deviation): with `env.sourceLines`, every block gets the source
 * lines it came from, so scroll sync can pair editor lines with preview
 * blocks. Footnote definitions are skipped: they render at the end, out of
 * source order.
 */
function sourceLinesPlugin(md: MarkdownIt): void {
  md.core.ruler.push('macdown_source_lines', (state) => {
    const env = state.env as RenderEnv;
    if (!env.sourceLines) return;
    const offset = env.lineOffset ?? 0;
    let inFootnotes = 0;
    for (const token of state.tokens) {
      if (token.type === 'footnote_block_open') inFootnotes++;
      else if (token.type === 'footnote_block_close') inFootnotes--;
      else if (!inFootnotes && token.map && (token.nesting === 1 || token.type === 'hr')) {
        token.attrSet('data-line', String(token.map[0] + offset));
        token.attrSet('data-line-end', String(token.map[1] + offset));
      }
    }
  });
}

/**
 * markdown-it `maxNesting` (D-07). 10000 was tried first, but markdown-it's
 * recursive block parser overflows the JS stack at about 1850 nested
 * blockquotes or link labels (about 925 list levels, a list level counts 2).
 * 1000 keeps a safety margin; deeper content is rendered as text, as with
 * markdown-it's default of 100. See the README.
 */
export const MAX_NESTING = 1000;

export function createMarkdownIt(prefs: RenderPreferences): MarkdownIt {
  const md = markdownit({
    html: true, // F-135: raw HTML is never escaped or skipped.
    xhtmlOut: false, // §6.2: `<hr>`, `<br>` without '/'.
    linkify: false, // F-113 uses the Hoedown autolink port instead (autolinkPlugin).
    breaks: prefs.htmlHardWrap, // F-134
    typographer: false, // F-120 is the Hoedown SmartyPants port (smartypants.ts).
    // D-07, §6.1 step 2: MacDown passes SIZE_MAX (unlimited nesting). markdown-it
    // needs a finite value; MAX_NESTING is far beyond realistic documents and
    // stays below the depth at which its recursive parser overflows the stack.
    maxNesting: MAX_NESTING,
  });
  if (!prefs.extensionTables) md.disable('table'); // F-111
  if (!prefs.extensionFencedCode) md.disable('fence'); // F-112
  else hoedownFencePlugin(md);
  if (!prefs.extensionStrikethough) md.disable('strikethrough'); // F-114
  // F-113 (D-05): Hoedown's autolink rules (scheme URLs, `www.`, e-mail).
  if (prefs.extensionAutolink) autolinkPlugin(md);
  if (prefs.extensionHighlight) md.use(mark); // F-116 `==x==` → <mark>
  if (prefs.extensionFootnotes) {
    md.use(footnote); // F-117
    md.use(hoedownFootnotes);
  }
  intraEmphasisPlugin(md, prefs.extensionIntraEmphasis); // F-121
  if (prefs.extensionUnderline) underlinePlugin(md); // F-115
  if (prefs.extensionSuperscript) superscriptPlugin(md); // F-118
  if (prefs.extensionQuote) quotePlugin(md); // F-119
  if (prefs.htmlMathJax) mathPlugin(md, prefs.htmlMathJaxInlineDollar); // F-130, F-131
  if (prefs.htmlTaskList) taskListPlugin(md); // F-132

  // Hoedown emits <del> for ~~x~~; markdown-it emits <s>.
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  md.renderer.rules.quote_open = () => '<q>';
  md.renderer.rules.quote_close = () => '</q>';

  md.renderer.rules.fence = (tokens, idx, _o, env) => renderCodeBlock(tokens[idx].content, tokens[idx].info, prefs, env as RenderEnv, tokens[idx].map);
  md.renderer.rules.code_block = (tokens, idx, _o, env) => renderCodeBlock(tokens[idx].content, '', prefs, env as RenderEnv, tokens[idx].map);

  md.use(headerIdsPlugin);
  md.use(sourceLinesPlugin);
  return md;
}

const cache = new Map<string, MarkdownIt>();

function instanceFor(prefs: RenderPreferences): MarkdownIt {
  const key = INSTANCE_KEYS.map((k) => String(prefs[k])).join('|');
  let md = cache.get(key);
  if (!md) {
    md = createMarkdownIt(prefs);
    cache.set(key, md);
  }
  return md;
}

export interface ParseResult {
  /** Body HTML (`renderer.currentHtml`): what the preview shows and Copy HTML copies. */
  body: string;
  /** Languages used by code blocks, dependencies first (Prism load order). */
  languages: string[];
  /** Front matter value (first YAML document), when P-28 found one. */
  frontMatter?: unknown;
}

export interface ParseOptions {
  /** F-11: mark blocks with their source lines (the preview; not Copy HTML or export). */
  sourceLines?: boolean;
}

/** The full parse of spec §6.1, steps 1 to 5. */
export function parseMarkdown(markdown: string, prefs: RenderPreferences, options: ParseOptions = {}): ParseResult {
  let frontMatter: ReturnType<typeof detectFrontMatter> = null;
  let lineOffset = 0;
  if (prefs.htmlDetectFrontMatter) {
    frontMatter = detectFrontMatter(markdown);
    if (frontMatter) {
      lineOffset = markdown.slice(0, frontMatter.length).split('\n').length - 1;
      markdown = markdown.slice(frontMatter.length);
    }
  }
  const md = instanceFor(prefs);
  const env: RenderEnv = { languages: [], sourceLines: options.sourceLines, lineOffset };
  const tokens = md.parse(markdown, env);
  let html = md.renderer.render(tokens, md.options, env);
  if (prefs.extensionSmartyPants) html = smartypants(html);
  if (prefs.htmlRendersTOC) html = insertToc(html, renderToc(collectHeaders(md, tokens, env)));
  if (frontMatter) {
    let table = htmlTable(frontMatter.value);
    if (options.sourceLines) table = table.replace(/^<table/, `<table data-line="0" data-line-end="${lineOffset + 1}"`);
    html = `${table}\n${html}`;
  }
  return { body: html, languages: env.languages, frontMatter: frontMatter?.value };
}

/**
 * Renders Markdown to the body HTML (`renderer.currentHtml` in the original:
 * no template, CSS or scripts). This is also what Copy HTML (F-39) copies.
 */
export function renderMarkdown(markdown: string, prefs: RenderPreferences): string {
  return parseMarkdown(markdown, prefs).body;
}
