import type { MacDownPreferences } from '../prefs/defaults';
import { parseMarkdown } from './markdown';
import { getStyleCss } from './styles';
import { inlineStyleTag, renderTemplate } from './template';
import { extraStyles, scriptIds, type ScriptId } from './assets';

export { renderMarkdown, parseMarkdown, createMarkdownIt, renderCodeBlock, mapLanguage, addToLanguages } from './markdown';
export { renderTemplate, inlineStyleTag, linkStyleTag, inlineScriptTag, linkScriptTag } from './template';
export { STYLE_NAMES, getStyleCss, styleNames } from './styles';
export { PRISM_THEME_NAMES, prismThemeFile, extraStyles, scriptIds, type ScriptId } from './assets';
export { countText, wordCountLabel, type TextCount } from './wordCount';
export { smartypants } from './smartypants';
export { runPreviewScripts } from './postprocess';

export interface RenderResult {
  /** Body HTML only (what Copy HTML copies, F-39). */
  body: string;
  /**
   * Full preview page from the template (§7.4) with the style tags of §6.10.
   * Script tags are not written into the preview page: the scripts listed in
   * `scripts` run from the app window instead (postprocess.ts).
   */
  html: string;
  /** Style asset ids in inclusion order (§6.10), for tests and export. */
  styles: string[];
  /** Script asset ids in inclusion order (§6.10). */
  scripts: ScriptId[];
  /** Languages used by code blocks (`currentLanguages`), dependencies first. */
  languages: string[];
  /** Front matter value (P-28), when present. */
  frontMatter?: unknown;
}

export interface RenderOptions {
  title?: string;
  /** F-11: mark blocks with their source lines (`data-line`), for scroll sync in the preview. */
  sourceLines?: boolean;
}

/**
 * The full pipeline of spec §6.1: Markdown → body → template, with the style
 * order of §6.10: base style (P-19c; none for the empty "no style" item,
 * F-166) → Prism theme, line-numbers, show-language (P-20) → Mermaid CSS
 * → show-information.css (P-23 = Custom).
 */
export function renderDocument(
  markdown: string,
  prefs: MacDownPreferences,
  options: RenderOptions = {},
): RenderResult {
  const parsed = parseMarkdown(markdown, prefs, { sourceLines: options.sourceLines });
  const styleTags: string[] = [];
  const styles: string[] = [];
  const css = getStyleCss(prefs.htmlStyleName);
  if (css) {
    styleTags.push(inlineStyleTag(css));
    styles.push(`style:${prefs.htmlStyleName}`);
  }
  for (const s of extraStyles(prefs)) {
    styleTags.push(inlineStyleTag(s.css));
    styles.push(s.id);
  }
  const html = renderTemplate({ title: options.title, styleTags, body: parsed.body, scriptTags: [] });
  return {
    body: parsed.body,
    html,
    styles,
    scripts: scriptIds(prefs, parsed.languages),
    languages: parsed.languages,
    frontMatter: parsed.frontMatter,
  };
}
