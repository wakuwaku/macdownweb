/**
 * M5: files (spec §2.2), export/print/copy (§2.3, §9), preferences (§8,
 * F-140, F-141) and help/about (§2.8). The File System Access API is mocked
 * (showOpenFilePicker / showSaveFilePicker); the fallbacks are tested with
 * Playwright's file chooser and download events.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { editorEl, mod, open, preview, splitState } from './helpers';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HELP_MD = readFileSync(resolve(ROOT, 'src/document/assets/help.md'), 'utf8');
const CONTRIBUTE_MD = readFileSync(resolve(ROOT, 'src/document/assets/contribute.md'), 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mocks the File System Access pickers. `__fs.openQueue` / `__fs.saveQueue` feed them; 'CANCEL' dismisses. */
async function mockFs(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const fs: any = { writes: [] as { name: string; text: string }[], saveCalls: [] as any[], openCalls: 0, openQueue: [] as any[], saveQueue: [] as any[] };
    w.__fs = fs;
    const mk = (name: string, content = '') => {
      const h: any = {
        kind: 'file',
        name,
        content,
        async getFile() {
          return new File([h.content], name, { type: 'text/markdown' });
        },
        async createWritable() {
          let buf = '';
          return {
            async write(d: Blob | string) {
              buf += typeof d === 'string' ? d : await d.text();
            },
            async close() {
              h.content = buf;
              fs.writes.push({ name, text: buf });
            },
          };
        },
        async queryPermission() {
          return 'granted';
        },
        async requestPermission() {
          return 'granted';
        },
      };
      return h;
    };
    fs.mk = mk;
    w.showOpenFilePicker = async () => {
      fs.openCalls++;
      const next = fs.openQueue.shift();
      if (!next || next === 'CANCEL') throw new DOMException('The user aborted a request.', 'AbortError');
      return [mk(next.name, next.text)];
    };
    w.showSaveFilePicker = async (o: any) => {
      fs.saveCalls.push(o);
      const next = fs.saveQueue.shift();
      if (next === 'CANCEL') throw new DOMException('The user aborted a request.', 'AbortError');
      return mk(next ?? o?.suggestedName ?? 'Untitled.md');
    };
  });
}

/** No File System Access API: the input/download fallbacks are used. */
async function noFs(page: Page) {
  await page.addInitScript(() => {
    for (const k of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true });
  });
}

const fs = (page: Page) => page.evaluate(() => { const f = (window as any).__fs; return { writes: f.writes, saveCalls: f.saveCalls, openCalls: f.openCalls }; });
const queueOpen = (page: Page, name: string, text: string) => page.evaluate(([n, t]) => (window as any).__fs.openQueue.push({ name: n, text: t }), [name, text]);
const queueSave = (page: Page, name: string) => page.evaluate((n) => (window as any).__fs.saveQueue.push(n), name);
const docText = (page: Page) => page.evaluate(() => (window as any).macdownEditor.text() as string);
const setText = (page: Page, t: string, from?: number, to?: number) => page.evaluate(([x, a, b]) => (window as any).macdownEditor.set(x, a ?? undefined, b ?? undefined), [t, from ?? null, to ?? null] as const);
const docInfo = (page: Page) => page.evaluate(() => (window as any).macdownDocument.info());
const menu = async (page: Page, m: string, item: string) => {
  await page.getByTestId(`menu-${m}`).click();
  await page.getByTestId(`menuitem-${item}`).click();
};
const press = async (page: Page, keys: string) => page.keyboard.press(keys.replace('Mod', await mod(page)));
const pv = (page: Page) => preview(page);
const pref = (page: Page, key: string) => page.getByTestId(`pref-${key}`);
const prefsValue = (page: Page, key: string) => page.evaluate((k) => (window as any).macdownPrefs.get()[k], key);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('macdown.preferences') ?? '{}'));
const openPrefs = async (page: Page, pane?: string) => {
  await menu(page, 'app', 'preferences');
  await expect(page.getByTestId('preferences')).toBeVisible();
  if (pane) await page.getByTestId(`preferences-tab-${pane}`).click();
};
/** The preview iframe's frame (for spying on its window). */
const previewFrame = async (page: Page) => (await (await page.getByTestId('preview-iframe').elementHandle())!.contentFrame())!;

async function waitPreview(page: Page, selector: string) {
  await expect(pv(page).locator(selector).first()).toBeAttached();
}

// ---------------------------------------------------------------------------
// §2.2 Files
// ---------------------------------------------------------------------------

