# MacDown 0.7.3 — Functional Specification (M1)

Target: rebuild as a client-only web app (TypeScript, React + Vite, CodeMirror 6, markdown-it, Prism, MathJax 3). See `docs/plan.md`.

## 0. Sources and evidence conventions

The REA MCP server failed to connect this session, so the bundle was analysed with standard macOS tools (`plutil`, `strings`, `otool -tV/-oV`, Python keyed-archive decoding). The GUI app was **not** run. All raw evidence is in `docs/analysis/`:

| Evidence file | What it is |
|---|---|
| `MainMenu.menu.txt` | Main menu tree decoded from `Base.lproj/MainMenu.nib`: titles, key equivalents, modifier masks, actions |
| `MP*.bindings.txt` | Cocoa bindings and actions per preference/export nib (control label → `NSUserDefaults` key) |
| `nib-strings-english.txt`, `mainmenu-strings-english.txt` | English base labels (quoted in localized `.strings` comments) |
| `binary-strings.txt`, `binary-utf16-strings.txt` | `strings` output of `Contents/MacOS/MacDown` |
| `disasm-annotated.txt` | `otool -tV` disassembly annotated with resolved CFStrings and Objective-C method labels (tool: `tools/annotate.py`) |
| `objc-metadata.txt` | `otool -oV` class/method metadata |
| `defaults-fresh-install.txt` | `defaults read com.uranusjr.macdown` on this Mac. It is a fresh install (`firstVersionInstalled = 1008.4`, only the Help documents were opened), so it shows the defaults the app writes on first launch |
| `resource-listing.txt` | Listing of Styles/Themes/Prism/Extensions/etc. |
| `tools/` | Scripts used (`nibdump.py`, `annotate.py`, `fn.sh`, `dbl.py`) |

**M1b source cross-check.** The spec was then checked against the original source code at tag `v0.7.3` of https://github.com/MacDownApp/macdown (cloned to `vendor/macdown`, gitignored), which matches this bundle (see `docs/analysis/source-notes.md` §1), and against upstream Hoedown 3.0.7, the parser version MacDown pins. Where the source and the disassembly-based text disagreed, the source wins. Source citations: `[src:path:line]` with `path` relative to `vendor/macdown/` (a bare file name such as `MPDocument.m` or `hoedown_html_patch.c` means the only file of that name under `MacDown/Code/` or `MacDown/Localization/Base.lproj/`); `[hoedown:src/file.c:line]` for Hoedown 3.0.7. Every M1b change is listed in §13.

Citation format: `[disasm:NNNN]` = line in `disasm-annotated.txt`; `[menu]` = `MainMenu.menu.txt`; `[bind:General]` = `MPGeneral.bindings.txt`, and so on; `[res:path]` = file under `MacDown.app/Contents/Resources/`; `[defaults]` = `defaults-fresh-install.txt`; `[help.md]` = bundled help document. Items marked **(inferred)** are not directly proven. Confidence is given for each.

Shortcut notation: `Cmd` = ⌘, `Opt` = ⌥, `Ctrl` = ⌃. An upper-case key equivalent in a nib means Shift (for example `Cmd+'S'` is `Shift+Cmd+S`). In the web app, map `Cmd` to `Ctrl` on non-Mac platforms.

---

## 1. Overview

| Item | Value |
|---|---|
| Product | MacDown 0.7.3 (build 1008.4), bundle id `com.uranusjr.macdown`, © 2014–2016 Tzu-ping Chung, MIT licence [Info.plist] |
| Purpose | Open-source Markdown editor with a live HTML preview |
| Users | Writers and developers editing `.md` / `.markdown` files |
| Platform | macOS 10.8+, x86_64, NSDocument-based, multi-window [Info.plist] |
| Original stack | Objective-C/Cocoa; NSTextView editor with `peg-markdown-highlight` (HGMarkdownHighlighter) syntax colouring; **Hoedown** Markdown parser with MacDown patches (task lists, code-block accessories, TOC); WebView preview; Handlebars template (`Templates/Default.handlebars`); Prism.js highlighting; MathJax 2.7.3 from CDN; Mermaid and Viz.js (Graphviz); LibYAML for front matter; PAPreferences over `NSUserDefaults`; MASPreferences window; Sparkle updates; AppleScript sdef; `macdown` CLI helper in `SharedSupport/bin` |
| Document types | Editor for `md`, `markdown` (UTI `net.daringfireball.markdown`, MIME `text/x-markdown`) and `public.plain-text`; viewer for `public.data` [Info.plist] |
| Encoding | Reads and writes UTF-8 (`dataUsingEncoding:4`, `initWithData:encoding:4`) [disasm:25718]. Strict: a leading UTF-8 BOM is dropped on reading and never written; CRLF, lone CR and mixed line endings are kept as read; an embedded NUL is kept; any invalid sequence (encoded surrogates, overlongs, UTF-16 input) fails with the "could not be opened" error (SD-11, Foundation probe `enc.m` in the M5 test report) |

### 1.1 Main window layout

From `Base.lproj/MPDocument.nib` and `MPDocument` code:

```
+--------------------------------------------------------------------------+
| Toolbar (icon-only, regular size)                                         |
| [Shift L|R] [B|I|U] [H1|H2|H3] [UL|OL] [Quote] [Code] [Link] [Img] [CopyHTML] ... [Layout v] |
+------------------------------------+-------------------------------------+
| Editor pane (MPEditorView,         | Preview pane (WebView rendering     |
| NSTextView, Markdown syntax        | the full HTML page from the         |
| highlighting, theme colours)       | template + style CSS + scripts)     |
|                                    |                                     |
|        [word count popup] (bottom) |                                     |
+------------------------------------+-------------------------------------+
```

- Default window content size is 1024×578. The split view's two subviews start at 509 px and 514 px wide, so the default ratio is about 1:1 [nib strings `{1024, 578}`, `{509, 578}`, `{{510, 0}, {514, 578}}`; defaults `NSSplitView Subview Frames Untitled`].
- The editor is on the left and the preview on the right. The `editorOnRight` preference swaps them (`MPDocumentSplitView swapViews`) [disasm:30586].
- The divider can be dragged. Split presets are 0.25, 0.5 and 0.75 [disasm:30388; constants resolved with `tools/dbl.py`]. The ratio is always the width of the **left** pane, whichever pane is on the left, so with `editorOnRight` "Left 1:3 Right" makes the preview narrow [src:MacDown/Code/View/MPDocumentSplitView.m:44-73].
- A pane is hidden by collapsing the divider to 0 or 1. The previous ratio is stored in `previousSplitRatio` (only when it is not 0 or 1) and restored when the pane is shown again. If there is no stored ratio, restoring uses 0.5 [disasm:30487; src:MacDown/Code/Document/MPDocument.m:1494-1522]. While the editor pane is collapsed the editor is not editable [src:MPDocument.m:693-697].
- The word-count widget is a pop-up button (`wordCountWidget`) at the bottom of the editor area. Its items are "N words", "N characters" and "N characters (no spaces)" [res:en.lproj/Localizable.strings]. The selected item is persisted as `editorWordCountType`. It is hidden unless `editorShowWordCount` is on [disasm:24390, 30586].
- The window title is the file name, or "Untitled" for a new document. Window frame and split frames are autosaved per document URL (`NSWindow Frame <url>`, `NSSplitView Subview Frames <url>`) [defaults; disasm:24390].
- The toolbar default configuration is icon-only (`TB Display Mode = 2`), regular size, and shown [defaults].

---

## 2. Feature list

Scope flags: **In** = must be implemented and tested. **Out** = excluded by the plan (Sparkle, AppleScript, CLI/Terminal, localization, macOS-only services, multi-window management, native plug-ins).

### 2.1 Window, layout and preview

| ID | Feature | Description | Trigger | Scope |
|---|---|---|---|---|
| F-01 | Split editor/preview window | Two panes separated by a draggable divider, about 1:1 by default (§1.1). | Opening any document | In |
| F-02 | Live preview | Each text change calls `parseAndRenderLater`, which parses and renders with a maximum delay of 0.5 s, so changes are coalesced [disasm:19584, `MPDocument editorTextDidChange:`]. Source detail: parsing runs on a serial queue and each new change cancels queued work; the render then waits only while the WebView is still loading the previous page (the intended 0.5 s cap never triggers because `timeIntervalSinceNow` is negative) [src:MacDown/Code/Document/MPRenderer.m:535-572]. Text changes trigger rendering only when the preview is visible or the word count is shown, and never in manual-render mode (`needsHtml`) [src:MPDocument.m:294-299, 1122-1126]. Showing a collapsed preview renders immediately [src:MPDocument.m:1855-1863]. Preview scroll position is kept across re-renders (`lastPreviewScrollTop`). | Typing, when "Update preview automatically as you type" is on (default) | In |
| F-03 | Render Markdown | Forces a parse and render. This is the only way to refresh the preview when auto-update is off (`markdownManualRender = YES`). The menu item is enabled only while the preview pane is visible [src:MacDown/Localization/Base.lproj/MainMenu.xib:367-372]. | View > Render Markdown, `Cmd+R` | In |
| F-04 | Left 1:3 Right | Sets the divider to 25% (editor narrow). | View > Left 1:3 Right (no shortcut) | In |
| F-05 | Left 1:1 Right | Sets the divider to 50%. | View > Left 1:1 Right, `Shift+Cmd+0` | In |
| F-06 | Left 3:1 Right | Sets the divider to 75% (editor wide). | View > Left 3:1 Right (no shortcut) | In |
| F-07 | Hide / Restore Preview Pane | Collapses the preview so the editor fills the window. The menu title toggles between "Hide Preview Pane" and "Restore Preview Pane". Restoring uses the previous ratio (0.5 if none). The menu item is hidden when the preview is collapsed and no previous ratio exists [src:MPDocument.m:667-677]. | View > Hide Preview Pane, `Shift+Cmd+H`; toolbar Layout menu | In |
| F-08 | Hide / Restore Editor Pane | Collapses the editor so the preview fills the window. Title toggles "Hide Editor Pane" / "Restore Editor Pane" [disasm:26508]. | View > Hide Editor Pane, `Shift+Cmd+E`; toolbar Layout menu | In |
| F-09 | Layout toolbar drop-down | Pull-down toolbar item (icon `ToolbarIconEditorAndPreview`) with two items: toggle editor pane, then toggle preview pane. The template menu items carry key equivalents `e` and `p`, but only title, target and action are copied into the pop-up, so the pop-up items have no shortcuts of their own [src:MacDown/Code/Application/MPToolbarController.m:51-52, 288-292]. Item titles come from validation (F-07, F-08) [disasm:13309]. | Toolbar "Layout" | In |
| F-10 | Editor on right | Swaps the pane order. | Preference P-03 | In |
| F-11 | Scroll sync | When the editor scrolls, the preview scrolls to match. **Deliberate web deviation (issue #2):** the anchors are every rendered block, not only headers and images. The preview marks each block with its source lines (`data-line`, `data-line-end`, from markdown-it's token `map`; front matter shifts them, footnote definitions get none; only in the preview, never in Copy HTML or export). The top of each block is paired with the top of its first line in the editor, the bottom with the top of the line after it, so headers, paragraphs, images, code blocks, lists, tables and the space between blocks line up. Pairs that would move the preview backwards are dropped, so the preview never jumps back. Positions between pairs are interpolated. Alignment is at mid-screen, tapered over one screen to the top edge at the top of the document and to the bottom edge at the end. An image that loads after the render re-syncs the preview, unless the preview was moved since the last sync (an in-page link, F-18, or a manual scroll). Original: the anchors are headers (`h1`–`h6`) and images that are a paragraph's only child (`document.querySelectorAll("h1, h2, h3, h4, h5, h6, img:only-child")`), and in the editor lines matching `^(#+)\s`, `^([-]+)$` (setext underline, only when the previous line has content and is not itself a dash line) and `^!\[[^\]]*\]\([^)]*\)$`; editor anchors in the last screenful are dropped, and the last stretch interpolates to the end of the document [disasm:31953, 32505; src:MPDocument.m:1717-1853]. Those regexes also match inside code fences (`# comment`, `---`) and miss quoted or HTML headers, so the two lists went out of step and the preview jumped across the document. | Editor scroll, when P-04 is on (default on) | In (deviation, see issue #2) |
| F-12 | Word count | Counts words, characters and characters without spaces from the **rendered preview text** (DOM text count), not the Markdown source. Updated after each preview load. Source algorithm [src:MacDown/Code/Extension/DOMNode+Text.m]: walk the whole preview DOM, skipping `SCRIPT`, `STYLE` and `HEAD`. Words: each text node is counted separately with NSString word enumeration (so `**foo**bar` counts 2). A `CODE` inside `PRE` (code block) counts 0 words, and an inline `CODE` counts 1 word if it has any words. Characters: text length minus newline characters (code blocks included). No spaces: text length minus all whitespace and newlines. The pop-up is disabled until the first preview load finishes [src:MPDocument.m:450, 1894-1904]. A pop-up chooses which count is shown (persisted as `editorWordCountType`: 0 = words (default), 1 = characters, 2 = characters (no spaces)). Labels: `%@ word`/`%@ words`, `%@ character`/`%@ characters`, `%@ character (no spaces)`/`%@ characters (no spaces)` [Localizable.strings; disasm:33314]. | Visible when P-05 is on | In |
| F-13 | Show / Hide Toolbar | Toggles the toolbar. The menu title toggles "Show Toolbar" / "Hide Toolbar". | View > Show Toolbar, `Opt+Cmd+T` | In |
| F-14 | Toolbar customization | NSToolbar customization. All 13 items are allowed. By default all are shown except Comment, Highlight and Strikethrough [disasm:14407]. | Right-click toolbar > Customize (macOS standard) | In (simple "customize toolbar" dialog; persisted). The dialog is modal: Tab and Shift+Tab stay inside it while it is open (D-11). Removing every item leaves an **empty** toolbar; "unset" (the default set) and "empty" are distinct states (D-12) |
| F-15 | Enter Full Screen | Full-screen window. | View > Enter Full Screen, `Ctrl+Cmd+F` | In (Fullscreen API) |
| F-16 | Window title and per-document layout memory | Title is the file name or "Untitled". Frame and split ratio are remembered per document. | Automatic | In (title and split ratio only) |
| F-17 | Scale preview based on editor font size | When on, preview zoom = `editorBaseFontSize / 14` (WebView `pageSizeMultiplier`) [disasm:31880; constant 14.0]. Applied after each preview load and when the base font changes. Turning the option off does not reset an already-applied zoom: `scaleWebview` just returns early and `pageSizeMultiplier` is a WebView property, so the zoom stays until the window is reopened [src:MPDocument.m:1578-1581, 1691-1715]. This looks like an original bug. Proposed web behaviour (CoS to confirm): zoom 1 when the option is off. | Preference P-29 | In |
| F-18 | Preview link handling | Clicking a link in the preview does not navigate the preview. Remote URLs open in the default browser. File URLs to existing files are opened (Markdown files open as documents in MacDown) [disasm:33461, `webView:decidePolicyForNavigationAction:`]. Source: a link whose URL without query and fragment equals the current page (an in-page `#anchor`) is followed inside the preview; a link to exactly the current URL is ignored; every other link is opened with `NSWorkspace openURL:` (the system default app) [src:MPDocument.m:912-939, 1927-1934]. Dragging onto the preview is disabled, and copying a preview selection also puts its HTML on the pasteboard [src:MPDocument.m:944-967]. | Click in preview | In (external links open in a new tab; in-page `#` anchors scroll, as WebKit scrolls to a fragment: to the element with that `id`, else to the first `<a name=…>` with that name, first as written and then percent-decoded; an empty fragment or `#top` scrolls to the top; a malformed percent escape is kept as is and never raises; no target does nothing. The bundled help document needs the `name` anchors) |
| F-19 | Auto-create link target files | Clicking a link to a missing local file creates it as a new document if P-06 is on. Errors: "Can’t create file:" / "MacDown can’t create a file for the clicked link because the current file is not saved anywhere yet. Save the current file somewhere to enable this feature." / "File not found at path:\n%@" / "Please check the path of your link is correct. Turn on “Automatically create link targets” If you want MacDown to create nonexistent link targets for you." / "An error occurred while creating the file:\n%@" [binary-utf16-strings.txt]. | Click on a local link | Out (needs sibling-file creation, which a client-only SPA cannot do) |
| F-20 | Preview base URL | Relative URLs in the preview resolve against the document's folder. For unsaved documents they resolve against the "Default path" preference (default: home folder) [`renderer:didProduceHTMLOutput:`, disasm:28273]. | Automatic | In (web: relative to the opened file's directory handle if available, otherwise unresolved) |

### 2.2 Files and documents

