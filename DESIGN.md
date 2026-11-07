# Nightroll design system

## Overview

Nightroll is a private payroll workspace for people testing stealth-address USDC payments on Base. The visual idea is a quiet ledger: charcoal surfaces, restrained lavender actions, full payment data and clear transaction states. The desktop workspace has a narrow navigation rail, a single main column and a supporting run summary. Mobile puts wallet connection and the payroll workflow first. The interface is intentionally flat, with no decorative gradients or loading animations.

The source of truth is `src/styles.css`; product-specific patterns are in `src/App.tsx`, and icons/brand are in `src/icons.tsx`. Receipt rendering uses the same system with a separate print stylesheet.

## Colors

Primitives and semantic aliases are declared together at `src/styles.css:1`. Reuse semantic roles when adding components.

| Semantic token | Value / primitive | Use |
| --- | --- | --- |
| `--color-bg` | `#111215` / `--neutral-950` | Page and field background |
| `--color-sidebar` | `#141518` | Navigation rail |
| `--color-surface` | `#17181c` / `--neutral-900` | Wallet, upload, review and summary surfaces |
| `--color-hover` | `#222329` / `--neutral-800` | Neutral buttons, hover and disabled fill |
| `--color-border` | `#36373f` / `--neutral-700` | Structural separators and panel outlines |
| `--color-text` | `#f3f2f7` / `--neutral-100` | Main text and headings |
| `--color-secondary` | `#c4c5ce` / `--neutral-300` | Payment details and secondary labels |
| `--color-muted` | `#9b9da9` / `--neutral-500` | Help, descriptions and metadata |
| `--color-accent` | `#bca6ff` / `--violet-400` | Primary action fill and brand mark |
| `--color-accent-hover` | `#c7b5ff` / `--violet-300` | Primary hover |
| `--color-on-accent` | `#24202e` | Text on the lavender action |
| `--color-focus` | `#c7b5ff` | Two-pixel keyboard outline, four-pixel offset |
| `--color-success` | `#a1d9bb` | Sent/approved text and completion mark |
| `--color-warning` | `#e5c38b` | Testnet badge, pending/unknown and warnings |
| `--color-danger` | `#f5acae` | Failed resolution, CSV errors and stopped sends |

Status color always accompanies text; a dot alone never establishes meaning. Neutral button borders use `#636570`; field boundaries use `#696b77` to remain distinguishable. Warnings, errors and success notices use their own dark tonal backgrounds. The app supports the requested dark theme only.

Measured initial-screen text contrast from the rendered probe: body heading 16.82:1 on the page, muted page copy 6.95:1, wallet help 6.58:1 on its surface, primary action 7.60:1 and secondary action 9.12:1. These measurements apply to the identified rendered pairs, not every possible user-supplied state.

## Typography

Manrope Variable is bundled via `@fontsource-variable/manrope@5.3.0` in `src/main.tsx`. The production build contains local WOFF2 subsets for Latin, Latin extended, Cyrillic, Greek and Vietnamese. The stack falls back to system UI and native sans serif; Unicode outside those subsets uses available system fallbacks. Font loading was confirmed in Chromium. Code/data uses `ui-monospace, SFMono-Regular, Consolas, monospace`.

Six named sizes are available: `--text-xs:12px`, `--text-sm:14px`, `--text-body:16px`, `--text-lg:20px`, `--text-title:28px`, `--text-display:40px`. Weights are 400, 500 and 600. The main heading is 28px/1.3 with -0.9px tracking; section headings are 16px/1.5, and dense table/help text is 12px with at least 1.6 line height. Inputs/selects use 16px to avoid iOS input zoom. Receipt amounts use 40px on desktop and 28px on mobile.

Headings balance their lines. Prose uses natural casing and `text-wrap: pretty`; long About copy is limited to 75ch. Amounts use tabular numerals. Full recipient addresses, transaction hashes and payment keys wrap anywhere and remain selectable. Notes preserve newlines. The wallet strip shows a shortened address alongside an explicit disclosure containing the full address; payment destinations are never shortened. `dir="auto"` isolates entered names/notes, while addresses are explicitly LTR.

## Layout

The shell is a flex layout. At desktop widths, the navigation rail is 218px and the body contains a 77px topbar. The workspace has a 1320px maximum width, 40px inline padding and 38px top padding. `workspace-grid` is `minmax(0,1fr) 274px` with a 24px gap. Shared panel padding is mostly 24px; mobile uses 18px. Within a group, use 7–12px gaps; between groups, use 20–32px. Controls are at least 44px tall.

Implemented breakpoints in `src/styles.css`:

