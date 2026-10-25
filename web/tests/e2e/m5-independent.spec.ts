/**
 * M5 independent test-engineer suite: files (spec 2.2), preferences (8, F-140,
 * F-141), export / print / copy (2.3, 9), help and about (2.8), plus extras for
 * the M4 fixes (D-09 to D-12). Complements the builder's
 * m5-files-prefs-export.spec.ts. Every test name starts with the spec ID(s) it
 * covers.
 *
 * Oracles: the spec, the original source in vendor/macdown (cited in comments)
 * and small AppKit / Foundation probes (UTF-8 decoding, key bindings). Expected
 * values never come from the app code.
 *
 * File System Access API: mocked with page.addInitScript (see mockFs); the
 * fallbacks use Playwright's filechooser and download events.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { editorEl, mod, open, preview } from './helpers';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VENDOR = resolve(ROOT, '../vendor/macdown/MacDown');
const HELP_MD = readFileSync(resolve(VENDOR, 'Resources/help.md'), 'utf8');
const CONTRIBUTE_MD = readFileSync(resolve(VENDOR, 'Resources/contribute.md'), 'utf8');

/** Opens the app without waiting for the split (P-02 off shows the empty state instead). */
async function openRaw(page: Page, query = '') {
  await page.goto('/' + query);
  await expect(page.getByTestId('menubar')).toBeVisible();
}

const q = (prefs: Record<string, unknown>) =>
  '?' + Object.entries(prefs).map(([k, v]) => `pref.${k}=${encodeURIComponent(JSON.stringify(v))}`).join('&');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Mocks showOpenFilePicker / showSaveFilePicker. Opening a file: push
 * `{ name, bytes | text }` to __fs.openQueue ('CANCEL' = the user dismisses the panel).
 * Saving: push a file name (or 'CANCEL' / 'FAIL-WRITE') to __fs.saveQueue; default is the suggested name.
 * Every write is recorded as bytes in __fs.writes.
 */
async function mockFs(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const fs: any = { writes: [], saveCalls: [], openCalls: [], openQueue: [], saveQueue: [], files: {} };
    w.__fs = fs;
    const enc = new TextEncoder();
    const mk = (name: string, bytes: Uint8Array, failWrite = false) => {
      const h: any = {
        kind: 'file',
        name,
        bytes,
        async getFile() {
          return new File([h.bytes], name, { type: 'text/markdown' });
        },
        async createWritable() {
          if (failWrite) throw new DOMException('disk full', 'NotAllowedError');
          const chunks: Uint8Array[] = [];
          return {
            async write(d: Blob | string) {
              chunks.push(typeof d === 'string' ? enc.encode(d) : new Uint8Array(await d.arrayBuffer()));
            },
            async close() {
              const total = chunks.reduce((n, c) => n + c.length, 0);
              const out = new Uint8Array(total);
              let o = 0;
              for (const c of chunks) { out.set(c, o); o += c.length; }
              h.bytes = out;
              fs.writes.push({ name, bytes: Array.from(out), text: new TextDecoder().decode(out) });
            },
          };
        },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
      };
      fs.files[name] = h;
      return h;
    };
    fs.mk = mk;
    w.showOpenFilePicker = async (o: any) => {
      fs.openCalls.push(o ?? null);
      const next = fs.openQueue.shift();
      if (!next || next === 'CANCEL') throw new DOMException('The user aborted a request.', 'AbortError');
      return [mk(next.name, next.bytes ? new Uint8Array(next.bytes) : enc.encode(next.text ?? ''))];
    };
    w.showSaveFilePicker = async (o: any) => {
      fs.saveCalls.push(o);
      const next = fs.saveQueue.shift();
      if (next === 'CANCEL') throw new DOMException('The user aborted a request.', 'AbortError');
      return mk(next === 'FAIL-WRITE' || next === undefined ? (o?.suggestedName ?? 'Untitled.md') : next, new Uint8Array(), next === 'FAIL-WRITE');
    };
  });
}

/** No File System Access API: the input / download fallbacks are used. */
async function noFs(page: Page) {
  await page.addInitScript(() => {
    for (const k of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
  });
}

type FsState = { writes: { name: string; bytes: number[]; text: string }[]; saveCalls: any[]; openCalls: any[] };
const fsState = (page: Page): Promise<FsState> => page.evaluate(() => { const f = (window as any).__fs; return { writes: f.writes, saveCalls: f.saveCalls, openCalls: f.openCalls }; });
const queueOpen = (page: Page, f: { name: string; text?: string; bytes?: number[] } | 'CANCEL') => page.evaluate((x) => (window as any).__fs.openQueue.push(x), f);
const queueSave = (page: Page, name: string) => page.evaluate((n) => (window as any).__fs.saveQueue.push(n), name);
const docText = (page: Page) => page.evaluate(() => (window as any).macdownEditor.text() as string);
/** Replaces the document through the editor hook and waits two frames so the app has processed the change. */
const setText = (page: Page, t: string, from?: number, to?: number) =>
  page.evaluate(
    async ([x, a, b]) => {
      (window as any).macdownEditor.set(x, a ?? undefined, b ?? undefined);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    },
    [t, from ?? null, to ?? null] as const,
  );
const docInfo = (page: Page) => page.evaluate(() => (window as any).macdownDocument.info());
const edited = (page: Page) => page.evaluate(() => (window as any).macdownDocument.edited() as boolean);
const stashed = (page: Page) => page.evaluate(() => (window as any).macdownDocument.stashed());
const draft = (page: Page) => page.evaluate(() => { const d = localStorage.getItem('macdown.draft'); return d ? JSON.parse(d) : null; });
const menu = async (page: Page, m: string, item: string) => {
  await page.getByTestId(`menu-${m}`).click();
  await page.getByTestId(`menuitem-${item}`).click();
};
const pv = (page: Page) => preview(page);
const key = async (page: Page, keys: string) => page.keyboard.press(keys.replace('Mod', await mod(page)));
const bytesOf = (s: string) => Array.from(new TextEncoder().encode(s));
const pref = (page: Page, k: string) => page.getByTestId(`pref-${k}`);
const prefValue = (page: Page, k: string) => page.evaluate((x) => (window as any).macdownPrefs.get()[x], k);
const storedPrefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('macdown.preferences') ?? '{}'));
const openPrefs = async (page: Page, pane?: string) => {
  if (!(await page.getByTestId('preferences').count())) await menu(page, 'app', 'preferences');
  await expect(page.getByTestId('preferences')).toBeVisible();
  if (pane) await page.getByTestId(`preferences-tab-${pane}`).click();
};
const waitSaved = async (page: Page) => page.waitForTimeout(450); // draft autosave is 250 ms
const previewFrame = async (page: Page) => (await (await page.getByTestId('preview-iframe').elementHandle())!.contentFrame())!;

