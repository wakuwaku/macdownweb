# Status

| Milestone | Owner | State | Latest test result |
|---|---|---|---|
| M1 Functional spec | reverse-engineer | **done** | 161 F-IDs (+5 from source check); 76 + later changes logged in spec §13 |
| M1b Spec cross-check vs source | reverse-engineer | **done** | v0.7.3 tag verified identical to bundle; all pref defaults confirmed |
| M2 Scaffold + core editor/preview | reverse-engineer | **done** | D-01..D-03 verified fixed |
| M3 Rendering parity | reverse-engineer | **done** | D-04 not-a-defect; D-05..D-08 verified fixed |
| M4 Editing features | reverse-engineer | **done** | D-09..D-12 verified fixed |
| M5 Files, prefs, export, help | reverse-engineer | **done** | D-13..D-20 verified fixed |
| T Testing / final regression | test-engineer | **done — GO** | Final sign-off: build OK; unit 762/762; E2E 1091/1091 (4.4 min, 3 workers). CoS re-run matches. |

## Open items (non-blocking)
- Partial features: F-16 (window frame not remembered), F-18/F-20 (relative links/images), F-36/F-37 (browser print dialog), F-62 (IME untested), F-130 (MathJax 3 locally; export links MathJax 2.7.3 CDN).
- Cosmetic: O-07 (export error sheet shows unsanitised name), O-08 (Save As on untitled doc suggests Untitled.md rather than front-matter title).
- Accepted deviations: single document; pasted CRLF becomes LF; oversized draft not kept; Cmd+N/W/T menu-only; emphasis nesting order; GitHub-2017 style hidden; F-11 scroll sync anchors on every block (issue #2).
- Load-flaky tests (pass alone; fail only on a heavily loaded machine): m3-independent lines 270/379/403/410/417/423, m5-independent 2199, m4-independent 1612/1806. Use `--workers=3` if the machine is busy.

## Manual checks still needed (cannot be automated headless)
Print/PDF in a headed browser; real File System Access pickers in Chrome/Edge; Firefox/Safari fallbacks; clipboard permission for Copy HTML; IME; VoiceOver; visual comparison with MacDown on Retina.