- Up to 1180px: the rail narrows to 190px, workspace padding becomes 28px, summary becomes 240px, and payment rows become two-column labeled records. Full address and status span both columns.
- Up to 980px: the rail is 180px, the workspace becomes one column and the summary follows the payroll content. The wallet action can wrap below its description.
- Up to 720px: the rail disappears, the brand moves into the topbar, content has 24px margins, settings stack and actions become full width. Receipt content uses 24px padding.
- Up to 430px: progress steps place their number above the label, and the three explanatory items become a single vertical list.
- Up to 350px: page margins reduce to 16px and the decorative wallet icon is removed to preserve content width.
- From 1500px: workspace top padding is 44px.

At 320, 390, 720, 980 and 1440 the tested initial/review/sent/receipt content has no page overflow. The 390 first screen shows the product and Connect Wallet. Review totals appear above the list, and the remaining amount is repeated beside the send decision because the supporting summary moves below the list on mobile. There are no sticky controls covering content. A 200% CSS text enlargement and an RTL mirror were tested; native browser zoom and localization are separate, unperformed checks.

## Elevation & Depth

There are no box shadows. Flat tonal surfaces establish hierarchy; one-pixel borders establish structure. The file illustration is the only decorative layered object, built with CSS and an inline SVG icon. It does not affect hit areas. The focus outline is a state boundary, not elevation. There are no modals or overlay focus traps.

## Shapes

Main panels have a 10px radius. Buttons and the drop zone use 7px; form fields use 6px. Status dots, step markers and the receipt success seal are round. The brand mark uses an 11px SVG radius. The drop zone has a dashed border to distinguish it from normal surfaces. Data containers do not clip their text.

## Components

| Pattern | Source | Behavior and states |
| --- | --- | --- |
| `Logo` / `Icon` | `src/icons.tsx` | Locally authored SVGs; icons inherit `currentColor`, are decorative and hidden from assistive technology. Logo is a home link. |
| `.button` | `src/styles.css:86` | Primary lavender and secondary neutral variants; compact padding retains 44px height. Native disabled state, hover, two-pixel focus and active feedback. |
| Wallet strip | `src/App.tsx:213` | Disconnected, connecting, connected, wrong network, missing wallet and error recovery. Full address disclosure uses native details/summary. |
| Upload panel | `src/App.tsx:219` | File chooser and drag/drop, loaded file, parsing, empty and line-numbered errors. Errors receive focus; native input has an accessible name. |
| `.field`, `.checkbox-line` | `src/styles.css:171` | Visible labels; native inputs, selects and checkboxes. Settings lock during name resolution/sending and after attempts. Before the first attempt, changing a setting clears the review. |
| `.review-totals`, `.payment-table` | `src/styles.css:186` | Full values, semantic table roles and a mobile labeled-record layout. Every status has text; sent rows add full hash and receipt link. |
| `.notice` | `src/styles.css:151` | Persistent warning, danger and success variants, with an icon plus text. Errors use alert semantics; progress/completion uses status semantics. |
| `ReceiptPage` | `src/App.tsx:23` | Hash-only data, malformed-link state, selectable details, Copy link feedback and native printing. Print hides navigation and controls, uses white paper and dark ink. |
| About box | `src/App.tsx:240` | Native details disclosure with visible chevron; explains test funds, local journal and receipt link privacy. |

The skip link is first in the tab order, appears on focus, and moves focus to the current main landmark without replacing the receipt fragment. Review moves focus to its heading. There are no automatic page entrances. Under `prefers-reduced-motion: no-preference`, buttons transition background, border and transform for 120ms and scale to 0.96 while pressed; reduced motion has no transition. User approval is never inferred from animation or elapsed time.

## Do's and Don'ts

- Start a new view with the shell and the existing page/section heading roles. Keep its main control near the top.
- Give the current primary action the filled lavender variant; keep secondary choices neutral. Use status hues only with explicit status text.
- Reuse token sizes and weights. Keep prose out of monospace, and leave full destinations/hashes selectable and wrapped.
- Preserve the pay run reference, fingerprints and guarded `sendPayment(row)` pathway when changing UI. A display edit must not create a new retry key.
- Keep one-column mobile reading order, labels adjacent to inputs and totals beside financial decisions.
- Add another receipt-like view by reusing `.receipt-main`, `.receipt-data` and existing action styles. Include its print behavior only if it is intended for printing.
- Do not add external fonts, analytics, remote data fetches, decorative shadows or a second accent system to this static prototype.

Applied guidance attribution and licenses are retained in `docs/design-guide-LICENSE.txt` and described in `README.md`. This document records the final implemented source, not a proposed redesign.