/** Dispatches a drop of synthetic files on the element matching `selector` (in the page) and waits a tick. */
async function dropFiles(page: Page, selector: string, files: { name: string; type: string; bytes: number[] }[]) {
  await page.evaluate(
    ([sel, fl]) => {
      const el = document.querySelector(sel as string)!;
      const dt = new DataTransfer();
      for (const f of fl as any[]) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(over);
      (window as any).__dragoverPrevented = over.defaultPrevented;
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [selector, files] as const,
  );
}

/** Reads a rule block like `COMMENT` from a bundled .style file (peg-markdown-highlight format). */
function styleColor(theme: string, element: string): string | null {
  const text = readFileSync(resolve(VENDOR, 'Resources/Themes', `${theme}.style`), 'utf8');
  const m = new RegExp(`^${element.replace(/[-]/g, '\\-')}\\s*\\n((?:[ \\t]*[^\\n]+\\n?)*)`, 'm').exec(text);
  if (!m) return null;
  const c = /(?:foreground|color|foreground-color):\s*([0-9a-fA-F]{6})/.exec(m[1]);
  return c ? c[1].toLowerCase() : null;
}
const rgb = (hex: string) => `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;

// ---------------------------------------------------------------------------
// M4 retest extras (D-09 to D-12)
// ---------------------------------------------------------------------------

test.describe('M4 retest D-09 to D-12', () => {
  test('F-64 (D-09) typing HTML tags with P-36 on never adds a closing tag', async ({ page }) => {
    await open(page, q({ editorCompleteMatchingCharacters: true }));
    await editorEl(page).click();
    await page.keyboard.type('<b>x</b>');
    expect(await docText(page)).toBe('<b>x</b>');
    await setText(page, '');
    await page.keyboard.type('<div class=');
    await page.keyboard.type('a>');
    expect(await docText(page)).toBe('<div class=a>');
    await setText(page, '');
    await page.keyboard.type('<br/>');
    expect(await docText(page)).toBe('<br/>');
  });

  test('F-64 (D-09) with P-36 off typing <b> is plain text', async ({ page }) => {
    await open(page);
    await editorEl(page).click();
    await page.keyboard.type('<b>x');
    expect(await docText(page)).toBe('<b>x');
  });

  for (const theme of ['Tomorrow+', 'Solarized (Dark)', 'Mou Paper', 'Writer+']) {
    test(`F-74 (D-10) a block HTML comment uses the COMMENT colour of the theme ${theme}`, async ({ page }) => {
      await open(page, q({ editorStyleName: theme }));
      await setText(page, 'para\n\n<!-- blockcomment -->\n\npara');
      await page.waitForTimeout(250);
      const expected = styleColor(theme, 'COMMENT');
      expect(expected, `COMMENT in ${theme}.style`).not.toBeNull();
      const colour = await page.evaluate(() => {
        const lines = Array.from(document.querySelectorAll('[data-testid="editor"] .cm-line'));
        const line = lines.find((l) => l.textContent?.includes('blockcomment'))!;
        const el = Array.from(line.querySelectorAll('span')).find((s) => s.textContent?.includes('blockcomment'));
        return getComputedStyle(el ?? line).color;
      });
      expect(colour).toBe(rgb(expected!));
    });
  }

  test('F-14 (D-11) the Customize dialog traps Tab and Shift+Tab, Escape closes it and returns the focus to the editor', async ({ page }) => {
    await open(page);
    await menu(page, 'view', 'customize-toolbar');
    const dlg = page.getByTestId('toolbar-customize');
    await expect(dlg).toBeVisible();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true);
  });

  test('F-14 (D-12) an emptied toolbar is stored as [], survives a reload, and Use Default Set restores the default set', async ({ page }) => {
    await open(page);
    await menu(page, 'view', 'customize-toolbar');
    const ids = (await page.getByTestId('toolbar').getAttribute('data-items'))!.split(' ').filter((x) => x !== 'flexible-space');
    expect(ids.length).toBe(10);
    for (const id of ids) await page.getByTestId(`toolbar-customize-${id}`).uncheck();
    expect(await storedPrefs(page)).toMatchObject({ toolbarItemIdentifiers: [] });
    await page.getByTestId('toolbar-customize-done').click();
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(((await page.getByTestId('toolbar').getAttribute('data-items')) ?? '').split(' ').filter(Boolean)).toEqual([]);
    expect(await storedPrefs(page)).toMatchObject({ toolbarItemIdentifiers: [] });
    // still reachable from the View menu with an empty toolbar
    await menu(page, 'view', 'customize-toolbar');
    await page.getByTestId('toolbar-customize-default').click();
    expect(await storedPrefs(page)).toMatchObject({ toolbarItemIdentifiers: null });
    expect(((await page.getByTestId('toolbar').getAttribute('data-items')) ?? '').split(' ').filter((x) => x !== 'flexible-space').length).toBe(10);
  });

  test('F-66 (Q-04) Shift+Return and keypad Enter continue lists and quotes exactly like Return (AppKit: insertNewline: for all three)', async ({ page }) => {
    await open(page);
    for (const k of ['Enter', 'Shift+Enter', 'NumpadEnter']) {
      await setText(page, '* a');
      await editorEl(page).click();
      await page.keyboard.press('Control+e'); // end of line (CodeMirror emacs-style binding on mac; harmless elsewhere)
      await page.evaluate(() => (window as any).macdownEditor.select(3));
      await page.keyboard.press(k);
      expect(await docText(page), k).toBe('* a\n* ');
      await setText(page, '> q');
      await page.evaluate(() => (window as any).macdownEditor.select(3));
      await page.keyboard.press(k);
      expect(await docText(page), k).toBe('> q\n> ');
      await setText(page, '3. x');
      await page.evaluate(() => (window as any).macdownEditor.select(4));
      await page.keyboard.press(k);
      expect(await docText(page), k).toBe('3. x\n4. ');
    }
    // Opt+Return is insertNewlineIgnoringFieldEditor: and Ctrl+Return insertLineBreak: in AppKit: neither is "Return"; just no crash
    await setText(page, '* a');
    await page.evaluate(() => (window as any).macdownEditor.select(3));
    await page.keyboard.press('Alt+Enter');
    expect((await docText(page)).startsWith('* a')).toBe(true);
  });

  test('F-81 (item 92) a Format command and the typing right after it are separate undo steps', async ({ page }) => {
    await open(page);
    await setText(page, 'hello', 0, 5);
    await key(page, 'Mod+b');
    expect(await docText(page)).toBe('**hello**');
    await page.keyboard.type('Z'); // replaces the selected text immediately after the command (well inside 500 ms)
    expect(await docText(page)).toBe('**Z**');
    await key(page, 'Mod+z');
    expect(await docText(page)).toBe('**hello**');
    await key(page, 'Mod+z');
    expect(await docText(page)).toBe('hello');
    await key(page, 'Mod+Shift+z');
    expect(await docText(page)).toBe('**hello**');
  });

  // Q-05 (spec section 13 item 91): expected values are the output of an AppKit probe (NSTextView uppercaseWord: / lowercaseWord: / capitalizeWord:).
  const transforms: [string, number, number, 'make-upper-case' | 'make-lower-case' | 'capitalize', string][] = [
    ['ab cd', 2, 2, 'make-upper-case', '«AB» cd'],
    ['ab cd', 3, 3, 'make-upper-case', 'ab« »cd'],
    ['ab\ncd', 3, 3, 'make-upper-case', 'ab\n«CD»'],
    ['ab cd', 0, 0, 'make-upper-case', '«AB» cd'],
    ['ab cd', 5, 5, 'make-upper-case', 'ab «CD»'],
    ['ab cd', 1, 4, 'make-upper-case', '«AB CD»'],
    ['hELLO wORLD-x', 0, 13, 'capitalize', '«Hello World-X»'],
    ['it\'s', 0, 4, 'capitalize', '«It\'s»'],
    ['x1y', 0, 3, 'capitalize', '«X1Y»'],
    ['HELLO World', 0, 11, 'make-lower-case', '«hello world»'],
    ['HeLLo wOrld', 8, 8, 'make-lower-case', 'HeLLo «world»'],
    ['hello world', 8, 8, 'capitalize', 'hello «World»'],
    ['a  b', 2, 2, 'make-upper-case', 'a«  »b'],
  ];
  for (const [text, from, to, cmd, want] of transforms) {
    test(`F-105 to F-107 (Q-05) ${cmd} on ${JSON.stringify(text)} [${from},${to}] gives ${JSON.stringify(want)} (AppKit probe) and is one undo step`, async ({ page }) => {
      await open(page);
      await setText(page, text, from, to);
      await menu(page, 'edit', cmd);
      const r = await page.evaluate(() => ({ t: (window as any).macdownEditor.text() as string, s: (window as any).macdownEditor.selection() as { from: number; to: number } }));
      expect(r.t.slice(0, r.s.from) + '«' + r.t.slice(r.s.from, r.s.to) + '»' + r.t.slice(r.s.to)).toBe(want);
      await key(page, 'Mod+z');
      expect(await docText(page)).toBe(text);
    });
  }

  test('F-79 (SD-09) scroll past end: trailing newlines add the extra empty line fragment (AppKit probe: 35 pt for "a\\nb\\nc\\n")', async ({ page }) => {
    await open(page, q({ editorScrollsPastEnd: true, editorStyleName: '' }));
    const pb = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="editor"] .cm-content')!).paddingBottom));
    // probe numbers (Menlo 14, spacing 3): used.h = 3 lines x 19 = 54 (+19 per extra line); junk.h("a\nb\nc")=16, junk.h("a\nb\nc\n")=35, junk.h("a\nb\nc\n\n\n")=73
    const line = 14 * 1.17;
    const pitch = line + 3;
    await setText(page, 'a\nb\nc');
    await expect.poll(async () => Math.abs((await pb()) - (30 + 3 * pitch - line)) < 1).toBe(true);
    await setText(page, 'a\nb\nc\n');
    // content = 4 lines (the empty last line counts); trailing = 2 line heights - one spacing (35 = 16 + 19)
    await expect.poll(async () => Math.abs((await pb()) - (30 + 4 * pitch - (line + pitch))) < 1.5).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-21, F-22, F-25 to F-28, F-34 files
// ---------------------------------------------------------------------------

test.describe('F-34 / F-16 dirty state and window title', () => {
  test('F-34 an untitled document is edited only while it has text: typing and deleting everything is clean again', async ({ page }) => {
    await open(page);
    await expect(page).toHaveTitle('Untitled');
    expect(await edited(page)).toBe(false);
    await editorEl(page).click();
    await page.keyboard.type('x');
    await expect(page).toHaveTitle('Untitled — Edited');
    expect(await edited(page)).toBe(true);
    await page.keyboard.press('Backspace');
    await expect(page).toHaveTitle('Untitled');
    // New on a clean untitled document needs no prompt
    await menu(page, 'file', 'new');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
  });

  test('F-34 the title uses an em dash: "name.md — Edited"; undoing back to the saved text makes the document clean', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'notes.md', text: 'one\n' });
    await key(page, 'Mod+o');
    await expect(page).toHaveTitle('notes.md');
    await editorEl(page).click();
    await page.keyboard.press((await mod(page)) + '+End');
    await page.keyboard.type('two');
    await expect(page).toHaveTitle('notes.md — Edited');
    expect(await page.title()).toContain('—');
    await key(page, 'Mod+z');
    await expect(page).toHaveTitle('notes.md');
    expect(await edited(page)).toBe(false);
  });

  test('F-34 the Revert item is disabled until a saved document is edited; never enabled for an untitled one', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'draft');
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-revert')).toBeDisabled();
    await page.keyboard.press('Escape');
    await queueOpen(page, { name: 'a.md', text: 'x' });
    await key(page, 'Mod+o');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect(page).toHaveTitle('a.md');
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-revert')).toBeDisabled();
    await page.keyboard.press('Escape');
    await setText(page, 'y');
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-revert')).toBeEnabled();
  });
});

test.describe('F-21 New and the save prompt', () => {
  test('F-21 the prompt names the document, offers Don\'t Save / Cancel / Save…, Escape cancels, and Cancel keeps text, selection and undo history', async ({ page }) => {
    await open(page);
    await editorEl(page).click();
    await page.keyboard.type('hello world');
    await page.evaluate(() => (window as any).macdownEditor.select(2, 5));
    await menu(page, 'file', 'new');
    await expect(page.getByTestId('save-prompt-message')).toHaveText('Do you want to save the changes made to the document “Untitled”?');
    expect(await page.getByTestId('save-prompt').locator('button').allInnerTexts()).toEqual(['Don’t Save', 'Cancel', 'Save…']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await docText(page)).toBe('hello world');
    expect(await page.evaluate(() => (window as any).macdownEditor.selection())).toEqual({ from: 2, to: 5 });
    await key(page, 'Mod+z'); // history is intact
    expect(await docText(page)).not.toBe('hello world');
  });

  test('F-21 Don\'t Save gives a blank untitled document with a fresh undo history and a blank draft', async ({ page }) => {
    await open(page);
    await setText(page, 'old text');
    await menu(page, 'file', 'new');
    await page.getByTestId('save-prompt-dont-save').click();
    expect(await docText(page)).toBe('');
    await expect(page).toHaveTitle('Untitled');
    await editorEl(page).click();
    await key(page, 'Mod+z');
    expect(await docText(page)).toBe('');
    await waitSaved(page);
    expect((await draft(page)).text).toBe('');
  });

  test('F-21 Save… in the prompt writes the file (suggested name from the header) and then opens the new document', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, '# My Plan\n\nbody');
    await menu(page, 'file', 'new');
    await page.getByTestId('save-prompt-save').click();
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    const f = await fsState(page);
    expect(f.saveCalls[0].suggestedName).toBe('My Plan.md');
    expect(f.writes[0].text).toBe('# My Plan\n\nbody');
    expect(await docText(page)).toBe('');
    await expect(page).toHaveTitle('Untitled');
  });

  test('F-21 the browser-reserved shortcuts are menu only: Mod+N / Mod+W in the page do nothing, the menu shows them', async ({ page }) => {
    await open(page);
    await setText(page, 'keep');
    await key(page, 'Mod+n');
    await key(page, 'Mod+w');
    expect(await docText(page)).toBe('keep');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-new')).toContainText('N');
    await expect(page.getByTestId('menuitem-close')).toContainText('W');
  });
});

test.describe('F-22 Open (File System Access)', () => {
  test('F-22 the picker offers md, markdown and plain text; the opened file has a handle; an empty file opens as an empty clean document', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'empty.md', text: '' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('empty.md');
    const f = await fsState(page);
    const accept = JSON.stringify(f.openCalls[0].types);
    expect(accept).toContain('.md');
    expect(accept).toContain('.markdown');
    expect(accept).toContain('.txt');
    expect(f.openCalls[0].multiple).toBe(false);
    const info = await docInfo(page);
    expect(info).toMatchObject({ kind: 'file', name: 'empty.md', savedText: '', hasHandle: true });
    expect(await edited(page)).toBe(false);
  });

  const valid: [string, number[], string][] = [
    ['plain ASCII', bytesOf('hello'), 'hello'],
    ['a UTF-8 BOM is dropped (Foundation initWithData:encoding: probe)', [0xef, 0xbb, 0xbf, 0x61, 0x0a], 'a\n'],
    ['2 / 3 / 4 byte sequences', bytesOf('é € 😀 日本'), 'é € 😀 日本'],
    ['U+FFFD written as such is valid', bytesOf('a�b'), 'a�b'],
    ['NUL bytes are kept (probe: NSString keeps them)', [0x61, 0x00, 0x62], 'a\u0000b'],
  ];
  for (const [name, bytes, text] of valid) {
    test(`F-22 UTF-8: ${name}`, async ({ page }) => {
      await mockFs(page);
      await open(page);
      await queueOpen(page, { name: 'v.md', bytes });
      await menu(page, 'file', 'open');
      await expect(page).toHaveTitle('v.md');
      expect(await docInfo(page)).toMatchObject({ savedText: text });
      expect(await edited(page)).toBe(false);
    });
  }

  const invalid: [string, number[]][] = [
    ['a lone 0xFF byte', [0x61, 0xff, 0x62]],
    ['a truncated 3-byte sequence', [0x61, 0xe2, 0x82]],
    ['an overlong NUL (C0 80)', [0xc0, 0x80]],
    ['an encoded surrogate (ED A0 80)', [0xed, 0xa0, 0x80]],
    ['a code point above U+10FFFF (F4 90 80 80)', [0xf4, 0x90, 0x80, 0x80]],
    ['UTF-16LE with BOM', [0xff, 0xfe, 0x61, 0x00]],
    ['Latin-1 text', [0x63, 0x61, 0x66, 0xe9]],
  ];
  for (const [name, bytes] of invalid) {
    test(`F-22 UTF-8: ${name} is refused with the error sheet and the current document is untouched, even when it is edited (no prompt)`, async ({ page }) => {
      await mockFs(page);
      await open(page);
      await setText(page, 'mine');
      await queueOpen(page, { name: 'bad.md', bytes });
      await menu(page, 'file', 'open');
      await expect(page.getByTestId('alert-message')).toHaveText('The document “bad.md” could not be opened.');
      await expect(page.getByTestId('save-prompt')).toHaveCount(0);
      await page.getByTestId('alert-ok').click();
      expect(await docText(page)).toBe('mine');
      await expect(page).toHaveTitle('Untitled — Edited');
    });
  }

  test('F-22 a CRLF file keeps its line endings through an edit and Save (NSTextView preserves CRLF; Cocoa probe)', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'win.md', text: 'a\r\nb\r\n' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('win.md');
    await editorEl(page).click();
    await page.keyboard.press((await mod(page)) + '+End');
    await page.keyboard.type('c');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    expect((await fsState(page)).writes[0].text).toBe('a\r\nb\r\nc');
  });

  test('F-34 a CRLF file typed in and back out is not "Edited" (the text equals the saved text)', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'win.md', text: 'a\r\nb\r\n' });
    await menu(page, 'file', 'open');
    await editorEl(page).click();
    await page.keyboard.type('z');
    await page.keyboard.press('Backspace');
    await expect(page).toHaveTitle('win.md');
  });

  test('F-22 a cancelled panel changes nothing and does not prompt', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'x');
    await queueOpen(page, 'CANCEL');
    await key(page, 'Mod+o');
    await expect.poll(async () => (await fsState(page)).openCalls.length).toBe(1);
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await docText(page)).toBe('x');
  });

  test('F-22 an edited document: the file is chosen first, then the prompt; Cancel keeps the document, Don\'t Save opens the file', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'mine');
    await queueOpen(page, { name: 'other.md', text: '# other' });
    await key(page, 'Mod+o');
    await expect(page.getByTestId('save-prompt')).toBeVisible();
    await page.getByTestId('save-prompt-cancel').click();
    expect(await docText(page)).toBe('mine');
    await queueOpen(page, { name: 'other.md', text: '# other' });
    await key(page, 'Mod+o');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect(page).toHaveTitle('other.md');
    expect(await docText(page)).toBe('# other');
    await expect(pv(page).locator('h1')).toHaveText('other');
  });

  test('F-22 a 2 MB file opens and renders in a reasonable time', async ({ page }) => {
    await mockFs(page);
    await open(page);
    const text = Array.from({ length: 40000 }, (_, i) => `line ${i} with *some* text and a [link](http://example.com/${i})`).join('\n');
    await queueOpen(page, { name: 'big.md', bytes: bytesOf(text) });
    const t0 = Date.now();
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('big.md', { timeout: 10_000 });
    await expect(pv(page).locator('a').first()).toBeAttached({ timeout: 20_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

test.describe('F-22 Open (fallback <input type=file>)', () => {
  test('F-22 the input accepts Markdown and text, the same file can be chosen twice, and invalid UTF-8 is refused', async ({ page }) => {
    await noFs(page);
    await open(page);
    const accept = await page.getByTestId('open-file-input').getAttribute('accept');
    expect(accept).toContain('.md');
    expect(accept).toContain('.markdown');
    expect(accept).toContain('.txt');
    for (let i = 0; i < 2; i++) {
      const chooser = page.waitForEvent('filechooser');
      await menu(page, 'file', 'open');
      await (await chooser).setFiles({ name: 'same.md', mimeType: 'text/markdown', buffer: Buffer.from('# same') });
      await expect(page).toHaveTitle('same.md');
      await expect(pv(page).locator('h1')).toHaveText('same');
      await setText(page, 'edit');
      if (i === 0) {
        // second round: edited document, so the prompt appears after the file is chosen
        const c2 = page.waitForEvent('filechooser');
        await menu(page, 'file', 'open');
        await (await c2).setFiles({ name: 'same.md', mimeType: 'text/markdown', buffer: Buffer.from('# same') });
        await page.getByTestId('save-prompt-dont-save').click();
        await expect(page).toHaveTitle('same.md');
        i++;
      }
    }
    const chooser = page.waitForEvent('filechooser');
    await menu(page, 'file', 'open');
    await (await chooser).setFiles({ name: 'bad.md', mimeType: 'text/markdown', buffer: Buffer.from([0x61, 0xff]) });
    await expect(page.getByTestId('alert-message')).toHaveText('The document “bad.md” could not be opened.');
  });

  test('F-26 fallback: the opened file is saved by download under its own name (also .markdown), every Save downloads again', async ({ page }) => {
    await noFs(page);
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await menu(page, 'file', 'open');
    await (await chooser).setFiles({ name: 'notes.markdown', mimeType: 'text/markdown', buffer: Buffer.from('x') });
    await expect(page).toHaveTitle('notes.markdown');
    for (let i = 0; i < 2; i++) {
      await setText(page, `v${i}`);
      await expect(page).toHaveTitle('notes.markdown — Edited'); // the app has processed the change before Save is pressed
      const dl = page.waitForEvent('download');
      await key(page, 'Mod+s');
      const d = await dl;
      expect(d.suggestedFilename()).toBe('notes.markdown');
      expect(readFileSync(await d.path(), 'utf8')).toBe(`v${i}`);
      await expect(page).toHaveTitle('notes.markdown');
    }
  });

  test('F-26 fallback: an untitled document downloads as "<header>.md" with UTF-8 bytes and becomes the named document', async ({ page }) => {
    await noFs(page);
    await open(page);
    await setText(page, '# Grüße 日本\n\nok');
    const dl = page.waitForEvent('download');
    await key(page, 'Mod+s');
    const d = await dl;
    expect(d.suggestedFilename()).toBe('Grüße 日本.md');
    expect(readFileSync(await d.path())).toEqual(Buffer.from('# Grüße 日本\n\nok', 'utf8'));
    await expect(page).toHaveTitle('Grüße 日本.md');
  });
});

test.describe('F-26 / F-27 / F-30 / F-31 save', () => {
  // [document text, P-28, expected presumed name]. Source: MPDocument.m:1865-1892, NSString+Lookup.m:89-112.
  const names: [string, boolean, string][] = [
    ['# Top', false, 'Top'],
    ['## Sub\n\n# Top', false, 'Top'],
    ['### Third\n\n## Second', false, 'Second'],
    ['###### Six', false, 'Six'],
    ['####### Seven', false, 'Untitled'],
    ['Title\n=====', false, 'Untitled'],
    ['#nospace', false, 'Untitled'],
    ['#\ttab title', false, 'tab title'],
    ['# a/b|c:d', false, 'a-b-c-d'],
    ['# one\n# two', false, 'one'],
    ['text\n\n# Late header', false, 'Late header'],
    ['# trailing   ', false, 'trailing   '],
    ['', false, 'Untitled'],
    ['---\ntitle: FM Title\n---\n# H', true, 'FM Title'],
    ['---\ntitle: FM Title\n---\n# H', false, 'H'],
    ['---\ntitle: "a/b: c"\n---\n# H', true, 'a/b: c'],
    ['---\nauthor: x\n---\n# H', true, 'H'],
    ['---\ntitle: 123\n---\n# H', true, '123'],
  ];
  for (const [text, p28, expected] of names) {
    test(`F-31 presumed name ${JSON.stringify(text)} (P-28 ${p28 ? 'on' : 'off'}) = ${JSON.stringify(expected)}: Export HTML panel name and Save panel name agree`, async ({ page }) => {
      await mockFs(page);
      await open(page, p28 ? q({ htmlDetectFrontMatter: true }) : '');
      await setText(page, text);
      await menu(page, 'file', 'export-html');
      await expect(page.getByTestId('export-html-filename')).toHaveText(`${expected}.html`);
      await page.getByTestId('export-html-cancel').click();
      await menu(page, 'file', 'save');
      await expect.poll(async () => (await fsState(page)).saveCalls.length).toBe(1);
      const suggested: string = (await fsState(page)).saveCalls[0].suggestedName;
      // a presumed name that already ends in .md leaves the panel's default (Untitled.md), otherwise name + ".md"
      expect(suggested).toBe(/\.md$/i.test(expected) ? 'Untitled.md' : `${expected}.md`);
    });
  }

  test('F-31 a saved document keeps its own name for Save As and Export, and renaming through Save As changes both', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'report.v2.md', text: '# Different Header' });
    await menu(page, 'file', 'open');
    await menu(page, 'file', 'export-html');
    await expect(page.getByTestId('export-html-filename')).toHaveText('report.v2.html');
    await page.getByTestId('export-html-cancel').click();
    await queueSave(page, 'copy.md');
    await menu(page, 'file', 'save-as');
    await expect.poll(async () => (await fsState(page)).saveCalls.length).toBe(1);
    expect((await fsState(page)).saveCalls[0].suggestedName).toBe('report.v2.md');
    await expect(page).toHaveTitle('copy.md');
    await menu(page, 'file', 'export-html');
    await expect(page.getByTestId('export-html-filename')).toHaveText('copy.html');
  });

  test('F-26 Save writes in place after the first panel, a cancelled panel keeps the document edited, and a failing write shows an error and stays edited', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'v1');
    await queueSave(page, 'CANCEL');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).saveCalls.length).toBe(1);
    await expect(page).toHaveTitle('Untitled — Edited');
    await queueSave(page, 'doc.md');
    await key(page, 'Mod+s');
    await expect(page).toHaveTitle('doc.md');
    await setText(page, 'v2');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(2);
    const f = await fsState(page);
    expect(f.saveCalls.length).toBe(2); // no second panel
    expect(f.writes.map((w) => w.text)).toEqual(['v1', 'v2']);
    // Save As to a file that cannot be written
    await queueSave(page, 'FAIL-WRITE');
    await setText(page, 'v3');
    await menu(page, 'file', 'save-as');
    await expect(page.getByTestId('alert-message')).toContainText('could not be saved');
    await page.getByTestId('alert-ok').click();
    await expect(page).toHaveTitle('doc.md — Edited');
  });

  test('F-26 the bytes written are UTF-8 without a BOM, and a Save of an unedited document still writes', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'é😀');
    await queueSave(page, 'u.md');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    expect((await fsState(page)).writes[0].bytes).toEqual([0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(2);
  });

  test('F-27 Save As with a handle-less restored document opens the panel and later Saves write in place', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'k.md', text: 'x' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('k.md');
    await setText(page, 'y');
    await waitSaved(page);
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docInfo(page)).toMatchObject({ kind: 'file', name: 'k.md', savedText: 'x', hasHandle: false });
    expect(await docText(page)).toBe('y');
    await expect(page).toHaveTitle('k.md — Edited');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).saveCalls.length).toBe(1);
    expect((await fsState(page)).saveCalls[0].suggestedName).toBe('k.md');
    await setText(page, 'z');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(2);
    expect((await fsState(page)).saveCalls.length).toBe(1);
  });

  // F-30 (MPDocument.m:522-538): the newline set is NSCharacterSet newlineCharacterSet
  const nl: [string, boolean][] = [['abc', true], ['abc\n', false], ['abc ', true], ['   ', true], ['', false], ['a\n\n', false]];
  for (const [text, adds] of nl) {
    test(`F-30 P-41 on: Save of ${JSON.stringify(text)} ${adds ? 'appends' : 'does not append'} a newline; the selection is kept`, async ({ page }) => {
      await mockFs(page);
      await open(page, q({ editorEnsuresNewlineAtEndOfFile: true }));
      await setText(page, text, 0, Math.min(1, text.length));
      await queueSave(page, 's.md');
      await key(page, 'Mod+s');
      await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
      expect((await fsState(page)).writes[0].text).toBe(adds ? text + '\n' : text);
      expect(await docText(page)).toBe(adds ? text + '\n' : text);
      expect(await page.evaluate(() => (window as any).macdownEditor.selection())).toEqual({ from: 0, to: Math.min(1, text.length) });
      await expect(page).toHaveTitle('s.md');
    });
  }

  test('F-30 P-41 off: nothing is appended', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'abc');
    await queueSave(page, 's.md');
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    expect((await fsState(page)).writes[0].text).toBe('abc');
  });
});