test.describe('§2.2 files: New, Open, Save, Save As, Revert, Close', () => {
  test('F-34 / F-16 an empty untitled document is not edited: title "Untitled", New needs no prompt', async ({ page }) => {
    await open(page);
    await expect(page).toHaveTitle('Untitled');
    await menu(page, 'file', 'new');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    await expect(page).toHaveTitle('Untitled');
  });

  test('F-16 / F-34 typing marks the document edited in the title', async ({ page }) => {
    await open(page);
    await editorEl(page).click();
    await page.keyboard.type('x');
    await expect(page).toHaveTitle('Untitled — Edited');
    await page.keyboard.press('Backspace');
    await expect(page).toHaveTitle('Untitled');
  });

  test('F-21 New on an edited document asks to save: Cancel keeps it, Don\'t Save gives a blank document with a fresh undo history', async ({ page }) => {
    await open(page);
    await setText(page, 'draft text');
    await menu(page, 'file', 'new');
    await expect(page.getByTestId('save-prompt')).toBeVisible();
    await expect(page.getByTestId('save-prompt-message')).toHaveText('Do you want to save the changes made to the document “Untitled”?');
    await page.getByTestId('save-prompt-cancel').click();
    expect(await docText(page)).toBe('draft text');
    await menu(page, 'file', 'new');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await docText(page)).toBe('');
    await expect(page).toHaveTitle('Untitled');
    await editorEl(page).click();
    await press(page, 'Mod+z');
    expect(await docText(page)).toBe('');
  });

  test('F-21 the save prompt is modal: Escape cancels, Tab stays inside', async ({ page }) => {
    await open(page);
    await setText(page, 'x');
    await menu(page, 'file', 'new');
    await expect(page.getByTestId('save-prompt-save')).toBeFocused();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="save-prompt"]'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await docText(page)).toBe('x');
  });

  test('F-21 Save in the prompt saves first (save panel), then the new document opens', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, '# Kept\n');
    await menu(page, 'file', 'new');
    await page.getByTestId('save-prompt-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    expect((await fs(page)).writes[0]).toEqual({ name: 'Kept.md', text: '# Kept\n' });
    await expect.poll(() => docText(page)).toBe('');
  });

  test('F-21 a cancelled save panel in the prompt keeps the document', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'keep me');
    await queueSave(page, 'CANCEL');
    await menu(page, 'file', 'new');
    await page.getByTestId('save-prompt-save').click();
    await expect.poll(async () => (await fs(page)).saveCalls.length).toBe(1);
    await page.waitForTimeout(200);
    expect(await docText(page)).toBe('keep me');
  });

  test('F-22 Open (File System Access API): the file becomes the document, title = file name, preview renders, Cmd+O works', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, 'notes.md', '# Opened\n\ntext');
    await menu(page, 'file', 'open');
    await expect.poll(() => docText(page)).toBe('# Opened\n\ntext');
    await expect(page).toHaveTitle('notes.md');
    await expect(pv(page).locator('h1')).toHaveText('Opened');
    expect(await pv(page).locator('title').textContent()).toBe('notes');
    expect(await docInfo(page)).toEqual({ kind: 'file', name: 'notes.md', savedText: '# Opened\n\ntext', hasHandle: true });
    await queueOpen(page, 'second.markdown', 'two');
    await editorEl(page).click();
    await press(page, 'Mod+o');
    await expect.poll(() => docText(page)).toBe('two');
    await expect(page).toHaveTitle('second.markdown');
  });

  test('F-22 a cancelled open panel changes nothing; an edited document is asked about only after a file was chosen', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, 'mine');
    await page.evaluate(() => { const f = (window as any).__fs; f.openQueue = ['CANCEL']; });
    await menu(page, 'file', 'open');
    await expect.poll(async () => (await fs(page)).openCalls).toBe(1);
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await docText(page)).toBe('mine');
    await queueOpen(page, 'b.md', 'B');
    await menu(page, 'file', 'open');
    await expect(page.getByTestId('save-prompt')).toBeVisible();
    await page.getByTestId('save-prompt-cancel').click();
    expect(await docText(page)).toBe('mine');
  });

  test('F-22 Open fallback without the API: <input type=file> through the file chooser', async ({ page }) => {
    await noFs(page);
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await menu(page, 'file', 'open');
    const fc = await chooser;
    expect(await fc.element().getAttribute('accept')).toContain('.md');
    await fc.setFiles({ name: 'fallback.md', mimeType: 'text/markdown', buffer: Buffer.from('# Héllo ✓\n', 'utf8') });
    await expect.poll(() => docText(page)).toBe('# Héllo ✓\n');
    await expect(page).toHaveTitle('fallback.md');
    expect((await docInfo(page)).hasHandle).toBe(false);
  });

  test('F-22 a file that is not UTF-8 is not opened (error sheet)', async ({ page }) => {
    await noFs(page);
    await open(page);
    await setText(page, 'stay');
    const chooser = page.waitForEvent('filechooser');
    await menu(page, 'file', 'open');
    await (await chooser).setFiles({ name: 'latin1.md', mimeType: 'text/markdown', buffer: Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
    await expect(page.getByTestId('alert-message')).toHaveText('The document “latin1.md” could not be opened.');
    await page.getByTestId('alert-ok').click();
    expect(await docText(page)).toBe('stay');
  });

  test('F-26 / F-31 first Save: panel suggests the highest-level header + .md; written as UTF-8; title and edited state follow; second Save writes in place', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, '## Sub\n# Main: a/b|c\ntext é');
    await editorEl(page).click();
    await press(page, 'Mod+s');
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const f1 = await fs(page);
    expect(f1.saveCalls[0].suggestedName).toBe('Main- a-b-c.md');
    expect(f1.saveCalls[0].types[0].accept['text/markdown']).toEqual(['.md', '.markdown']);
    expect(f1.writes[0]).toEqual({ name: 'Main- a-b-c.md', text: '## Sub\n# Main: a/b|c\ntext é' });
    await expect(page).toHaveTitle('Main- a-b-c.md');
    await page.keyboard.type('!');
    await expect(page).toHaveTitle('Main- a-b-c.md — Edited');
    await menu(page, 'file', 'save');
    await expect.poll(async () => (await fs(page)).writes.length).toBe(2);
    expect((await fs(page)).saveCalls.length).toBe(1);
    await expect(page).toHaveTitle('Main- a-b-c.md');
  });

  test('F-31 with P-28 the front-matter title names the file; without a header the name is Untitled', async ({ page }) => {
    await mockFs(page);
    await open(page, '?pref.htmlDetectFrontMatter=true');
    await setText(page, '---\ntitle: Front Title\n---\n# Header\n');
    await menu(page, 'file', 'save');
    await expect.poll(async () => (await fs(page)).saveCalls.length).toBe(1);
    expect((await fs(page)).saveCalls[0].suggestedName).toBe('Front Title.md');
    await menu(page, 'file', 'new');
    await setText(page, 'plain');
    await menu(page, 'file', 'save');
    await expect.poll(async () => (await fs(page)).saveCalls.length).toBe(2);
    expect((await fs(page)).saveCalls[1].suggestedName).toBe('Untitled.md');
  });

  test('F-27 Save As always opens the panel with the current name and switches to the new file', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, 'orig.md', 'body');
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('orig.md');
    await queueSave(page, 'copy.md');
    await press(page, 'Mod+Shift+s');
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const f = await fs(page);
    expect(f.saveCalls[0].suggestedName).toBe('orig.md');
    expect(f.writes[0]).toEqual({ name: 'copy.md', text: 'body' });
    await expect(page).toHaveTitle('copy.md');
  });

  test('F-26 fallback: Save downloads the file with the suggested name', async ({ page }) => {
    await noFs(page);
    await open(page);
    await setText(page, '# Down Load\nbody');
    const dl = page.waitForEvent('download');
    await editorEl(page).click();
    await press(page, 'Mod+s');
    const d = await dl;
    expect(d.suggestedFilename()).toBe('Down Load.md');
    expect(readFileSync(await d.path(), 'utf8')).toBe('# Down Load\nbody');
    await expect(page).toHaveTitle('Down Load.md');
  });

  test('F-30 P-41 on: Save appends a newline in the editor and the file, selection kept; off: no newline; never for an empty document', async ({ page }) => {
    await mockFs(page);
    await open(page, '?pref.editorEnsuresNewlineAtEndOfFile=true');
    await setText(page, 'abc', 1, 2);
    await menu(page, 'file', 'save');
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    expect((await fs(page)).writes[0].text).toBe('abc\n');
    expect(await docText(page)).toBe('abc\n');
    expect(await page.evaluate(() => (window as any).macdownEditor.selection())).toEqual({ from: 1, to: 2 });
    await expect(page).toHaveTitle('Untitled.md');
    await open(page);
    await setText(page, 'abc');
    await menu(page, 'file', 'save');
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    expect((await fs(page)).writes[0].text).toBe('abc');
  });

  test('F-28 Revert to Saved: disabled until edited; asks; reloads the file text', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-revert')).toBeDisabled();
    await page.keyboard.press('Escape');
    await queueOpen(page, 'r.md', 'original');
    await menu(page, 'file', 'open');
    await expect.poll(() => docText(page)).toBe('original');
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-revert')).toBeDisabled();
    await page.keyboard.press('Escape');
    await setText(page, 'changed');
    await menu(page, 'file', 'revert');
    await expect(page.getByTestId('revert-prompt-message')).toHaveText('Do you want to revert to the most recently saved version of the document “r.md”?');
    await page.getByTestId('revert-prompt-cancel').click();
    expect(await docText(page)).toBe('changed');
    await menu(page, 'file', 'revert');
    await page.getByTestId('revert-prompt-revert').click();
    await expect.poll(() => docText(page)).toBe('original');
    await expect(page).toHaveTitle('r.md');
  });

  test('F-25 Close: asks when edited, then a blank untitled document (P-02 on)', async ({ page }) => {
    await open(page);
    await setText(page, 'x');
    await menu(page, 'file', 'close');
    await page.getByTestId('save-prompt-dont-save').click();
    expect(await docText(page)).toBe('');
    await expect(page.getByTestId('empty-state')).toHaveCount(0);
  });

  test('F-25 / U-12 Close with P-02 off leaves no document: the empty state offers New and Open', async ({ page }) => {
    await open(page, '?pref.supressesUntitledDocumentOnLaunch=false');
    await page.evaluate(() => (window as any).macdownPrefs.set({ supressesUntitledDocumentOnLaunch: true }));
    await menu(page, 'file', 'close');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('split')).toBeHidden();
    await expect(page).toHaveTitle('MacDown');
    await page.getByTestId('menu-file').click();
    await expect(page.getByTestId('menuitem-save')).toBeDisabled();
    await expect(page.getByTestId('menuitem-new')).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.getByTestId('empty-state-new').click();
    await expect(page.getByTestId('split')).toBeVisible();
    await expect(page).toHaveTitle('Untitled');
  });

  test('F-16 split ratio is remembered per named document', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, 'a.md', 'A');
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('a.md');
    await menu(page, 'view', 'split-3-1');
    await menu(page, 'file', 'new');
    await menu(page, 'view', 'split-1-1');
    expect((await splitState(page)).ratio).toBe(0.5);
    await queueOpen(page, 'a.md', 'A');
    await menu(page, 'file', 'open');
    await expect.poll(async () => (await splitState(page)).ratio).toBe(0.75);
  });

  test('F-33 a JPEG dropped on the editor is inserted as a data URI at the selection start (selection not replaced)', async ({ page }) => {
    await open(page);
    await setText(page, 'ab cd', 3, 5);
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' }));
      return d;
    });
    await page.dispatchEvent('[data-testid="editor"] .cm-content', 'drop', { dataTransfer: dt });
    await expect.poll(() => docText(page)).toBe('ab ![](data:image/jpeg;base64,/9j/4A==)cd');
  });

  test('drag and drop: a dropped .md file opens as the document (with the save prompt), not inserted as text', async ({ page }) => {
    await open(page);
    await setText(page, 'mine');
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(['# Dropped\n'], 'dropped.md', { type: 'text/markdown' }));
      return d;
    });
    await page.dispatchEvent('[data-testid="editor"] .cm-content', 'drop', { dataTransfer: dt });
    await expect(page.getByTestId('save-prompt')).toBeVisible();
    await page.getByTestId('save-prompt-dont-save').click();
    await expect.poll(() => docText(page)).toBe('# Dropped\n');
    await expect(page).toHaveTitle('dropped.md');
    // Dropped onto the preview pane area (outside the iframe) works as well; a non-Markdown file is ignored.
    const dt2 = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(['x'], 'data.bin', { type: 'application/octet-stream' }));
      return d;
    });
    await page.dispatchEvent('[data-testid="split"]', 'drop', { dataTransfer: dt2 });
    await page.waitForTimeout(200);
    expect(await docText(page)).toBe('# Dropped\n');
  });

  test('shortcuts reserved by the browser are menu only: Cmd+N and Cmd+W do nothing in the page', async ({ page }) => {
    await open(page);
    await setText(page, 'text');
    await editorEl(page).click();
    await press(page, 'Mod+n');
    await press(page, 'Mod+w');
    await page.waitForTimeout(150);
    await expect(page.getByTestId('save-prompt')).toHaveCount(0);
    expect(await docText(page)).toBe('text');
  });

  test('§3 File menu items, order and shortcuts', async ({ page }) => {
    await open(page);
    await page.getByTestId('menu-file').click();
    const items = await page.getByTestId('menu-file-dropdown').locator('[role^="menuitem"]').evaluateAll((es) => es.map((e) => (e.textContent ?? '').trim()));
    expect(items).toEqual(['New⌘N', 'Open…⌘O', 'Close⌘W', 'Save…⌘S', 'Save As…⇧⌘S', 'Revert to Saved', 'Export HTML…⌥⌘E', 'Export PDF…⌥⌘P', 'Print…⌘P']);
  });
});