| ID | Feature | Description | Trigger | Scope |
|---|---|---|---|---|
| F-21 | New | New untitled document. | File > New, `Cmd+N` | In (browser reserves `Cmd+N`; also offer an in-app button) |
| F-22 | Open | Opens `.md`, `.markdown` or plain-text files. The text is read as §1 "Encoding" says; line endings are kept as read (NSTextView `setString:` stores the string as is) and the document is not edited after opening. | File > Open…, `Cmd+O` | In |
| F-23 | Open Recent | List of recent documents. | File > Open Recent | Out (single-document web app; optional later) |
| F-24 | Clear Recent Menu | Clears the recent list. | File > Open Recent > Clear Menu | Out |
| F-25 | Close | Closes the document. Prompts to save if edited. | File > Close, `Cmd+W` | In (closes to an empty untitled doc; `Cmd+W` is browser-reserved) |
| F-26 | Save | Saves. On first save a panel opens with the default name from F-31, extension `.md` added when missing, "other file types" allowed, and the folder set to the current file's folder [disasm:25947]. Source: the name is suggested only for documents that have never been saved; for saved documents (Save As) the panel opens in the file's folder without a suggested name. Allowed types are the `CFBundleTypeExtensions` of the document types (`md`, `markdown`), and the extension is shown [src:MPDocument.m:558-605]. A presumed name that already ends in `.md` is not set, so the panel keeps its default name: the web app suggests "Untitled.md" [src:MPDocument.m:578-582] (SD-14). The file is written as UTF-8 without a BOM, with the line endings it was read with: untouched CRLF and CR breaks stay, a newly typed Return inserts LF (`insertNewline:`), and Backspace or Delete removes a CRLF whole (AppKit probe, SD-11 / D-13). | File > Save…, `Cmd+S` | In |
| F-27 | Save As | Save to a new location. | File > Save As…, `Shift+Cmd+S` | In |
| F-28 | Revert to Saved | Discards edits and reloads from disk. | File > Revert to Saved | In |
| F-29 | Autosave in place | `autosavesInPlace = YES`: edits are saved automatically to the file (macOS Versions) [disasm:25624]. | Automatic | In (web: autosave draft to localStorage; restore on reload) |
| F-30 | Ensure newline at end of file | On save, if the text is not empty and does not end with a newline character, "\n" is inserted into the editor at the end and the selection is preserved [disasm:25718; src:MPDocument.m:522-538]. | Save, when P-41 is on | In |
| F-31 | Presumed file name | Default save/export name. Source order [src:MPDocument.m:1865-1892; src:MacDown/Code/Extension/NSString+Lookup.m:89-112]: (1) a saved document uses its file name without extension (`stringByDeletingPathExtension`: the extension is the text after the last dot of the last path component, only when it is non-empty, has no space and the dot is not the component's first character, so `a.`, `v1. final` and `Notes v1.5 final` keep their dots, D-17); (2) the front-matter `title` (if P-28 is on), used as is; (3) the **highest-level** ATX header: the first line matching `^#\s+(\S.*)$` anywhere in the text, else the first `^##\s+(\S.*)$`, and so on to H6 (setext headers are ignored); (4) "Untitled". Only for a header-derived title (3), the characters `/`, `|` and `:` are replaced with `-` [disasm:33134]. | Save/Export panels | In |
| F-32 | Ensure open document on launch | When on, an untitled document opens at launch if no other files are opening [disasm:16399]. | Launch, preference P-02 | In (web: checked = the last draft or a blank document at launch; unchecked = the empty "no document" state with New and Open, see U-12 (resolved)) |
| F-33 | Drop JPEG into editor | Dragging a JPEG file into the editor inserts `![](data:image/jpeg;base64,<data>)` at the selection [disasm:132; format `%@![](data:image/jpeg;base64,%@)%@`]. Source: the drag is accepted only when the pasteboard has `public.jpeg` data; the **first** dropped file is read and inserted at the start of the current selection (the selection is not replaced) [src:MacDown/Code/View/MPEditorView.m:47-93]. | Drag and drop | In |
| F-34 | Dirty state | A new untitled document that is still empty is not "edited", so no save prompt [disasm:25654]. | Automatic | In |

### 2.3 Export, print, copy

| ID | Feature | Description | Trigger | Scope |
|---|---|---|---|---|
| F-35 | Export HTML | Save panel (type `html`, default name F-31) with an accessory view of two checkboxes: **Include styles** (`stylesIncluded`, default on when a preview style is selected) and **Include syntax highlighting** (`highlightingIncluded`, default = P-20). Writes `HTMLForExportWithStyles:highlighting:` as UTF-8: the full template (§7.4) with style CSS (if styles are included), Prism CSS/JS (if highlighting is included) and, when enabled, Mermaid, Graphviz and MathJax scripts. `<title>` is the file name without its extension [disasm:29104, 20617; bind:ExportPanelAccessory]. Exact asset rules from source in §9 (E-01 to E-03) [src:MPRenderer.m:660-702]. "Include styles" defaults to on whenever `htmlStyleName` is set, i.e. off only when the empty "no style" item is chosen [src:MPDocument.m:1257]. | File > Export > HTML…, `Opt+Cmd+E` | In |
| F-36 | Export PDF | Save panel (type `pdf`, default name F-31). Prints the preview frame to the PDF file (`NSPrintSaveJob`) [disasm:29382]. | File > Export > PDF…, `Opt+Cmd+P` | In (web: print dialog of the rendered preview, "Save as PDF") |
| F-37 | Print | Prints the preview (not the source). Margins **50 pt top and bottom, 0 pt left and right**, automatic pagination, not vertically centred [src:MPDocument.m:607-620] (M1b correction: the M1 text said 50 pt on all four sides). While printing, new renders are not loaded into the preview [src:MPDocument.m:1052-1053]. | File > Print…, `Cmd+P` | In (print stylesheet, preview only) |
| F-38 | Page Setup | macOS page layout dialog. | File > Page Setup…, `Shift+Cmd+P` | Out |
| F-39 | Copy HTML | Copies the rendered **body HTML** (`renderer.currentHtml`, without template, CSS or scripts) to the clipboard as plain text [disasm:28990]. If the preview is not being updated (hidden pane, or manual render), a fresh parse runs first and the copy happens when it completes [src:MPDocument.m:1228-1246, 1057-1064]. The body includes the front-matter table and TOC substitutions. | Format > Copy HTML, `Opt+Cmd+C`; toolbar Copy HTML | In |

### 2.4 Format menu commands (editing)

All of these act on the editor selection. Helper behaviour is in §5.

| ID | Feature | Markup | Trigger | Scope |
|---|---|---|---|---|
| F-40 | Strong | toggles `**…**` | Format > Strong, `Cmd+B`; toolbar Strong | In |
| F-41 | Emphasize | toggles `*…*`. A selection already inside `**…**` or `***…***` is handled so bold is not broken [disasm:8722] | Format > Emphasize, `Cmd+I`; toolbar Emphasize | In |
| F-42 | Underline | toggles `_…_`. The **menu item** is hidden (and so its shortcut is inactive) unless P-11 is on; the toolbar button always works (F-162) | Format > Underline, `Cmd+U`; toolbar Underline | In |
| F-43 | Strikethrough | toggles `~~…~~`. Menu item hidden unless P-10 is on (F-162) | Format > Strikethrough, `Cmd+-`; toolbar Strikethrough (customize only) | In |
| F-44 | Highlight | toggles `==…==`. Menu item hidden unless P-12 is on (F-162) | Format > Highlight, `Cmd+=`; toolbar Highlight (customize only) | In |
| F-45 | Inline Code | toggles `` `…` `` | Format > Inline Code, `Cmd+K`; toolbar Inline Code | In |
| F-46 | Comment | toggles `<!--…-->` | Format > Comment, `Cmd+/` | In |
| F-47 | Header 1 | Selected lines: strip existing `#` prefixes (`^(#+ )*`), add `# `. With more than one line selected, whitespace-only lines are left alone [src:NSTextView+Autocomplete.m:653-716] | Format > Convert To > Header 1, `Cmd+1`; toolbar Heading 1 | In |
| F-48 | Header 2 | as F-47 with `## ` | `Cmd+2`; toolbar Heading 2 | In |
| F-49 | Header 3 | `### ` | `Cmd+3`; toolbar Heading 3 | In |
| F-50 | Header 4 | `#### ` | `Cmd+4` | In |
| F-51 | Header 5 | `##### ` | `Cmd+5` | In |
| F-52 | Header 6 | `###### ` | `Cmd+6` | In |
| F-53 | Paragraph | strips header prefixes | Format > Convert To > Paragraph, `Cmd+0` | In |
| F-54 | Ordered List | Toggles the prefix `1. ` on each selected line. Original detection pattern `^[0-9]+ \S` [disasm:30137; src:MPDocument.m:1409-1412], which never matches `1. x`, so toggling an existing ordered list in the original adds a second prefix (`1. 1. x`). **Deliberate web deviation (CoS decision, U-05):** detect with `^[0-9]+\. \S` and, when removing, strip the matched `^[0-9]+\. ` from each line. All other rules of the block toggle (§5.4) stay as in the original | Format > Ordered List, `Shift+Cmd+O`; toolbar Ordered List | In (deviation, see U-05) |
| F-55 | Unordered List | Toggles the prefix from P-45 (`* `, `+ ` or `- `). Detection `^[\*\+-] \S` | Format > Unordered List, `Shift+Cmd+U`; toolbar Unordered List | In |
| F-56 | Blockquote | Toggles the prefix `> `. Detection `^> \S` | Format > Blockquote, `Shift+Cmd+B`; toolbar Blockquote | In |
| F-57 | Shift Right | Indents the selected lines by `\t`, or by 4 spaces when P-37 is on. Every line in the range gets the padding, including empty lines, except a final empty line after a trailing newline [src:NSTextView+Autocomplete.m:387-417]. **Quirk kept (SD-08):** when the last processed line is empty (`modLines.lastObject` equals the padding), it gets no padding, so Shift Right on an empty last line changes nothing [src:NSTextView+Autocomplete.m:405-409] | Format > Shift Right, `Cmd+]`; toolbar Shift Right | In |
| F-58 | Shift Left | Per selected line, removes up to 4 leading spaces, or one leading tab, or spaces followed by a tab (for example `"  \t"`), at most 4 characters. A line made only of whitespace is left unchanged [src:NSTextView+Autocomplete.m:419-467]. **Quirk kept (SD-08):** on a whitespace-only first line the shift is still counted, so the text is unchanged but the selection moves left by that count (`selectedRange.location -= firstShift`) [src:NSTextView+Autocomplete.m:437-465] | Format > Shift Left, `Cmd+[`; toolbar Shift Left | In |
| F-59 | Link | Toggles `[` + selection + `]()` [disasm:29883; src:MPDocument.m:1369-1387]. When markup was **added**, the cursor moves inside the `()`. If the clipboard string parses as a URL with scheme `http`, `https` or `file` (case-insensitive) [src:MacDown/Code/Extension/NSPasteboard+Types.m:14-38], that URL is inserted inside the `()` and selected. When markup was **removed** (the selection was directly surrounded by `[` and `]()`), nothing else happens | Format > Link, `Shift+Cmd+K`; toolbar Link | In |
| F-60 | Image | as F-59 with `![` … `]()` [src:MPDocument.m:1389-1407] | Format > Image, `Shift+Cmd+I`; toolbar Image | In |
| F-61 | New Paragraph | Inserts `\n\n` **at the cursor** (replacing any selection); it does not move to the end of the line. If the cursor is on an empty line, it inserts a single plain newline instead (no list or quote continuation) [src:MPDocument.m:1438-1454] (M1b correction) | Format > New Paragraph, `Cmd+Return` | In |

### 2.5 Editor behaviours

| ID | Feature | Description (details in §5) | Trigger | Scope |
|---|---|---|---|---|
| F-62 | Auto-pair characters | Typing an opening character inserts its pair when the next character is a boundary (and, for the symmetric `'` and `"`, the previous character too) | Typing; P-36 | In |
| F-63 | Wrap selection | Typing a pair/markup character with text selected wraps the selection | Typing; P-36 | In |
| F-64 | Skip over closing char | Typing a closing char right before the same char moves past it. There is **no HTML tag auto-close**: with P-36 on, typing `<b>` gives `<b>|` (D-09) | Typing; P-36 | In |
| F-65 | Delete empty pair | Backspace between an empty pair deletes both | Backspace; P-36 | In |
| F-66 | List continuation | Return in a list item continues the list | Return; P-38 | In |
| F-67 | Auto-increment ordered lists | The next number is n+1 | Return; P-39 | In |
| F-68 | Blockquote continuation | Return in a `>` line continues the quote | Return; P-38 | In |
| F-69 | Indented line continuation | Return keeps the leading whitespace of the current line. **Not gated by P-38**: it applies even when P-38 is off [src:MPDocument.m:769-783] (M1b correction) | Return (always) | In |
| F-70 | Tab key | With a selection: Shift Right (F-57). Without: inserts `\t`, or spaces up to the next 4-column stop when P-37 is on | Tab | In |
| F-71 | Shift+Tab | Shift Left (F-58) | Shift+Tab | In |
| F-72 | Backspace soft-tab | When P-37 is on and at least 2 spaces precede the cursor, deletes back to the previous 4-column stop (max 4 spaces) | Backspace | In |
| F-73 | Smart Home | `Cmd+←` jumps to the first non-whitespace character of the line. Pressed again (cursor already there or before it) it goes to the line start. On a soft-wrapped line, when the target is on a different visual row, the normal `Cmd+←` behaviour is used [src:MPDocument.m:803-830] | `Cmd+Left`; P-40 | In |
| F-74 | Editor syntax highlighting and themes | The Markdown source is coloured by the theme (§7.2). If the theme file fails to parse, `editorStyleName` is reset to none [src:MPDocument.m:1559-1569]. An HTML comment that forms its own block gets the COMMENT style, as an inline one does (`HtmlBlock` contains `HtmlComment`, which adds `pmh_COMMENT` [pmh_grammar.leg:365-366, 614-615]; D-10) | Always; P-31 | In |
| F-75 | Base font | Editor font family and size (default Menlo 14). The preference shows the font name and size (`%@ - %.1lf`) and has a "Change…" button | P-30 | In |
| F-76 | Line spacing | Extra paragraph line spacing in points | P-32 | In |
| F-77 | Text insets | Horizontal × vertical padding inside the editor | P-33, P-34 | In |
| F-78 | Limit editor width | If editor width > 2×hInset + maxWidth, the horizontal inset becomes **(width − maxWidth) × 0.45**, so the text column sits slightly left of centre ("we tend to expect things in an editor to shift to left a bit") [disasm:31593; src:MPDocument.m:1649-1663] (M1b correction: was /2). Re-applied when the editor frame changes | P-35 | In |
| F-79 | Scroll past end | Adds bottom padding so the last line can scroll to the top. Extra height = min(content height, visible height) − `trailingHeight` − 2 × vertical inset, when positive [src:MacDown/Code/View/MPEditorView.m:130-142, 184-218]. `trailingHeight` is the bounding rectangle of the whitespace after the last visible character. **SD-09:** when nothing trails, AppKit returns one line height of the font (without line spacing) for the empty range, so one line is subtracted (16 pt for Menlo 14; AppKit probe); with trailing newlines it also covers the extra empty line fragment; with no visible character at all it is the whole used rectangle (no padding) | P-42 | In |
| F-80 | Unordered list marker | Marker used by F-55. List continuation (F-66) reuses the marker of the current line, not P-45 | P-45 | In |

### 2.6 Edit menu (standard text editing)

| ID | Item | Shortcut | Scope |
|---|---|---|---|
| F-81 | Undo | `Cmd+Z` | In |
| F-82 | Redo | `Shift+Cmd+Z` | In |
| F-83 | Cut | `Cmd+X` | In |
| F-84 | Copy | `Cmd+C` | In |
| F-85 | Paste | `Cmd+V` | In |
| F-86 | Delete | (none) | In |
| F-87 | Select All | `Cmd+A` | In |
| F-88 | Find… | `Cmd+F` | In (CodeMirror search panel) |
| F-89 | Find and Replace… | `Opt+Cmd+F` | In |
| F-90 | Find Next | `Cmd+G` | In |
| F-91 | Find Previous | `Shift+Cmd+G` | In |
| F-92 | Use Selection for Find | `Cmd+E` | In |
| F-93 | Jump to Selection | `Cmd+J` | In (scroll the selection into view) |
| F-94 | Show Spelling and Grammar | `Cmd+:` | Out (macOS panel) |
| F-95 | Check Document Now | `Cmd+;` | Out |
| F-96 | Check Spelling While Typing | (none) | In (toggles the `spellcheck` attribute; default off, persisted as `editorContinuousSpellCheckingEnabled`, see F-164) |
| F-97 | Check Grammar With Spelling | (none) | Out |
| F-98 | Correct Spelling Automatically | (none) | Out |
| F-99 | Show Substitutions | (none) | Out |
| F-100 | Smart Copy/Paste | (none) | Out |
| F-101 | Smart Quotes (macOS text substitution; when on, auto-pair inserts `‘’`/`“”`, see §5.1) | (none) | Out |
| F-102 | Smart Dashes | (none) | Out |
| F-103 | Data Detectors | (none) | Out |
| F-104 | Text Replacement | (none) | Out |
| F-105 | Make Upper Case | (none) | In. NSTextView `uppercaseWord:` (Q-05, AppKit probe): the selection is extended to whole word-granularity units, the units are transformed and the result is selected. With an empty selection the unit is the one **before** the cursor (at a document or line start, the one after it): `ab| cd` → `«AB» cd`, `ab |cd` → the space only (no change), `ab\n|cd` → `ab\n«CD»` |
| F-106 | Make Lower Case | (none) | In. Same unit rules as F-105 (`lowercaseWord:`) |
| F-107 | Capitalize | (none) | In. Same unit rules as F-105 (`capitalizeWord:`). A letter is upper-cased when the character before it is not a letter (digits, `-`, `_`, `.`, `:` and whitespace start a word), except after an apostrophe that follows a letter; all other letters are lower-cased: `hELLO wORLD-x` → `Hello World-X`, `it's` → `It's`, `x1y` → `X1Y` (AppKit probe) |
| F-108 | Start Speaking | (none) | Out |
| F-109 | Stop Speaking | (none) | Out |

### 2.7 Rendering

Details and markdown-it mapping are in §6.

| ID | Feature | Controlled by | Scope |
|---|---|---|---|
| F-110 | Core Markdown (Hoedown: paragraphs, ATX/setext headers, emphasis, lists, blockquotes, indented code, hr, links, images, reference links, line breaks with two trailing spaces, inline HTML) | always | In |
| F-111 | Tables | P-07 | In |
| F-112 | Fenced code blocks (``` and ~~~) | P-08 | In |
| F-113 | Autolink (bare URLs, `www.`, e-mails) | P-09 | In |
| F-114 | Strikethrough `~~x~~` → `<del>` | P-10 | In |
| F-115 | Underline `_x_` → `<u>` | P-11 | In |
| F-116 | Highlight `==x==` → `<mark>` | P-12 | In |
| F-117 | Footnotes `[^id]` / `[^id]: …` | P-13 | In |
| F-118 | Superscript `^x` / `^(x y)` → `<sup>` | P-14 | In |
| F-119 | Quote `"x"` → `<q>x</q>` | P-15 | In |
| F-120 | SmartyPants typography | P-16 | In |
| F-121 | Intra-word emphasis | P-17 | In |
| F-122 | Header anchors `id="toc_N"` on every header | always | In |
| F-123 | Table of contents token `[TOC]` | P-27 | In |
| F-124 | Prism syntax highlighting of code blocks plus theme | P-20, P-21 | In |
| F-125 | Language aliases and on-demand Prism language loading | with F-124 | In |
| F-126 | Line numbers in code blocks | P-22 | In |
| F-127 | Code block accessory (None / Language name / Custom info) | P-23 | In |
| F-128 | Mermaid diagrams (` ```mermaid `) | P-24 | In (low priority) |
| F-129 | Graphviz diagrams (` ```dot `, `circo`, `fdp`, `neato`, `osage`, `twopi`) | P-25 | In (low priority) |
| F-130 | TeX-like math via MathJax | P-18 | In |
| F-131 | `$…$` inline math | P-19 | In |
| F-132 | Task lists `[ ]` / `[x]` | P-26 | In |
| F-133 | Jekyll front matter as a table | P-28 | In |
| F-134 | Render newline literally (hard wrap) | P-29b | In |
| F-135 | Raw HTML pass-through (not escaped, not sanitised) | always | In |
| F-136 | Preview CSS style selection | P-19c | In |
| F-137 | "Reveal" styles/themes folder in Finder | Rendering/Editor panes | Out (Finder) |
| F-138 | "Reload" styles/themes list | Rendering/Editor panes | In (re-reads the built-in list plus user-imported CSS/themes) |
| F-139 | HTML page template and `<title>` | always | In |

### 2.8 Application, help and miscellaneous

| ID | Feature | Trigger | Scope |
|---|---|---|---|
| F-140 | Preferences window (General, Markdown, Editor, Rendering, Terminal panes, in that order [src:MacDown/Code/Application/MPMainController.m:131-137]; M1b correction: M1 had Rendering before Editor) | MacDown > Preferences…, `Cmd+,` | In (Terminal pane Out) |
| F-141 | Preferences persistence and live apply. Any change re-renders open documents (`userDefaultsDidChange:`) and re-applies editor settings (`setupEditor:`) | automatic | In (localStorage) |
| F-142 | About MacDown | MacDown > About MacDown | In (simple dialog: name, version 0.7.3, copyright, MIT) |
| F-143 | Check for Updates… (Sparkle) | MacDown > Check for Updates… | Out |
| F-144 | Include pre-releases (update channel) | General pane | Out |
| F-145 | Services | MacDown > Services | Out |
| F-146 | Hide MacDown | `Cmd+H` | Out |
| F-147 | Hide Others | `Opt+Cmd+H` | Out |
| F-148 | Show All | (none) | Out |
| F-149 | Quit MacDown | `Cmd+Q` | Out |
| F-150 | Minimize | Window > Minimize, `Cmd+M` | Out |
| F-151 | Zoom | Window > Zoom, `Shift+Cmd+M` | Out |
| F-152 | Bring All to Front | Window > Bring All to Front | Out |
| F-153 | MacDown Help: copies `help.md` to a temporary folder and opens it as a normal editable document [disasm:16076]. The help window is sized to the screen's visible frame when it is newly opened [src:MacDown/Code/Application/MPMainController.m:28-51] | Help > MacDown Help | In (opens the bundled help as a read-write document, not overwriting the user's draft) |
| F-154 | Contributing to MacDown: opens `contribute.md` the same way | Help > Contributing to MacDown | In |
| F-155 | First-launch tips: on a fresh install, opens Help and Contributing [disasm:17470] | first launch | In (first visit opens help) |
| F-156 | Plug-ins menu: lists native plug-in bundles from Application Support (`MPPlugInController`) | Plug-ins menu | Out |
| F-157 | Terminal pane / `macdown` shell utility install | Preferences > Terminal | Out |
| F-158 | AppleScript (`MacDown.sdef`) | — | Out |
| F-159 | Localization (≈20 languages) | — | Out (English only) |
| F-160 | Easter-egg content maps (`Data/data.map`, `Data/treats.map`; `insertMappedContent` on Return, `treatLastSeenStamp`) | — | Out |
| F-161 | Copies bundled Styles/Themes into `~/Library/Application Support/MacDown` on launch so users can edit them (`copyFiles`) | launch | Out (web: built-ins are read-only; users may import custom CSS, see F-138) |

### 2.9 Features added in M1b (found in the source)

| ID | Feature | Description | Trigger | Scope |
|---|---|---|---|---|
| F-162 | Extension-dependent Format menu items | Format > Underline, Strikethrough and Highlight are **hidden** unless P-11, P-10 and P-12 respectively are on (`hidden` bound to the negated preference). A hidden menu item does not respond to its key equivalent on macOS, so `Cmd+U`, `Cmd+-` and `Cmd+=` do nothing while the extension is off. The toolbar buttons (T-02c, T-11, T-12) are not affected [src:MacDown/Localization/Base.lproj/MainMenu.xib:440-470]. The shortcut part relies on documented AppKit behaviour (`NSMenuItem.hidden`, `allowsKeyEquivalentWhenHidden` defaults to NO), not on a run of the app (high confidence) | Preferences P-10, P-11, P-12 | In |
| F-163 | Touch Bar | Editor Touch Bar with: Shift Left, Shift Right ‖ Strong, Emphasize ‖ Heading 1–3 ‖ Unordered List, Ordered List ‖ Blockquote, Inline Code ‖ Link, Image ‖ Copy HTML (‖ = small fixed space) [src:MacDown/Localization/Base.lproj/MPDocument.xib:54-315] | Touch Bar Macs | Out (macOS hardware) |
| F-164 | Persisted text-checking toggles | The editor's Edit-menu text-checking switches are saved as preferences and restored for every new window: `editorContinuousSpellCheckingEnabled`, `editorGrammarCheckingEnabled`, `editorAutomaticSpellingCorrectionEnabled`, `editorAutomaticQuoteSubstitutionEnabled`, `editorAutomaticDashSubstitutionEnabled`, `editorAutomaticTextReplacementEnabled`, `editorAutomaticDataDetectionEnabled` (all default NO) and `editorEnabledTextCheckingTypes` (default all types) [src:MPDocument.m:47-62, 1205-1216, 1610-1624]. Editor link detection is always forced off [src:MPDocument.m:1646] | Edit menu toggles | In for `editorContinuousSpellCheckingEnabled` (F-96); the rest Out |
| F-165 | Divider colour follows the visible pane | When the editor pane is collapsed, the split divider takes the preview body's computed background colour; when the preview is collapsed, the editor background colour; with both visible, the default divider colour [src:MPDocument.m:1665-1689] | Hide/restore panes, theme change | In (low priority) |
| F-166 | "No style" / "No theme" options | The preview CSS pop-up (P-19c) and the editor Theme pop-up (P-31) both start with an **empty item**. Choosing it stores nil (`htmlStyleName` / `editorStyleName` removed), giving an unstyled preview. For the editor, `highlighter.styles = nil` selects `getDefaultStyles`, so Markdown elements still get the HGMarkdownHighlighter default palette (dark blue bold headers, magenta strong and list markers, cyan links, grey comments and so on) on the default text view colours (black text, white background) [src:Dependency/peg-markdown-highlight/HGMarkdownHighlighter.m:435-473, 487] (SD-07). Export then defaults "Include styles" to off (F-35) [src:MacDown/Code/Preferences/MPHtmlPreferencesViewController.m:58-67, 106-124; src:MacDown/Code/Preferences/MPEditorPreferencesViewController.m:65-83, 120-129] | Preferences | In |

---

## 3. Menus

Source: `[menu]` (decoded `MainMenu.nib`). The "ID" column links to §2.

### MacDown (application) menu
| Item | Shortcut | Action | ID |
|---|---|---|---|
| About MacDown | — | `orderFrontStandardAboutPanel:` | F-142 |
| Check for Updates… | — | `SUUpdater checkForUpdates:` | F-143 |
| Preferences… | `Cmd+,` | `showPreferencesWindow:` | F-140 |
| Services | — | submenu | F-145 |
| Hide MacDown | `Cmd+H` | `hide:` | F-146 |
| Hide Others | `Opt+Cmd+H` | `hideOtherApplications:` | F-147 |
| Show All | — | `unhideAllApplications:` | F-148 |
| Quit MacDown | `Cmd+Q` | `terminate:` | F-149 |

### File
| Item | Shortcut | Action | ID |
|---|---|---|---|
| New | `Cmd+N` | `newDocument:` | F-21 |
| Open… | `Cmd+O` | `openDocument:` | F-22 |
| Open Recent ▸ (recent files) | — | — | F-23 |
| Open Recent ▸ Clear Menu | — | `clearRecentDocuments:` | F-24 |
| Close | `Cmd+W` | `performClose:` | F-25 |
| Save… | `Cmd+S` | `saveDocument:` | F-26 |
| Save As… | `Shift+Cmd+S` | `saveDocumentAs:` | F-27 |
| Revert to Saved | — | `revertDocumentToSaved:` | F-28 |
| Export ▸ HTML… | `Opt+Cmd+E` | `exportHtml:` | F-35 |
| Export ▸ PDF… | `Opt+Cmd+P` | `exportPdf:` | F-36 |
| Page Setup… | `Shift+Cmd+P` | `runPageLayout:` | F-38 |
| Print… | `Cmd+P` | `printDocument:` | F-37 |

### Edit
| Item | Shortcut | ID |
|---|---|---|
| Undo / Redo | `Cmd+Z` / `Shift+Cmd+Z` | F-81 / F-82 |
| Cut / Copy / Paste | `Cmd+X` / `Cmd+C` / `Cmd+V` | F-83 / F-84 / F-85 |
| Delete | — | F-86 |
| Select All | `Cmd+A` | F-87 |
| Find ▸ Find… (tag 1) | `Cmd+F` | F-88 |
| Find ▸ Find and Replace… (tag 12) | `Opt+Cmd+F` | F-89 |
| Find ▸ Find Next (tag 2) | `Cmd+G` | F-90 |
| Find ▸ Find Previous (tag 3) | `Shift+Cmd+G` | F-91 |
| Find ▸ Use Selection for Find (tag 7) | `Cmd+E` | F-92 |
| Find ▸ Jump to Selection | `Cmd+J` | F-93 |
| Spelling and Grammar ▸ Show Spelling and Grammar | `Cmd+:` | F-94 |
| Spelling and Grammar ▸ Check Document Now | `Cmd+;` | F-95 |
| Spelling and Grammar ▸ Check Spelling While Typing | — | F-96 |
| Spelling and Grammar ▸ Check Grammar With Spelling | — | F-97 |
| Spelling and Grammar ▸ Correct Spelling Automatically | — | F-98 |
| Substitutions ▸ Show Substitutions | — | F-99 |
| Substitutions ▸ Smart Copy/Paste | — | F-100 |
| Substitutions ▸ Smart Quotes | — | F-101 |
| Substitutions ▸ Smart Dashes | — | F-102 |
| Substitutions ▸ Data Detectors | — | F-103 |
| Substitutions ▸ Text Replacement | — | F-104 |
| Transformations ▸ Make Upper Case | — | F-105 |
| Transformations ▸ Make Lower Case | — | F-106 |
| Transformations ▸ Capitalize | — | F-107 |
| Speech ▸ Start Speaking | — | F-108 |
| Speech ▸ Stop Speaking | — | F-109 |

### View
| Item | Shortcut | Action | ID |
|---|---|---|---|
| Render Markdown | `Cmd+R` | `render:` | F-03 |
| Left 1:3 Right | — | `setEditorOneQuarter:` | F-04 |
| Left 1:1 Right | `Shift+Cmd+0` | `setEqualSplit:` | F-05 |
| Left 3:1 Right | — | `setEditorThreeQuarters:` | F-06 |
| Hide Preview Pane / Restore Preview Pane | `Shift+Cmd+H` | `togglePreviewPane:` | F-07 |
| Hide Editor Pane / Restore Editor Pane | `Shift+Cmd+E` | `toggleEditorPane:` | F-08 |
| Show Toolbar / Hide Toolbar | `Opt+Cmd+T` | `toggleToolbar:` | F-13 |
| Enter Full Screen | `Ctrl+Cmd+F` | `toggleFullScreen:` | F-15 |

### Format
| Item | Shortcut | Action | ID |
|---|---|---|---|
| Copy HTML | `Opt+Cmd+C` | `copyHtml:` | F-39 |
| Strong | `Cmd+B` | `toggleStrong:` | F-40 |
| Emphasize | `Cmd+I` | `toggleEmphasis:` | F-41 |
| Underline | `Cmd+U` | `toggleUnderline:` | F-42 |
| Strikethrough | `Cmd+-` | `toggleStrikethrough:` | F-43 |
| Highlight | `Cmd+=` | `toggleHighlight:` | F-44 |
| Inline Code | `Cmd+K` | `toggleInlineCode:` | F-45 |
| Comment | `Cmd+/` | `toggleComment:` | F-46 |
| Convert To ▸ Header 1 … Header 6 | `Cmd+1` … `Cmd+6` | `convertToH1:` … `convertToH6:` | F-47 … F-52 |
| Convert To ▸ Paragraph | `Cmd+0` | `convertToParagraph:` | F-53 |
| Ordered List | `Shift+Cmd+O` | `toggleOrderedList:` | F-54 |
| Unordered List | `Shift+Cmd+U` | `toggleUnorderedList:` | F-55 |
| Blockquote | `Shift+Cmd+B` | `toggleBlockquote:` | F-56 |
| Shift Right | `Cmd+]` | `indent:` | F-57 |
| Shift Left | `Cmd+[` | `unindent:` | F-58 |
| Link | `Shift+Cmd+K` | `toggleLink:` | F-59 |
| Image | `Shift+Cmd+I` | `toggleImage:` | F-60 |
| New Paragraph | `Cmd+Return` | `insertNewParagraph:` | F-61 |

### Plug-ins
Dynamic list of installed native plug-ins (empty by default). F-156, Out.

### Window
| Item | Shortcut | ID |
|---|---|---|
| Minimize | `Cmd+M` | F-150 |
| Zoom | `Shift+Cmd+M` | F-151 |
| Bring All to Front | — | F-152 |

### Help
| Item | Shortcut | Action | ID |
|---|---|---|---|
| MacDown Help | — | `showHelp:` | F-153 |
| Contributing to MacDown | — | `showContributing:` | F-154 |

**M1b verification:** every title, key equivalent and modifier above was checked against `MacDown/Localization/Base.lproj/MainMenu.xib` and all match (New Paragraph's key equivalent is `\r`, i.e. `Cmd+Return`). Source-only details: View > Render Markdown is enabled only while the preview is visible (F-03); Format > Underline, Strikethrough and Highlight are hidden while their extension is off (F-162); Edit > Find > Jump to Selection is `centerSelectionInVisibleArea:`.

**Web note:** browsers do not let pages override `Cmd/Ctrl+N`, `W`, `T` and (in some browsers) `Q`. The web app must offer those commands through its own menu bar. Shortcut handlers should call `preventDefault` where allowed (for example `Cmd+S`, `Cmd+O`, `Cmd+P`, `Cmd+B`).

---

## 4. Toolbar

Source: `MPToolbarController setupToolbarItems` [disasm:13309] and `toolbarDefaultItemIdentifiers:` [disasm:14407]. Icons are template images `ToolbarIcon*.png` (with `@2x`) in Resources. Groups are segmented controls with one segment per sub-item and a tooltip equal to the sub-item label.

Order of allowed items:

| ID | Identifier | Label (palette label) | Icon | Action | Default set? | Feature |
|---|---|---|---|---|---|---|
| T-01 | `indent-group` | Shift Left/Right | — | group | yes | — |
| T-01a | `shift-left` | Shift Left | ToolbarIconShiftLeft | `unindent:` | (in group) | F-58 |
| T-01b | `shift-right` | Shift Right | ToolbarIconShiftRight | `indent:` | (in group) | F-57 |
| T-02 | `text-formatting-group` | Text Styles | — | group | yes | — |
| T-02a | `bold` | Strong | ToolbarIconBold | `toggleStrong:` | | F-40 |
| T-02b | `italic` | Emphasize | ToolbarIconItalic | `toggleEmphasis:` | | F-41 |
| T-02c | `underline` | Underline | ToolbarIconUnderlined | `toggleUnderline:` | | F-42 |
| T-03 | `heading-group` | Headings | — | group | yes | — |
| T-03a | `heading1` | Heading 1 | ToolbarIconHeading1 | `convertToH1:` | | F-47 |
| T-03b | `heading2` | Heading 2 | ToolbarIconHeading2 | `convertToH2:` | | F-48 |
| T-03c | `heading3` | Heading 3 | ToolbarIconHeading3 | `convertToH3:` | | F-49 |
| T-04 | `list-group` | Ordered/Unordered List | — | group | yes | — |
| T-04a | `unordered-list` | Unordered List | ToolbarIconUnorderedList | `toggleUnorderedList:` | | F-55 |
| T-04b | `ordered-list` | Ordered List | ToolbarIconOrderedList | `toggleOrderedList:` | | F-54 |
| T-05 | `blockquote` | Blockquote | ToolbarIconBlockquote | `toggleBlockquote:` | yes | F-56 |
| T-06 | `code` | Inline Code | ToolbarIconInlineCode | `toggleInlineCode:` | yes | F-45 |
| T-07 | `link` | Link | ToolbarIconLink | `toggleLink:` | yes | F-59 |
| T-08 | `image` | Image | ToolbarIconImage | `toggleImage:` | yes | F-60 |
| T-09 | `copy-html` | Copy HTML | ToolbarIconCopyHTML | `copyHtml:` | yes | F-39 |
| T-10 | `comment` | Comment | ToolbarIconComment | `toggleComment:` | **no** (customize only) | F-46 |
| T-11 | `highlight` | Highlight | ToolbarIconHighlight | `toggleHighlight:` | **no** | F-44 |
| T-12 | `strikethrough` | Strikethrough | ToolbarIconStrikethrough | `toggleStrikethrough:` | **no** | F-43 |
| T-13 | `layout` | Layout | ToolbarIconEditorAndPreview | pull-down: toggle editor pane / toggle preview pane | yes | F-09 |

The bundle also ships `ToolbarIconHideEditor`, `ToolbarIconHidePreview`, `HideEditor@2x`, `HidePreview@2x` (and non-prefixed `*@2x.png` copies of most icons). Source (resolves U-15): the non-prefixed images are the **Touch Bar** asset set (`Images.xcassets/TouchBar Icons`, F-163), and neither the `ToolbarIconHide*` nor the `Hide*` images are referenced by any code or xib, so they are unused. The Layout pop-up shows only `ToolbarIconEditorAndPreview` (on a dummy first item) and its items have no images [src:MPToolbarController.m:269-299]. The web app may reuse all icons (MIT).

Toolbar appearance: icon only, regular size, visible by default [defaults: `TB Display Mode = 2`, `TB Size Mode = 1`, `TB Is Shown = 1`].

**Default item order (verified, resolves U-08)** [src:MacDown/Code/Application/MPToolbarController.m:126-169]. The code walks the 13 items in the order of the table above, skips Comment, Highlight and Strikethrough, and inserts a flexible space after the items at indices 2, 3, 5, 7 and 11 of the full list (index 11 is the skipped Strikethrough, so that space lands after Copy HTML). No fixed spaces (`spaceAfterIndices` is an empty array). Result:

`Shift Left/Right` · `Text Styles` · `Headings` · ⟷ · `Ordered/Unordered List` · ⟷ · `Blockquote` · `Inline Code` · ⟷ · `Link` · `Image` · ⟷ · `Copy HTML` · ⟷ · `Layout`

(⟷ = flexible space.) The allowed set is the 13 items only; Space / Flexible Space are added by NSToolbar customization. Group look: `indent-group` and `list-group` are separated segmented controls, `text-formatting-group` and `heading-group` are joined (textured rounded); each segment is 33 px wide and shows the sub-item label as a tooltip; single buttons are 37 × 27 px with a 19 × 19 template icon [src:MPToolbarController.m:16, 201-264]. The Text Styles group has only Strong, Emphasize and Underline (no Strikethrough or Highlight).

---

## 5. Editor behaviours (detail)

### 5.1 Auto-complete matching characters (F-62 to F-65), preference P-36 (default **off**)

Pair table (static UTF-16 table in the binary at 0x10008a670) [disasm:8202]:

| Open | Close |
|---|---|
| `(` | `)` |
| `[` | `]` |
| `{` | `}` |
| `<` | `>` |
| `'` | `'` |
| `"` | `"` |
| `（` | `）` |
| `「` | `」` |
| `『` | `』` |
| `‘` | `’` |
| `“` | `”` |

Rules, derived from `completeMatchingCharacterForText:atLocation:` and verified in the source [src:MacDown/Code/Extension/NSTextView+Autocomplete.m:87-244; src:MPDocument.m:717-744, 785-801]:

0. Nothing happens while the change overlaps IME marked text. The whole of §5.1 is skipped when P-36 is off (rules 1 to 5 run from `textView:shouldChangeTextInRange:replacementString:` only inside the `editorCompleteMatchingCharacters` check, and rule 6 from Backspace only inside the same check).
1. Only single-character insertions with an empty selection are considered for rules 2 to 4. Table entries below U+0100 are ignored while an input method has marked text.
2. **Insert pair:** the table is scanned in order. For an entry whose opener equals the typed character, the pair is inserted when the **next** character is a boundary character, **and**, if the opener equals its closer (`'` and `"`), the **previous** character is also a boundary character. Boundary = `whitespaceAndNewlineCharacterSet ∪ punctuationCharacterSet`; start and end of document count as a space. The cursor is placed between the two characters. (M1b correction: the previous-character condition for `'` and `"` was missing, so `don't` does not get a pair.)
3. **Skip closing:** otherwise, if the typed character equals the entry's closer and the next character is that same closer, the cursor moves past it and nothing is inserted (F-64). Because rule 2 is tried first, typing `"` (or `'`) between an empty pair `"|"` inserts a **new pair** (`""|""`), since `"` is itself punctuation: this is the original behaviour, keep it for parity. For brackets, `(|)` + `)` gives `()|`.
4. If macOS "Smart Quotes" is on, typing `"` inserts only `“` and `'` only `‘` (a single opening curly quote, no closer) [src:NSTextView+Autocomplete.m:148-165]. F-101 is Out, so the web app always uses straight quotes.
5. **Wrap selection (F-63)** (`wrapMatchingCharactersOfCharacter:aroundTextInRange:strikethroughEnabled:`): with a non-empty selection, typing a single opener from the table wraps the selection in open/close. Typing `*`, `_`, `` ` `` or `=` wraps it in the same character on both sides. `~` wraps in `~`…`~` only when the Strikethrough extension (P-10) is on. The original text stays selected (selection shifted by one). Closers that are not openers (for example `)`) replace the selection normally.
6. **Delete empty pair (F-65)** (`deleteMatchingCharactersAround:`): Backspace with an empty or non-empty selection whose start lies between an opener and its matching closer (and is not at the document end) deletes both characters.

### 5.2 Return key (F-66 to F-69) [disasm:26934; src:MPDocument.m:769-783]

Order in `textViewShouldInsertNewline:`: (easter egg F-160) → if P-38 "Automatically insert line prefix for the current block" (default **on**): list item, then blockquote → **always** (P-38 not required): indented line → otherwise a normal newline. Each rule does nothing when the selection is non-empty or the document is empty.

**Shift+Return (Q-04):** AppKit's key bindings send `insertNewline:` for Return, Shift+Return and keypad Enter alike (Opt+Return sends `insertNewlineIgnoringFieldEditor:`, Ctrl+Return `insertLineBreak:`; AppKit probe of `-[NSTextView interpretKeyEvents:]`), and MacDown handles the selector in `textView:doCommandBySelector:` [src:MPDocument.m:702-712]. So Shift+Return runs the same rules as Return.

1. **List item** (`completeNextListItem:` [src:NSTextView+Autocomplete.m:494-591], regex `^(\s*)((?:(?:\*|\+|-|)\s+)?)((?:\d+\.\s+)?)(\S)?` applied to the current line **from its start up to the cursor**):
   - Skipped (falls through to the next rule) if the text before the cursor on this line is only whitespace, or if the line has neither a bullet (group 2) nor a number (group 3).
   - **Empty item** (bullet or number, but nothing after it before the cursor, group 4 empty): the text from the line start to the cursor (indent and marker) is deleted, then a newline is inserted, then the line's original indentation is inserted on the new line. Example: `* |` → `\n|`; `  * |` → `\n  |`. So the list ends and an empty line remains above the cursor. (M1b correction: M1 said no newline is added.) Confidence high for the deletion and newline; the indentation step depends on NSTextView returning its live string, which Apple documents.
   - **Bullet item**: newline + same indentation + the line's **own** bullet character + one space (`* `, `+ ` or `-`+space; P-45 is not used). A line with both a bullet and a number (`* 1. x`) continues as a bullet.
   - **Numbered item**: newline + same indentation + `N.` + space, where N is the parsed number, plus 1 when P-39 "Auto-increment numbering in ordered lists" (default **on**, enabled only when P-38 is on) is set. Format `%ld.`, so leading zeros are dropped (`09.` → `10.`).
   - Duplicate guard: if the text that follows the cursor (now at the start of the new line) already starts with the marker, only the indentation is inserted; if it already starts with indentation + marker, nothing more is inserted.
   - Task-list items (`- [ ] x`) are continued as plain bullets (`- `). Confirmed: the continuation code has no checkbox handling.
2. **Blockquote** (`completeNextBlockquoteLine` [src:NSTextView+Autocomplete.m:593-632], regex `^((?:\> ?)+).*$` applied to the **whole** current line): newline + the same marker run, including the optional single space after each `>` (`> ` → `> `, `>` → `>`, `> > ` → `> > `). There is **no** termination rule: Return on an empty `> ` line inserts another `> ` (M1b correction of the M1 guess). If the text after the cursor (which moves to the new line) already starts with the same markers, only the newline is inserted. The rule applies to any line that starts with `>`, so Return in the middle of a quote line splits it and prefixes the second half.
3. **Indented line** (`completeNextIndentedLine` [src:NSTextView+Autocomplete.m:634-651]): if the current line starts with whitespace before the cursor, newline + the whitespace from the line start up to the first non-whitespace character (or up to the cursor if the line is all whitespace).
4. Otherwise a normal newline.

### 5.3 Tab, Shift+Tab, Backspace, Home (F-70 to F-73) [src:MPDocument.m:702-830]

- **Tab** [disasm:26871]: if the selection length is greater than 0, run F-57 (indent selected lines). Otherwise, if P-37 "Insert spaces instead of tabs" (default **off**) is on, insert `4 − (column mod 4)` spaces (`insertSpacesForTab`) [disasm:8083; src:NSTextView+Autocomplete.m:74-85]. Otherwise insert `\t`. Column is counted in UTF-16 characters from the line start (a tab counts as 1).
- **Shift+Tab**: F-58, always (with or without a selection).
- **Backspace** [disasm:27009]: (a) if P-36 is on, the delete-pair rule (§5.1 rule 6); (b) else if P-37 is on and the selection is empty, `unindentForSpacesBefore:` counts up to 4 spaces immediately before the cursor. If there are at least 2, it deletes `min(count, (col mod 4) or 4)` spaces [disasm:8643; src:NSTextView+Autocomplete.m:246-275]; (c) otherwise a normal Backspace.
- **Cmd+← (Smart Home)**, P-40 (default **off**) [disasm:27092]: if the cursor is after the first non-whitespace character of its line, moves there. If the cursor is at or before it, or at document position 0, the normal `Cmd+←` (line start) is used. Soft-wrapped lines: see F-73.
- Indent unit for F-57: `\t`, or 4 spaces when P-37 is on. Unindent rules: F-58.

### 5.4 Toggle helpers

- `toggleForMarkupPrefix:suffix:` [disasm:8722; src:NSTextView+Autocomplete.m:47-71, 277-305]: if the text **immediately outside** the selection is the prefix (before) and the suffix (after), they are removed and the same text stays selected. Otherwise the selection is wrapped (`%@%@%@`) and the inner text stays selected. With an empty selection the prefix and suffix are inserted and the cursor is placed between them. (M1b correction: a selection that itself starts and ends with the markup, such as a selected `**a**`, is **not** unwrapped; `Cmd+B` gives `****a****`.) Special case for `*` (F-41): a selection surrounded by `***…***` counts as emphasised, but one surrounded only by `**…**` does not, so `Cmd+I` inside bold adds `*` instead of breaking the bold.
- `toggleBlockWithPattern:prefix:` [disasm:8852; src:NSTextView+Autocomplete.m:307-385]: works on whole selected lines (the line range is expanded to full lines; a trailing `\n` is kept). If **every** line, including empty lines, matches the pattern, `prefix.length` characters are removed from the start of each line (a fixed length, not the matched text). Otherwise the prefix is added to **every** line, including empty ones. (M1b correction: M1 said "every non-empty line".) The selection is shifted to cover the same text. Patterns: ordered `^[0-9]+ \S` (web deviation in F-54), unordered `^[\*\+-] \S`, blockquote `^> \S` [src:MPDocument.m:1409-1423].
- `makeHeaderForSelectedLinesWithLevel:` [disasm:10530; src:NSTextView+Autocomplete.m:653-716]: for each selected line, strip every leading `#+ ` group (regex `^(#+ )*`; `#foo` without a space is not a header prefix and stays) and prepend `#`×level + space (level 0 = paragraph, strip only). With more than one line selected, whitespace-only lines are skipped; a single empty line becomes `# `.

### 5.5 Other editor details

- Undo, redo and the find bar are standard NSTextView. The web app uses CodeMirror history and search.
- Editor link detection is always turned off (`automaticLinkDetectionEnabled = NO` at the end of `setupEditor:`) [src:MPDocument.m:1646].
- Dropped JPEG becomes a base64 data URI (F-33).
- Editor footnote highlighting: `setupEditor:` passes `pmh_EXT_NOTES` to the highlighter when P-13 is **off** and no extension when it is on [src:MPDocument.m:1528-1534]. This looks inverted (original bug); it only affects colouring of `[^id]` in the editor. Web: highlight footnote syntax when P-13 is on (low priority).

---

## 6. Rendering

### 6.1 Pipeline (original)

From `MPRenderer parseMarkdown:` [disasm:19680], with the order confirmed in the source [src:MPRenderer.m:96-145, 586-617]:

1. If front-matter detection (P-28) is on and the text **starts** with front matter (regex `^-{3}[\r\n]+(.*?[\r\n]+)((?:-{3})|(?:\.{3}))`, dot matches newlines, `^` = start of text), the captured block is parsed as YAML with all scalars as strings. Only if YAML returns at least one document is the whole match removed from the Markdown and the first document used; otherwise nothing is removed and no table is produced [src:NSString+Lookup.m:55-87]. Text after the closing `---` on the same line stays in the Markdown.
2. Hoedown 3.0.7 parses with extension flags from `extensionFlags` [disasm:23612; src:MPDocument.m:127-155] and HTML renderer flags from `rendererFlags` [disasm:23714; src:MPDocument.m:157-169]. The HTML renderer and the TOC renderer are created with header **nesting level 6** (every `h1`–`h6` gets an id). The document's maximum block nesting is `SIZE_MAX`, i.e. unlimited [src:MPRenderer.m:32-33] (M1b correction: M1 said 16).
3. If SmartyPants (P-16) is on, Hoedown SmartyPants post-processes the body HTML [src:MPRenderer.m:105-111].
4. If TOC (P-27) is on, the Markdown is rendered a second time with the TOC renderer, and that TOC HTML replaces **every** paragraph matching `<p.*?>\s*\[TOC\]\s*</p>`, **case-insensitive** (so `[toc]` also works) [disasm:21841; src:MPRenderer.m:116-140]. The TOC is inserted after SmartyPants, so the TOC text is not SmartyPants-processed. (M1b correction: M1 had TOC before SmartyPants.)
5. Final body = `frontMatterTable + "\n" + html` (`%@\n%@`), only when a front-matter object exists.
6. Body inserted into `Templates/Default.handlebars` with style and script tags (§7.4), loaded in the WebView with `loadHTMLString:baseURL:` and the base URL from F-20 [src:MPDocument.m:1066-1116].

Rendering is coalesced (F-02). Changing a parse-affecting preference (extensions, SmartyPants, TOC, front matter, renderer flags) re-parses; changing style, highlighting, Mermaid, Graphviz, Prism theme or accessory only re-renders the page [src:MPDocument.m:1128-1146; src:MPRenderer.m:574-640].

### 6.2 Hoedown flag mapping (verified from disassembly and source [src:MPDocument.m:126-170; src:MacDown/Code/Extension/hoedown_html_patch.h])

| Preference | Hoedown flag | Value | Notes |
|---|---|---|---|
| extensionTables | `EXT_TABLES` | 0x1 | |
| extensionFencedCode | `EXT_FENCED_CODE` | 0x2 | |
| extensionFootnotes | `EXT_FOOTNOTES` | 0x4 | |
| extensionAutolink | `EXT_AUTOLINK` | 0x8 | |
| extensionStrikethough (sic) | `EXT_STRIKETHROUGH` | 0x10 | |
| extensionUnderline | `EXT_UNDERLINE` | 0x20 | |
| extensionHighlight | `EXT_HIGHLIGHT` | 0x40 | |
| extensionQuote | `EXT_QUOTE` | 0x80 | |
| extensionSuperscript | `EXT_SUPERSCRIPT` | 0x100 | |
| htmlMathJax | `EXT_MATH` | 0x200 | |
| extensionIntraEmphasis **off** | `EXT_NO_INTRA_EMPHASIS` | 0x800 | flag set when the preference is false |
| htmlMathJaxInlineDollar | `EXT_MATH_EXPLICIT` | 0x2000 | enables `$…$` |
| htmlHardWrap | `HTML_HARD_WRAP` | 0x4 | |
| htmlTaskList | MacDown `HTML_USE_TASK_LIST` | 0x10 | |
| htmlLineNumbers | MacDown `HTML_BLOCKCODE_LINE_NUMBERS` | 0x20 | |
| htmlCodeBlockAccessory == 2 (Custom) | MacDown `HTML_BLOCKCODE_INFORMATION` | 0x40 | |

Raw HTML is never skipped or escaped. XHTML output is off (so `<hr>`, `<br>`, `<input …>` without `/`).

### 6.3 markdown-it mapping (target)

| ID | Original behaviour | markdown-it implementation |
|---|---|---|
| F-110 | Hoedown core | `markdownit({ html: true, linkify: false, breaks: P-29b, typographer: false, maxNesting: 1000 })` (P-09 and P-16 are custom rules, see F-113 and F-120; `maxNesting` stands in for Hoedown's unlimited nesting, M3 fix D-07). Hoedown is not CommonMark. Tests compare structure, not exact bytes. |
| F-111 | Tables, `<th style="text-align: left">` | built-in `table` rule; disable it when P-07 is off |
| F-112 | Fenced ``` and ~~~ | built-in `fence` rule; disable it when P-08 is off (fences then parse as paragraphs or inline code) |
| F-113 | Bare `http://`, `https://`, `ftp://`, `www.` and e-mail autolinked; bare domains and file names (`example.com`, `README.md`) are **not** linked. Exact rules [hoedown:src/autolink.c; hoedown:src/document.c:1009-1095]: a URL is `scheme://` with scheme `http`, `https` or `ftp` (case-insensitive, letters directly before the `:`), then an alphanumeric, then a domain of alphanumerics, `-`, `.` and `:` containing at least one `.` or `:`; `www.` needs a whitespace or punctuation character (or nothing) before it and a dot in the domain, and links to `http://www.…`; an e-mail address is `[A-Za-z0-9.+_-]+@` plus a domain with one `@`, at least one `.` and a final letter. Each link runs to the next whitespace, is cut at `<`, loses trailing `?!.,:` and a trailing `&entity;`, and loses a final `)`, `]`, `}`, `"` or `'` that is unbalanced inside the link. No autolink inside link text. The href is escaped with `escape_href` | `linkify: false` (linkify-it cannot express these rules: with `fuzzyLink: false` it also stops linking `www.`, and with it on it links bare domains). A custom port of Hoedown's three autolink triggers (`:`, `@`, `w`) as inline rules. `<…>` autolinks are always on (M3 fix D-05) |
| F-114 | `~~x~~` → `<del>` | built-in `strikethrough`; disable when off |
| F-115 | `_x_` → `<u>x</u>` (single-underscore emphasis becomes underline; `*x*` stays `<em>`, `__x__` stays `<strong>`) [hoedown:src/document.c:644-647] | **custom plugin**: override the `_` delimiter's emphasis render to `<u>` when P-11 is on |
| F-116 | `==x==` → `<mark>` | `markdown-it-mark` |
| F-117 | Footnotes (Hoedown markup, §6.5) | `markdown-it-footnote` with custom renderer rules to match the Hoedown structure |
| F-118 | `^word` or `^(several words)` → `<sup>`. `^word` runs to the next whitespace; `^(…)` runs to the first `)` (no nesting; code spans and links inside are skipped when looking for it); `^()` produces nothing and consumes `^()`; the content is parsed as inline Markdown [hoedown:src/document.c:1320-1354] | **custom plugin** (`markdown-it-sup` uses `^x^`, which is a different syntax) |
| F-119 | `"x"` → `<q>x</q>`. Takes precedence over SmartyPants [help.md] | **custom inline rule** |
| F-120 | SmartyPants (Hoedown, applied to the HTML output): `"`/`'` (and `&quot;`) to curly quotes, ` `` ` to “, `--` to – (`&ndash;`), `---` to — (`&mdash;`), `...` and `. . .` to … , `(c)` `(r)` `(tm)` case-insensitive to © ® ™, `1/2` `1/4` `3/4` at word boundaries (also `1/4th`, `3/4ths`) to ½ ¼ ¾. Text inside `pre`, `code`, `var`, `samp`, `kbd`, `math`, `script` and `style` is skipped [hoedown:src/html_smartypants.c:159-300, 307-345] | `typographer: true` (quotes `“”‘’`) plus replacements, and a small custom rule for fractions |
| F-121 | Intra-word emphasis ON (default): `A*maz*ing` → `A<em>maz</em>ing`, and the same for `_` (`snake_case_word` → `snake<em>case</em>word`, or `<u>` with P-11). OFF (`NO_INTRA_EMPHASIS`): an opening delimiter is rejected when preceded by anything other than whitespace, `>` or `(`, and a closing single delimiter is rejected when followed by a letter or digit. Applies to `*`, `_`, `~~` and `==` [hoedown:src/document.c:619-655, 775-800] | `*` intraword is native in markdown-it; `_` intraword needs a custom rule (markdown-it forbids it). When OFF, a custom rule applies the Hoedown conditions above. See U-03 (resolved) |
| F-122 | Every header gets `id="toc_N"`, N = 0-based document order | custom `heading_open` renderer |
| F-123 | `[TOC]` alone in a paragraph → nested `<ul class="toc">` of links `<a href="#toc_N">` | custom core rule (§6.6) |
| F-124 to F-127 | Code block HTML (§6.4) and Prism | custom `fence` and `code_block` renderer, then Prism highlights in the preview |
| F-130 / F-131 | Only when P-18 is on (`EXT_MATH`): `\\[…\\]` → display `\[…\]`; `\\(…\\)` → inline `\(…\)`; `$$…$$` → display `\[…\]` when P-19 is on, otherwise display only if the `$$…$$` is the only content of its paragraph and inline `\(…\)` when there is other text around it; `$…$` → inline only when P-19 is on. A delimiter preceded by a backslash does not close. The TeX text is HTML-escaped and not processed as Markdown [hoedown:src/document.c:733-772, 921-933, 1356-1367; hoedown:src/html.c:550-557] | custom inline/block math rule that outputs the delimited TeX text escaped, then MathJax 3 typesets `\(..\)` and `\[..\]` |
| F-132 | Task lists | custom list-item rule (§6.7) |
| F-133 | Front matter table | `markdown-it-front-matter` + `js-yaml`, then the table renderer (§6.8) |
| F-134 | Hard wrap | `breaks: true` |

### 6.4 Code blocks (F-124 to F-127)

Exact original output (patched Hoedown `blockcode`, [disasm:≈21995–22060; src:MacDown/Code/Extension/hoedown_html_patch.c:22-89]):

```
<div><pre[ class="line-numbers"][ data-information="INFO"]><code class="language-LANG">ESCAPED CODE</code></pre></div>
```

- Applies to both fenced and indented code blocks. With no language (indented block, or a fence without info), `LANG` = `none`.
- **The final newline of the code is removed** before escaping, so there is no `\n` before `</code>` (it would make Prism add a blank line) [src:hoedown_html_patch.c:74-82] (M1b correction to S-05/S-06).
- The code is escaped with Hoedown's HTML escaper (`&`, `<`, `>`, `"` → `&quot;`, `'` → `&#39;`).
- `class="line-numbers"` is present when `htmlLineNumbers` (P-22) is set. This follows the stored preference even when P-20 is off (the checkbox is only disabled in the UI) [src:MPDocument.m:157-169].
- Fence info: Hoedown takes only the **first whitespace-delimited word** after the fence as the language (```` ```python extra ```` → `python`) [hoedown:src/document.c:1453-1475].
- **Split at `:` only when P-23 = Custom** (`HTML_BLOCKCODE_INFORMATION`). Then `LANG` = the part before the first `:` and `INFO` = the rest, emitted as `data-information` (raw, not HTML-escaped) only when non-empty. Example: ```` ```python:hello.py ````. `show-information.css` displays it in the top-right corner of the block. When P-23 is None or Language name, there is no split: the whole word is the language (`class="language-python:hello.py"`), no `data-information`, and no Prism language matches [src:hoedown_html_patch.c:31-48, 61-66] (resolves U-02).
- `LANG` is looked up in the `syntax_highlighting.json` aliases **case-sensitively** (exact key match); if found, the class uses the mapped name. Prism component files are then looked up with the language lower-cased [src:MPRenderer.m:68, 291-299] (M1b correction: M1 said case-insensitive). The alias table:

| Alias | Prism language |
|---|---|
| `c++` | cpp |
| `coffee`, `coffee-script` | coffeescript |
| `cs` | csharp |
| `html`, `xml` | markup |
| `jl` | julia |
| `js`, `json` | javascript |
| `objective-c`, `obj-c`, `objc` | objectivec |
| `py` | python |
| `rb` | ruby |
| `sh` | bash |
| `graphviz`, `gv` | dot |

- Prism (only when P-20 is on): loads `prism-core.min.js` plus, for each language used in the document, `prism-<lang>.min.js` (or `.js`) and `prism-<lang>-extras` where present, with all `require` dependencies from `Prism/components.js` walked recursively; dependencies are moved before the languages that need them [src:MPRenderer.m:62-94, 233-258, 395-420]. Plugins: `line-numbers` CSS and JS (when P-22 is set) and `show-language` CSS and JS (P-23 = Language name). Theme CSS: `Prism/themes/prism-<lower-cased theme name>.css`; if the file does not exist (including the empty "(Default)" value), `prism.css` [disasm:18114; src:MacDown/Code/Utility/MPUtilities.m:133-150].
- **Bundled Prism languages (Prism ≈1.5)**: abap, actionscript, apacheconf, apl, applescript, asciidoc, aspnet, autohotkey, autoit, bash, basic, batch, bison, brainfuck, c, clike, coffeescript, cpp, crystal, csharp, css, css-extras, d, dart, diff, docker, eiffel, elixir, erlang, fortran, fsharp, gherkin, git, glsl, go, groovy, haml, handlebars, haskell, haxe, http, icon, inform7, ini, j, jade, java, javascript, json, jsx, julia, keyman, kotlin, latex, less, lolcode, lua, makefile, markdown, markup, matlab, mel, mizar, monkey, nasm, nginx, nim, nix, nsis, objectivec, ocaml, oz, parigp, parser, pascal, perl, php, php-extras, powershell, processing, prolog, puppet, pure, python, q, qore, r, rest, rip, roboconf, ruby, rust, sas, sass, scala, scheme, scss, smalltalk, smarty, sql, stylus, swift, tcl, textile, twig, typescript, verilog, vhdl, vim, wiki, yaml [res:Prism/components].
- **Prism themes** (popup "Theme:", first entry "(Default)"): (Default) = `prism.css`, `coy`, `dark`, `funky`, `okaidia`, `solarizedlight`, `tomorrow`, `twilight` [res:Prism/themes; disasm `loadHighlightingThemes`]. Source: the pop-up titles are the file names without `prism-` and `.css`, passed through `capitalizedString`, so they read **Coy, Dark, Funky, Okaidia, Solarizedlight, Tomorrow, Twilight**. The selected title is stored as is in `htmlHighlightingThemeName` (for example `Okaidia`); "(Default)" stores an empty string [src:MPHtmlPreferencesViewController.m:69-76, 126-153].
- **Mermaid (F-128)**: when P-24 is on, `mermaid.min.js`, `mermaid.init.js` and `mermaid.forest.css` are added. Each `.language-mermaid` block is replaced by its rendered SVG (`startOnLoad:false`, `flowchart.htmlLabels:false`, `useMaxWidth:true`) [res:Extensions/mermaid.init.js].
- **Graphviz (F-129)**: when P-25 is on, `viz.js` and `viz.init.js` are added. `code.language-{circo,dot,fdp,neato,osage,twopi}` blocks are replaced by `Viz(src,{engine})` SVG [res:Extensions/viz.init.js].
- The Theme pop-up, Show line numbers, Mermaid and Graphviz controls are enabled only when P-20 is on. The Accessory pop-up has **no** enabled binding and is always enabled [bind:Html; src:MacDown/Localization/Base.lproj/MPHtmlPreferencesViewController.xib:226-245] (M1b correction). Mermaid and Graphviz scripts are only added when P-20 is on as well as their own preference [src:MPRenderer.m:505-531].

### 6.5 Footnotes (Hoedown 3 output, F-117)

```
<p>Text<sup id="fnref1"><a href="#fn1" rel="footnote">1</a></sup></p>

<div class="footnotes">
<hr>
<ol>

<li id="fn1">
<p>Note text.&nbsp;<a href="#fnref1" rev="footnote">&#8617;</a></p>
</li>

</ol>
</div>
```

Footnotes are numbered in order of first reference, whatever their labels [help.md]. **Verified** against Hoedown 3.0.7 source [hoedown:src/html.c:498-547]: the back-link `&nbsp;<a href="#fnrefN" rev="footnote">&#8617;</a>` is inserted before the first `</p>` of the definition; if the definition has no paragraph, no back-link is added. `<hr>` (no XHTML).

### 6.6 TOC (F-123)

When P-27 is on, a paragraph containing only `[TOC]` is replaced by Hoedown's TOC renderer output (levels 1–6). The outer list is patched to `<ul class="toc">` [strings `<ul class="toc">`, `<a href="#toc_%d">`]:

```
<ul class="toc">
<li>
<a href="#toc_0">Title</a>
<ul>
<li>
<a href="#toc_1">Sub</a>
</li>
</ul>
</li>
</ul>
```

Header ids are always emitted (F-122), even when TOC is off. When TOC is off, `[TOC]` renders literally as `<p>[TOC]</p>`.

Source details [src:hoedown_html_patch.c:147-185; hoedown:src/html.c:595-668]: the level of the **first** header becomes TOC level 1 (`level_offset = first level − 1`), so a document starting with `##` gets a flat top level of H2s; a later header shallower than the first one produces a level below 1 and closes lists accordingly. Entry text keeps inline formatting (`<code>`, `<em>`, `<strong>`, `<u>`, `<mark>`, `<q>`, `<del>`, `<sup>`), but links are reduced to their text. Every matching `[TOC]` paragraph gets the same TOC.

### 6.7 Task lists (F-132)

When P-26 is on, a list item whose text starts with `[ ]` or `[x]` (lower-case `x`, checked with `strncmp`) renders as:

```
<li class="task-list-item"><input type="checkbox"> text</li>
<li class="task-list-item"><input type="checkbox" checked> text</li>
```

The three bracket characters are removed and the rest of the text (including its leading space) follows. Works in ordered and unordered lists and when nested. `Extensions/tasklist.js` disables the first `input` of every `.task-list-item`, so checkboxes cannot be toggled in the preview [help.md: "I don't support clicking checkboxes directly"; disasm:22144; src:MacDown/Resources/Extensions/tasklist.js]. Upper-case `[X]` is **not** treated as checked: only `[ ]` and `[x]` are compared [src:hoedown_html_patch.c:105-131] (U-16 resolved). For a "loose" item whose content is wrapped in `<p>` (`HOEDOWN_LI_BLOCK`), the check is made after the `<p>` and the checkbox goes inside it: `<li class="task-list-item"><p><input type="checkbox"> text</p>` [src:hoedown_html_patch.c:100-116]. The `[ ]` must be followed by nothing in particular: `[ ]text` also becomes a task item.

### 6.8 Front matter (F-133)

When P-28 is on and the document starts with `---`, a newline, YAML, and then `---` or `...`, the YAML is removed from the body and rendered as a table using the Handlebars `HTMLTable` helper:

- Mapping: `<table><thead><tr>{{#each keys}}<th>KEY</th>{{/each}}</tr></thead><tbody><tr>{{#each objects}}<td>VALUE</td>{{/each}}</tr></tbody></table>`, so the keys form one header row and the values one data row.
- Array: `<table><tbody><tr>{{#each objects}}<td>ITEM</td>{{/each}}</tr></tbody></table>`.
- Nested values recurse. Scalars are strings (`kYAMLReadOptionStringScalars`) and are HTML-escaped; YAML null renders as an empty cell. Mapping keys keep their document order (ordered dictionary) [src:MacDown/Code/Extension/NSObject+HTMLTabularize.m; src:Dependency/YAML-framework/YAMLSerialization.m:11].
- If the YAML document is a scalar, its escaped text is placed before the body instead of a table.
- The table is placed before the body. The front-matter `title` also sets the presumed file name (F-31).

When P-28 is off, a leading `---` block renders as normal Markdown (an `<hr>`, or a setext `<h2>` for the preceding text).

### 6.9 MathJax (F-130, F-131)

- The original loads `https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.3/MathJax.js?config=TeX-AMS-MML_HTMLorMML` plus `MathJax/init.js` (`showProcessingMessages:false`, `messageStyle:'none'`, and a callback on the `End` hook). The preference pane says "Math support requires Internet connection." [disasm:18677; res:MathJax/init.js]. Source: `init.js` is always **embedded** as `<script type="text/x-mathjax-config">` before the CDN script [src:MPRenderer.m:422-435; src:MPAsset.m:182-191]. In the preview, the request for `MathJax.js` itself is redirected to the bundled `MathJax/MathJax.js` (a workaround for MathJax issue #548), but MathJax takes its root from the script's `src`, so the other components still come from the CDN [src:MPDocument.m:835-848]. When MathJax is on, the preview's post-load work (scroll sync, zoom) waits for MathJax's `End` hook [src:MPDocument.m:852-880].
- Delimiters reaching MathJax: inline `\( … \)`, display `\[ … \]` and `$$ … $$`. In the Markdown source the user writes `\\( … \\)` and `\\[ … \\]` (doubled backslashes, as in help.md), or `$$ … $$`. `$ … $` works only with P-19.
- MathML `<math>` raw HTML is also typeset (MML input).
- MathJax configuration: `init.js` sets only `showProcessingMessages` and `messageStyle`, so MathJax 2.7.3's `tex2jax` defaults apply: inline `[['\\(','\\)']]` only, display `[['$$','$$'],['\\[','\\]']]`, `processEscapes: false`, and `skipTags` `script`, `noscript`, `style`, `textarea`, `pre`, `code`, `annotation`, `annotation-xml` [src:MacDown/Resources/MathJax/init.js; src:MPRenderer.m:26-27]. There is **no** `$` delimiter in MathJax, even with P-19: Hoedown already converts `$…$` to `\(…\)`. So `\$5` (Hoedown output `$5`) and `$x$` inside raw HTML stay literal, while `\(…\)` inside raw HTML (outside the skipped tags) is typeset.
- Web target: MathJax 3 (`tex-mml-chtml`) with exactly that configuration (inline `\(…\)` only, whatever P-19 says). Bundle it locally if possible. Typeset after each render. Exports include MathJax only when P-18 is on. (M3 fix D-04: the M1 text added `['$','$']` with P-19, which the original does not have.)

### 6.10 Script and style inclusion order (preview)

Styles: base style (P-19c CSS, none if the empty style is chosen) → Prism theme, then line-numbers CSS (if P-22), then show-language CSS (if P-23 = Language name) (all only if P-20) → Mermaid CSS (if P-20 and P-24) → `show-information.css` (if P-23 = Custom, regardless of P-20).
Scripts: `tasklist.js` (if P-26) → Prism core, languages, line-numbers and show-language plugins (if P-20) → Mermaid (if P-20 and P-24) → Graphviz (if P-20 and P-25) → MathJax config + MathJax (if P-18) [disasm:19006, 19127; src:MPRenderer.m:360-531].
In the preview every bundle asset is a `file://` link (`<link>` / `<script src>`), except the embedded MathJax config [src:MPRenderer.m:642-650].

---

## 7. Styles, themes and template

### 7.1 Preview styles (`Resources/Styles`, popup "CSS:", default **GitHub2**)

| File | Notes |
|---|---|
| `Clearness.css` | |
| `Clearness Dark.css` | |
| `GitHub.css` | |
| `GitHub2.css` | default (`htmlStyleName = GitHub2`) |
| `GitHub-2017.css` | **0 bytes** in this bundle and **absent from the source repo** (v0.7.3 tag and HEAD), so it is a packaging artefact. **CoS decision (U-07): the web app hides this style** (it is not listed and cannot be selected) |
| `Solarized (Light).css` | |
| `Solarized (Dark).css` | |

The popup lists the `.css` files in the user's Styles folder (copied from the bundle), without the extension, in directory-listing order (the code does not sort; the web app sorts by name) [src:MPUtilities.m:52-89]. A "Reveal / Reload" segmented control sits next to it (F-137 / F-138). **The first item is empty** and means "no style" (`htmlStyleName` removed), see F-166 (M1b correction: M1 inferred that no "None" option exists). If the stored name has no matching file, the stylesheet link points to a missing file and the preview is unstyled.

Web list therefore: (empty = none), Clearness, Clearness Dark, GitHub, GitHub2 (default), Solarized (Dark), Solarized (Light).

### 7.2 Editor themes (`Resources/Themes`, popup "Theme:", default **Tomorrow+**)

`Mou Fresh Air`, `Mou Fresh Air+`, `Mou Night`, `Mou Night+`, `Mou Paper`, `Mou Paper+`, `Solarized (Dark)`, `Solarized (Dark)+`, `Solarized (Light)`, `Solarized (Light)+`, `Tomorrow`, `Tomorrow Blue`, `Tomorrow+`, `Writer`, `Writer+` (all `.style`). The `+` variants add header font sizes (H1 24px, H2 20px, H3 17px, H4 15px, H5 13px, H6 11px), as the diff of `Tomorrow` and `Tomorrow+` shows.

The pop-up starts with an **empty item** meaning "no theme" (`editorStyleName` removed; default text view colours plus the highlighter's default element styles, SD-07), see F-166 [src:MPEditorPreferencesViewController.m:65-83, 120-129]. "Reload" re-reads the list and re-applies the theme to open editors [src:MPEditorPreferencesViewController.m:139-153].

**Theme file format** (peg-markdown-highlight stylesheet): blocks of `NAME` followed by `attribute: value` lines, separated by blank lines.
- Special names: `editor` (foreground, background, caret), `editor-selection` (foreground, background), `editor-current-line`.
- Element names: `H1`–`H6`, `EMPH`, `STRONG`, `LINK`, `AUTO_LINK_URL`, `AUTO_LINK_EMAIL`, `IMAGE`, `CODE`, `HTML`, `HTML_ENTITY`, `LIST_BULLET`, `LIST_ENUMERATOR`, `COMMENT`, `BLOCKQUOTE`, `VERBATIM`, `HTMLBLOCK`, `HRULE`, `REFERENCE`, `NOTE`.
- Attributes: `foreground`/`color`/`foreground-color`, `background`/`background-color`, `caret`/`caret-color`, `font-size`, `font-family`, `font-style` (`bold`, `italic`, `underlined`).
- Colours are 6- or 8-digit hex. Errors: "Value '%s' is not a valid color value: it should be a hexadecimal number, 6 or 8 characters long." [binary-strings].
- Web target: parse `.style` files at build or run time into CodeMirror `HighlightStyle` and an editor theme. The `+` header sizes apply to header lines.

### 7.3 Prism themes
See §6.4.

### 7.4 HTML template (`Templates/Default.handlebars`)

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
{{{ titleTag }}}            <!-- <title>FILENAME-WITHOUT-EXT</title>, or empty for untitled -->
{{#each styleTags}}{{{this}}}{{/each}}
</head>
<body>
{{{ body }}}
{{#each scriptTags}}{{{this}}}{{/each}}
</body>
</html>
```

Asset tags: `<link rel="stylesheet" type="text/css" href="URL">` / `<style type="text/css">CONTENT</style>`, and `<script type="text/javascript" src="URL"></script>` / `<script type="text/javascript">CONTENT</script>`. In the preview, bundle assets are linked by file URL. On HTML export they are embedded inline. The MathJax CDN script stays a remote `src`. **Verified** [src:MPAsset.m:69-191]: embedded assets are written as `<style type="text/css">\nCONTENT\n</style>` and `<script type="text/javascript">\nCONTENT\n</script>`, with one trailing newline of the file content removed; a non-file URL always falls back to a link; the MathJax config script (`MPEmbeddedScript`) is embedded even in the preview.

---

## 8. Preferences

Window: MASPreferences toolbar window titled "Preferences" with panes in this order: **General**, **Markdown**, **Editor**, **Rendering**, **Terminal** [src:MacDown/Code/Application/MPMainController.m:127-146] (M1b correction: M1 inferred Rendering before Editor; the subsections below keep their M1 order and IDs). Icons: `PreferencesGeneral/Markdown/Rendering/Editor/Terminal.png` (32×32 pane icons, not screenshots). Values are applied live (F-141). Defaults come from `loadDefaultPreferences` (first launch) and `loadDefaultUserDefaults` (missing keys) [disasm:7720, 7847], confirmed by `[defaults]`. Keys not written there default to `NO`/`0`/empty.

**M1b verification:** every key and default in §8.1 to §8.4 was checked against `MPPreferences.h:17-74` and `MPPreferences.m:26-35, 244-286`, and every label, binding, enablement rule and stepper range against the source xibs in `MacDown/Localization/Base.lproj/`. All keys and defaults match. `loadDefaultPreferences` runs only on a fresh install (`firstVersionInstalled` unset); `loadDefaultUserDefaults` runs on every launch and only fills missing keys (`editorMaximumWidth`, `editorAutoIncrementNumberedLists`, `editorInsertPrefixInBlock`, `htmlTemplateName`). Web: apply both sets as defaults for missing localStorage keys. UI corrections are marked in the rows below.

### 8.1 General (`MPGeneralPreferencesViewController`) [bind:General]

| ID | Group | Label | Defaults key | Default | Effect | Scope |
|---|---|---|---|---|---|---|
| P-01 | Behavior | Update preview automatically as you type | `markdownManualRender` (**negated**) | checked (`markdownManualRender = NO`) | Off: preview updates only on `Cmd+R` (F-02, F-03). **Unchecking it also sets P-05 off** [src:MacDown/Code/Preferences/MPGeneralPreferencesViewController.m:40-47]. Switching back to automatic forces a re-render [src:MPDocument.m:1135-1140] | In |
| P-02 | Behavior | Ensure open document on launch | `supressesUntitledDocumentOnLaunch` (**negated**, key misspelt) | checked | F-32. Source: answers `applicationShouldOpenUntitledFile:` (also asked when the app is re-activated with no window open), unless files or piped content from the CLI are pending [src:MPMainController.m:183-188] | In |
| P-03 | Behavior | Put editor on the right | `editorOnRight` | off | F-10 | In |
| P-04 | Behavior | Sync preview scrollbar when editor scrolls | `editorSyncScrolling` | **on** | F-11 | In |
| P-05 | Behavior | Show word count | `editorShowWordCount` | off | F-12. Enabled only when P-01 is checked | In |
| P-06 | Behavior | Automatically create files for link targets | `createFileForLinkTarget` | off | F-19 | Out |
| P-06b | Update | Include pre-releases | `updateIncludesPreReleases` | off | Sparkle beta feed | Out |
| P-06c | (hidden) | word-count pop-up selection | `editorWordCountType` | 0 (words) | F-12 | In |

### 8.2 Markdown (`MPMarkdownPreferencesViewController`) [bind:Markdown; groups from help.md]

| ID | Group | Label | Defaults key | Default | Effect | Scope |
|---|---|---|---|---|---|---|
| P-07 | Block formatting | Table | `extensionTables` | **on** | F-111 | In |
| P-08 | Block formatting | Fenced code block | `extensionFencedCode` | **on** | F-112 | In |
| P-09 | Inline formatting | Autolink | `extensionAutolink` | off | F-113 | In |
| P-10 | Inline formatting | Strikethrough | `extensionStrikethough` (sic) | off | F-114; also enables `~` wrapping (§5.1) | In |
| P-11 | Inline formatting | Underline | `extensionUnderline` | off | F-115 | In |
| P-12 | Inline formatting | Highlight | `extensionHighlight` | off | F-116 | In |
| P-13 | Inline formatting | Footnote | `extensionFootnotes` | **on** | F-117; also passed to the editor highlighter (inverted in the original, §5.5) | In |
| P-14 | Inline formatting | Superscript | `extensionSuperscript` | off | F-118 | In |
| P-15 | Inline formatting | Quote | `extensionQuote` | off | F-119 | In |
| P-16 | Document formatting | Smartypants | `extensionSmartyPants` | off | F-120 | In |
| P-17 | Inline formatting | Intra-word emphasis | `extensionIntraEmphasis` | **on** | F-121 | In |

### 8.3 Rendering (`MPHtmlPreferencesViewController`) [bind:Html]

| ID | Label | Defaults key | Default | Effect / enablement | Scope |
|---|---|---|---|---|---|
| P-19c | CSS: (popup) + Reveal/Reload | `htmlStyleName` | `GitHub2` | F-136, F-137, F-138. First pop-up item is empty = no style (nil), F-166. Reload re-lists the folder and re-renders open previews | In (Reveal Out) |
| P-20 | Syntax highlighted code block | `htmlSyntaxHighlighting` | off | F-124 | In |
| P-21 | Theme: (popup) | `htmlHighlightingThemeName` | unset/empty = "(Default)" = `prism.css` | Items: (Default), Coy, Dark, Funky, Okaidia, Solarizedlight, Tomorrow, Twilight; the capitalised title is stored (§6.4). F-124; enabled when P-20 is on | In |
| P-22 | Show line numbers | `htmlLineNumbers` | off | F-126; enabled when P-20 is on | In |
| P-23 | Accessory: (popup: None / Language name / Custom) | `htmlCodeBlockAccessory` (index 0/1/2) | 0 (None) | F-127. Always enabled (no binding to P-20) [src:MPHtmlPreferencesViewController.xib:226-245] | In |
| P-24 | Mermaid | `htmlMermaid` | off | F-128; enabled when P-20 is on | In |
| P-25 | Graphviz | `htmlGraphviz` | off | F-129; enabled when P-20 is on | In |
| P-18 | TeX-like math syntax | `htmlMathJax` | off | F-130. Note label "Math support requires Internet connection." | In |
| P-19 | Use dollar sign ($) as inline delimiter | `htmlMathJaxInlineDollar` | off | F-131; enabled when P-18 is on | In |
| P-26 | Task list syntax | `htmlTaskList` | off | F-132 | In |
| P-27 | Detect table of contents token | `htmlRendersTOC` | off | F-123 | In |
| P-28 | Detect Jekyll front-matter | `htmlDetectFrontMatter` | off | F-133, F-31 | In |
| P-29b | Render newline literally | `htmlHardWrap` | off | F-134 | In |
| P-29 | Scale preview based on editor font size | `previewZoomRelativeToBaseFontSize` | off | F-17 | In |
| P-29c | Default path: (path control) | `htmlDefaultDirectoryUrl` | home folder (`~`) | F-20 | In (stored, informational; see F-20) |
| P-29d | (hidden) template | `htmlTemplateName` | `Default` | F-139 | In (fixed) |

### 8.4 Editor (`MPEditorPreferencesViewController`) [bind:Editor]

| ID | Label | Defaults key | Default | Range / effect | Scope |
|---|---|---|---|---|---|
| P-30 | Base font: (preview `Name - size`) + "Change…" | `editorBaseFontInfo` {name,size} | `Menlo-Regular`, 14.0 | F-75 (web: font family list and size input) | In |
| P-31 | Theme: (popup) + Reveal/Reload | `editorStyleName` | `Tomorrow+` | F-74. First pop-up item is empty = no theme (nil), F-166 | In (Reveal Out) |
| P-32 | Line spacing: (field + stepper) | `editorLineSpacing` | 3 | 0–100, step 1 (F-76). In all numeric fields of this pane, an emptied field is set to `0` when editing ends [src:MPEditorPreferencesViewController.m:98-103] | In |
| P-33 | Text insets: horizontal (field + stepper) "×" | `editorHorizontalInset` | 15 | 0–35 (F-77) | In |
| P-34 | Text insets: vertical | `editorVerticalInset` | 30 | 0–35 (F-77) | In |
| P-35 | Limit editor width to (checkbox + field + stepper) | `editorWidthLimited`, `editorMaximumWidth` | off, 1000 | width 300–10000; field and stepper enabled only when checked (F-78) | In |
| P-36 | Auto-complete matching characters | `editorCompleteMatchingCharacters` | off | §5.1 | In |
| P-37 | Insert spaces instead of tabs | `editorConvertTabs` | off | §5.3 | In |
| P-38 | Automatically insert line prefix for the current block | `editorInsertPrefixInBlock` | **on** | §5.2 | In |
| P-39 | Auto-increment numbering in ordered lists | `editorAutoIncrementNumberedLists` | **on** | §5.2; enabled only when P-38 is on | In |
| P-40 | ⌘← jumps to first non-whitespace character in line | `editorSmartHome` | off | F-73 | In |
| P-42 | Scroll past end | `editorScrollsPastEnd` | off | F-79 | In |
| P-41 | Ensure newline at end of file on save | `editorEnsuresNewlineAtEndOfFile` | off | F-30 | In |
| P-45 | List marker: (popup `* (Asterisk)`, `+ (Plus sign)`, `- (Minus sign)`) | `editorUnorderedListMarkerType` | 0 → `* ` | 1 → `+ `, 2 → `- ` [disasm:7254] | In |

Group box "Behavior" holds, top to bottom in the xib: P-37, P-36, P-40, P-42, P-41, P-39, P-38 (xib element order; on-screen order follows the constraints and may differ). P-45 "List marker:" is **outside** the box, with the font, theme, line spacing, insets and width controls [src:MacDown/Localization/Base.lproj/MPEditorPreferencesViewController.xib] (M1b correction).

### 8.4b Hidden editor preferences (no pane; added in M1b)

| ID | Defaults key | Default | Effect | Scope |
|---|---|---|---|---|
| P-46 | `editorContinuousSpellCheckingEnabled` | NO | Edit > Spelling and Grammar > Check Spelling While Typing, persisted (F-96, F-164) | In |
| P-47 | `editorGrammarCheckingEnabled`, `editorAutomaticSpellingCorrectionEnabled`, `editorAutomaticQuoteSubstitutionEnabled`, `editorAutomaticDashSubstitutionEnabled`, `editorAutomaticTextReplacementEnabled`, `editorAutomaticDataDetectionEnabled` | NO | The matching Edit-menu toggles, persisted (F-164) | Out |
| P-48 | `editorEnabledTextCheckingTypes` | `NSTextCheckingAllTypes` | NSTextView text-checking mask (F-164) | Out |

Other keys written by the app and not user-facing: `firstVersionInstalled`, `latestVersionInstalled` (fresh-install detection, F-155), `treatLastSeenStamp` (F-160), and in the `com.uranusjr.macdown` suite `filesToOpenOnNextLaunch` / `pipedContentFileToOpenOnNextLaunch` (CLI, Out) [src:MPPreferences.h:17-18; src:MacDown/Code/Utility/MPGlobals.h].

### 8.5 Terminal (`MPTerminalPreferencesViewController`)

Labels: status indicator "●", "Shell support not installed" / "Shell utility installed" / "Shell utility not installed", "Location:" with "<Not installed>" or `/usr/local/bin/macdown`, "By activating shell support you can use the macdown utility to open MacDown and documents from a shell.", and an "Install"/"Uninstall" button. **F-157, Out.**

---

## 9. Export options summary

| ID | Option | Default | Effect |
|---|---|---|---|
| E-01 | Export HTML ▸ Include styles | on when a preview style is set (off when the empty style is chosen) | Embeds the selected CSS (§7.1) inline in `<style type="text/css">`. **`show-information.css` is never exported**, even with accessory = Custom [src:MPRenderer.m:660-672] (M1b correction) |
| E-02 | Export HTML ▸ Include syntax highlighting | = P-20 | Embeds Prism theme and plugin CSS and Prism JS (core, used languages, line-numbers / show-language plugins) inline. The Prism CSS is embedded even when "Include styles" is off. **Mermaid (CSS + JS) and Graphviz (JS) are exported only when this box is checked** and P-24 / P-25 are on. The checkbox works even when P-20 is off, because the used languages are collected during every parse [src:MPRenderer.m:673-689, 261-305] |
| E-03 | Export HTML ▸ (implicit) MathJax | per P-18 | When P-18 is on: MathJax config embedded (`text/x-mathjax-config`) and MathJax loaded from the CDN by `<script src>` (a non-file URL is never embedded) [src:MPRenderer.m:690-694; src:MPAsset.m:78-89]. **`tasklist.js` is not exported** (exported task checkboxes stay clickable) (M1b correction). Neither style nor script options set means no asset tags at all |
| E-04 | Export HTML ▸ file name | F-31 + `.html` | `<title>` = saved file name without extension; no `<title>` tag for an unsaved document [src:MPRenderer.m:180-182; src:MPDocument.m:980-984] |
| E-05 | Export PDF ▸ file name | F-31 + `.pdf` | Printed preview, margins 50 pt top/bottom, 0 left/right (F-37) |
| E-06 | Print | — | Preview only, margins 50 pt top/bottom, 0 left/right (F-37) |
| E-07 | Copy HTML | — | Body HTML only, as plain text |

---

## 10. Sample Markdown cases (for tests)

Default preferences unless stated. Expected HTML is **structural**: whitespace and attribute order may differ, and Hoedown-specific escaping (for example `&#39;`) is not required. `toc_N` ids are required.

**S-01 Headers (ATX + setext), ids (F-110, F-122)**
```markdown
# Title
Sub
---
### Third
```
```html
<h1 id="toc_0">Title</h1>
<h2 id="toc_1">Sub</h2>
<h3 id="toc_2">Third</h3>
```

**S-02 Emphasis and strong (F-110, F-121 default on)**
```markdown
**bold** *it* __b2__ _i2_ So A*maz*ing
```
```html
<p><strong>bold</strong> <em>it</em> <strong>b2</strong> <em>i2</em> So A<em>maz</em>ing</p>
```

**S-03 Optional inline extensions (P-10, P-11, P-12, P-14, P-15 all on)**
```markdown
~~gone~~ _under_ ==mark== hoge^(fuga) 2^10 "Such editor"
```
```html
<p><del>gone</del> <u>under</u> <mark>mark</mark> hoge<sup>fuga</sup> 2<sup>10</sup> <q>Such editor</q></p>
```
With the same extensions **off**: `<p>~~gone~~ <em>under</em> ==mark== hoge^(fuga) 2^10 &quot;Such editor&quot;</p>` (quotes may stay literal `"`).

**S-04 Table with alignment (P-07 on, the default)**
```markdown
| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |
```
```html
<table>
<thead><tr><th style="text-align: left">Left</th><th style="text-align: center">Center</th><th style="text-align: right">Right</th></tr></thead>
<tbody><tr><td style="text-align: left">a</td><td style="text-align: center">b</td><td style="text-align: right">c</td></tr></tbody>
</table>
```
With P-07 off: a single `<p>` containing the pipe text.

**S-05 Fenced code with alias, highlighting off (default)**
````markdown
```js
var a = 1 < 2;
```
````
```html
<div><pre><code class="language-javascript">var a = 1 &lt; 2;</code></pre></div>
```
(M1b: no newline before `</code>`; the patch strips the final newline [src:hoedown_html_patch.c:74-82].)

**S-06 Code: no language, indented, line numbers and info (P-20, P-22 on, P-23 = Custom)**
````markdown
```python:hello.py
print("hi")
```

    indented
````
```html
<div><pre class="line-numbers" data-information="hello.py"><code class="language-python">print(&quot;hi&quot;)</code></pre></div>
<div><pre class="line-numbers"><code class="language-none">indented</code></pre></div>
```
After Prism runs: tokens wrapped in `<span class="token …">`, and line-number rows added (`.line-numbers-rows`).

**S-06b Info string without Custom accessory (P-23 = None, the default; added in M1b)**
Same first block as S-06, with P-20, P-22 off:
```html
<div><pre><code class="language-python:hello.py">print(&quot;hi&quot;)</code></pre></div>
```
Also: ```` ```Python ```` gives `class="language-Python"` (alias lookup is case-sensitive, so ```` ```JS ```` stays `language-JS`), and ```` ```python extra words ```` gives `language-python`.

**S-07 Task list (P-26 on)**
```markdown
- [ ] todo
- [x] done
1. [x] ordered
```
```html
<ul>
<li class="task-list-item"><input type="checkbox" disabled> todo</li>
<li class="task-list-item"><input type="checkbox" checked disabled> done</li>
</ul>
<ol>
<li class="task-list-item"><input type="checkbox" checked disabled> ordered</li>
</ol>
```
(`disabled` is set by `tasklist.js` after load.) With P-26 off: `<li>[ ] todo</li>` and so on.

**S-08 TOC (P-27 on)**
```markdown
[TOC]

# A
## B
# C
```
```html
<ul class="toc">
<li><a href="#toc_0">A</a>
<ul><li><a href="#toc_1">B</a></li></ul>
</li>
<li><a href="#toc_2">C</a></li>
</ul>
<h1 id="toc_0">A</h1>
<h2 id="toc_1">B</h2>
<h1 id="toc_2">C</h1>
```
With P-27 off: `<p>[TOC]</p>` followed by the headers.

**S-09 Footnotes (P-13 on, the default)**
```markdown
Text[^n].

[^n]: Note.
```
```html
<p>Text<sup id="fnref1"><a href="#fn1" rel="footnote">1</a></sup>.</p>
<div class="footnotes"><hr><ol>
<li id="fn1"><p>Note.&nbsp;<a href="#fnref1" rev="footnote">&#8617;</a></p></li>
</ol></div>
```

**S-10 Math (P-18 on; P-19 off, then on)**
```markdown
Inline \\( 1 + 1 \\) and $x$.

$$
A^T_S = B
$$
```
P-19 off:
```html
<p>Inline \(1 + 1\) and $x$.</p>
<p>\[
A^T_S = B
\]</p>
```
P-19 on: `$x$` becomes `\(x\)`. After MathJax runs, `mjx-container` elements replace the delimiters. Exact whitespace inside the delimiters and the wrapping `<p>` are not significant.

**S-11 Front matter (P-28 on)**
```markdown
---
title: "Macdown is my friend"
date: 2014-06-06 20:00:00
---
# Body
```
```html
<table><thead><tr><th>title</th><th>date</th></tr></thead>
<tbody><tr><td>Macdown is my friend</td><td>2014-06-06 20:00:00</td></tr></tbody></table>
<h1 id="toc_0">Body</h1>
```
Presumed file name = `Macdown is my friend`. With P-28 off, the block renders as `<hr>` followed by `<h2 id="toc_0">title: … date: …</h2>` or similar Markdown output.

**S-12 Autolink (P-09 on) and angle autolinks (always)**
```markdown
Visit http://t.co or www.example.com, mail <a@b.co>.
```
```html
<p>Visit <a href="http://t.co">http://t.co</a> or <a href="http://www.example.com">www.example.com</a>, mail <a href="mailto:a@b.co">a@b.co</a>.</p>
```
With P-09 off, only `<a@b.co>` becomes a link.

**S-13 SmartyPants (P-16 on, P-15 off)**
```markdown
"Hello" -- it's -- wait... --- done
```
```html
<p>&ldquo;Hello&rdquo; &ndash; it&rsquo;s &ndash; wait&hellip; &mdash; done</p>
```
(Entities or the equivalent Unicode characters “ ” – ’ … — are both acceptable.)

**S-14 Hard wrap (P-29b on) and raw HTML**
```markdown
line one
line two

<div class="x">raw <b>html</b></div>
```
```html
<p>line one<br>
line two</p>
<div class="x">raw <b>html</b></div>
```
With P-29b off: `<p>line one\nline two</p>`.

**S-15 Lists and blockquote (core)**
```markdown
* a
* b
    1. one
    2. two

> quote
> > nested
```
```html
<ul><li>a</li><li>b
<ol><li>one</li><li>two</li></ol></li></ul>
<blockquote><p>quote</p><blockquote><p>nested</p></blockquote></blockquote>
```

**S-16 Editor behaviour cases (F-62 to F-73), text plus cursor `|`**

| Case | Before | Action | After |
|---|---|---|---|
| E1 | `|` | type `(` (P-36 on) | `(|)` |
| E2 | `(|)` | type `)` | `()|` |
| E3 | `(|)` | Backspace | `|` |
| E4 | `[word]` selected | type `*` | `*word*` (word still selected) |
| E5 | `x|y` | type `(` | `x(|y` (no pair: next char not whitespace or punctuation) |
| E6 | `* item|` | Return | `* item\n* |` |
| E7 | `3. item|` | Return | `3. item\n4. |` (P-39 on), `3. |` with P-39 off |
| E8 | `* |` | Return | `\n|` (marker removed, list ends, the cursor is on a new empty line below the now-empty line; M1b correction) |
| E9 | `> q|` | Return | `> q\n> |` |
| E10 | `ab|` | Tab, P-37 on | `ab  |` (2 spaces to column 4) |
| E11 | `[a]` selected | `Cmd+B` | `**a**`; pressing again gives `a` |
| E12 | `[Title]` selected | `Cmd+2` | `## Title`; `Cmd+0` gives `Title` |
| E13 | `[l1\nl2]` selected | `Shift+Cmd+U` | `* l1\n* l2`; again gives `l1\nl2` |
| E14 | `[a\nb]` selected | `Cmd+]` | `\ta\n\tb` (or 4 spaces each with P-37) |
| E15 | `don|` | type `'` (P-36 on) | `don'|` (no pair: previous char is not a boundary) |
| E16 | `"|"` | type `"` (P-36 on) | `""|""` (a new pair; original quirk, §5.1 rule 3) |
| E17 | `[**a**]` selected (asterisks included) | `Cmd+B` | `****a****` (not unwrapped, §5.4) |
| E18 | `  * |` | Return | `\n  |` (indent kept, marker removed) |
| E19 | `> |` | Return | `> \n> |` (quote is not terminated) |
| E20 | `ab|cd` | `Cmd+Return` | `ab\n\n|cd` (F-61) |
| E21 | `  ab|` | Return, P-38 **off** | `  ab\n  |` (indent continuation is not gated by P-38) |
| E22 | `[1. a\n1. b]` selected | `Shift+Cmd+O` | web: `a\nb` (U-05 deviation); original: `1. 1. a\n1. 1. b` |
| E23 | `  \tx` (cursor anywhere on the line) | `Cmd+[` | `x` (spaces + tab removed as one unit, F-58) |

---

## 11. Integrations

| Area | Original | Web target |
|---|---|---|
| Files | NSDocument open/save, autosave in place, UTF-8 | File System Access API (Chromium) with `<input type=file>` and download fallback; localStorage draft |
| Clipboard | NSPasteboard (Copy HTML as string; Link/Image read a URL from the clipboard) | `navigator.clipboard.writeText` / `readText` (readText may need permission; treat failure as "no URL") |
| Network | MathJax 2.7.3 from cdnjs; images in documents load remotely | MathJax 3 bundled locally (no network needed); remote images load as normal |
| Printing/PDF | NSPrintOperation of the WebView | `window.print()` with a print stylesheet showing only the preview |
| Updates | Sparkle (`SUFeedURL`) | Out |
| Scripting | AppleScript sdef, `macdown` CLI | Out |
| Auth | none | none |

---

## 12. Unknowns

M1b status: each unknown was re-checked against the v0.7.3 source and Hoedown 3.0.7. "Resolved" means the source settles the original behaviour; the citation is the evidence. Where an M1 guess was wrong, §13 records the change.

| ID | Unknown | Status | Resolution (M1b) | Confidence |
|---|---|---|---|---|
| U-01 | Exact Hoedown output for edge cases (footnote markup, table whitespace, entity escaping) | **Resolved** (templates); runtime edge cases still not executed | Footnote, table-alignment, header-id, math and TOC templates read from Hoedown 3.0.7 [hoedown:src/html.c:222-223, 456-464, 498-557, 595-617] and the MacDown patch [src:hoedown_html_patch.c]. §6.4 to §6.8 now match them. Text escaping uses Hoedown's escaper (`'` → `&#39;`, `"` → `&quot;`). Tests still compare structure, not bytes | high |
| U-02 | Is `lang:info` split always or only with accessory = Custom? | **Resolved** | Only when `HTML_BLOCKCODE_INFORMATION` (P-23 = Custom) is set; otherwise the whole word is the language [src:hoedown_html_patch.c:33-48]. §6.4, S-06b | high |
| U-03 | Underscore intra-word emphasis with P-17 on | **Resolved** | With intra-word emphasis on, `_` behaves like `*`: `snake_case_word` → `snake<em>case</em>word` (`<u>` with P-11). With it off, Hoedown rejects an opener preceded by anything but whitespace, `>` or `(`, and a single closer followed by a letter or digit [hoedown:src/document.c:619-655, 775-800]. F-121 | high |
| U-04 | Return on an empty list item or an empty `>` line | **Resolved** | Empty list item: line text up to the cursor deleted, newline inserted, indentation re-inserted (`* |` → `\n|`). Empty `>` line: **not** terminated, another `> ` is added [src:NSTextView+Autocomplete.m:528-543, 593-632]. §5.2, E8, E18, E19 | high (indentation step medium-high) |
| U-05 | Ordered-list toggle regex `^[0-9]+ \S` never matches `1. x` | **Resolved: decision** | Original confirmed [src:MPDocument.m:1409-1412]: toggling an ordered list adds a second `1. `. **CoS decision: the web version fixes the regex** (detect `^[0-9]+\. \S`, remove the matched `^[0-9]+\. `). Recorded as a deliberate deviation in F-54 and E22 | n/a (decision) |
| U-06 | Link/Image toggle cursor placement | **Resolved** | After adding markup the cursor goes inside `()`; an `http`/`https`/`file` URL from the clipboard is inserted there and selected; nothing else happens when markup was removed [src:MPDocument.m:1369-1407; src:NSPasteboard+Types.m:14-38]. F-59 | high |
| U-07 | `GitHub-2017.css` is empty (0 bytes) | **Resolved: decision** | The file is not in the source repo (v0.7.3 or HEAD); it is a packaging artefact. Per the CoS rule (use the source content if it exists, otherwise hide), **the web app hides the style**. §7.1 | high |
| U-08 | Default toolbar order and spaces | **Resolved** | Flexible spaces after Headings, Ordered/Unordered List, Inline Code, Image and Copy HTML; no fixed spaces [src:MPToolbarController.m:126-169]. §4 | high |
| U-09 | `editorCompleteMatchingCharacters` default | **Resolved** | Off: neither defaults method sets it, and booleans default to NO [src:MPPreferences.m:226-286] | high |
| U-10 | No preference pane screenshots in the bundle | **Resolved** | The source xibs give exact labels, bindings, enablement and stepper ranges [src:MacDown/Localization/Base.lproj/MP*PreferencesViewController.xib]. §8 updated (pane order, group box membership, accessory enablement). Pixel layout can be read from the xib frames if needed | high |
| U-11 | Does HTML export embed or link assets? | **Resolved** | File assets are embedded inline; the MathJax CDN script stays a `src` link; the MathJax config is embedded; `show-information.css` and `tasklist.js` are not exported [src:MPRenderer.m:660-702; src:MPAsset.m:69-191]. §9 | high |
| U-12 | Meaning of P-02 on the web | **Resolved (M5 fixes, CoS decision SD-12)** | Original: when checked, an untitled document opens at launch and on re-activation with no windows, unless CLI files are pending [src:MPMainController.m:183-188]. Web, as implemented and tested: checked = open the last draft or a blank document at startup, and Close of the last document opens a blank one; unchecked = an empty "no document" state with New and Open, document commands disabled, and Close also clears the draft (D-14) | high |
| U-13 | Superscript grammar | **Resolved** | `^word` ends at whitespace; `^(…)` ends at the first `)` (no nesting); `^()` renders nothing; content is inline-parsed [hoedown:src/document.c:1320-1354]. F-118 | high |
| U-14 | SmartyPants details | **Resolved** | `--` → –, `---` → —, `...` / `. . .` → …, `(c)` `(r)` `(tm)` (case-insensitive), `1/2` `1/4` `3/4` at word boundaries, ` `` ` → “, quotes by context; skips `pre`, `code`, `var`, `samp`, `kbd`, `math`, `script`, `style` [hoedown:src/html_smartypants.c]. F-120 | high |
| U-15 | Layout menu item images | **Resolved** | No images on the Layout items; the `HideEditor`/`HidePreview` assets are unused (the non-prefixed set is the Touch Bar set) [src:MPToolbarController.m:269-299; src:MPDocument.xib:54-315]. §4 | high |
| U-16 | Upper-case `[X]` in task lists | **Resolved** | Not a task item: only `[ ]` and `[x]` are compared [src:hoedown_html_patch.c:105-131] | high |
| U-17 | Word count algorithm | **Resolved** (algorithm); web approximation | NSString word enumeration per text node (ICU word boundaries, so CJK is segmented by dictionary); code blocks excluded from words, inline code = 1 word; characters exclude newlines; "no spaces" excludes all whitespace [src:DOMNode+Text.m]. Web: `Intl.Segmenter` (`granularity: 'word'`, `isWordLike`) per text node, same exclusions. CJK counts may differ slightly from macOS | medium-high |
| U-18 | (new) F-162: do hidden Format menu items still answer their shortcuts? | **Inferred** | AppKit documents that hidden items do not respond to key equivalents (`allowsKeyEquivalentWhenHidden` defaults to NO). The app was not run | high |
| U-19 | (new) F-17 zoom not reset when the option is turned off | **Still open (decision)** | Original keeps the zoom (bug). Proposed web behaviour: zoom 1 when off. CoS to confirm | high (that it is a bug) |

---

## 13. Change log (M1b)

Source cross-check against MacDown v0.7.3 (`vendor/macdown`, commit `0a9e065`) and Hoedown 3.0.7. Notes and evidence: `docs/analysis/source-notes.md`. No feature ID was renumbered or removed. "Behaviour change" marks corrections that change what the web app must do.

### Version and sources
1. §0: added the source cross-check paragraph and the `[src:…]` / `[hoedown:…]` citation formats. The v0.7.3 tag matches the bundle (identical `help.md`, template, extensions, styles, themes). HEAD (2021-04-29) has no code changes since the tag.

### Preferences (§8)
2. All preference keys and defaults verified against `MPPreferences.{h,m}`: **no default changed**.
3. Preferences window pane order corrected to General, Markdown, **Editor, Rendering**, Terminal (§8 intro, F-140).
4. P-01: unchecking "Update preview automatically" also turns P-05 (word count) off. Behaviour change.
5. P-02: original semantics documented (`applicationShouldOpenUntitledFile:`).
6. P-13: noted the inverted footnote flag passed to the editor highlighter (§5.5).
7. P-19c and P-31: the first pop-up item is an empty "no style" / "no theme" option (new F-166). Behaviour change.
8. P-21: Prism theme titles are capitalised (Coy, Dark, Funky, Okaidia, Solarizedlight, Tomorrow, Twilight) and stored as shown; empty = (Default).
9. P-23: the Accessory pop-up is always enabled (not bound to P-20). Behaviour change for the preferences UI.
10. P-32 to P-35: an emptied numeric field becomes 0.
11. Editor "Behavior" group membership corrected (P-45 List marker is outside the box).
12. New §8.4b: hidden keys P-46 (`editorContinuousSpellCheckingEnabled`, In), P-47 and P-48 (other text-checking keys, Out), plus the internal keys list.

### Menus and toolbar (§3, §4)
13. §3: all shortcuts verified against `MainMenu.xib`; no shortcut changed. Added the Render Markdown enablement and the hidden Format items.
14. §4: default toolbar order resolved, with flexible spaces after Headings, Lists, Inline Code, Image and Copy HTML (U-08). Behaviour change.
15. §4: segment styles and sizes documented; the HideEditor/HidePreview images are unused (U-15).
16. F-09: the Layout pop-up items have no key equivalents of their own.

### Editor behaviours (§2.4, §2.5, §5, §10 S-16)
17. §5.1 rule 2: for `'` and `"` a pair is inserted only when the **previous** character is a boundary too. Behaviour change.
18. §5.1 rule 3: typing `"` or `'` inside an empty pair inserts another pair (original quirk, kept). Behaviour change (new test E16).
19. §5.1 rule 4: with Smart Quotes on, only an opening curly quote is inserted, not a pair (Out anyway).
20. §5.1 rule 6: delete-pair works from the selection start (even with a selection).
21. §5.2: empty list item: the marker is removed **and a newline is inserted**, with the indentation kept (`* |` → `\n|`). M1 said no newline. Behaviour change (E8 corrected, E18 added).
22. §5.2: an empty `>` line is **not** terminated; Return adds another `> `. M1 guessed it would end. Behaviour change (E19).
23. §5.2 / F-69: indented-line continuation works even when P-38 is off. Behaviour change (E21).
24. §5.2: list continuation reuses the line's own bullet (not P-45), drops leading zeros from numbers, uses the text up to the cursor, and has a duplicate-marker guard.
25. §5.4: inline toggle only checks the text **outside** the selection (a selected `**a**` is wrapped again, E17); block toggle requires **every** line including empty ones to match, removes a fixed prefix length, and adds the prefix to empty lines too. Behaviour change.
26. F-47: multi-line header conversion skips whitespace-only lines.
27. F-54: original ordered-list toggle confirmed; **deliberate web deviation (CoS decision, U-05)**: detect `^[0-9]+\. \S` and strip the matched prefix (E22).
28. F-57 / F-58: exact indent and unindent rules (empty lines get the padding; `"  \t"` removed as one unit; whitespace-only lines untouched; E23).
29. F-59 / F-60: cursor placement resolved; only `http`, `https` and `file` clipboard URLs are inserted (U-06).
30. F-61 New Paragraph: inserts `\n\n` **at the cursor** (does not move to the end of the line); on an empty line inserts one plain newline. Behaviour change (E20).
31. F-62: description updated for the boundary rule.
32. F-73: soft-wrapped line exception; position 0 uses normal behaviour.
33. F-74: a theme that fails to parse resets `editorStyleName`.
34. F-78: centred inset uses **(width − maxWidth) × 0.45**, not /2. Behaviour change.
35. F-79: exact scroll-past-end padding formula.
36. F-80: continuation does not use P-45.
37. F-42 / F-43 / F-44: menu items hidden unless their extension is on (see F-162).
38. §5.5: editor link detection is always off (resolved).

### Window, files, export (§1.1, §2.1 to §2.3, §9)
39. §1.1: split ratio is the left pane width; restoring with no stored ratio uses 0.5; the editor is not editable while collapsed.
40. F-02: real coalescing behaviour (serial queue, cancel on change, the 0.5 s cap is ineffective); no rendering while the preview is hidden and word count is off.
41. F-03: Render Markdown is enabled only while the preview is visible.
42. F-07: the Hide Preview item is hidden when collapsed with no stored ratio.
43. F-11: scroll-sync anchor details.
44. F-12: exact word-count algorithm (code blocks excluded from words, inline code counts 1, per-text-node counting; U-17).
45. F-17: zoom is not reset when the option is turned off (original bug; proposed web fix, U-19).
46. F-18: in-page anchors navigate; other links go to the system default app; preview drag disabled; copy adds HTML.
47. F-26: the save name is suggested only for never-saved documents; allowed types `md`, `markdown`.
48. F-30: not applied to an empty document.
49. F-31: presumed name prefers the **highest-level** header (first H1 anywhere, then H2, …); saved documents use their file name; the `/|:` replacement applies only to header titles. Behaviour change.
50. F-33: only the first dropped file; inserted at the selection start without replacing it.
51. F-35 / §9: export asset rules corrected: `show-information.css` and `tasklist.js` are **not** exported; Mermaid and Graphviz only with "Include syntax highlighting"; Prism CSS embedded even without "Include styles"; "Include styles" defaults to off only for the empty style; no `<title>` for unsaved documents (U-11). Behaviour change.
52. F-37 / E-05 / E-06: print margins are 50 pt top/bottom and **0 pt left/right** (M1 said 50 on all sides). Behaviour change.
53. F-39: Copy HTML re-parses first when the preview is not live.
54. F-96: spell-check state persisted (P-46). F-140: pane order. F-153: help window sized to the screen.

### Rendering (§6, §7, §10)
55. §6.1: order corrected to Hoedown → SmartyPants → TOC substitution → front matter prefix (TOC text is not SmartyPants-processed); the TOC regex is case-insensitive (`[toc]` works); maximum nesting is unlimited (`SIZE_MAX`), not 16; front matter is removed only when YAML parses. Behaviour change.
56. §6.2: flags confirmed from source.
57. §6.3: F-115 (`__x__` stays strong), F-118 superscript grammar (U-13), F-120 SmartyPants rules (U-14), F-121 intra-word emphasis rules for `_` (U-03), F-130/F-131 math rules (`$$` display only when alone in its paragraph unless P-19 is on; math only with P-18).
58. §6.4: no trailing newline inside `<code>` (S-05, S-06 corrected). Behaviour change.
59. §6.4: the `:` split happens **only** with accessory = Custom; otherwise the whole first word is the class (U-02, new S-06b). Behaviour change.
60. §6.4: alias lookup is **case-sensitive**; only the first word of the info string is used; `data-information` is not escaped; the line-numbers class follows the stored preference. Behaviour change.
61. §6.4: Prism dependency walk, plugin assets and theme file fallback documented; the Accessory pop-up is not bound to P-20.
62. §6.5: footnote template verified against Hoedown 3.0.7 (U-01).
63. §6.6: TOC level offset and entry formatting documented.
64. §6.7: upper-case `[X]` confirmed not checked (U-16); checkbox placed inside `<p>` for loose items.
65. §6.8: front-matter escaping, null, key order and scalar handling.
66. §6.9: MathJax config embedded; the `MathJax.js` loader is redirected to the bundled copy but the components still need the CDN; post-load work waits for MathJax.
67. §6.10: exact style and script order; Mermaid and Graphviz require P-20.
68. §7.1: `GitHub-2017.css` is absent from the source, so **the web app hides it** (CoS decision, U-07); the empty "no style" item exists; list order is not sorted in the original. Behaviour change.
69. §7.2: the empty "no theme" item; Reload re-applies the theme.
70. §7.4: embedded asset tag format verified.

### New features
71. F-162 Extension-dependent Format menu items (In).
72. F-163 Touch Bar (Out).
73. F-164 Persisted text-checking toggles (In for spell check only).
74. F-165 Divider colour follows the visible pane (In, low priority).
75. F-166 "No style" / "No theme" options (In).

### Unknowns (§12)
76. U-01 to U-11 and U-13 to U-17 marked Resolved (U-05 and U-07 as CoS decisions). U-12 is still open as a web-design question. Added U-18 (hidden-item shortcuts, inferred) and U-19 (F-17 zoom reset, decision needed).

### M3 fixes (defects D-04 to D-08)
77. §6.9 / F-131 (D-04): MathJax uses the original's effective configuration, MathJax 2.7.3 `tex2jax` defaults: inline `\(…\)` only (no `$`, even with P-19), display `$$…$$` and `\[…\]`, `processEscapes: false`, default skipped tags. A `\$` and `$x$` inside raw HTML stay literal, as in the original. The M1 web target (`['$','$']` with P-19) was wrong. Behaviour change.
78. §6.3 / F-113 (D-05): autolink follows Hoedown's `autolink.c` exactly (scheme URLs with `http`, `https`, `ftp`; `www.`; e-mail), with no fuzzy links, so `README.md` and `example.com` are not linked. The M1 mapping (`linkify: true` + linkify-it) linked bare domains; linkify-it options cannot express the rules (`fuzzyLink: false` also drops `www.`), so the web app uses a port of Hoedown's three autolink triggers and `linkify: false`. Behaviour change.
79. §6.5 / F-117 (D-06): only the first reference to a footnote is rendered; a later `[^id]` to the same footnote stays literal text, so there are no duplicate `fnref` ids [hoedown:src/document.c:1131-1141]. Behaviour change.
80. §6.1 / F-110 (D-07): markdown-it's `maxNesting` is 1000 instead of its default 100. Hoedown's nesting is unlimited (`SIZE_MAX`), but markdown-it's recursive parser overflows the JavaScript stack at about 1850 nested blockquotes, so 10000 is not safe. 1000 levels (500 list levels) is far beyond realistic documents; deeper content renders as text.
81. §6.3 / F-121 (D-08): with intra-word emphasis off, an opener is rejected only when **plain text** precedes it (Hoedown checks `offset > 0`, the characters since the last successful construct). Emphasis at the start of nested content (`[*a*](u)`, `**_a_**`, `"_a_"`, `~~_a_~~`, `==*a*==`) or right after a construct works. A `~`/`=` run opens only when it is exactly two long and a `*`/`_` run of four or more never opens, so `~~~b~~~` stays literal. Behaviour change.
82. §6.4 / F-112 (found with D-08): a fence whose opening line has three fence characters in a row after the fence (`~~~b~~~`) is not a fence, as Hoedown's "avoid parsing a codespan as a fence" rule [hoedown:src/document.c:1472-1475]. markdown-it applied this only to backtick fences. Behaviour change.

### M4 fixes (defects D-09 to D-12, SD-07 to SD-09, Q-04, Q-05)
83. F-64 / §5.1 (D-09): there is no HTML tag auto-close. With P-36 on, typing `<b>` gives `<b>|` (rule 2 pairs `<`, rule 3 skips the typed `>`); the original has no tag completion [src:NSTextView+Autocomplete.m:116-172]. Web: CodeMirror's nested HTML language is created with `autoCloseTags: false`, and the §5.1 input handler has the highest precedence. Behaviour fix.
84. F-74 / §7.2 (D-10): an HTML comment that forms its own block gets the theme's COMMENT style, as an inline comment does (peg-markdown-highlight `HtmlBlock` contains `HtmlComment`, which adds `pmh_COMMENT` [pmh_grammar.leg:365-366, 614-615]; no bundled theme styles HTMLBLOCK). Behaviour fix.
85. F-14 (D-11): the Customize Toolbar dialog is modal; Tab and Shift+Tab cycle inside it while it is open.
86. F-14 (D-12): unchecking every item gives an empty toolbar. `toolbarItemIdentifiers` distinguishes unset (`null`, the default set) from empty (`[]`); only "Use Default Set" stores unset. Behaviour fix.
87. F-166 / §7.2 (SD-07): "no theme" keeps the HGMarkdownHighlighter default element styles (`getDefaultStyles`) on the default text view colours; it is not an uncoloured editor. Wording fix; the app already did this.
88. F-57 / F-58 (SD-08): both original quirks are kept and documented: Shift Left on a whitespace-only first line leaves the text unchanged but moves the selection left by the counted shift; Shift Right on an empty last line adds nothing.
89. F-79 (SD-09): `trailingHeight` is one line height of the font (without line spacing) when nothing trails the last visible character, as AppKit's `boundingRectForGlyphRange:` returns for an empty range (AppKit probe, Menlo 14: 16 pt). The bottom padding is one line smaller than the M1 formula gave. Behaviour change.
90. §5.2 (Q-04): Shift+Return is the same command as Return (`insertNewline:`), so it continues lists and quotes. Behaviour change (the M4 build inserted a plain newline).
91. F-105 to F-107 (Q-05): the NSTextView transformations extend the selection to whole word-granularity units; with an empty selection they act on the unit before the cursor (after it at a document or line start), and select the result. Capitalize rules as measured with an AppKit probe (F-107 row). Resolved from AppKit; the M4 build's "word around the cursor" rule was an inference.
92. Undo (F-81, §5.5): each Format menu, toolbar or Edit-menu command (Delete, Paste, Transformations) is one undo step, and typing after it starts a new undo step (`isolateHistory`), as NSTextView starts a new undo group after a command. CodeMirror would otherwise merge typing within 500 ms into the command's step.


### M5 fixes (defects D-13 to D-20, SD-10 to SD-14, O-01, O-03)
93. §1, F-22, F-26, F-34 (D-13, SD-11): line endings are kept as read. CodeMirror stores one separator, so the editor remembers the separator of every CRLF or lone-CR break, maps it through each edit, and Save, the draft and the "Edited" test use the text with those separators. Matches NSTextView (AppKit probe): CRLF, CR and mixed endings stay byte for byte; a typed Return inserts LF, so editing a CRLF file can give mixed endings, as in MacDown; Backspace or Delete removes a CRLF whole, and undo brings it back, so typing and undoing back to the original text leaves the document not edited. The preview and export render with CR and CRLF turned into LF, as Hoedown's first pass does. Deviation: text pasted or dropped into the editor gets LF breaks (NSTextView would keep a pasted CRLF). Behaviour fix.
94. §1 (SD-11): the encoding rules are written down (BOM dropped and never written, CRLF and CR kept, NUL kept, invalid UTF-8 refused). The app already did this apart from D-13.
95. F-25, F-29, F-32 (D-14): with P-02 off, Close (Don't Save or a saved document) also clears the draft, so switching P-02 on later does not bring the closed text back. Closing a help copy leaves the draft alone. Behaviour fix.
96. F-18, F-153 (D-15, SD-10): in-page links scroll to the element with that `id`, else to the first `<a name>` with that name, as WebKit does; all 7 in-page links of `help.md` work. An empty fragment or `#top` scrolls to the top. F-18 text updated. Behaviour fix.
97. F-18 (D-16): the fragment is percent-decoded as the URL standard does (a `%` without two hex digits stays as is, invalid UTF-8 becomes U+FFFD), so a malformed escape such as `#100%` never raises. Behaviour fix.
98. F-31, E-04 (D-17): "file name without extension" is `stringByDeletingPathExtension`, as a Foundation probe gives it: `a.`, `v1. final`, `Notes v1.5 final`, `a.md.`, `a.m d`, `..md` keep their dots; `a..md` gives `a.`. `hasExtension:` uses the same rule (case-insensitive in the web app, as before). Behaviour fix.
99. F-29 (D-18): when the draft cannot be stored (quota exceeded), the older draft is removed, so a reload does not restore stale text. Deviation kept: a draft larger than the browser's storage quota (about 5 MB of UTF-16, half that for an opened file, which also stores its saved text) is not kept at all.
100. F-16 (D-19): the remembered split ratio of a named document is applied when that document is restored at launch, not only on Open. Behaviour fix.
101. F-21, F-22, F-25, F-28, F-153 (D-20): after New, Open, Revert, Help or Close the new document's editor has the keyboard focus, as AppKit makes the new text view the first responder. With the editor pane collapsed the preview gets the focus; with no document (P-02 off) the empty state's New button gets it. Behaviour fix.
102. F-31 (SD-13): checked against the source. With `kYAMLReadOptionStringScalars` every YAML scalar is an `NSString` [YAMLSerialization.m:80-82], so `title:` and `title: ""` give `""`, and `title: ~` and `title: null` give the strings `~` and `null` (never `NSNull`). `presumedFileName` tests the title for nil only [MPDocument.m:1873-1875], so the presumed name is `""` and the header is not used. The app now matches: the presumed name is `""`, so the PDF print title is empty and Export HTML suggests `.html` (the original sets an empty name field with the `html` type; if the browser refuses `.html`, O-03 retries with `Untitled.html`). Save panel: in the original `[@"" stringByAppendingPathExtension:@"md"]` returns nil and `nameFieldStringValue = nil` raises `NSInternalInconsistencyException` (AppKit probe), so such a document cannot be saved through the panel. Deviation: the web app suggests "Untitled.md". A front matter that is not a mapping would raise in the original on `objectForKey:`; the web app treats it as no title.
103. U-12 (SD-12): resolved as implemented (U-12 row, F-32).
104. F-26 (SD-14): one sentence added: a presumed name that already ends in `.md` leaves the panel's default "Untitled.md".
105. Save and Export (O-01): the text that Save, Save As and Export read is updated in the same transaction as the editor change, so a Save in the same task as a text change saves the new text. Before, it was set during React's next render, and a programmatic change followed at once by Save wrote the previous text. Typing was not affected. Fix.
106. Save panel (O-03): if `showSaveFilePicker` rejects the suggested name (for example a front-matter title such as `a/b: c`, used as is per F-31), the panel is asked again with a safe name (`\ / : * ? " < > |` and control characters become `-`; a name that would be hidden or empty gets "Untitled" in front). If that also fails, an error sheet says "The document “…” could not be saved." (Export: "The file “….html” could not be exported."), and the document stays edited. Before, Save did nothing silently. NSSavePanel always appears, so the original has no such case. A real browser may refuse the second picker for lack of user activation; then the error sheet appears.
107. Editor performance (F-22 large files): the editor's Markdown parser uses a linear-time wrapper around Lezer's `LinkEnd` that gives the same tree (checked against the stock parser on fixed and 2000 random inputs). Lezer marks earlier `[` as invalid by walking every earlier inline part after each link, which is O(n²) in one paragraph: a 2 MB paragraph with 40,000 links took 7 to 20 s to open. It now takes well under a second to parse.
108. Scroll sync (F-11, issue #2): anchors come from the parse instead of the original's line regexes. Every preview block carries its source lines, and both its top and bottom are paired with the editor, so images and the space between blocks line up too; the mapping only moves forward. A `# comment` in a code fence no longer counts as a header (before: 37 of 41 scroll steps showed a different section in the preview, up to 12 sections off, with jumps back). Deliberate deviation.