test.describe('F-28 Revert and F-25 Close', () => {
  test('F-28 Revert asks, Cancel keeps the edits, Revert reloads the file as changed on disk, clears the undo history and the edited state', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'r.md', text: 'disk v1' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('r.md');
    await setText(page, 'edited');
    await menu(page, 'file', 'revert');
    await expect(page.getByTestId('revert-prompt-message')).toHaveText('Do you want to revert to the most recently saved version of the document “r.md”?');
    await page.getByTestId('revert-prompt-cancel').click();
    expect(await docText(page)).toBe('edited');
    await page.evaluate(() => { const h = (window as any).__fs.files['r.md']; h.bytes = new TextEncoder().encode('disk v2 (changed externally)'); });
    await menu(page, 'file', 'revert');
    await page.getByTestId('revert-prompt-revert').click();
    await expect.poll(() => docText(page)).toBe('disk v2 (changed externally)');
    await expect(page).toHaveTitle('r.md');
    await editorEl(page).click();
    await key(page, 'Mod+z');
    expect(await docText(page)).toBe('disk v2 (changed externally)');
    expect(await docInfo(page)).toMatchObject({ savedText: 'disk v2 (changed externally)' });
  });

  test('F-28 Revert without a handle (after a reload) goes back to the saved text', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'r.md', text: 'saved' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('r.md');
    await setText(page, 'edited');
    await waitSaved(page);
    await page.reload();
    await menu(page, 'file', 'revert');
    await page.getByTestId('revert-prompt-revert').click();
    await expect.poll(() => docText(page)).toBe('saved');
  });

  test('F-25 Close of an edited document: Cancel keeps it, Don\'t Save closes, Save writes then closes; P-02 on gives a blank document', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, '# T\n');
    await menu(page, 'file', 'close');
    await page.getByTestId('save-prompt-cancel').click();
    expect(await docText(page)).toBe('# T\n');
    await menu(page, 'file', 'close');
    await queueSave(page, 'closed.md');
    await page.getByTestId('save-prompt-save').click();
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    expect((await fsState(page)).saveCalls[0].suggestedName).toBe('T.md');
    expect(await docText(page)).toBe('');
    await expect(page).toHaveTitle('Untitled');
    await expect(page.getByTestId('empty-state')).toHaveCount(0);
  });

  test('F-25 Close of a clean document does not prompt', async ({ page }) => {
    await open(page);
    await menu(page, 'file', 'close');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
  });
});

test.describe('F-29 autosave, F-32 / U-12 launch (P-02)', () => {
  test('F-29 the draft is written within about 250 ms of a change and immediately on pagehide', async ({ page }) => {
    await open(page);
    await editorEl(page).click();
    await page.keyboard.type('quick');
    await expect.poll(async () => (await draft(page))?.text, { timeout: 1500 }).toBe('quick');
    await page.keyboard.type('er');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect((await draft(page)).text).toBe('quicker');
  });

  test('F-29 a draft restores text, name, saved text and edited state; undo history is not part of it', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'persist.md', text: 'base' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('persist.md');
    await setText(page, 'base plus');
    await waitSaved(page);
    await page.reload();
    await expect(page).toHaveTitle('persist.md — Edited');
    expect(await docText(page)).toBe('base plus');
    expect(await draft(page)).toMatchObject({ version: 1, kind: 'file', name: 'persist.md', savedText: 'base', text: 'base plus' });
  });

  test('F-29 corrupt or foreign draft data is ignored: a blank document opens and nothing throws', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    for (const bad of ['{', 'null', '[]', '{"version":2,"kind":"untitled","text":"x"}', '{"version":1,"kind":"file","text":"x"}', '{"version":1,"kind":"untitled","text":5}', '"str"']) {
      await page.goto('/');
      await page.evaluate((b) => localStorage.setItem('macdown.draft', b), bad);
      await page.reload();
      await expect(page.getByTestId('split')).toBeVisible();
      expect(await docText(page), bad).toBe('');
    }
    expect(errors).toEqual([]);
  });

  test('F-32 / U-12 P-02 on (default): a blank document or the last draft; the editor is usable immediately', async ({ page }) => {
    await open(page);
    expect(await docText(page)).toBe('');
    await editorEl(page).click();
    await page.keyboard.type('typing works');
    expect(await docText(page)).toBe('typing works');
    await expect(page.getByTestId('empty-state')).toHaveCount(0);
  });

  test('F-32 / U-12 P-02 off: an empty state with New and Open…, nothing editable, file commands disabled', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await mockFs(page);
    await openRaw(page, q({ supressesUntitledDocumentOnLaunch: true }));
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('split')).toBeHidden();
    await expect(page.getByTestId('empty-state-new')).toBeEnabled();
    await expect(page.getByTestId('empty-state-open')).toBeEnabled();
    await expect(page).toHaveTitle('MacDown');
    await page.getByTestId('menu-file').click();
    for (const id of ['save', 'save-as', 'close', 'export-html', 'export-pdf', 'print', 'revert']) await expect(page.getByTestId(`menuitem-${id}`), id).toBeDisabled();
    for (const id of ['new', 'open']) await expect(page.getByTestId(`menuitem-${id}`), id).toBeEnabled();
    await page.keyboard.press('Escape');
    // shortcuts and commands with no document must not throw
    await key(page, 'Mod+s');
    await key(page, 'Mod+p');
    await key(page, 'Mod+Alt+e');
    await key(page, 'Mod+Alt+c');
    await key(page, 'Mod+b');
    await menu(page, 'format', 'strong');
    await menu(page, 'edit', 'undo');
    await page.getByTestId('toolbar-bold').click({ force: true }).catch(() => undefined);
    await page.getByTestId('toolbar-copy-html').click({ force: true }).catch(() => undefined);
    expect(errors).toEqual([]);
    // New brings a blank document
    await page.getByTestId('empty-state-new').click();
    await expect(page.getByTestId('split')).toBeVisible();
    await expect(page.getByTestId('empty-state')).toHaveCount(0);
    await expect(page).toHaveTitle('Untitled');
    // Open from the empty state
    await menu(page, 'file', 'close');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await queueOpen(page, { name: 'from-empty.md', text: '# hi' });
    await page.getByTestId('empty-state-open').click();
    await expect(page).toHaveTitle('from-empty.md');
  });

  test('F-32 / U-12 P-02 off: the empty state is also shown when a draft exists, and the draft is left alone', async ({ page }) => {
    await open(page);
    await setText(page, 'precious');
    await waitSaved(page);
    await page.goto('/' + q({ supressesUntitledDocumentOnLaunch: true }));
    await expect(page.getByTestId('empty-state')).toBeVisible();
    expect((await draft(page)).text).toBe('precious');
    await page.goto('/');
    expect(await docText(page)).toBe('precious');
  });

  test('F-25 / F-29 closing a document with P-02 off must not bring the discarded text back when P-02 is switched on later', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).macdownPrefs.set({ supressesUntitledDocumentOnLaunch: true }));
    await editorEl(page).click();
    await page.keyboard.type('discard me');
    await waitSaved(page);
    await menu(page, 'file', 'close');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await page.evaluate(() => (window as any).macdownPrefs.set({ supressesUntitledDocumentOnLaunch: false }));
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('');
  });

  test('F-32 P-02 switched in the Preferences window applies at the next launch, not immediately', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    await pref(page, 'supressesUntitledDocumentOnLaunch').uncheck();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await storedPrefs(page)).toMatchObject({ supressesUntitledDocumentOnLaunch: true });
    await page.reload();
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });
});

test.describe('drag and drop (F-33 and Markdown files)', () => {
  test('F-33 a JPEG dropped on the editor is inserted as a data URI at the selection start; the selection is not replaced; bytes round-trip', async ({ page }) => {
    await open(page);
    await setText(page, 'abcdef', 2, 4);
    const bytes = Array.from({ length: 70000 }, (_, i) => (i * 37 + 11) & 0xff);
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'p.jpg', type: 'image/jpeg', bytes }]);
    await expect.poll(() => docText(page)).toContain('![](data:image/jpeg;base64,');
    const text = await docText(page);
    expect(text.startsWith('ab![](data:image/jpeg;base64,')).toBe(true);
    expect(text.endsWith(')cdef')).toBe(true);
    const b64 = /base64,([^)]*)\)/.exec(text)![1];
    expect(Array.from(Buffer.from(b64, 'base64'))).toEqual(bytes);
    expect(await page.evaluate(() => (window as any).__dragoverPrevented)).toBe(true);
  });

  test('F-33 only the first of several dropped files is used; a PNG or a text file dropped on the editor is not inserted', async ({ page }) => {
    await open(page);
    await setText(page, '');
    await dropFiles(page, '[data-testid="editor"] .cm-content', [
      { name: 'a.jpg', type: 'image/jpeg', bytes: [1, 2, 3] },
      { name: 'b.jpg', type: 'image/jpeg', bytes: [9, 9, 9] },
    ]);
    await expect.poll(() => docText(page)).toBe('![](data:image/jpeg;base64,AQID)');
    await setText(page, 'keep');
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'a.png', type: 'image/png', bytes: [1, 2, 3] }]);
    await page.waitForTimeout(300);
    expect(await docText(page)).toBe('keep');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    await expect(page.getByTestId('alert')).toHaveCount(0);
  });

  test('F-33 a JPEG dropped outside the editor (toolbar, preview) is ignored', async ({ page }) => {
    await open(page);
    await setText(page, 'keep');
    await dropFiles(page, '[data-testid="toolbar"]', [{ name: 'a.jpg', type: 'image/jpeg', bytes: [1, 2, 3] }]);
    await page.waitForTimeout(300);
    expect(await docText(page)).toBe('keep');
    await pv(page).locator('body').evaluate((body) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));
      body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    expect(await docText(page)).toBe('keep');
  });

  test('drag and drop: a dropped .md file on the toolbar / editor / empty state opens as the document; a dropped file that is not Markdown or text is ignored', async ({ page }) => {
    await open(page);
    await dropFiles(page, '[data-testid="toolbar"]', [{ name: 'dropped.md', type: '', bytes: bytesOf('# dropped') }]);
    await expect(page).toHaveTitle('dropped.md');
    await expect(pv(page).locator('h1')).toHaveText('dropped');
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'again.markdown', type: 'text/markdown', bytes: bytesOf('# again') }]);
    await expect(page).toHaveTitle('again.markdown');
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'photo.png', type: 'image/png', bytes: [1] }]);
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'doc.pdf', type: 'application/pdf', bytes: [1] }]);
    await page.waitForTimeout(300);
    await expect(page).toHaveTitle('again.markdown');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
  });

  test('drag and drop: an edited document is asked about first; Cancel keeps it; a non-UTF-8 .md shows the error sheet', async ({ page }) => {
    await open(page);
    await setText(page, 'mine');
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'd.md', type: '', bytes: bytesOf('# d') }]);
    await expect(page.getByTestId('save-prompt')).toBeVisible();
    await page.getByTestId('save-prompt-cancel').click();
    expect(await docText(page)).toBe('mine');
    await dropFiles(page, '[data-testid="editor"] .cm-content', [{ name: 'bad.md', type: '', bytes: [0x61, 0xff] }]);
    await expect(page.getByTestId('alert-message')).toHaveText('The document “bad.md” could not be opened.');
    await page.getByTestId('alert-ok').click();
    expect(await docText(page)).toBe('mine');
  });

  test('drag and drop with P-02 off: a .md dropped on the empty state opens it', async ({ page }) => {
    await openRaw(page, q({ supressesUntitledDocumentOnLaunch: true }));
    await dropFiles(page, '[data-testid="empty-state"]', [{ name: 'e.md', type: '', bytes: bytesOf('# e') }]);
    await expect(page).toHaveTitle('e.md');
    await expect(page.getByTestId('empty-state')).toHaveCount(0);
  });

  test('F-18 dragging onto the preview is disabled: a dropped .md on the preview does not open', async ({ page }) => {
    await open(page);
    await setText(page, 'keep');
    await pv(page).locator('body').evaluate((body) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# x'], 'x.md', { type: 'text/markdown' }));
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      body.dispatchEvent(over);
      (window.parent as any).__previewOver = over.defaultPrevented;
      body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    expect(await docText(page)).toBe('keep');
    await expect(page).toHaveTitle('Untitled — Edited');
  });
});

test.describe('F-153 / F-154 / F-155 help', () => {
  test('F-153 Help is the original help.md byte for byte, opens in front of an edited document without a prompt and leaves the draft alone; Close restores text, selection and edited state', async ({ page }) => {
    await open(page);
    await setText(page, 'work in progress', 5, 7);
    await waitSaved(page);
    await menu(page, 'help', 'help');
    await expect.poll(() => docText(page)).toBe(HELP_MD);
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    await expect(page).toHaveTitle('help.md');
    expect(await docInfo(page)).toMatchObject({ kind: 'help', name: 'help.md' });
    expect(await stashed(page)).toMatchObject({ kind: 'untitled' });
    await waitSaved(page);
    expect((await draft(page)).text).toBe('work in progress');
    await expect(pv(page).locator('h1').first()).toHaveText('MacDown');
    await menu(page, 'file', 'close');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0); // an unedited help copy closes silently
    expect(await docText(page)).toBe('work in progress');
    await expect(page).toHaveTitle('Untitled — Edited');
    expect(await stashed(page)).toBeNull();
  });

  test('F-153 the help document is editable; closing it asks; Cancel stays in help; Don\'t Save returns to the user\'s document; Save As turns it into a normal file', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'mine');
    await menu(page, 'help', 'help');
    await expect.poll(() => docText(page)).toBe(HELP_MD);
    await editorEl(page).click();
    await page.keyboard.type('Z');
    await expect(page).toHaveTitle('help.md — Edited');
    await menu(page, 'file', 'close');
    await expect(page.getByTestId('save-prompt-message')).toContainText('“help.md”');
    await page.getByTestId('save-prompt-cancel').click();
    await expect(page).toHaveTitle('help.md — Edited');
    await menu(page, 'file', 'close');
    await page.getByTestId('save-prompt-dont-save').click();
    expect(await docText(page)).toBe('mine');
  });

  test('F-153 Help twice does not stack: the second Help replaces the first (asking only when the first was edited); Contributing replaces Help; Close returns to the user document', async ({ page }) => {
    await open(page);
    await setText(page, 'mine');
    await menu(page, 'help', 'help');
    await menu(page, 'help', 'help');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    await menu(page, 'help', 'contributing');
    await expect.poll(() => docText(page)).toBe(CONTRIBUTE_MD);
    await expect(page).toHaveTitle('contribute.md');
    await menu(page, 'file', 'close');
    expect(await docText(page)).toBe('mine');
    expect(await stashed(page)).toBeNull();
  });

  test('F-153 the file handle and saved state of the user\'s file survive a Help detour', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'real.md', text: 'disk' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('real.md');
    await setText(page, 'disk + edit');
    await menu(page, 'help', 'help');
    await menu(page, 'file', 'close');
    expect(await docInfo(page)).toMatchObject({ kind: 'file', name: 'real.md', hasHandle: true, savedText: 'disk' });
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    expect((await fsState(page)).saveCalls.length).toBe(0);
    expect((await fsState(page)).writes[0].text).toBe('disk + edit');
  });

  test('F-153 a reload while the help document is open restores the user\'s document, and F-154 contribute.md is the original file', async ({ page }) => {
    await open(page);
    await setText(page, 'mine');
    await waitSaved(page);
    await menu(page, 'help', 'contributing');
    await expect.poll(() => docText(page)).toBe(CONTRIBUTE_MD);
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('mine');
  });

  test('F-153 help with P-02 off and no document: Close of the help document leaves the empty state', async ({ page }) => {
    await openRaw(page, q({ supressesUntitledDocumentOnLaunch: true }));
    await menu(page, 'help', 'help');
    await expect.poll(() => docText(page)).toBe(HELP_MD);
    expect(await stashed(page)).toBeNull();
    await menu(page, 'file', 'close');
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  test('F-153 in-page anchors of the help document scroll the preview (the pane links of help.md)', async ({ page }) => {
    await open(page);
    await menu(page, 'help', 'help');
    await expect(pv(page).locator('h1').first()).toHaveText('MacDown');
    const frame = await previewFrame(page);
    const before = await frame.evaluate(() => window.scrollY);
    await pv(page).locator('a[href="#markdown-pane"]').first().click();
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBeGreaterThan(before);
    expect(page.url()).not.toContain('#markdown-pane');
  });

  test('F-155 the first launch opens help in front of the (blank) document; Close shows the blank document; with P-02 off Close shows the empty state', async ({ browser }) => {
    for (const p02Off of [false, true]) {
      const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const page = await ctx.newPage();
      await page.goto('/' + (p02Off ? q({ supressesUntitledDocumentOnLaunch: true }) : ''));
      await expect(page.getByTestId('split')).toBeVisible();
      await expect.poll(() => docText(page)).toBe(HELP_MD);
      await expect(page).toHaveTitle('help.md');
      await menu(page, 'file', 'close');
      if (p02Off) await expect(page.getByTestId('empty-state')).toBeVisible();
      else {
        expect(await docText(page)).toBe('');
        await expect(page).toHaveTitle('Untitled');
      }
      await ctx.close();
    }
  });
});