// ---------------------------------------------------------------------------
// F-29 / F-32 autosave draft and launch
// ---------------------------------------------------------------------------

test.describe('F-29 / F-32 / U-12 draft and launch', () => {
  test('F-29 the draft survives a reload (text, edited state)', async ({ page }) => {
    await open(page);
    await editorEl(page).click();
    await page.keyboard.type('# Draft');
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('# Draft');
    await expect(page).toHaveTitle('Untitled — Edited');
    await expect(pv(page).locator('h1')).toHaveText('Draft');
  });

  test('F-29 an opened file is restored with its name and saved text; Save then asks for a location again (no handle after reload)', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await queueOpen(page, 'kept.md', 'saved');
    await menu(page, 'file', 'open');
    await expect(page).toHaveTitle('kept.md');
    await setText(page, 'saved+');
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('saved+');
    await expect(page).toHaveTitle('kept.md — Edited');
    await menu(page, 'file', 'save');
    await expect.poll(async () => (await fs(page)).saveCalls.length).toBe(1);
    expect((await fs(page)).saveCalls[0].suggestedName).toBe('kept.md');
  });

  test('U-12 P-02 off: the next launch shows the empty state (New, Open); P-02 on restores the draft', async ({ page }) => {
    await open(page);
    await setText(page, 'remember');
    await page.waitForTimeout(400);
    await openPrefs(page, 'general');
    await pref(page, 'supressesUntitledDocumentOnLaunch').uncheck();
    expect(await prefsValue(page, 'supressesUntitledDocumentOnLaunch')).toBe(true);
    await page.reload();
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('empty-state-open')).toBeVisible();
    await page.evaluate(() => (window as any).macdownPrefs.set({ supressesUntitledDocumentOnLaunch: false }));
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('remember');
  });
});

