import { test, expect, type Page } from '@playwright/test';
import { open, setDoc, preview } from './helpers';
import { alignmentFraction } from '../../src/layout/scrollSync';

interface Row {
  editor: number;
  preview: number;
  previewTop: number;
  /** Distance from the alignment line to the nearest header, in either pane. */
  gap: number;
}

/** The issue #2 document: 20 sections, every third with a code block of `# ` comments. */
function sections(withCode: boolean, image = ''): string {
  const out: string[] = [];
  for (let n = 1; n <= 20; n++) {
    out.push(`## Section ${n}`, '', `Paragraph of section ${n}, long enough to wrap a little in the editor pane at this width.`, '');
    if (withCode && n % 3 === 0) out.push('```bash', '# install deps', 'npm ci', '# build', 'npm run build', '```', '');
    if (image && n === 10) out.push(image, '');
  }
  return out.join('\n');
}

/**
 * Section whose header is the last one above the alignment line (mid-screen,
 * tapered to the top and bottom edge at the ends), in the editor and in the preview.
 */
async function sectionsAtAlignment(page: Page): Promise<Row> {
  const { scrollTop, maxScroll, height } = await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="editor"] .cm-scroller') as HTMLElement;
    return { scrollTop: sc.scrollTop, maxScroll: sc.scrollHeight - sc.clientHeight, height: sc.clientHeight };
  });
  const f = alignmentFraction(scrollTop, maxScroll, height);
  return page.evaluate((f) => {
    const sc = document.querySelector('[data-testid="editor"] .cm-scroller') as HTMLElement;
    const frame = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    const win = frame.contentWindow!;
    const lastAbove = (items: { n: number; y: number }[], y: number) =>
      items.filter((i) => i.y <= y).reduce((a, i) => (i.y > a.y ? i : a), { n: 0, y: -Infinity }).n;
    const scTop = sc.getBoundingClientRect().top;
    const editorItems = Array.from(sc.querySelectorAll('.cm-line'))
      .map((l) => ({ m: /^## Section (\d+)$/.exec(l.textContent ?? ''), y: l.getBoundingClientRect().top - scTop }))
      .filter((i) => i.m)
      .map((i) => ({ n: Number(i.m![1]), y: i.y }));
    const previewItems = Array.from(doc.querySelectorAll('h2')).map((h) => ({
      n: Number(/\d+/.exec(h.textContent ?? '')![0]),
      y: h.getBoundingClientRect().top,
    }));
    const editorLine = f * sc.clientHeight;
    const previewLine = f * win.innerHeight;
    const gaps = [...editorItems.map((i) => i.y - editorLine), ...previewItems.map((i) => i.y - previewLine)].map(Math.abs);
    return {
      editor: lastAbove(editorItems, editorLine),
      preview: lastAbove(previewItems, previewLine),
      previewTop: win.scrollY,
      gap: Math.min(...gaps),
    };
  }, f);
}

/** Every step shows the same section in both panes, except when a header sits right on the alignment line. */
function expectAligned(rows: Row[]) {
  for (const r of rows) {
    if (r.editor !== r.preview) {
      expect(Math.abs(r.editor - r.preview), JSON.stringify(r)).toBe(1);
      expect(r.gap, JSON.stringify(r)).toBeLessThanOrEqual(12);
    }
  }
  for (let k = 1; k < rows.length; k++) expect(rows[k].previewTop).toBeGreaterThanOrEqual(rows[k - 1].previewTop);
}

/** Scrolls the editor from top to bottom in `steps` steps and records the sections at mid-screen. */
async function scrollThrough(page: Page, steps: number) {
  const rows: Row[] = [];
  for (let k = 0; k < steps; k++) {
    await page.evaluate((f) => {
      const sc = document.querySelector('[data-testid="editor"] .cm-scroller') as HTMLElement;
      sc.scrollTop = f * (sc.scrollHeight - sc.clientHeight);
    }, k / (steps - 1));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    rows.push(await sectionsAtAlignment(page));
  }
  return rows;
}

test.describe('F-11 scroll sync follows the blocks', () => {
  test('F-11 code blocks with # comments do not shift the preview (issue #2)', async ({ page }) => {
    await open(page);
    await setDoc(page, sections(true));
    await expect(preview(page).locator('h2')).toHaveCount(20);
    // Before the fix 37 of 41 steps differed, with jumps back and forth across the document.
    expectAligned(await scrollThrough(page, 41));
  });

  test('F-11 a tall image scrolls through the preview while the editor passes its line', async ({ page }) => {
    // Served late, so the preview first lays out without it and must re-sync when it loads.
    await page.route('https://images.test/tall.svg', async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='1500'><rect width='300' height='1500' fill='#cde'/></svg>",
      });
    });
    const image = '![tall](https://images.test/tall.svg)';
    await open(page);
    await setDoc(page, sections(false, image));
    await expect(preview(page).locator('h2')).toHaveCount(20);
    await expect.poll(() => preview(page).locator('img').evaluate((i) => (i as HTMLImageElement).getBoundingClientRect().height)).toBeGreaterThan(1000);
    expectAligned(await scrollThrough(page, 61));
  });

  test('F-11 an image that loads late re-syncs the preview without another editor scroll', async ({ page }) => {
    let release!: () => void;
    const loaded = new Promise<void>((r) => (release = r));
    await page.route('https://images.test/late.svg', async (route) => {
      await loaded;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='1500'><rect width='300' height='1500' fill='#cde'/></svg>",
      });
    });
    await open(page);
    await setDoc(page, sections(false, '![late](https://images.test/late.svg)'));
    await expect(preview(page).locator('h2')).toHaveCount(20);
    await page.evaluate(() => {
      const sc = document.querySelector('[data-testid="editor"] .cm-scroller') as HTMLElement;
      sc.scrollTop = 0.7 * (sc.scrollHeight - sc.clientHeight);
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const before = await sectionsAtAlignment(page);
    expect(before.preview).toBe(before.editor);
    release();
    await expect.poll(() => preview(page).locator('img').evaluate((i) => i.getBoundingClientRect().height)).toBeGreaterThan(1000);
    // The image sits above the alignment line, so without a re-sync the preview would now show an earlier section.
    await expect.poll(async () => (await sectionsAtAlignment(page)).preview).toBe(before.editor);
  });
});