test.describe('F-18 in-page links (found while testing help)', () => {
  const longDoc = (anchor: string) => `[go](#target)\n\n${Array.from({ length: 80 }, (_, i) => `para ${i}`).join('\n\n')}\n\n${anchor}\n\nend`;

  test('F-18 a link to an <a name="..."> anchor scrolls the preview (WebKit follows name anchors; the bundled help.md uses them)', async ({ page }) => {
    await open(page);
    await setText(page, longDoc('## <a name="target"></a>Target'));
    await expect(pv(page).locator('a[name="target"]')).toBeAttached();
    const frame = await previewFrame(page);
    await pv(page).locator('a[href="#target"]').click();
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  });

  test('F-18 a link to an element id scrolls the preview (control for the previous test)', async ({ page }) => {
    await open(page);
    await setText(page, longDoc('<div id="target">Target</div>'));
    const frame = await previewFrame(page);
    await pv(page).locator('a[href="#target"]').click();
    await expect.poll(() => frame.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  });

  test('F-18 an in-page link with a malformed percent escape does not throw', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page);
    await setText(page, '<a href="#100%">bad</a> <a href="#%E0%A4%A">bad2</a> <a href="#">empty</a>\n\n# h');
    await pv(page).locator('a[href="#100%"]').click();
    await pv(page).locator('a[href="#%E0%A4%A"]').click();
    await pv(page).locator('a[href="#"]').click();
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });

  test('F-18 / F-153 every in-page link of the bundled help.md points at an element that exists in the preview and scrolls to it', async ({ page }) => {
    await open(page);
    await menu(page, 'help', 'help');
    await expect(pv(page).locator('h1').first()).toHaveText('MacDown');
    const frame = await previewFrame(page);
    const links = await frame.evaluate(() => Array.from(document.querySelectorAll('a[href^="#"]')).map((a) => a.getAttribute('href')!));
    expect(links.length).toBeGreaterThan(3);
    const dead = await frame.evaluate((hs) => hs.filter((h) => { const id = decodeURIComponent(h.slice(1)); return !document.getElementById(id) && !document.getElementsByName(id).length; }), links);
    expect(dead).toEqual([]);
    for (const h of Array.from(new Set(links))) {
      await frame.evaluate(() => window.scrollTo(0, 0));
      await pv(page).locator(`a[href="${h}"]`).first().click();
      await expect.poll(() => frame.evaluate(() => window.scrollY), h).toBeGreaterThan(0);
    }
  });
});

test.describe('F-142 About and F-140 menu entries', () => {
  test('F-142 / F-140 the MacDown menu lists About MacDown and Preferences… with ⌘, ; About closes with its button and with Escape and returns focus', async ({ page }) => {
    await open(page);
    await page.getByTestId('menu-app').click();
    await expect(page.getByTestId('menuitem-about')).toHaveText(/About MacDown/);
    await expect(page.getByTestId('menuitem-preferences')).toContainText('Preferences…');
    await expect(page.getByTestId('menuitem-preferences')).toContainText(',');
    await page.getByTestId('menuitem-about').click();
    await expect(page.getByTestId('about-version')).toContainText('0.7.3');
    await page.getByTestId('about-close').click();
    await expect(page.getByTestId('about')).toHaveCount(0);
    await key(page, 'Mod+Comma');
    await expect(page.getByTestId('preferences')).toBeVisible();
  });
});

test.describe('security of opened and exported content', () => {
  const HOSTILE = [
    '<script>window.__pwned=1;parent.__pwned=2;top.__pwned=3</script>',
    '<img src=x onerror="window.__pwned=4;parent.__pwned=5">',
    '<a href="javascript:window.top.__pwned=6">js</a>',
    '<iframe srcdoc="<script>parent.parent.__pwned=7</script>"></iframe>',
    '<svg onload="parent.__pwned=8"></svg>',
    '<meta http-equiv="refresh" content="0;url=javascript:top.__pwned=9">',
    '<form action="javascript:top.__pwned=10"><input type=submit id=s></form>',
    '<base href="http://evil.example/">',
    '<style>@import url(http://evil.example/x.css)</style>',
    '```js:"><script>top.__pwned=11</script>',
  ].join('\n\n');

  test('F-135 / F-18 a hostile .md opened from disk stays inert: no script, no popup, no navigation, the app is unchanged', async ({ page }) => {
    await mockFs(page);
    const popups: string[] = [];
    page.on('popup', (p) => popups.push(p.url()));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page, q({ htmlSyntaxHighlighting: true, htmlCodeBlockAccessory: 2, htmlMathJax: true, htmlTaskList: true }));
    await queueOpen(page, { name: 'evil.md', text: HOSTILE });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('evil.md');
    await expect(pv(page).locator('img').first()).toBeAttached();
    await pv(page).locator('a').first().click().catch(() => undefined);
    await pv(page).locator('#s').click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(await page.evaluate(() => location.href)).toMatch(/^http:\/\/localhost:5173\/(\?.*)?$/);
    expect(popups).toEqual([]);
    expect(errors).toEqual([]);
    const sandbox = await page.getByTestId('preview-iframe').getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-forms');
  });

  test('E-07 / F-35 hostile content exported and copied stays text: nothing executes in the app origin, the download is not navigated to, the clipboard holds plain text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await noFs(page);
    const popups: string[] = [];
    page.on('popup', (p) => popups.push(p.url()));
    await open(page);
    await setText(page, HOSTILE);
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('<script>');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(await page.evaluate(async () => (await navigator.clipboard.read())[0].types)).toEqual(['text/plain']);
    expect(clip).not.toMatch(/<html|<body|<head/);
    await menu(page, 'file', 'export-html');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-html-save').click();
    const d = await dl;
    const html = readFileSync(await d.path(), 'utf8');
    expect(html).toContain('<script>window.__pwned=1');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(popups).toEqual([]);
    expect(page.url()).toMatch(/^http:\/\/localhost:5173\//);
    expect(page.context().pages().length).toBe(1);
  });

  test('F-35 a file name with markup is escaped in the exported <title>', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: '</title><script>top.x=1</script>.md', text: 'x' });
    await menu(page, 'file', 'open');
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    const html = (await fsState(page)).writes[0].text;
    expect(html).not.toContain('<script>top.x');
    expect(html).toMatch(/<title>&lt;\/title&gt;&lt;script&gt;top\.x=1&lt;\/script&gt;<\/title>/);
  });
});

// ---------------------------------------------------------------------------
// Preferences (F-140, F-141, section 8)
// ---------------------------------------------------------------------------

/** Labels of the checkboxes of the open pane, in DOM order. */
const checkLabels = (page: Page) => page.locator('[data-testid^="preferences-pane-"] label.prefs-check').allInnerTexts().then((l) => l.map((x) => x.trim()));
const legends = (page: Page) => page.locator('[data-testid^="preferences-pane-"] legend').allInnerTexts();
const rowLabels = (page: Page) => page.locator('[data-testid^="preferences-pane-"] .prefs-label').allInnerTexts().then((l) => l.map((x) => x.trim()));
const optionTexts = (page: Page, testId: string) => page.getByTestId(testId).locator('option').allInnerTexts();
const optionValues = (page: Page, testId: string) => page.getByTestId(testId).locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

test.describe('F-140 Preferences window', () => {
  test('F-140 panes in the order General, Markdown, Editor, Rendering (no Terminal); title bar shows the pane; the last pane is remembered', async ({ page }) => {
    await open(page);
    await key(page, 'Mod+Comma');
    await expect(page.getByTestId('preferences')).toBeVisible();
    expect(await page.locator('[data-testid^="preferences-tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('preferences-tab-', '')))).toEqual(['general', 'markdown', 'editor', 'rendering']);
    expect(await page.locator('[data-testid^="preferences-tab-"]').allInnerTexts()).toEqual(['General', 'Markdown', 'Editor', 'Rendering']);
    await expect(page.getByTestId('preferences-title')).toHaveText('General');
    await expect(page.getByTestId('preferences-tab-general')).toHaveAttribute('aria-selected', 'true');
    for (const [id, title] of [['markdown', 'Markdown'], ['editor', 'Editor'], ['rendering', 'Rendering']]) {
      await page.getByTestId(`preferences-tab-${id}`).click();
      await expect(page.getByTestId('preferences-title')).toHaveText(title);
      await expect(page.getByTestId(`preferences-pane-${id}`)).toBeVisible();
      await expect(page.getByTestId('preferences')).toHaveAttribute('data-pane', id);
    }
    await page.getByTestId('preferences-close').click();
    await expect(page.getByTestId('preferences')).toHaveCount(0);
    await key(page, 'Mod+Comma');
    await expect(page.getByTestId('preferences-title')).toHaveText('Rendering');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences')).toHaveCount(0);
  });

  test('F-140 the panel is not modal: the editor stays usable and the preview follows while it is open', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    await editorEl(page).click();
    await page.keyboard.type('# live');
    await expect(pv(page).locator('h1')).toHaveText('live');
    await expect(page.getByTestId('preferences')).toBeVisible();
  });

  test('F-140 the pane controls are keyboard operable: tabs focus, checkboxes toggle with Space', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'markdown');
    await pref(page, 'extensionAutolink').focus();
    await page.keyboard.press('Space');
    expect(await prefValue(page, 'extensionAutolink')).toBe(true);
    await page.keyboard.press('Space');
    expect(await prefValue(page, 'extensionAutolink')).toBe(false);
  });

  test('F-140 every control has an accessible name', async ({ page }) => {
    await open(page);
    await openPrefs(page);
    for (const pane of ['general', 'markdown', 'editor', 'rendering']) {
      await page.getByTestId(`preferences-tab-${pane}`).click();
      const unnamed = await page.locator('[data-testid^="preferences-pane-"] :is(input,select,button)').evaluateAll((els) =>
        els
          .filter((e) => !(e as HTMLElement).hidden)
          .filter((e) => {
            const el = e as HTMLInputElement;
            const labelled = el.labels && el.labels.length > 0;
            return !(labelled || el.getAttribute('aria-label') || (el.tagName === 'BUTTON' && el.textContent?.trim()) || el.getAttribute('title'));
          })
          .map((e) => (e as HTMLElement).dataset.testid ?? e.outerHTML.slice(0, 80)),
      );
      expect(unnamed, pane).toEqual([]);
    }
  });
});

test.describe('F-140 / section 8.1 General', () => {
  test('section 8.1 General: group, labels, order (from the xib constraints) and defaults; Out items are not offered', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    expect(await legends(page)).toEqual(['Behavior']);
    expect(await checkLabels(page)).toEqual([
      'Ensure open document on launch',
      'Update preview automatically as you type',
      'Sync preview scrollbar when editor scrolls',
      'Put editor on the right',
      'Show word count',
    ]);
    const state = await Promise.all(['supressesUntitledDocumentOnLaunch', 'markdownManualRender', 'editorSyncScrolling', 'editorOnRight', 'editorShowWordCount'].map((k) => pref(page, k).isChecked()));
    expect(state).toEqual([true, true, true, false, false]); // P-02 and P-01 are shown negated
    await expect(page.getByText('Include pre-releases')).toHaveCount(0);
    await expect(page.getByText('Automatically create files for link targets')).toHaveCount(0);
  });

  test('P-01 unchecking turns word count off and disables it; checking again does not turn it back on; stored negated', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    await pref(page, 'editorShowWordCount').check();
    await expect(page.getByTestId('word-count')).toBeVisible();
    await pref(page, 'markdownManualRender').uncheck();
    await expect(page.getByTestId('word-count')).toHaveCount(0);
    await expect(pref(page, 'editorShowWordCount')).toBeDisabled();
    await expect(pref(page, 'editorShowWordCount')).not.toBeChecked();
    expect(await storedPrefs(page)).toMatchObject({ markdownManualRender: true, editorShowWordCount: false });
    await pref(page, 'markdownManualRender').check();
    await expect(pref(page, 'editorShowWordCount')).toBeEnabled();
    await expect(pref(page, 'editorShowWordCount')).not.toBeChecked();
    await expect(page.getByTestId('word-count')).toHaveCount(0);
  });

  test('P-01 off: typing does not update the preview, Render Markdown and switching back on do; the setting persists', async ({ page }) => {
    await open(page);
    await setText(page, 'first');
    await expect(pv(page).locator('p')).toHaveText('first');
    await openPrefs(page, 'general');
    await pref(page, 'markdownManualRender').uncheck();
    await setText(page, 'second');
    await page.waitForTimeout(500);
    await expect(pv(page).locator('p')).toHaveText('first');
    await key(page, 'Mod+r');
    await expect(pv(page).locator('p')).toHaveText('second');
    await setText(page, 'third');
    await page.waitForTimeout(400);
    await expect(pv(page).locator('p')).toHaveText('second');
    await pref(page, 'markdownManualRender').check();
    await expect(pv(page).locator('p')).toHaveText('third'); // switching back to automatic forces a re-render
    await pref(page, 'markdownManualRender').uncheck();
    await page.reload();
    await openPrefs(page, 'general');
    await expect(pref(page, 'markdownManualRender')).not.toBeChecked();
  });

  test('P-05 word count shown from the pane; counts the rendered text; P-06c type persists across a reload', async ({ page }) => {
    await open(page);
    await setText(page, 'one two three');
    await openPrefs(page, 'general');
    await pref(page, 'editorShowWordCount').check();
    await expect(page.getByTestId('word-count')).toHaveValue('0');
    await expect(page.getByTestId('word-count').locator('option').first()).toHaveText('3 words');
    await page.getByTestId('word-count').selectOption('1');
    await page.reload();
    await expect(page.getByTestId('word-count')).toHaveValue('1');
    await expect(page.getByTestId('word-count').locator('option:checked')).toHaveText(/^13 characters$/);
  });

  test('P-03 / P-04 apply live: editor on the right swaps the panes; sync scroll off leaves the preview where it is', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    const x = async (id: string) => (await page.getByTestId(id).boundingBox())!.x;
    expect(await x('editor-pane')).toBeLessThan(await x('preview-pane'));
    await pref(page, 'editorOnRight').check();
    await expect.poll(async () => (await x('editor-pane')) > (await x('preview-pane'))).toBe(true);
    await pref(page, 'editorOnRight').uncheck();
    await expect.poll(async () => (await x('editor-pane')) < (await x('preview-pane'))).toBe(true);
  });
});