// ---------------------------------------------------------------------------
// F-140 / F-141 Preferences window
// ---------------------------------------------------------------------------

test.describe('F-140 / F-141 preferences', () => {
  test('F-140 Cmd+, and MacDown > Preferences… open the window; panes General, Markdown, Editor, Rendering; Escape and the close button close it', async ({ page }) => {
    await open(page);
    await editorEl(page).click();
    await press(page, 'Mod+,');
    await expect(page.getByTestId('preferences')).toBeVisible();
    const tabs = await page.locator('[data-testid^="preferences-tab-"]').allTextContents();
    expect(tabs).toEqual(['General', 'Markdown', 'Editor', 'Rendering']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences')).toHaveCount(0);
    await openPrefs(page, 'markdown');
    await expect(page.getByTestId('preferences-title')).toHaveText('Markdown');
    await page.getByTestId('preferences-close').click();
    await expect(page.getByTestId('preferences')).toHaveCount(0);
  });

  test('§3 MacDown menu has About MacDown and Preferences… (⌘,)', async ({ page }) => {
    await open(page);
    await page.getByTestId('menu-app').click();
    const items = await page.getByTestId('menu-app-dropdown').locator('[role^="menuitem"]').evaluateAll((es) => es.map((e) => (e.textContent ?? '').trim()));
    expect(items).toEqual(['About MacDown', 'Preferences…⌘,']);
  });

  test('§8.1 General: labels, order, defaults; P-01 off also turns off and disables word count', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    const labels = await page.getByTestId('preferences-pane-general').locator('label').allTextContents();
    expect(labels).toEqual([
      'Ensure open document on launch',
      'Update preview automatically as you type',
      'Sync preview scrollbar when editor scrolls',
      'Put editor on the right',
      'Show word count',
    ]);
    await expect(pref(page, 'supressesUntitledDocumentOnLaunch')).toBeChecked();
    await expect(pref(page, 'markdownManualRender')).toBeChecked();
    await expect(pref(page, 'editorSyncScrolling')).toBeChecked();
    await expect(pref(page, 'editorOnRight')).not.toBeChecked();
    await pref(page, 'editorShowWordCount').check();
    await expect(page.getByTestId('word-count')).toBeVisible();
    await pref(page, 'markdownManualRender').uncheck();
    await expect(pref(page, 'editorShowWordCount')).not.toBeChecked();
    await expect(pref(page, 'editorShowWordCount')).toBeDisabled();
    await expect(page.getByTestId('word-count')).toHaveCount(0);
    expect(await prefsValue(page, 'markdownManualRender')).toBe(true);
    await pref(page, 'markdownManualRender').check();
    await expect(pref(page, 'editorShowWordCount')).toBeEnabled();
    await expect(pref(page, 'editorShowWordCount')).not.toBeChecked();
  });

  test('F-141 P-01 off: typing no longer updates the preview until Render Markdown; back on renders again', async ({ page }) => {
    await open(page);
    await setText(page, '# One');
    await waitPreview(page, 'h1');
    await openPrefs(page, 'general');
    await pref(page, 'markdownManualRender').uncheck();
    await setText(page, '# Two');
    await page.waitForTimeout(400);
    await expect(pv(page).locator('h1')).toHaveText('One');
    await pref(page, 'markdownManualRender').check();
    await expect(pv(page).locator('h1')).toHaveText('Two');
  });

  test('F-10 P-03 applies live from the General pane', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'general');
    await pref(page, 'editorOnRight').check();
    const e = await page.getByTestId('editor-pane').boundingBox();
    const p = await page.getByTestId('preview-pane').boundingBox();
    expect(e!.x).toBeGreaterThan(p!.x);
  });

  test('§8.2 Markdown: groups, labels and order from the xib; toggles apply live and persist across a reload', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'markdown');
    const legends = await page.getByTestId('preferences-pane-markdown').locator('legend').allTextContents();
    expect(legends).toEqual(['Document formatting', 'Block formatting', 'Inline formatting']);
    const labels = await page.getByTestId('preferences-pane-markdown').locator('label').allTextContents();
    expect(labels).toEqual(['Smartypants', 'Table', 'Fenced code block', 'Intra-word emphasis', 'Strikethrough', 'Underline', 'Quote', 'Highlight', 'Superscript', 'Autolink', 'Footnote']);
    for (const [k, on] of [['extensionTables', true], ['extensionFencedCode', true], ['extensionAutolink', false], ['extensionStrikethough', false], ['extensionUnderline', false], ['extensionHighlight', false], ['extensionFootnotes', true], ['extensionSuperscript', false], ['extensionQuote', false], ['extensionSmartyPants', false], ['extensionIntraEmphasis', true]] as const) {
      if (on) await expect(pref(page, k)).toBeChecked();
      else await expect(pref(page, k)).not.toBeChecked();
    }
    await setText(page, '|a|b|\n|-|-|\n|1|2|\n\n~~s~~');
    await waitPreview(page, 'table');
    await pref(page, 'extensionTables').uncheck();
    await pref(page, 'extensionStrikethough').check();
    await expect(pv(page).locator('table')).toHaveCount(0);
    await expect(pv(page).locator('del')).toHaveText('s');
    expect(await stored(page)).toEqual({ extensionTables: false, extensionStrikethough: true });
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await prefsValue(page, 'extensionTables')).toBe(false);
    await expect(pv(page).locator('del')).toHaveText('s');
    await expect(pv(page).locator('table')).toHaveCount(0);
    // F-162: the Format menu follows the persisted extension.
    await page.getByTestId('menu-format').click();
    await expect(page.getByTestId('menuitem-strikethrough')).toBeVisible();
  });

  test('F-141 ?pref. URL overrides win over stored values and are never persisted', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).macdownPrefs.set({ extensionTables: false }));
    await open(page, '?pref.extensionTables=true');
    await setText(page, '|a|\n|-|\n|1|');
    await waitPreview(page, 'table');
    expect(await stored(page)).toEqual({ extensionTables: false });
    await open(page);
    expect(await prefsValue(page, 'extensionTables')).toBe(false);
  });

  test('§8.3 Rendering: CSS pop-up starts with the empty "no style" item; choosing it unstyles the preview (F-166); Reveal is not available', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'rendering');
    const opts = await pref(page, 'htmlStyleName').locator('option').allTextContents();
    expect(opts).toEqual(['', 'Clearness', 'Clearness Dark', 'GitHub', 'GitHub2', 'Solarized (Dark)', 'Solarized (Light)']);
    await expect(pref(page, 'htmlStyleName')).toHaveValue('GitHub2');
    await expect(page.getByTestId('pref-htmlStyleName-reveal')).toBeDisabled();
    await setText(page, '# H');
    await waitPreview(page, 'h1');
    await expect.poll(() => pv(page).locator('style').count()).toBe(1);
    await pref(page, 'htmlStyleName').selectOption('');
    await expect.poll(() => pv(page).locator('style').count()).toBe(0);
    expect(await stored(page)).toEqual({ htmlStyleName: '' });
    await pref(page, 'htmlStyleName').selectOption('Clearness Dark');
    await expect.poll(() => pv(page).locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('§8.3 Rendering: enablement (Theme, line numbers, Graphviz, Mermaid need P-20; $ needs P-18; Accessory always enabled), labels, Prism theme items', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'rendering');
    for (const k of ['htmlHighlightingThemeName', 'htmlLineNumbers', 'htmlGraphviz', 'htmlMermaid', 'htmlMathJaxInlineDollar']) await expect(pref(page, k)).toBeDisabled();
    await expect(pref(page, 'htmlCodeBlockAccessory')).toBeEnabled();
    expect(await pref(page, 'htmlCodeBlockAccessory').locator('option').allTextContents()).toEqual(['None', 'Language name', 'Custom']);
    expect(await pref(page, 'htmlHighlightingThemeName').locator('option').allTextContents()).toEqual(['(Default)', 'Coy', 'Dark', 'Funky', 'Okaidia', 'Solarizedlight', 'Tomorrow', 'Twilight']);
    await pref(page, 'htmlSyntaxHighlighting').check();
    for (const k of ['htmlHighlightingThemeName', 'htmlLineNumbers', 'htmlGraphviz', 'htmlMermaid']) await expect(pref(page, k)).toBeEnabled();
    await pref(page, 'htmlMathJax').check();
    await expect(pref(page, 'htmlMathJaxInlineDollar')).toBeEnabled();
    const pane = page.getByTestId('preferences-pane-rendering');
    for (const l of ['Syntax highlighted code block', 'Show line numbers', 'Graphviz', 'Mermaid', 'TeX-like math syntax', 'Use dollar sign ($) as inline delimiter', 'Task list syntax', 'Detect Jekyll front-matter', 'Detect table of contents token', 'Render newline literally', 'Scale preview based on editor font size'])
      await expect(pane.getByText(l, { exact: true })).toBeVisible();
    await expect(pane.getByText('Math support requires Internet connection.')).toBeVisible();
    await expect(pref(page, 'htmlDefaultDirectoryUrl')).toHaveValue('~');
    await setText(page, '```js\nvar a = 1;\n```');
    await pref(page, 'htmlHighlightingThemeName').selectOption('Okaidia');
    await expect(pv(page).locator('.token.keyword').first()).toBeAttached();
    expect(await prefsValue(page, 'htmlHighlightingThemeName')).toBe('Okaidia');
  });

  test('§8.4 Editor: theme pop-up with the empty "no theme" item, list marker, behaviour group order and P-39 enablement', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    const themes = await pref(page, 'editorStyleName').locator('option').allTextContents();
    expect(themes[0]).toBe('');
    expect(themes.length).toBe(16);
    await expect(pref(page, 'editorStyleName')).toHaveValue('Tomorrow+');
    await pref(page, 'editorStyleName').selectOption('Mou Night');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-theme', 'Mou Night');
    await pref(page, 'editorStyleName').selectOption('');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-theme', '');
    expect(await pref(page, 'editorUnorderedListMarkerType').locator('option').allTextContents()).toEqual(['* (Asterisk)', '+ (Plus sign)', '- (Minus sign)']);
    const behaviour = await page.getByTestId('preferences-pane-editor').locator('fieldset label').allTextContents();
    expect(behaviour).toEqual([
      'Insert spaces instead of tabs',
      'Auto-complete matching characters',
      'Automatically insert line prefix for the current block',
      '⌘← jumps to first non-whitespace character in line',
      'Scroll past end',
      'Ensure newline at end of file on save',
      'Auto-increment numbering in ordered lists',
    ]);
    await expect(pref(page, 'editorAutoIncrementNumberedLists')).toBeEnabled();
    await pref(page, 'editorInsertPrefixInBlock').uncheck();
    await expect(pref(page, 'editorAutoIncrementNumberedLists')).toBeDisabled();
    await pref(page, 'editorUnorderedListMarkerType').selectOption('2');
    await setText(page, 'a', 0, 1);
    await menu(page, 'format', 'unordered-list');
    expect(await docText(page)).toBe('- a');
  });

  test('§8.4 numeric fields: live, clamped to the stepper range, emptied = 0; width field enabled only with the checkbox', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await pref(page, 'editorLineSpacing').fill('8');
    expect(await prefsValue(page, 'editorLineSpacing')).toBe(8);
    await pref(page, 'editorLineSpacing').fill('');
    await pref(page, 'editorLineSpacing').blur();
    expect(await prefsValue(page, 'editorLineSpacing')).toBe(0);
    await expect(pref(page, 'editorLineSpacing')).toHaveValue('0');
    await pref(page, 'editorHorizontalInset').fill('99');
    await pref(page, 'editorHorizontalInset').blur();
    expect(await prefsValue(page, 'editorHorizontalInset')).toBe(35);
    await pref(page, 'editorVerticalInset').fill('5');
    await expect.poll(() => page.locator('[data-testid="editor"] .cm-content').evaluate((e) => getComputedStyle(e).paddingTop)).toBe('5px');
    await expect(pref(page, 'editorMaximumWidth')).toBeDisabled();
    await pref(page, 'editorWidthLimited').check();
    await expect(pref(page, 'editorMaximumWidth')).toBeEnabled();
    await pref(page, 'editorMaximumWidth').fill('50');
    await pref(page, 'editorMaximumWidth').blur();
    expect(await prefsValue(page, 'editorMaximumWidth')).toBe(300);
    // Native stepper: ArrowUp in the field.
    await pref(page, 'editorLineSpacing').focus();
    await page.keyboard.press('ArrowUp');
    expect(await prefsValue(page, 'editorLineSpacing')).toBe(1);
  });

  test('§8.4 P-30 base font: preview text "Name - size", Change… family and size apply live to the editor', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await expect(page.getByTestId('pref-editorBaseFontInfo-preview')).toHaveText('Menlo Regular - 14.0');
    await page.getByTestId('pref-editorBaseFontInfo-change').click();
    await page.getByTestId('pref-editorBaseFontInfo-family').selectOption('Courier-Regular');
    await page.getByTestId('pref-editorBaseFontInfo-size').fill('18');
    await expect(page.getByTestId('pref-editorBaseFontInfo-preview')).toHaveText('Courier Regular - 18.0');
    expect(await prefsValue(page, 'editorBaseFontInfo')).toEqual({ name: 'Courier-Regular', size: 18 });
    const f = await page.locator('[data-testid="editor"] .cm-scroller').evaluate((e) => getComputedStyle(e).fontFamily);
    expect(f.startsWith('Courier')).toBe(true);
  });

  test('F-17 / U-19 scale preview: zoom = font size / 14 when on, reset to 1 when turned off', async ({ page }) => {
    await open(page, '?pref.editorBaseFontInfo={"name":"Menlo-Regular","size":21}');
    await setText(page, '# Z');
    await waitPreview(page, 'h1');
    const zoom = () => pv(page).locator('html').evaluate((h) => (h as HTMLElement).style.zoom);
    expect(await zoom()).toBe('');
    await openPrefs(page, 'rendering');
    await pref(page, 'previewZoomRelativeToBaseFontSize').check();
    await expect.poll(zoom).toBe('1.5');
    await setText(page, '# Z2');
    await expect(pv(page).locator('h1')).toHaveText('Z2');
    expect(await zoom()).toBe('1.5');
    await page.evaluate(() => (window as any).macdownPrefs.set({ editorBaseFontInfo: { name: 'Menlo-Regular', size: 28 } }));
    await expect.poll(zoom).toBe('2');
    await pref(page, 'previewZoomRelativeToBaseFontSize').uncheck();
    await expect.poll(zoom).toBe('');
  });

  test('F-138 / F-161 Import… adds a user CSS style and a .style theme; they persist; a built-in name is overridden; Reload re-reads the stored files', async ({ page }) => {
    await open(page);
    await setText(page, '# Styled');
    await waitPreview(page, 'h1');
    await openPrefs(page, 'rendering');
    await page.getByTestId('pref-htmlStyleName-import-input').setInputFiles({ name: 'Mine.css', mimeType: 'text/css', buffer: Buffer.from('body { background: rgb(1, 2, 3); }\n') });
    await expect(pref(page, 'htmlStyleName').locator('option', { hasText: 'Mine' })).toHaveCount(1);
    await pref(page, 'htmlStyleName').selectOption('Mine');
    await expect.poll(() => pv(page).locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(1, 2, 3)');
    // A user file named like a built-in one replaces it (an edited copy in the Styles folder).
    await page.getByTestId('pref-htmlStyleName-import-input').setInputFiles({ name: 'GitHub2.css', mimeType: 'text/css', buffer: Buffer.from('body { background: rgb(9, 9, 9); }') });
    await pref(page, 'htmlStyleName').selectOption('GitHub2');
    await expect.poll(() => pv(page).locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(9, 9, 9)');
    await page.getByTestId('preferences-tab-editor').click();
    await page.getByTestId('pref-editorStyleName-import-input').setInputFiles({ name: 'Ink.style', mimeType: 'text/plain', buffer: Buffer.from('editor\nbackground: 102030\nforeground: f0f0f0\n') });
    await pref(page, 'editorStyleName').selectOption('Ink');
    await expect.poll(() => page.locator('[data-testid="editor"] .cm-editor').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(16, 32, 48)');
    await page.reload();
    await expect.poll(() => page.locator('[data-testid="editor"] .cm-editor').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(16, 32, 48)');
    await expect.poll(() => pv(page).locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(9, 9, 9)');
    // Reload: files stored elsewhere (another tab) appear and are re-applied.
    await page.evaluate(() => localStorage.setItem('macdown.userThemes', JSON.stringify({ Ink: 'editor\nbackground: 405060\n' })));
    await openPrefs(page, 'editor');
    await page.getByTestId('pref-editorStyleName-reload').click();
    await expect.poll(() => page.locator('[data-testid="editor"] .cm-editor').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(64, 80, 96)');
  });

  test('F-141 every pane keeps working after a reload: Editor and Rendering values persisted', async ({ page }) => {
    await open(page);
    await openPrefs(page, 'editor');
    await pref(page, 'editorStyleName').selectOption('Solarized (Dark)');
    await pref(page, 'editorScrollsPastEnd').check();
    await page.getByTestId('preferences-tab-rendering').click();
    await pref(page, 'htmlTaskList').check();
    await page.reload();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-theme', 'Solarized (Dark)');
    expect(await stored(page)).toEqual({ editorStyleName: 'Solarized (Dark)', editorScrollsPastEnd: true, htmlTaskList: true });
    await openPrefs(page);
    await expect(page.getByTestId('preferences')).toHaveAttribute('data-pane', 'rendering');
    await expect(pref(page, 'htmlTaskList')).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// §2.3 / §9 Export, print, copy
// ---------------------------------------------------------------------------

test.describe('§2.3 / §9 export HTML, PDF, print, copy HTML', () => {
  test('F-35 Export HTML: accessory defaults, panel name, exported body and styles equal the preview', async ({ page }) => {
    await mockFs(page);
    await open(page);
    await setText(page, '# Report: Q1\n\nSome *text* and a [link](#x).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    await waitPreview(page, 'table');
    await editorEl(page).click();
    await press(page, 'Mod+Alt+e');
    await expect(page.getByTestId('export-html-dialog')).toBeVisible();
    await expect(page.getByTestId('export-include-styles')).toBeChecked();
    await expect(page.getByTestId('export-include-highlighting')).not.toBeChecked();
    await expect(page.getByTestId('export-html-filename')).toHaveText('Report- Q1.html');
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const f = await fs(page);
    expect(f.saveCalls[0].suggestedName).toBe('Report- Q1.html');
    expect(f.saveCalls[0].types[0].accept).toEqual({ 'text/html': ['.html'] });
    const html: string = f.writes[0].text;
    expect(html).not.toContain('<title>');
    expect(html).not.toContain('<script');
    const exported = await page.evaluate((h) => {
      const d = new DOMParser().parseFromString(h, 'text/html');
      return { body: d.body.innerHTML, styles: Array.from(d.querySelectorAll('style')).map((s) => s.textContent!.trim()) };
    }, html);
    const shown = await pv(page).locator('html').evaluate(() => ({ body: document.body.innerHTML, styles: Array.from(document.querySelectorAll('style')).map((s) => s.textContent!.trim()) }));
    // The preview alone marks blocks with their source lines for scroll sync (F-11); export does not.
    expect(exported.body).not.toContain('data-line');
    expect(exported.body).toBe(shown.body.replace(/ data-line(-end)?="\d+"/g, ''));
    expect(exported.styles).toEqual(shown.styles);
  });

  test('F-35 the empty style defaults "Include styles" off; with both boxes off the page has no assets; Cancel exports nothing', async ({ page }) => {
    await mockFs(page);
    await open(page, '?pref.htmlStyleName=%22%22');
    await setText(page, 'x');
    await menu(page, 'file', 'export-html');
    await expect(page.getByTestId('export-include-styles')).not.toBeChecked();
    await page.getByTestId('export-html-cancel').click();
    await expect(page.getByTestId('export-html-dialog')).toHaveCount(0);
    expect((await fs(page)).saveCalls.length).toBe(0);
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const html: string = (await fs(page)).writes[0].text;
    expect(html).not.toMatch(/<style|<script|<link/);
    expect(html).toMatch(/<body>\n\n<p>x<\/p>\n+<\/body>/);
  });

  test('E-02 Include syntax highlighting embeds Prism (even with P-20 off) and the page highlights itself; tasklist.js and show-information.css are never exported', async ({ page, context }) => {
    await mockFs(page);
    await open(page, '?pref.htmlTaskList=true&pref.htmlCodeBlockAccessory=2');
    await setText(page, '- [x] done\n\n```js:info\nvar a = "s";\n```\n');
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-include-highlighting').check();
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const html: string = (await fs(page)).writes[0].text;
    expect(html).toContain('Prism');
    expect(html).not.toContain('data-information]');
    expect(html).not.toMatch(/tasklist|disabled="disabled"/);
    const other = await context.newPage();
    await other.setContent(html);
    await expect(other.locator('.token.keyword')).toHaveText('var');
    await expect(other.locator('input[type="checkbox"]')).toBeEnabled();
    await other.close();
  });

  test('E-02 Mermaid and Graphviz scripts are exported only with "Include syntax highlighting"', async ({ page }) => {
    await mockFs(page);
    await open(page, '?pref.htmlSyntaxHighlighting=true&pref.htmlMermaid=true&pref.htmlGraphviz=true');
    await setText(page, 'x');
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-include-highlighting').uncheck();
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const off: string = (await fs(page)).writes[0].text;
    expect(off).not.toMatch(/mermaid|Viz\(/i);
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(2);
    const on: string = (await fs(page)).writes[1].text;
    expect(on).toMatch(/mermaid/i);
    expect(on).toContain('// graphviz init');
    expect(on.indexOf('mermaid.initialize') < on.indexOf('// graphviz init')).toBe(true);
  });

  test('E-03 MathJax: config embedded as text/x-mathjax-config and MathJax linked from the CDN', async ({ page }) => {
    await mockFs(page);
    await open(page, '?pref.htmlMathJax=true');
    await setText(page, '$$x^2$$');
    await menu(page, 'file', 'export-html');
    await page.getByTestId('export-include-styles').uncheck();
    await page.getByTestId('export-html-save').click();
    await expect.poll(async () => (await fs(page)).writes.length).toBe(1);
    const html: string = (await fs(page)).writes[0].text;
    expect(html).toContain('<script type="text/x-mathjax-config">\n(function () {\n\nMathJax.Hub.Config({');
    expect(html).toContain('<script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.3/MathJax.js?config=TeX-AMS-MML_HTMLorMML"></script>');
    expect(html).not.toContain('<style');
  });

  test('E-04 a saved document exports with <title> = file name without extension; download fallback uses the presumed name', async ({ page }) => {
    await noFs(page);
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await menu(page, 'file', 'open');
    await (await chooser).setFiles({ name: 'chapter one.md', mimeType: 'text/markdown', buffer: Buffer.from('# Heading\n') });
    await expect(page).toHaveTitle('chapter one.md');
    await menu(page, 'file', 'export-html');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-html-save').click();
    const d = await dl;
    expect(d.suggestedFilename()).toBe('chapter one.html');
    const html = readFileSync(await d.path(), 'utf8');
    expect(html).toContain('<title>chapter one</title>');
    expect(html).toContain('<h1 id="toc_0">Heading</h1>');
  });

  test('F-37 Print (Cmd+P) prints the preview document only, with 50 pt top/bottom and 0 pt side margins', async ({ page }) => {
    await open(page);
    await setText(page, '# Print me');
    await waitPreview(page, 'h1');
    const frame = await previewFrame(page);
    await frame.evaluate(() => {
      (window as any).__printed = [];
      window.print = () => (window as any).__printed.push({ title: document.title, sheets: Array.from(document.adoptedStyleSheets).map((s) => Array.from(s.cssRules).map((r) => r.cssText).join(' ')) });
    });
    await editorEl(page).click();
    await press(page, 'Mod+p');
    const printed = await frame.evaluate(() => (window as any).__printed);
    expect(printed.length).toBe(1);
    expect(printed[0].sheets.join(' ')).toContain('@page { margin: 50pt 0pt; }');
    expect(await page.getByTestId('preview-iframe').getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  test('F-36 Export PDF (Opt+Cmd+P): print dialog with the presumed file name as the page title, restored afterwards', async ({ page }) => {
    await open(page);
    await setText(page, '# Annual Report\n');
    await waitPreview(page, 'h1');
    const frame = await previewFrame(page);
    await frame.evaluate(() => {
      (window as any).__printed = [];
      window.print = () => (window as any).__printed.push(document.title);
    });
    await editorEl(page).click();
    await press(page, 'Mod+Alt+p');
    expect(await frame.evaluate(() => (window as any).__printed)).toEqual(['Annual Report']);
    expect(await frame.evaluate(() => document.querySelector('title'))).toBeNull();
    await page.getByTestId('menu-file').click();
    await page.getByTestId('menuitem-export-pdf').click();
    expect(await frame.evaluate(() => (window as any).__printed)).toEqual(['Annual Report', 'Annual Report']);
  });

  test('E-07 / F-39 Copy HTML copies the body only (no template, styles or scripts)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '?pref.htmlSyntaxHighlighting=true');
    await setText(page, '# C\n\n```js\nx\n```');
    await menu(page, 'format', 'copy-html');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('<h1 id="toc_0">C</h1>');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).not.toMatch(/<html|<head|<style|<script|<body/);
    expect(text.startsWith('<h1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2.8 Help and About
// ---------------------------------------------------------------------------

test.describe('§2.8 help, about, first launch', () => {
  test('F-153 MacDown Help opens help.md as an editable document without replacing the draft; Close brings the document back', async ({ page }) => {
    await open(page);
    await setText(page, 'my work');
    await page.waitForTimeout(400);
    await menu(page, 'help', 'help');
    await expect.poll(() => docText(page)).toBe(HELP_MD);
    await expect(page).toHaveTitle('help.md');
    await expect(pv(page).locator('h1').first()).toBeAttached();
    await editorEl(page).click();
    await page.keyboard.type('Z');
    await expect(page).toHaveTitle('help.md — Edited');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('macdown.draft')!).text)).toBe('my work');
    await menu(page, 'file', 'close');
    await page.getByTestId('save-prompt-dont-save').click();
    await expect.poll(() => docText(page)).toBe('my work');
    await expect(page).toHaveTitle('Untitled — Edited');
  });

  test('F-154 Contributing to MacDown opens contribute.md; a reload while help is open restores the user draft', async ({ page }) => {
    await open(page);
    await setText(page, 'draft!');
    await menu(page, 'help', 'contributing');
    await expect.poll(() => docText(page)).toBe(CONTRIBUTE_MD);
    await expect(page).toHaveTitle('contribute.md');
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('draft!');
  });

  test('F-142 About MacDown shows name, version 0.7.3 (1008.4), copyright and licence', async ({ page }) => {
    await open(page);
    await menu(page, 'app', 'about');
    await expect(page.getByTestId('about')).toBeVisible();
    await expect(page.getByTestId('about-version')).toHaveText('Version 0.7.3 (1008.4)');
    await expect(page.getByTestId('about-copyright')).toHaveText('Copyright © 2014–2016 Tzu-ping Chung.');
    await expect(page.getByTestId('about')).toContainText('MIT License');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('about')).toHaveCount(0);
  });
});

test.describe('F-155 first launch', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('F-155 the first visit opens the help document; the next visit does not', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('split')).toBeVisible();
    await expect.poll(() => docText(page)).toBe(HELP_MD);
    expect(await page.evaluate(() => localStorage.getItem('macdown.firstVersionInstalled'))).toBe('0.7.3');
    await page.reload();
    await expect(page.getByTestId('split')).toBeVisible();
    expect(await docText(page)).toBe('');
    await expect(page).toHaveTitle('Untitled');
  });
});

