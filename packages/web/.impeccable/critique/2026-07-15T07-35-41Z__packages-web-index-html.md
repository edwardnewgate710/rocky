---
target: packages/web (app shell)
total_score: 25
p0_count: 0
p1_count: 3
timestamp: 2026-07-15T07-35-41Z
slug: packages-web-index-html
---
# Critique — packages/web (Gambit web app shell)

Method: DEGRADED single-context (sub-agents not spawned per harness policy); browser viz unavailable (node_modules absent, static detector only).

Scope: index.html + src/style.css, board-view.ts renderer, lobby/profile/auth controllers.

## Design Health Score: 25/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No loading indicators (seek load, profile load, move submit); pending only disables a button |
| 2 | Match System / Real World | 3 | Chess vocabulary correct and audience-appropriate |
| 3 | User Control and Freedom | 3 | Cancel seek, logout, promotion-cancel; SPA back works |
| 4 | Consistency and Standards | 3 | One button/row style; but error reuses the selection color |
| 5 | Error Prevention | 3 | required + reportValidity; create-seek gated when signed out |
| 6 | Recognition Rather Than Recall | 3 | Text-labeled nav, aria-labels; theme toggle icon-only but labeled |
| 7 | Flexibility and Efficiency | 2 | Zero keyboard shortcuts; board click/drag-only |
| 8 | Aesthetic and Minimalist Design | 3 | Board-first, uncluttered; some "minimal" = unfinished |
| 9 | Error Recovery | 2 | Errors wrong-colored, fail light-mode contrast, not beside field |
| 10 | Help and Documentation | 1 | No empty states, no first-run help, no tooltips |

## Anti-Patterns Verdict
detect.mjs returned [] (zero slop patterns). Not AI-slop — genuine restraint. But reads prototype-grade, not premium; failure mode is "unfinished," not "sloppy."

## Priority Issues
- [P1] Unicode glyph pieces instead of a real SVG piece set (board is the product; central asset looks prototype). Fix: adopt open-licensed SVG set (Cburnett). -> polish (asset swap).
- [P1] Light mode broken: white-tint panels invisible on #f7f6f5; .error teal (#20b2aa) ~2.5:1 on light bg FAILS WCAG AA. Fix: theme-aware panel tint + Ember danger token verified >=4.5:1. -> colorize.
- [P1] No empty states (blank seek list / ratings / games). Fix: teach-the-interface empty copy. -> onboard.
- [P2] No loading/status visibility (fetch + move submit). Fix: skeletons + inline indicator. -> harden.
- [P2] Flat/unresponsive: buttons have no :hover/:active; zero transitions/animations; no piece-move animation. Fix: hover/active states, 150-250ms transitions, board move animation + reduced-motion fallback. -> animate.
- [P2] Sign-in form not route-gated (#auth never hidden; stacks with lobby/board). Fix: gate app behind auth or dedicated route/modal. -> layout.
- [P3] No keyboard shortcuts / board keyboard nav for power users. -> adapt.

## Persona Red Flags
- Alex (competitive power user): no keyboard shortcuts, click/drag-only board, no accelerators.
- Sam (a11y): error meaning by color that also means "selected"; error text + focus outline fail/marginal contrast in light mode.
- Mara (rated competitor, project persona): Unicode pieces + no motion + broken light mode contradict "premium/trustworthy" on first impression.

## Minor Observations
- .clock-label 0.7 opacity borderline (~5:1).
- Board has no max-width; can grow past ~800px on ultrawide.
- Theme toggle raw emoji; inline SVG would read more premium.
- Signed-in: #auth form hides but empty section wrapper remains in flow.