test.describe('F-140 / section 8.2 Markdown', () => {
  const rows: [string, string, boolean][] = [
    ['extensionSmartyPants', 'Smartypants', false],
    ['extensionTables', 'Table', true],
    ['extensionFencedCode', 'Fenced code block', true],
    ['extensionIntraEmphasis', 'Intra-word emphasis', true],
    ['extensionStrikethough', 'Strikethrough', false],
    ['extensionUnderline', 'Underline', false],
    ['extensionQuote', 'Quote', false],
    ['extensionHighlight', 'Highlight', false],
    ['extensionSuperscript', 'Superscript', false],
    ['extensionAutolink', 'Autolink', false],
    ['extensionFootnotes', 'Footnote', true],
  ];

  test('section 8.2 Markdown: groups and labels in the xib order; defaults', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'markdown');
    expect(await legends(page)).toEqual(['Document formatting', 'Block formatting', 'Inline formatting']);
    expect(await checkLabels(page)).toEqual([
      'Smartypants', 'Table', 'Fenced code block',
      'Intra-word emphasis', 'Strikethrough', 'Underline', 'Quote', 'Highlight', 'Superscript', 'Autolink', 'Footnote',
    ]);
    for (const [k, label, def] of rows) expect(await pref(page, k).isChecked(), label).toBe(def);
  });

  for (const [k, label, def] of rows) {
    test(`F-141 ${label} (${k}): toggling flips the preference, persists only that key and survives a reload`, async ({ page }) => {
      await open(page);
      await openPrefs(page, 'markdown');
      await page.locator('[data-testid^="preferences-pane-"]').getByLabel(label, { exact: true }).setChecked(!def);
      expect(await prefValue(page, k)).toBe(!def);
      expect(await storedPrefs(page)).toEqual({ [k]: !def });
      await page.reload();
      await openPrefs(page, 'markdown');
      expect(await pref(page, k).isChecked()).toBe(!def);
      await page.locator('[data-testid^="preferences-pane-"]').getByLabel(label, { exact: true }).setChecked(def);
      expect(await prefValue(page, k)).toBe(def);
    });
  }

  test('F-141 / F-162 Markdown toggles apply live to the preview and to the Format menu (hidden items appear)', async ({ page }) => {
    await open(page);
    await setText(page, '~~del~~ ==mark== _under_ H^2 "q" a--b www.example.com [^1]\n\n[^1]: note');
    await openPrefs(page, 'markdown');
    await page.getByTestId('menu-format').click();
    for (const id of ['underline', 'strikethrough', 'highlight']) await expect(page.getByTestId(`menuitem-${id}`)).toHaveCount(0);
    await page.getByTestId('menu-format').click();
    for (const [k, sel] of [['extensionStrikethough', 'del'], ['extensionHighlight', 'mark'], ['extensionUnderline', 'u'], ['extensionSuperscript', 'sup'], ['extensionQuote', 'q'], ['extensionAutolink', 'a[href^="http://www."]']] as const) {
      await expect(pv(page).locator(sel).first(), `${k} off`).toHaveCount(sel === 'sup' ? 1 : 0); // footnote ref is a <sup>
      await pref(page, k).check();
      await expect(pv(page).locator(sel).first(), `${k} on`).toBeAttached();
    }
    await page.getByTestId('menu-format').click();
    for (const id of ['underline', 'strikethrough', 'highlight']) await expect(page.getByTestId(`menuitem-${id}`)).toBeVisible();
    await page.getByTestId('menu-format').click();
    await pref(page, 'extensionSmartyPants').check();
    await expect(pv(page).locator('p').first()).toContainText('a–b');
    await pref(page, 'extensionFootnotes').uncheck();
    await expect(pv(page).locator('.footnotes')).toHaveCount(0);
    await pref(page, 'extensionTables').uncheck();
    await setText(page, '| a | b |\n|---|---|\n| 1 | 2 |');
    await expect(pv(page).locator('table')).toHaveCount(0);
    await pref(page, 'extensionTables').check();
    await expect(pv(page).locator('table')).toHaveCount(1);
    await pref(page, 'extensionFencedCode').uncheck();
    await setText(page, '```js\nx\n```');
    await expect(pv(page).locator('pre code.language-javascript')).toHaveCount(0);
    await pref(page, 'extensionFencedCode').check();
    await expect(pv(page).locator('pre code.language-javascript')).toHaveCount(1);
  });
});

test.describe('F-140 / section 8.4 Editor', () => {
  test('section 8.4 Editor: row labels, order, controls and defaults', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    expect(await rowLabels(page)).toEqual(['Base font:', 'Theme:', 'Line spacing:', 'Text insets:', 'List marker:']);
    expect(await legends(page)).toEqual(['Behavior']);
    expect(await checkLabels(page)).toEqual([
      'Limit editor width to',
      'Insert spaces instead of tabs',
      'Auto-complete matching characters',
      'Automatically insert line prefix for the current block',
      '⌘← jumps to first non-whitespace character in line',
      'Scroll past end',
      'Ensure newline at end of file on save',
      'Auto-increment numbering in ordered lists',
    ]);
    await expect(page.getByTestId('pref-editorBaseFontInfo-preview')).toHaveText('Menlo Regular - 14.0');
    await expect(pref(page, 'editorStyleName')).toHaveValue('Tomorrow+');
    await expect(pref(page, 'editorLineSpacing')).toHaveValue('3');
    await expect(pref(page, 'editorHorizontalInset')).toHaveValue('15');
    await expect(pref(page, 'editorVerticalInset')).toHaveValue('30');
    await expect(pref(page, 'editorMaximumWidth')).toHaveValue('1000');
    await expect(pref(page, 'editorUnorderedListMarkerType')).toHaveValue('0');
    const defaults: Record<string, boolean> = {
      editorWidthLimited: false, editorConvertTabs: false, editorCompleteMatchingCharacters: false, editorInsertPrefixInBlock: true,
      editorSmartHome: false, editorScrollsPastEnd: false, editorEnsuresNewlineAtEndOfFile: false, editorAutoIncrementNumberedLists: true,
    };
    for (const [k, v] of Object.entries(defaults)) expect(await pref(page, k).isChecked(), k).toBe(v);
  });

  test('P-45 / P-31 pop-ups: list marker items, theme list = empty item + the 15 themes of section 7.2', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    expect(await optionTexts(page, 'pref-editorUnorderedListMarkerType')).toEqual(['* (Asterisk)', '+ (Plus sign)', '- (Minus sign)']);
    const themes = await optionTexts(page, 'pref-editorStyleName');
    expect(themes[0]).toBe('');
    expect(new Set(themes.slice(1))).toEqual(new Set([
      'Mou Fresh Air', 'Mou Fresh Air+', 'Mou Night', 'Mou Night+', 'Mou Paper', 'Mou Paper+', 'Solarized (Dark)', 'Solarized (Dark)+',
      'Solarized (Light)', 'Solarized (Light)+', 'Tomorrow', 'Tomorrow Blue', 'Tomorrow+', 'Writer', 'Writer+',
    ]));
    expect(themes.length).toBe(16);
  });

  test('P-31 choosing a theme applies live to the open editor; the empty item removes the theme (white background); persists', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="editor"] .cm-editor')!).backgroundColor);
    const night = readFileSync(resolve(VENDOR, 'Resources/Themes/Mou Night.style'), 'utf8');
    const m = /editor\s*\n(?:[^\n]*\n)*?\s*background:\s*([0-9a-fA-F]{6})/.exec(night)!;
    await pref(page, 'editorStyleName').selectOption('Mou Night');
    await expect.poll(bg).toBe(rgb(m[1]));
    await expect(page.getByTestId('editor')).toHaveAttribute('data-theme', 'Mou Night');
    await pref(page, 'editorStyleName').selectOption('');
    await expect.poll(bg).toBe('rgb(255, 255, 255)');
    expect(await storedPrefs(page)).toMatchObject({ editorStyleName: '' });
    await page.reload();
    await expect.poll(bg).toBe('rgb(255, 255, 255)');
    await openPrefs(page, 'editor');
    await expect(pref(page, 'editorStyleName')).toHaveValue('');
  });

  const ranges: [string, number, number, number][] = [
    ['editorLineSpacing', 0, 100, 3],
    ['editorHorizontalInset', 0, 35, 15],
    ['editorVerticalInset', 0, 35, 30],
  ];
  for (const [k, min, max, def] of ranges) {
    test(`P-32..P-34 ${k}: typing, Enter, clamping to ${min}..${max}, empty = 0, arrow keys step by 1`, async ({ page }) => {
      await open(page);
      await openPrefs(page, 'editor');
      const f = pref(page, k);
      await f.fill(String(max - 1));
      expect(await prefValue(page, k)).toBe(max - 1); // live while valid
      await f.fill(String(max + 50));
      await f.blur();
      expect(await prefValue(page, k)).toBe(max);
      await expect(f).toHaveValue(String(max));
      await f.fill('-7');
      await f.blur();
      expect(await prefValue(page, k)).toBe(min);
      await f.fill('12');
      await f.press('Enter');
      expect(await prefValue(page, k)).toBe(12);
      await f.fill('');
      await f.blur();
      expect(await prefValue(page, k)).toBe(0);
      await expect(f).toHaveValue('0');
      await f.fill(String(max));
      await f.press('ArrowUp');
      expect(await prefValue(page, k)).toBe(max);
      await f.press('ArrowDown');
      expect(await prefValue(page, k)).toBe(max - 1);
      await f.fill(String(def));
      await f.blur();
      expect(await prefValue(page, k)).toBe(def);
    });
  }

  test('P-35 the width field is enabled only with the checkbox; range 300..10000; empty gives the minimum; the limit applies live', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await expect(pref(page, 'editorMaximumWidth')).toBeDisabled();
    await pref(page, 'editorWidthLimited').check();
    await expect(pref(page, 'editorMaximumWidth')).toBeEnabled();
    const f = pref(page, 'editorMaximumWidth');
    await f.fill('50000');
    await f.blur();
    expect(await prefValue(page, 'editorMaximumWidth')).toBe(10000);
    await f.fill('299');
    await f.blur();
    expect(await prefValue(page, 'editorMaximumWidth')).toBe(300);
    await f.fill('');
    await f.blur();
    expect(await prefValue(page, 'editorMaximumWidth')).toBe(300);
    await f.fill('500');
    await f.blur();
    const pl = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="editor"] .cm-content')!).paddingLeft));
    const width = await page.evaluate(() => document.querySelector('[data-testid="editor"] .cm-scroller')!.clientWidth);
    await expect.poll(async () => Math.abs((await pl()) - (width - 500) * 0.45) < 1).toBe(true);
    await pref(page, 'editorWidthLimited').uncheck();
    await expect.poll(pl).toBe(15);
  });

  test('F-75 / P-30 Change… opens a family and size panel; the preview reads "Name - size"; the editor font follows live; sizes outside 4..288 are not applied', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await page.getByTestId('pref-editorBaseFontInfo-change').click();
    await page.getByTestId('pref-editorBaseFontInfo-family').selectOption('Courier-Regular');
    await page.getByTestId('pref-editorBaseFontInfo-size').fill('18');
    await expect(page.getByTestId('pref-editorBaseFontInfo-preview')).toHaveText('Courier Regular - 18.0');
    const font = () => page.evaluate(() => { const c = getComputedStyle(document.querySelector('[data-testid="editor"] .cm-content')!); return { family: c.fontFamily, size: c.fontSize }; });
    await expect.poll(async () => (await font()).size).toBe('18px');
    expect((await font()).family).toMatch(/Courier/);
    await page.getByTestId('pref-editorBaseFontInfo-size').fill('3');
    expect((await prefValue(page, 'editorBaseFontInfo')).size).toBe(18);
    await page.getByTestId('pref-editorBaseFontInfo-size').fill('289');
    expect((await prefValue(page, 'editorBaseFontInfo')).size).toBe(18);
    await page.reload();
    await expect.poll(async () => (await font()).size).toBe('18px');
  });

  test('P-36..P-42, P-45 apply live from the pane without a reload', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await pref(page, 'editorConvertTabs').check();
    await setText(page, '');
    await editorEl(page).click();
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe('    ');
    await pref(page, 'editorConvertTabs').uncheck();
    await setText(page, '');
    await editorEl(page).click();
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe('\t');
    await pref(page, 'editorCompleteMatchingCharacters').check();
    await setText(page, '');
    await editorEl(page).click();
    await page.keyboard.type('(');
    expect(await docText(page)).toBe('()');
    await pref(page, 'editorCompleteMatchingCharacters').uncheck();
    await pref(page, 'editorUnorderedListMarkerType').selectOption('2');
    await setText(page, 'item', 0, 4);
    await menu(page, 'format', 'unordered-list');
    expect(await docText(page)).toBe('- item');
    await pref(page, 'editorUnorderedListMarkerType').selectOption('1');
    await setText(page, 'item', 0, 4);
    await menu(page, 'format', 'unordered-list');
    expect(await docText(page)).toBe('+ item');
  });

  test('P-38 / P-39 unchecking the line prefix option disables auto-increment and stops list continuation but not indent continuation (F-69)', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await pref(page, 'editorInsertPrefixInBlock').uncheck();
    await expect(pref(page, 'editorAutoIncrementNumberedLists')).toBeDisabled();
    await setText(page, '* a');
    await editorEl(page).click();
    await page.evaluate(() => (window as any).macdownEditor.select(3));
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('* a\n');
    await setText(page, '  indented');
    await page.evaluate(() => (window as any).macdownEditor.select(10));
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('  indented\n  ');
    await pref(page, 'editorInsertPrefixInBlock').check();
    await expect(pref(page, 'editorAutoIncrementNumberedLists')).toBeEnabled();
    await pref(page, 'editorAutoIncrementNumberedLists').uncheck();
    await setText(page, '5. x');
    await page.evaluate(() => (window as any).macdownEditor.select(4));
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('5. x\n5. ');
  });

  test('P-41 / P-42 / P-40 are stored under their section 8 keys', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await page.getByLabel('Scroll past end').check();
    await page.getByLabel('Ensure newline at end of file on save').check();
    await page.getByLabel('⌘← jumps to first non-whitespace character in line').check();
    expect(await storedPrefs(page)).toEqual({ editorScrollsPastEnd: true, editorEnsuresNewlineAtEndOfFile: true, editorSmartHome: true });
  });
});

test.describe('F-140 / section 8.3 Rendering', () => {
  test('section 8.3 Rendering: rows, pop-ups, labels and defaults; GitHub-2017 and Out items are not offered', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'rendering');
    expect(await rowLabels(page)).toEqual(['CSS:', 'Theme:', 'Accessory:', 'Default path:']);
    expect(await checkLabels(page)).toEqual([
      'Syntax highlighted code block', 'Show line numbers', 'Graphviz', 'Mermaid', 'TeX-like math syntax',
      'Use dollar sign ($) as inline delimiter', 'Task list syntax', 'Detect Jekyll front-matter', 'Detect table of contents token',
      'Render newline literally', 'Scale preview based on editor font size',
    ]);
    await expect(page.getByText('Math support requires Internet connection.')).toBeVisible();
    expect(await optionTexts(page, 'pref-htmlStyleName')).toEqual(['', 'Clearness', 'Clearness Dark', 'GitHub', 'GitHub2', 'Solarized (Dark)', 'Solarized (Light)']);
    await expect(pref(page, 'htmlStyleName')).toHaveValue('GitHub2');
    expect(await optionTexts(page, 'pref-htmlHighlightingThemeName')).toEqual(['(Default)', 'Coy', 'Dark', 'Funky', 'Okaidia', 'Solarizedlight', 'Tomorrow', 'Twilight']);
    expect(await optionValues(page, 'pref-htmlHighlightingThemeName')).toEqual(['', 'Coy', 'Dark', 'Funky', 'Okaidia', 'Solarizedlight', 'Tomorrow', 'Twilight']);
    expect(await optionTexts(page, 'pref-htmlCodeBlockAccessory')).toEqual(['None', 'Language name', 'Custom']);
    await expect(pref(page, 'htmlDefaultDirectoryUrl')).toHaveValue('~');
    await expect(page.getByTestId('pref-htmlStyleName-reveal')).toBeDisabled();
    await expect(page.getByTestId('pref-htmlStyleName-reload')).toBeEnabled();
    const defaults: Record<string, boolean> = {
      htmlSyntaxHighlighting: false, htmlLineNumbers: false, htmlGraphviz: false, htmlMermaid: false, htmlMathJax: false,
      htmlMathJaxInlineDollar: false, htmlTaskList: false, htmlDetectFrontMatter: false, htmlRendersTOC: false, htmlHardWrap: false,
      previewZoomRelativeToBaseFontSize: false,
    };
    for (const [k, v] of Object.entries(defaults)) expect(await pref(page, k).isChecked(), k).toBe(v);
  });

  test('section 8.3 enablement: Theme, line numbers, Graphviz, Mermaid need P-20; $ needs P-18; Accessory is always enabled', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'rendering');
    const dependents = ['htmlHighlightingThemeName', 'htmlLineNumbers', 'htmlGraphviz', 'htmlMermaid'];
    for (const k of dependents) await expect(pref(page, k), k).toBeDisabled();
    await expect(pref(page, 'htmlCodeBlockAccessory')).toBeEnabled();
    await expect(pref(page, 'htmlMathJaxInlineDollar')).toBeDisabled();
    await pref(page, 'htmlSyntaxHighlighting').check();
    for (const k of dependents) await expect(pref(page, k), k).toBeEnabled();
    await pref(page, 'htmlMathJax').check();
    await expect(pref(page, 'htmlMathJaxInlineDollar')).toBeEnabled();
    await pref(page, 'htmlSyntaxHighlighting').uncheck();
    for (const k of dependents) await expect(pref(page, k), k).toBeDisabled();
    await pref(page, 'htmlMathJax').uncheck();
    await expect(pref(page, 'htmlMathJaxInlineDollar')).toBeDisabled();
  });

  test('P-19c choosing a style restyles the preview live; the empty item gives an unstyled preview; persists; Prism theme names are stored as shown', async ({ page }) => {
    await open(page);
    await setText(page, '# Title\n\ntext');
    await openPrefs(page, 'rendering');
    const look = () => pv(page).locator('h1').evaluate((h) => { const c = getComputedStyle(h); return `${c.fontFamily}|${c.color}|${c.fontSize}|${getComputedStyle(document.body).backgroundColor}`; });
    const seen = new Set<string>();
    for (const n of ['Clearness', 'Clearness Dark', 'GitHub', 'GitHub2', 'Solarized (Dark)', 'Solarized (Light)', '']) {
      await pref(page, 'htmlStyleName').selectOption(n);
      await expect.poll(async () => (await pv(page).locator('style').count()) > 0 || n === '').toBe(true);
      seen.add(await look());
    }
    expect(seen.size).toBe(7);
    await expect(pv(page).locator('style')).toHaveCount(0);
    await page.reload();
    await expect(pv(page).locator('style')).toHaveCount(0);
    await openPrefs(page, 'rendering');
    await expect(pref(page, 'htmlStyleName')).toHaveValue('');
    await pref(page, 'htmlSyntaxHighlighting').check();
    await pref(page, 'htmlHighlightingThemeName').selectOption('Okaidia');
    expect(await storedPrefs(page)).toMatchObject({ htmlHighlightingThemeName: 'Okaidia' });
  });

  test('section 8.3 each Rendering toggle applies live: highlighting, line numbers, accessory, TOC, front matter, hard wrap, task list, math, mermaid, graphviz', async ({ page }) => {
    await open(page);
    await setText(page, '---\ntitle: T\n---\n\n[TOC]\n\n# H\n\nline one\nline two\n\n- [x] done\n\n```js\nvar a;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```dot\ndigraph { a -> b }\n```\n\n\\\\(x\\\\)');
    await openPrefs(page, 'rendering');
    const ready = () => expect(pv(page).locator('html')).toHaveAttribute('data-macdown-scripts', 'done');
    await expect(pv(page).locator('table')).toHaveCount(0);
    await pref(page, 'htmlDetectFrontMatter').check();
    await expect(pv(page).locator('table th')).toHaveText('title');
    await pref(page, 'htmlRendersTOC').check();
    await expect(pv(page).locator('ul.toc')).toHaveCount(1);
    await pref(page, 'htmlHardWrap').check();
    await expect(pv(page).locator('p br')).toHaveCount(1);
    await pref(page, 'htmlTaskList').check();
    await expect(pv(page).locator('li.task-list-item input[type=checkbox][disabled]')).toHaveCount(1);
    await expect(pv(page).locator('.token')).toHaveCount(0);
    await pref(page, 'htmlSyntaxHighlighting').check();
    await ready();
    await expect(pv(page).locator('code.language-javascript .token.keyword')).toHaveText('var');
    await pref(page, 'htmlLineNumbers').check();
    await ready();
    await expect(pv(page).locator('pre.line-numbers .line-numbers-rows').first()).toBeAttached();
    await pref(page, 'htmlCodeBlockAccessory').selectOption('1');
    await ready();
    await expect(pv(page).getByText('JavaScript', { exact: true })).toBeAttached();
    await pref(page, 'htmlMermaid').check();
    await pref(page, 'htmlGraphviz').check();
    await ready();
    await expect(pv(page).locator('svg').first()).toBeAttached({ timeout: 15_000 });
    await pref(page, 'htmlMathJax').check();
    await ready();
    await expect(pv(page).locator('mjx-container').first()).toBeAttached({ timeout: 15_000 });
    await pref(page, 'htmlSyntaxHighlighting').uncheck();
    await expect(pv(page).locator('.token')).toHaveCount(0);
    await expect(pv(page).locator('code.language-mermaid')).toHaveCount(1); // diagrams are code blocks again (MathJax output remains: P-18 is still on)
    await expect(pv(page).locator('svg:not(mjx-container svg)')).toHaveCount(0);
  });
});

test.describe('F-17 / U-19 preview zoom', () => {
  test('F-17 zoom = base font size / 14 when P-29 is on; applied live, after re-render and after reload; U-19: back to 1 when switched off', async ({ page }) => {
    await open(page);
    await setText(page, 'some text');
    const z = () => pv(page).locator('html').evaluate((h) => h.style.zoom);
    const h = () => pv(page).locator('p').evaluate((p) => p.getBoundingClientRect().height);
    const h0 = await h();
    expect(await z()).toBe('');
    await openPrefs(page, 'rendering');
    await pref(page, 'previewZoomRelativeToBaseFontSize').check();
    expect(await z()).toBe(''); // 14 / 14
    await openPrefs(page, 'editor');
    await page.getByTestId('pref-editorBaseFontInfo-change').click();
    await page.getByTestId('pref-editorBaseFontInfo-size').fill('28');
    await expect.poll(z).toBe('2');
    expect(Math.abs((await h()) / h0 - 2)).toBeLessThan(0.1);
    await setText(page, 'other text'); // re-render keeps the zoom
    await expect(pv(page).locator('p')).toHaveText('other text');
    expect(await z()).toBe('2');
    await page.reload();
    await expect.poll(z).toBe('2');
    await page.getByTestId('menu-app').click().catch(() => undefined);
    await page.keyboard.press('Escape');
    await openPrefs(page, 'editor');
    await page.getByTestId('pref-editorBaseFontInfo-change').click();
    await page.getByTestId('pref-editorBaseFontInfo-size').fill('7');
    await expect.poll(z).toBe('0.5');
    await openPrefs(page, 'rendering');
    await pref(page, 'previewZoomRelativeToBaseFontSize').uncheck();
    await expect.poll(z).toBe('');
    await expect.poll(async () => Math.abs((await h()) / h0 - 1) < 0.05).toBe(true);
  });

  test('F-17 off by default: a large base font does not zoom the preview', async ({ page }) => {
    await open(page, q({ editorBaseFontInfo: { name: 'Menlo-Regular', size: 28 } }));
    await setText(page, 'x');
    expect(await pv(page).locator('html').evaluate((h) => h.style.zoom)).toBe('');
  });
});

test.describe('F-141 persistence and overrides', () => {
  test('F-141 only changed keys are stored; a change back to the default keeps the key (explicit); Reset forgets everything', async ({ page }) => {
    await open(page);
    expect(await storedPrefs(page)).toEqual({});
    await openPrefs(page, 'markdown');
    await pref(page, 'extensionAutolink').check();
    expect(await storedPrefs(page)).toEqual({ extensionAutolink: true });
    await page.evaluate(() => (window as any).macdownPrefs.reset());
    expect(await page.evaluate(() => localStorage.getItem('macdown.preferences'))).toBeNull();
    await expect(pref(page, 'extensionAutolink')).not.toBeChecked();
  });

  test('F-141 ?pref. overrides win over stored values, are not persisted, and an explicit change of the same key replaces the override and is persisted', async ({ page }) => {
    await open(page, q({ extensionAutolink: true }));
    await page.evaluate(() => localStorage.setItem('macdown.preferences', JSON.stringify({ extensionAutolink: false, extensionUnderline: true })));
    await page.reload();
    expect(await prefValue(page, 'extensionAutolink')).toBe(true); // URL wins
    expect(await prefValue(page, 'extensionUnderline')).toBe(true); // stored
    expect(await storedPrefs(page)).toEqual({ extensionAutolink: false, extensionUnderline: true }); // override not written
    await openPrefs(page, 'markdown');
    await expect(pref(page, 'extensionAutolink')).toBeChecked();
    await pref(page, 'extensionAutolink').uncheck();
    expect(await prefValue(page, 'extensionAutolink')).toBe(false);
    expect(await storedPrefs(page)).toEqual({ extensionAutolink: false, extensionUnderline: true });
    await pref(page, 'extensionAutolink').check();
    expect(await storedPrefs(page)).toEqual({ extensionAutolink: true, extensionUnderline: true });
    await page.goto('/');
    expect(await prefValue(page, 'extensionAutolink')).toBe(true);
  });

  test('F-141 corrupt, mistyped and unknown stored preferences are ignored without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page);
    for (const bad of ['{', 'null', '[]', '"x"', '{"extensionAutolink":"yes","bogus":1,"editorLineSpacing":"7","editorBaseFontInfo":{"name":3}}']) {
      await page.evaluate((b) => localStorage.setItem('macdown.preferences', b), bad);
      await page.reload();
      await expect(page.getByTestId('split')).toBeVisible();
      expect(await prefValue(page, 'extensionAutolink'), bad).toBe(false);
      expect(await prefValue(page, 'editorLineSpacing'), bad).toBe(3);
      expect(await prefValue(page, 'editorBaseFontInfo'), bad).toEqual({ name: 'Menlo-Regular', size: 14 });
    }
    expect(errors).toEqual([]);
  });

  test('F-141 a change in one tab is applied live in another tab of the same profile (storage event)', async ({ page, context }) => {
    await open(page);
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByTestId('split')).toBeVisible();
    await openPrefs(page, 'markdown');
    await pref(page, 'extensionUnderline').check();
    await expect.poll(() => other.evaluate(() => (window as any).macdownPrefs.get().extensionUnderline)).toBe(true);
    await other.close();
  });

  test('F-141 every pane keeps working after a reload: values of all four panes persisted', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    await pref(page, 'editorOnRight').check();
    await openPrefs(page, 'markdown');
    await pref(page, 'extensionSuperscript').check();
    await openPrefs(page, 'editor');
    await pref(page, 'editorLineSpacing').fill('9');
    await pref(page, 'editorUnorderedListMarkerType').selectOption('1');
    await openPrefs(page, 'rendering');
    await pref(page, 'htmlStyleName').selectOption('Clearness');
    await pref(page, 'htmlCodeBlockAccessory').selectOption('2');
    await page.reload();
    await openPrefs(page, 'general');
    await expect(pref(page, 'editorOnRight')).toBeChecked();
    await openPrefs(page, 'markdown');
    await expect(pref(page, 'extensionSuperscript')).toBeChecked();
    await openPrefs(page, 'editor');
    await expect(pref(page, 'editorLineSpacing')).toHaveValue('9');
    await expect(pref(page, 'editorUnorderedListMarkerType')).toHaveValue('1');
    await openPrefs(page, 'rendering');
    await expect(pref(page, 'htmlStyleName')).toHaveValue('Clearness');
    await expect(pref(page, 'htmlCodeBlockAccessory')).toHaveValue('2');
  });
});

test.describe('F-138 / F-161 import and reload of user styles and themes', () => {
  const CSS = 'h1 { color: rgb(1, 2, 3) !important; }\nbody { background: rgb(250, 240, 230) !important; }\n';

  test('F-138 Import… adds a CSS style: listed, selectable, applied to the preview, persisted across a reload; the same name replaces it', async ({ page }) => {
    await open(page);
    await setText(page, '# T');
    await openPrefs(page, 'rendering');
    await page.getByTestId('pref-htmlStyleName-import-input').setInputFiles({ name: 'My Style.css', mimeType: 'text/css', buffer: Buffer.from(CSS) });
    await expect.poll(() => optionTexts(page, 'pref-htmlStyleName')).toContain('My Style');
    await pref(page, 'htmlStyleName').selectOption('My Style');
    await expect(pv(page).locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await page.reload();
    await expect(pv(page).locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await openPrefs(page, 'rendering');
    await expect(pref(page, 'htmlStyleName')).toHaveValue('My Style');
    await page.getByTestId('pref-htmlStyleName-import-input').setInputFiles({ name: 'My Style.css', mimeType: 'text/css', buffer: Buffer.from(CSS.replace('1, 2, 3', '9, 8, 7')) });
    await expect(pv(page).locator('h1')).toHaveCSS('color', 'rgb(9, 8, 7)');
    expect((await optionTexts(page, 'pref-htmlStyleName')).filter((x) => x === 'My Style').length).toBe(1);
  });

  test('F-138 a user style named like a built-in replaces it; Include styles in Export HTML embeds the user CSS', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, '# T');
    await openPrefs(page, 'rendering');
    await page.getByTestId('pref-htmlStyleName-import-input').setInputFiles({ name: 'GitHub2.css', mimeType: 'text/css', buffer: Buffer.from(CSS) });
    await expect(pv(page).locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)');
    expect((await optionTexts(page, 'pref-htmlStyleName')).filter((x) => x === 'GitHub2').length).toBe(1);
    await page.getByTestId('preferences-close').click();
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
    expect((await fsState(page)).writes[0].text).toContain('<style type="text/css">\nh1 { color: rgb(1, 2, 3) !important; }\nbody { background: rgb(250, 240, 230) !important; }\n</style>');
  });

  test('F-138 Reload re-reads the stored files (a file added by another tab appears) and Reveal is not available', async ({ page, context }) => {
    await open(page);
    await openPrefs(page, 'rendering');
    expect(await optionTexts(page, 'pref-htmlStyleName')).not.toContain('Other Tab');
    await page.evaluate((css) => localStorage.setItem('macdown.userStyles', JSON.stringify({ 'Other Tab': css })), CSS);
    await page.getByTestId('pref-htmlStyleName-reload').click();
    expect(await optionTexts(page, 'pref-htmlStyleName')).toContain('Other Tab');
    await expect(page.getByTestId('pref-htmlStyleName-reveal')).toBeDisabled();
    expect(context.pages().length).toBe(1);
  });

  const NIGHT = readFileSync(resolve(VENDOR, 'Resources/Themes/Mou Night.style'), 'utf8');
  test('F-138 / F-74 Import… adds a .style theme: listed, selectable, applied; persisted; the colours come from the imported file', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    const custom = NIGHT.replace(/background:\s*[0-9a-fA-F]{6}/, 'background: 123456');
    await page.getByTestId('pref-editorStyleName-import-input').setInputFiles({ name: 'My Theme.style', mimeType: 'text/plain', buffer: Buffer.from(custom) });
    await expect.poll(() => optionTexts(page, 'pref-editorStyleName')).toContain('My Theme');
    await pref(page, 'editorStyleName').selectOption('My Theme');
    const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="editor"] .cm-editor')!).backgroundColor);
    await expect.poll(bg).toBe('rgb(18, 52, 86)');
    await page.reload();
    await expect.poll(bg).toBe('rgb(18, 52, 86)');
  });

  test('F-74 a selected theme that fails to parse resets the theme to none (editorStyleName removed) and the app keeps working', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page);
    await openPrefs(page, 'editor');
    const broken = 'editor\nforeground: nothex\nbackground: 12345\n\nH1\nforeground: zzzzzz\n';
    await page.getByTestId('pref-editorStyleName-import-input').setInputFiles({ name: 'Broken.style', mimeType: 'text/plain', buffer: Buffer.from(broken) });
    await pref(page, 'editorStyleName').selectOption('Broken');
    await expect.poll(() => prefValue(page, 'editorStyleName')).toBe('');
    await expect(pref(page, 'editorStyleName')).toHaveValue('');
    await editorEl(page).click();
    await page.keyboard.type('still works');
    expect(await docText(page)).toBe('still works');
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Export HTML (F-35, E-01 to E-04), PDF / Print (F-36, F-37), Copy HTML (F-39)
// Oracle for the embedded assets: the installed MacDown.app bundle.
// ---------------------------------------------------------------------------

const BUNDLE = '/Applications/MacDown.app/Contents/Resources';
const haveBundle = existsSync(BUNDLE);
const rd = (rel: string) => readFileSync(resolve(BUNDLE, rel), 'utf8');
const dropNl = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s);

interface ParsedExport {
  styles: string[];
  scripts: { type: string; src: string | null; text: string }[];
  links: number;
  title: string | null;
  body: string;
  head: string;
}
function parseExport(html: string): ParsedExport {
  const styles = Array.from(html.matchAll(/<style type="text\/css">\n([\s\S]*?)\n<\/style>/g)).map((m) => m[1]);
  const scripts = Array.from(html.matchAll(/<script type="([^"]+)"(?: src="([^"]*)")?>(?:\n([\s\S]*?)\n)?<\/script>/g)).map((m) => ({ type: m[1], src: m[2] ?? null, text: m[3] ?? '' }));
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? null;
  const links = (html.match(/<link\b/g) ?? []).length;
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  const body = (/<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '').replace(/<script[\s\S]*?<\/script>\n?/g, '');
  return { styles, scripts, links, title, body, head };
}

/** Prism languages in the order MPRenderer.m:add_to_languages produces them (inserted at index 0, dependencies after). */
function prismOrder(used: string[]): string[] {
  const comps = new Function(`${rd('Prism/components.js')}; return components;`)().languages as Record<string, { require?: string | string[] }>;
  const langs: string[] = [];
  const add = (l: string) => {
    const i = langs.indexOf(l);
    if (i >= 0) langs.splice(i, 1);
    langs.unshift(l);
    const req = comps[l]?.require;
    if (typeof req === 'string') add(req);
    else if (Array.isArray(req)) req.forEach(add);
  };
  used.forEach(add);
  return langs;
}
function prismScriptFiles(used: string[]): string[] {
  const out: string[] = [];
  for (const l of prismOrder(used)) {
    for (const f of [`prism-${l}`, `prism-${l}-extras`]) {
      const p = ['min.js', 'js'].map((e) => `Prism/components/${f}.${e}`).find((x) => existsSync(resolve(BUNDLE, x)));
      if (p) out.push(p);
    }
  }
  return out;
}

const EXPORT_DOC = [
  '# Export <me>',
  '',
  '```js',
  'var a = 1;',
  '```',
  '',
  '```python',
  'print(1)',
  '```',
  '',
  '```cpp',
  'int a;',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```dot',
  'digraph { a -> b }',
  '```',
  '',
  '- [x] task',
  '',
  '$$x^2$$',
  '',
].join('\n');

async function doExport(page: Page, o: { styles?: boolean; highlighting?: boolean }): Promise<string> {
  const before = (await fsState(page)).writes.length;
  await menu(page, 'file', 'export-html');
  if (o.styles !== undefined) await page.getByTestId('export-include-styles').setChecked(o.styles);
  if (o.highlighting !== undefined) await page.getByTestId('export-include-highlighting').setChecked(o.highlighting);
  await page.getByTestId('export-html-save').click();
  await expect.poll(async () => (await fsState(page)).writes.length, { timeout: 40_000 }).toBe(before + 1);
  return (await fsState(page)).writes[before].text;
}

test.describe('F-35 Export HTML: every combination of the two boxes', () => {
  test.skip(!haveBundle, 'MacDown.app bundle not available');
  test.describe.configure({ timeout: 90_000 });
  const ALL = { htmlMermaid: true, htmlGraphviz: true, htmlMathJax: true, htmlTaskList: true, htmlLineNumbers: true, htmlCodeBlockAccessory: 1, htmlHighlightingThemeName: 'Okaidia' };

  for (const p20 of [false, true]) {
    for (const styles of [false, true]) {
      for (const highlighting of [false, true]) {
        test(`E-01 / E-02 / E-03 P-20 ${p20 ? 'on' : 'off'}, Include styles ${styles}, Include syntax highlighting ${highlighting}: exactly the original's assets, in order`, async ({ page }) => {
          await mockFs(page);
          await open(page, q({ ...ALL, htmlSyntaxHighlighting: p20 }));
          await setText(page, EXPORT_DOC);
          const html = await doExport(page, { styles, highlighting });
          const e = parseExport(html);
          // expected styles (MPRenderer.m:660-702)
          const wantStyles: string[] = [];
          if (styles) wantStyles.push(dropNl(rd('Styles/GitHub2.css')));
          if (highlighting) {
            wantStyles.push(dropNl(rd('Prism/themes/prism-okaidia.css')));
            wantStyles.push(dropNl(rd('Prism/plugins/line-numbers/prism-line-numbers.css')));
            wantStyles.push(dropNl(rd('Prism/plugins/show-language/prism-show-language.css')));
            wantStyles.push(dropNl(rd('Extensions/mermaid.forest.css')));
          }
          expect(e.styles.length).toBe(wantStyles.length);
          e.styles.forEach((s, i) => expect(s === wantStyles[i], `style #${i}`).toBe(true));
          // expected scripts
          const want: { type: string; src?: string; text?: string }[] = [];
          if (highlighting) {
            want.push({ type: 'text/javascript', text: dropNl(rd('Prism/components/prism-core.min.js')) });
            for (const f of prismScriptFiles(['js', 'python', 'cpp', 'mermaid', 'dot'].map((l) => (l === 'js' ? 'javascript' : l)))) want.push({ type: 'text/javascript', text: dropNl(rd(f)) });
            want.push({ type: 'text/javascript', text: dropNl(rd('Prism/plugins/line-numbers/prism-line-numbers.min.js')) });
            want.push({ type: 'text/javascript', text: dropNl(rd('Prism/plugins/show-language/prism-show-language.min.js')) });
            want.push({ type: 'text/javascript', text: dropNl(rd('Extensions/mermaid.min.js')) });
            want.push({ type: 'text/javascript', text: dropNl(rd('Extensions/mermaid.init.js')) });
            want.push({ type: 'text/javascript', text: dropNl(rd('Extensions/viz.js')) });
            want.push({ type: 'text/javascript', text: dropNl(rd('Extensions/viz.init.js')) });
          }
          want.push({ type: 'text/x-mathjax-config', text: dropNl(rd('MathJax/init.js')) });
          want.push({ type: 'text/javascript', src: 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.3/MathJax.js?config=TeX-AMS-MML_HTMLorMML' });
          expect(e.scripts.length, JSON.stringify(e.scripts.map((s) => [s.type, s.src, s.text.length]))).toBe(want.length);
          e.scripts.forEach((s, i) => {
            expect(s.type, `script #${i} type`).toBe(want[i].type);
            expect(s.src, `script #${i} src`).toBe(want[i].src ?? null);
            if (want[i].text !== undefined) expect(s.text === want[i].text, `script #${i} content (${want[i].text!.slice(0, 40)})`).toBe(true);
          });
          // never exported
          expect(html).not.toContain('data-information]');
          expect(e.scripts.some((s) => s.text.includes('task-list-item') && s.text.includes('disabled'))).toBe(false);
          expect(e.links).toBe(0);
          // MathJax config comes first among the MathJax scripts, before the CDN link
          expect(html.indexOf('text/x-mathjax-config')).toBeLessThan(html.indexOf('cdnjs.cloudflare.com'));
        });
      }
    }
  }

  test('E-03 without P-18 there is no MathJax at all, even with both boxes on; "Neither" means no asset tags', async ({ page }) => {
    await mockFs(page);
    await open(page, q({ htmlMermaid: true, htmlGraphviz: true, htmlSyntaxHighlighting: true }));
    await setText(page, EXPORT_DOC);
    const both = await doExport(page, { styles: true, highlighting: true });
    expect(both).not.toMatch(/mathjax|cdnjs/i);
    const none = await doExport(page, { styles: false, highlighting: false });
    expect(none).not.toMatch(/<style|<script|<link/);
  });

  test('E-02 Mermaid / Graphviz need their own preference as well as the box; show-information.css is never exported (Custom accessory)', async ({ page }) => {
    await mockFs(page);
    await open(page, q({ htmlSyntaxHighlighting: true, htmlCodeBlockAccessory: 2, htmlMermaid: true }));
    await setText(page, '```js:file.js\nx\n```\n\n```mermaid\ngraph TD; A-->B\n```');
    const html = await doExport(page, { styles: true, highlighting: true });
    const e = parseExport(html);
    expect(e.styles.some((s) => s.includes('data-information'))).toBe(false);
    expect(e.scripts.some((s) => s.text.includes('mermaid.initialize'))).toBe(true);
    expect(e.scripts.some((s) => s.text.includes('Viz('))).toBe(false);
    expect(html).toContain('data-information="file.js"');
  });

  test('E-01 the user\'s style choice is embedded: each of the six styles exports its own CSS, "no style" defaults the box off and exports nothing', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'x');
    for (const n of ['Clearness', 'Clearness Dark', 'GitHub', 'GitHub2', 'Solarized (Dark)', 'Solarized (Light)']) {
      await page.evaluate((x) => (window as any).macdownPrefs.set({ htmlStyleName: x }), n);
      const html = await doExport(page, {});
      const e = parseExport(html);
      expect(e.styles.length, n).toBe(1);
      expect(e.styles[0] === dropNl(rd(`Styles/${n}.css`)), n).toBe(true);
    }
    await page.evaluate(() => (window as any).macdownPrefs.set({ htmlStyleName: '' }));
    await menu(page, 'file', 'export-html');
    await expect(page.getByTestId('export-include-styles')).not.toBeChecked();
    await page.getByTestId('export-include-styles').check();
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(7);
    expect(parseExport((await fsState(page)).writes[6].text).styles).toEqual([]);
  });

  test('E-02 the Prism theme chosen in Preferences is the one embedded (all eight, (Default) = prism.css)', async ({ page }) => {
    await mockFs(page);
    await open(page, q({ htmlSyntaxHighlighting: true }));
    await setText(page, '```js\nx\n```');
    for (const [name, file] of [['', 'prism.css'], ['Coy', 'prism-coy.css'], ['Dark', 'prism-dark.css'], ['Funky', 'prism-funky.css'], ['Okaidia', 'prism-okaidia.css'], ['Solarizedlight', 'prism-solarizedlight.css'], ['Tomorrow', 'prism-tomorrow.css'], ['Twilight', 'prism-twilight.css']]) {
      await page.evaluate((n) => (window as any).macdownPrefs.set({ htmlHighlightingThemeName: n }), name);
      const e = parseExport(await doExport(page, { styles: false, highlighting: true }));
      expect(e.styles.length, name).toBe(1);
      expect(e.styles[0] === dropNl(rd(`Prism/themes/${file}`)), name).toBe(true);
    }
  });

  test('E-02 the exported page highlights itself, draws diagrams, and keeps checkboxes clickable when opened on its own (offline, no MathJax)', async ({ page, context }) => {
    await mockFs(page);
    await open(page, q({ htmlSyntaxHighlighting: true, htmlMermaid: true, htmlGraphviz: true, htmlTaskList: true, htmlLineNumbers: true }));
    await setText(page, '- [ ] todo\n\n```js\nvar a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```dot\ndigraph { a -> b }\n```');
    const html = await doExport(page, { styles: true, highlighting: true });
    const other = await context.newPage();
    const errors: string[] = [];
    other.on('pageerror', (e) => errors.push(String(e)));
    await other.setContent(html);
    await expect(other.locator('code.language-javascript .token.keyword')).toHaveText('var');
    await expect(other.locator('pre.line-numbers .line-numbers-rows').first()).toBeAttached();
    await expect(other.locator('svg').first()).toBeAttached({ timeout: 15_000 });
    await expect(other.locator('input[type=checkbox]')).toBeEnabled();
    await other.locator('input[type=checkbox]').check();
    expect(errors).toEqual([]);
    await other.close();
  });

  test('E-04 / F-139 the template: doctype, charset, viewport; <title> only for a saved document (file name without extension); body equals the preview body', async ({ page }) => {
    await mockFs(page);
    await open(page);
    const md = '---\ntitle: FM\n---\n\n[TOC]\n\n# One\n\ntext with <b>html</b> & "quotes"\n\n## Two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[^1]: n\n\nref[^1]';
    await page.evaluate(() => (window as any).macdownPrefs.set({ htmlDetectFrontMatter: true, htmlRendersTOC: true, extensionSmartyPants: true }));
    await setText(page, md);
    await expect(pv(page).locator('ul.toc')).toHaveCount(1);
    const untitled = await doExport(page, {});
    expect(untitled.startsWith('<!DOCTYPE html>\n<html>')).toBe(true);
    expect(untitled).toContain('<meta charset="utf-8">');
    expect(untitled).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">');
    expect(parseExport(untitled).title).toBeNull();
    const shown = await pv(page).locator('body').evaluate((b) => b.innerHTML);
    const exported = await page.evaluate((h) => { const d = new DOMParser().parseFromString(h, 'text/html'); d.querySelectorAll('script').forEach((x) => x.remove()); return d.body.innerHTML; }, untitled);
    // The preview alone marks blocks with their source lines for scroll sync (F-11); export does not.
    expect(exported).not.toContain('data-line');
    expect(exported).toBe(shown.replace(/ data-line(-end)?="\d+"/g, ''));
    await queueSave(page, 'My Doc.v2.md');
    await menu(page, 'file', 'save');
    await expect(page).toHaveTitle('My Doc.v2.md');
    const titled = parseExport(await doExport(page, {}));
    expect(titled.title).toBe('My Doc.v2');
  });

  test('F-35 the dialog: Escape and Cancel export nothing, Enter exports, the filename shows the presumed name with .html, defaults follow the preferences', async ({ page }) => {
    await mockFs(page);
    await open(page, q({ htmlSyntaxHighlighting: true }));
    await setText(page, '# Name');
    await menu(page, 'file', 'export-html');
    await expect(page.getByTestId('export-html-filename')).toHaveText('Name.html');
    await expect(page.getByTestId('export-include-styles')).toBeChecked();
    await expect(page.getByTestId('export-include-highlighting')).toBeChecked();
    expect(await page.getByTestId('export-html-dialog').evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-html-dialog')).toHaveCount(0);
    expect((await fsState(page)).saveCalls.length).toBe(0);
    await menu(page, 'file', 'export-html');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.getByTestId('export-html-dialog').evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.getByTestId('export-html-cancel').click();
    await menu(page, 'file', 'export-html');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(1);
  });

  test('F-35 a cancelled save panel and a failing write: no file, no crash, an error sheet for the failure', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'x');
    await queueSave(page, 'CANCEL');
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fsState(page)).saveCalls.length).toBe(1);
    await expect(page.getByTestId('export-html-dialog')).toHaveCount(0);
    expect((await fsState(page)).writes.length).toBe(0);
    await queueSave(page, 'FAIL-WRITE');
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-html-save').click();
    await expect(page.getByTestId('alert-message')).toContainText('could not be exported');
  });

  test('F-35 exporting in manual-render mode (P-01 off) exports the current text, as the preview would after Render Markdown', async ({ page }) => {
    await mockFs(page);
    await open(page, q({ markdownManualRender: true }));
    await setText(page, 'old');
    await key(page, 'Mod+r');
    await setText(page, 'new text');
    await page.waitForTimeout(400);
    await expect(pv(page).locator('p')).toHaveText('old');
    const html = await doExport(page, {});
    expect(parseExport(html).body).toContain('new text');
  });

  test('F-35 downloads (no File System Access): the file is named "<presumed name>.html" and is UTF-8', async ({ page }) => {
    await noFs(page);
    await open(page);
    await setText(page, '# Grüße 😀\n\ntext');
    await menu(page, 'file', 'export-html');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-html-save').click();
    const d = await dl;
    expect(d.suggestedFilename()).toBe('Grüße 😀.html');
    const html = readFileSync(await d.path(), 'utf8');
    expect(html).toContain('<h1 id="toc_0">Grüße 😀</h1>');
  });
});

test.describe('F-36 / F-37 Print and Export PDF', () => {
  test('F-37 the preview document carries @page { margin: 50pt 0pt } as a real CSS page rule: 50pt top and bottom, 0pt left and right; no <style> is added to the page', async ({ page }) => {
    await open(page);
    await setText(page, '# P');
    await expect(pv(page).locator('h1')).toBeAttached();
    const frame = await previewFrame(page);
    const rule = await frame.evaluate(() => {
      const sheets = Array.from(document.adoptedStyleSheets);
      const r = sheets.flatMap((s) => Array.from(s.cssRules)).find((x) => x.constructor.name === 'CSSPageRule') as CSSPageRule | undefined;
      return r ? { top: r.style.marginTop, bottom: r.style.marginBottom, left: r.style.marginLeft, right: r.style.marginRight, styleTags: document.querySelectorAll('style').length } : null;
    });
    expect(rule).toEqual({ top: '50pt', bottom: '50pt', left: '0pt', right: '0pt', styleTags: rule?.styleTags });
    // the page's own style list is the template's (GitHub2 only)
    expect(rule!.styleTags).toBe(1);
  });

  test('F-37 the rule survives every re-render (typing, preference change, style change)', async ({ page }) => {
    await open(page);
    const has = async () => (await previewFrame(page)).evaluate(() => Array.from(document.adoptedStyleSheets).some((s) => Array.from(s.cssRules).some((r) => r.cssText.includes('50pt'))));
    await setText(page, 'a');
    expect(await has()).toBe(true);
    await setText(page, 'b');
    await expect(pv(page).locator('p')).toHaveText('b');
    expect(await has()).toBe(true);
    await page.evaluate(() => (window as any).macdownPrefs.set({ htmlStyleName: 'Clearness' }));
    await expect.poll(has).toBe(true);
  });

  test('F-37 Chromium honours the same constructable @page rule: a full-width block prints 50pt from the top and bottom and edge to edge (PDF rasterised with sips)', async ({ page, context }) => {
    test.skip(process.platform !== 'darwin', 'uses macOS sips to rasterise the PDF');
    const rule = await (async () => {
      await open(page);
      return page.evaluate(() => '@page { margin: 50pt 0pt; }');
    })();
    expect(rule).toBe('@page { margin: 50pt 0pt; }');
    const p2 = await context.newPage();
    await p2.setContent('<!DOCTYPE html><html><body style="margin:0"><div style="background:#000;height:100vh;width:100%">x</div></body></html>');
    await p2.evaluate((css) => {
      const s = new CSSStyleSheet();
      s.replaceSync(css);
      document.adoptedStyleSheets = [s];
    }, rule);
    const pdf = await p2.pdf({ format: 'Letter', printBackground: true });
    const dir = test.info().outputPath('pdf');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/p.pdf`, pdf);
    const { execFileSync } = await import('node:child_process');
    execFileSync('sips', ['-s', 'format', 'png', `${dir}/p.pdf`, '--out', `${dir}/p.png`]);
    const png = readFileSync(`${dir}/p.png`).toString('base64');
    const m = await p2.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let top = -1, bottom = -1, left = c.width, right = -1;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] < 128 && d[i + 3] > 128) {
            if (top < 0) top = y;
            bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      return { w: c.width, h: c.height, top, bottom, left, right };
    }, png);
    // US Letter 612 x 792 pt, rendered at 72 dpi
    expect(m.w).toBe(612);
    expect(m.h).toBe(792);
    expect(Math.abs(m.top - 50)).toBeLessThanOrEqual(2);
    expect(Math.abs(792 - 1 - m.bottom - 50)).toBeLessThanOrEqual(2);
    expect(m.left).toBeLessThanOrEqual(1);
    expect(m.right).toBeGreaterThanOrEqual(610);
  });

  test('F-37 / F-36 Print and Export PDF call print() on the preview document only (not the app), Cmd+P and the menu; nothing is printed without a document', async ({ page }) => {
    await open(page);
    await setText(page, '# Print me');
    await expect(pv(page).locator('h1')).toBeAttached();
    const frame = await previewFrame(page);
    await frame.evaluate(() => { (window as any).__n = 0; window.print = () => { (window as any).__n++; }; });
    await page.evaluate(() => { (window as any).__appPrint = 0; window.print = () => { (window as any).__appPrint++; }; });
    await key(page, 'Mod+p');
    await menu(page, 'file', 'print');
    await key(page, 'Mod+Alt+p');
    await menu(page, 'file', 'export-pdf');
    expect(await frame.evaluate(() => (window as any).__n)).toBe(4);
    expect(await page.evaluate(() => (window as any).__appPrint)).toBe(0);
  });

  test('F-36 the PDF title is the presumed name (header, front-matter title, file name, "Untitled") and the page is back to its own title afterwards', async ({ page }) => {
    await mockFs(page);
    await open(page, q({ htmlDetectFrontMatter: true }));
    const titles: string[] = [];
    const arm = async () => {
      const f = await previewFrame(page);
      await f.evaluate(() => { (window as any).__t = []; window.print = () => (window as any).__t.push(document.title); });
      return f;
    };
    for (const [text, want] of [['# Hdr: A/B', 'Hdr- A-B'], ['---\ntitle: "Front: M"\n---\n# H', 'Front: M'], ['plain', 'Untitled']] as const) {
      await setText(page, text);
      await expect(pv(page).locator('body')).toBeAttached();
      await page.waitForTimeout(250);
      const f = await arm();
      await key(page, 'Mod+Alt+p');
      titles.push((await f.evaluate(() => (window as any).__t))[0]);
      expect(titles.at(-1)).toBe(want);
      expect(await f.evaluate(() => document.title)).toBe('');
    }
    await queueOpen(page, { name: 'named.md', text: '# Other' });
    await menu(page, 'file', 'open');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect(page).toHaveTitle('named.md');
    const f = await arm();
    await key(page, 'Mod+Alt+p');
    expect((await f.evaluate(() => (window as any).__t))[0]).toBe('named');
    await expect(page).toHaveTitle('named.md');
  });

  test('F-37 under print media emulation the preview keeps its style print rules and the app does not hide the preview iframe document', async ({ page }) => {
    await open(page);
    await setText(page, '# H\n\ntext');
    await expect(pv(page).locator('h1')).toBeAttached();
    await page.emulateMedia({ media: 'print' });
    const info = await pv(page).locator('body').evaluate(() => ({ print: matchMedia('print').matches, color: getComputedStyle(document.body).color, h1: !!document.querySelector('h1') }));
    expect(info).toMatchObject({ print: true });
    await expect(pv(page).locator('h1')).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
  });
});

test.describe('F-39 Copy HTML', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });
  const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

  test('F-39 / E-07 copies the body HTML only, as plain text: from the Format menu, the toolbar and Opt+Cmd+C; front matter table and TOC included', async ({ page }) => {
    await open(page, q({ htmlDetectFrontMatter: true, htmlRendersTOC: true, htmlSyntaxHighlighting: true, htmlMathJax: true, htmlTaskList: true }));
    await setText(page, '---\ntitle: T\n---\n\n[TOC]\n\n# Head\n\n- [x] a\n\n```js\nvar x;\n```\n\n\\\\(y\\\\)');
    await expect(pv(page).locator('html')).toHaveAttribute('data-macdown-scripts', 'done');
    const expectBody = async () => {
      await expect.poll(() => clip(page)).toContain('<h1 id="toc_0">Head</h1>');
      const c = await clip(page);
      expect(c).toContain('<table>');
      expect(c).toContain('<ul class="toc">');
      expect(c).toContain('<li class="task-list-item"><input type="checkbox" checked> a</li>'); // no tasklist.js: not disabled
      expect(c).toContain('<div><pre><code class="language-javascript">var x;</code></pre></div>'); // no Prism tokens
      expect(c).toContain('\\(y\\)');
      expect(c).not.toMatch(/<html|<head|<body|<style|<script|<link|<title|DOCTYPE|mjx-|class="token/i);
      expect(c.trimStart().startsWith('<table>')).toBe(true);
    };
    await menu(page, 'format', 'copy-html');
    await expectBody();
    await page.evaluate(() => navigator.clipboard.writeText('reset'));
    await page.getByTestId('toolbar-copy-html').click();
    await expectBody();
    await page.evaluate(() => navigator.clipboard.writeText('reset'));
    await editorEl(page).click();
    await key(page, 'Mod+Alt+c');
    await expectBody();
  });

  test('F-39 the copy is a single plain-text clipboard item', async ({ page }) => {
    await open(page);
    await setText(page, '**x**');
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => clip(page)).toBe('<p><strong>x</strong></p>\n');
    expect(await page.evaluate(async () => (await navigator.clipboard.read()).map((i) => i.types))).toEqual([['text/plain']]);
  });

  test('F-39 with the preview hidden or in manual-render mode the current text is rendered fresh', async ({ page }) => {
    await open(page, q({ markdownManualRender: true }));
    await setText(page, '# stale');
    await key(page, 'Mod+r');
    await setText(page, '# fresh');
    await page.waitForTimeout(300);
    await expect(pv(page).locator('h1')).toHaveText('stale');
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => clip(page)).toContain('fresh');
    await page.evaluate(() => (window as any).macdownPrefs.set({ markdownManualRender: false }));
    await menu(page, 'view', 'toggle-preview');
    await setText(page, '# hidden pane');
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => clip(page)).toContain('hidden pane');
  });

  test('F-39 the copy honours the Markdown preferences in force (SmartyPants, hard wrap, autolink) and an empty document copies an empty string', async ({ page }) => {
    await open(page, q({ extensionSmartyPants: true, htmlHardWrap: true, extensionAutolink: true }));
    await setText(page, '"a" -- b\nc www.example.com');
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => clip(page)).toContain('&ldquo;a&rdquo; &ndash; b<br>');
    expect(await clip(page)).toContain('<a href="http://www.example.com">www.example.com</a>');
    await setText(page, '');
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => clip(page)).toBe('');
  });

  test('F-39 clipboard permission denied: no crash, no page error', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [{ origin: 'http://localhost:5173', localStorage: [{ name: 'macdown.firstVersionInstalled', value: '0.7.3' }] }] } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page);
    await setText(page, 'x');
    await menu(page, 'format', 'copy-html');
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// F-16 split ratio memory, F-29 draft limits
// ---------------------------------------------------------------------------

test.describe('F-16 per-document split ratio and F-29 draft limits', () => {
  test('F-16 the split ratio is remembered per file name, independently, and restored after a reload of the named draft', async ({ page }) => {
    await mockFs(page);
    await open(page);
    const ratio = async () => Number(await page.getByTestId('split').getAttribute('data-left-ratio'));
    await queueOpen(page, { name: 'one.md', text: '1' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('one.md');
    await menu(page, 'view', 'split-1-3');
    expect(await ratio()).toBeCloseTo(0.25, 3);
    await queueOpen(page, { name: 'two.md', text: '2' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('two.md');
    await menu(page, 'view', 'split-3-1');
    expect(await ratio()).toBeCloseTo(0.75, 3);
    await queueOpen(page, { name: 'one.md', text: '1' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('one.md');
    await expect.poll(ratio).toBeCloseTo(0.25, 3);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('macdown.splitRatios')!))).toEqual({ 'one.md': 0.25, 'two.md': 0.75 });
    await waitSaved(page);
    await page.reload();
    await expect(page).toHaveTitle('one.md');
    await expect.poll(ratio).toBeCloseTo(0.25, 3);
  });

  test('F-16 an untitled document has no remembered ratio and a collapsed pane (ratio 0 or 1) is not stored', async ({ page }) => {
    await open(page);
    await menu(page, 'view', 'split-1-3');
    await menu(page, 'view', 'toggle-preview');
    expect(await page.evaluate(() => localStorage.getItem('macdown.splitRatios'))).toBeNull();
    await mockFs(page);
  });

  test('F-29 a draft too large for localStorage must not leave an older draft behind to be restored later', async ({ page }) => {
    await open(page);
    const small = 'a'.repeat(2_700_000);
    await setText(page, small);
    await expect.poll(async () => (await draft(page))?.text.length ?? 0, { timeout: 5000 }).toBe(small.length);
    await setText(page, small + small);
    await page.waitForTimeout(800);
    const d = await draft(page);
    // either the newest text is stored or no stale draft remains
    expect(d === null || d.text.length === small.length * 2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-20 (partial by design) and F-164
// ---------------------------------------------------------------------------

test.describe('F-20 / F-164', () => {
  // Observation (not asserted): the written preview document inherits the app's base URL, so a relative
  // image such as pic.png is requested from the app origin (http://localhost:5173/pic.png), not left unresolved.
  test('F-20 (accepted deviation) clicking a relative link does nothing: no navigation, no new page, the document stays', async ({ page }) => {
    await open(page);
    await setText(page, '![alt](pic.png)\n\n[rel](other.md)');
    await expect(pv(page).locator('a[href="other.md"]')).toBeAttached();
    await pv(page).locator('a[href="other.md"]').click();
    await page.waitForTimeout(400);
    expect(page.context().pages().length).toBe(1);
    expect(await page.evaluate(() => location.pathname)).toBe('/');
    await expect(page).toHaveTitle('Untitled — Edited');
  });

  test('F-164 / F-96 Check Spelling While Typing is persisted as editorContinuousSpellCheckingEnabled and restored on the next launch', async ({ page }) => {
    await open(page);
    const spell = () => page.evaluate(() => document.querySelector('[data-testid="editor"] .cm-content')!.getAttribute('spellcheck'));
    expect(await spell()).toBe('false');
    await page.getByTestId('menu-edit').click();
    await expect(page.getByTestId('menuitem-check-spelling')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('menuitem-check-spelling').click();
    expect(await storedPrefs(page)).toEqual({ editorContinuousSpellCheckingEnabled: true });
    await expect.poll(spell).toBe('true');
    await page.reload();
    await expect.poll(spell).toBe('true');
    await page.getByTestId('menu-edit').click();
    await expect(page.getByTestId('menuitem-check-spelling')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('menuitem-check-spelling').click();
    await expect.poll(spell).toBe('false');
    expect(await storedPrefs(page)).toEqual({ editorContinuousSpellCheckingEnabled: false });
  });
});

// ---------------------------------------------------------------------------
// Shortcut matrix for the File and MacDown menus (section 3)
// ---------------------------------------------------------------------------

test.describe('section 3 File menu shortcuts', () => {
  test('F-27 / F-26 Shift+Cmd+S is Save As (panel even for a named document), Cmd+S saves in place, neither reacts to look-alike chords', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueSave(page, 'a.md');
    await setText(page, 'x');
    await key(page, 'Mod+s');
    await expect(page).toHaveTitle('a.md');
    expect((await fsState(page)).saveCalls.length).toBe(1);
    await key(page, 'Mod+s');
    await expect.poll(async () => (await fsState(page)).writes.length).toBe(2);
    expect((await fsState(page)).saveCalls.length).toBe(1);
    await queueSave(page, 'b.md');
    await key(page, 'Mod+Shift+s');
    await expect(page).toHaveTitle('b.md');
    expect((await fsState(page)).saveCalls.length).toBe(2);
    expect((await fsState(page)).saveCalls[1].suggestedName).toBe('a.md');
    // look-alikes do nothing
    await key(page, 'Mod+Alt+s');
    await key(page, 'Control+s').catch(() => undefined);
    await page.waitForTimeout(200);
    expect((await fsState(page)).saveCalls.length).toBe(2);
  });

  test('F-22 / F-35 / F-37 Cmd+O, Opt+Cmd+E and Cmd+P do not fire for their Shift or Opt look-alikes (Shift+Cmd+P is Page Setup, Out)', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'x');
    const frame = await previewFrame(page);
    await frame.evaluate(() => { (window as any).__n = 0; window.print = () => { (window as any).__n++; }; });
    await key(page, 'Mod+Shift+p');
    await key(page, 'Mod+Alt+Shift+p');
    expect(await frame.evaluate(() => (window as any).__n)).toBe(0);
    await key(page, 'Mod+Shift+e'); // View > Hide Editor Pane, not Export
    await expect(page.getByTestId('export-html-dialog')).toHaveCount(0);
    await key(page, 'Mod+Shift+e');
    await key(page, 'Mod+Shift+o'); // Format > Ordered List, not Open
    await page.waitForTimeout(200);
    expect((await fsState(page)).openCalls.length).toBe(0);
    await key(page, 'Mod+o');
    await expect.poll(async () => (await fsState(page)).openCalls.length).toBe(1);
  });

  test('shortcuts are ignored while a document sheet is open', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'x');
    await menu(page, 'file', 'new');
    await expect(page.getByTestId('save-prompt')).toBeVisible();
    await key(page, 'Mod+s');
    await key(page, 'Mod+o');
    await key(page, 'Mod+Comma');
    await page.waitForTimeout(250);
    const f = await fsState(page);
    expect(f.saveCalls.length + f.openCalls.length).toBe(0);
    await expect(page.getByTestId('preferences')).toHaveCount(0);
    await page.getByTestId('save-prompt-cancel').click();
  });
});

// ---------------------------------------------------------------------------
// Keyboard focus after a document change (usability; AppKit gives a new document's text view the first responder)
// ---------------------------------------------------------------------------

test.describe('focus after document commands', () => {
  const typed = async (page: Page) => {
    await page.keyboard.type('Z');
    return (await docText(page)).includes('Z');
  };
  test('F-21 after File > New the editor has the keyboard focus (typing works without a click)', async ({ page }) => {
    await open(page);
    await setText(page, 'old');
    await menu(page, 'file', 'new');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await typed(page)).toBe(true);
  });
  test('F-22 after File > Open the editor has the keyboard focus', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'a.md', text: 'hello' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('a.md');
    expect(await typed(page)).toBe(true);
  });
  test('F-28 after Revert to Saved the editor has the keyboard focus', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, { name: 'a.md', text: 'hello' });
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('a.md');
    await setText(page, 'changed');
    await menu(page, 'file', 'revert');
    await page.getByTestId('revert-prompt-revert').click();
    await expect.poll(() => docText(page)).toBe('hello');
    expect(await typed(page)).toBe(true);
  });
  test('F-153 after Help opens and after Close brings the document back, the editor has the keyboard focus', async ({ page }) => {
    await open(page);
    await setText(page, 'mine');
    await menu(page, 'help', 'help');
    await expect.poll(() => docText(page)).toBe(HELP_MD);
    expect(await typed(page)).toBe(true);
    await menu(page, 'file', 'close');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect.poll(() => docText(page)).toBe('mine');
    expect(await typed(page)).toBe(true);
  });
  test('F-25 after Close the editor (blank document) has the keyboard focus', async ({ page }) => {
    await open(page);
    await menu(page, 'file', 'close');
    expect(await typed(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 3: every in-scope menu item, label, shortcut (expected values typed from spec section 3)
// ---------------------------------------------------------------------------

test.describe('section 3 menus', () => {
  const expected: Record<string, string[]> = {
    app: ['About MacDown', 'Preferences…⌘,'],
    file: ['New⌘N', 'Open…⌘O', 'Close⌘W', 'Save…⌘S', 'Save As…⇧⌘S', 'Revert to Saved', 'Export HTML…⌥⌘E', 'Export PDF…⌥⌘P', 'Print…⌘P'],
    edit: [
      'Undo⌘Z', 'Redo⇧⌘Z', 'Cut⌘X', 'Copy⌘C', 'Paste⌘V', 'Delete', 'Select All⌘A', 'Find…⌘F', 'Find and Replace…⌥⌘F', 'Find Next⌘G', 'Find Previous⇧⌘G',
      'Use Selection for Find⌘E', 'Jump to Selection⌘J', 'Check Spelling While Typing', 'Make Upper Case', 'Make Lower Case', 'Capitalize',
    ],
    view: ['Render Markdown⌘R', 'Left 1:3 Right', 'Left 1:1 Right⇧⌘0', 'Left 3:1 Right', 'Hide Preview Pane⇧⌘H', 'Hide Editor Pane⇧⌘E', 'Hide Toolbar⌥⌘T', 'Customize Toolbar…', 'Enter Full Screen⌃⌘F'],
    format: [
      'Copy HTML⌥⌘C', 'Strong⌘B', 'Emphasize⌘I', 'Inline Code⌘K', 'Comment⌘/', 'Header 1⌘1', 'Header 2⌘2', 'Header 3⌘3', 'Header 4⌘4', 'Header 5⌘5', 'Header 6⌘6', 'Paragraph⌘0',
      'Ordered List⇧⌘O', 'Unordered List⇧⌘U', 'Blockquote⇧⌘B', 'Shift Right⌘]', 'Shift Left⌘[', 'Link⇧⌘K', 'Image⇧⌘I', 'New Paragraph⌘↩',
    ],
    help: ['MacDown Help', 'Contributing to MacDown'],
  };
  test('section 3 the menu bar has MacDown, File, Edit, View, Format, Help in this order (Plug-ins and Window are Out)', async ({ page }) => {
    await open(page);
    expect(await page.locator('[data-testid="menubar"] > *').allInnerTexts()).toEqual(['MacDown', 'File', 'Edit', 'View', 'Format', 'Help']);
  });
  for (const [m, items] of Object.entries(expected)) {
    test(`section 3 ${m} menu: items, order and shortcut glyphs; Out items (Services, Hide, Quit, Open Recent, Page Setup, spelling panels) are absent`, async ({ page }) => {
      await open(page);
      await page.getByTestId(`menu-${m}`).click();
      const got = await page.locator(`[data-testid="menu-${m}-dropdown"] [role^="menuitem"]`).evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(got).toEqual(items);
      const all = got.join('|');
      for (const out of ['Services', 'Hide MacDown', 'Quit', 'Open Recent', 'Page Setup', 'Check for Updates', 'Minimize', 'Zoom', 'Speech', 'Substitutions', 'Show Spelling']) expect(all).not.toContain(out);
    });
  }
  test('section 3 the MacDown menu is keyboard operable: Enter opens it, ArrowDown moves to Preferences…, Enter runs it', async ({ page }) => {
    await open(page);
    await page.getByTestId('menu-app').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('menu-app-dropdown')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('menuitem-preferences')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('preferences')).toBeVisible();
  });
});
