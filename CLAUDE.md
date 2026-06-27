# Credit & Debit Dashboard — Project Context

Single-page web app for tracking accounts receivable (дебиторка) and payable (кредиторка) for a Kazakhstan small business. User uploads 1C exports — app parses them and renders a dashboard.

**Live URL:** https://credit-debit-swart.vercel.app/
**Language:** UI is in Russian. Code/comments mix Russian and English.

---

## Architecture

Static site (no build step) + one Vercel serverless function.

```
index.html (~1380 lines, everything inline)
├── XLSX.js (CDN)              — parses .xlsx/.xls/.csv in browser
├── pdfjsLib v3.11.174 (CDN)   — extracts text from text-based PDFs in browser
├── Chart.js (CDN)             — top-10 contractors chart
└── localStorage               — persists parsed records + company settings

api/extract.js (Vercel Node.js function, maxDuration: 90s)
├── ai v6 + @ai-sdk/anthropic@ai-v6 (3.0.88) + generateObject + zod schema
├── model: anthropic('claude-sonnet-4-5-20250929') — direct Anthropic API, env ANTHROPIC_API_KEY
└── Russian system prompt for KZ accounting docs (ЭСФ, акт сверки, etc.)
```

**No frontend framework. No bundler. No tests.** Edit `index.html` directly; the IIFE at the bottom owns all state and DOM.

---

## File map

| File | Purpose |
|---|---|
| `index.html` | Entire frontend: HTML + CSS + IIFE JS. ~1380 lines. |
| `api/extract.js` | Serverless function that proxies PDF/image to Claude via AI Gateway. Returns `{headers, rows, _meta}` matching the xlsx parser's output shape. |
| `package.json` | `type: module`, Node 24.x, deps: `ai@^6.0.0`, `zod@^3.23.8`. |
| `.vercel/project.json` | Project link: `projectId=prj_t8y6bi6vAm50ns772TxpR3nyNxPJ`, `orgId=team_aPHaO2CdcshD1kAwsLJUHyUG`. |

---

## Data flow

### Excel / CSV
1. `readWorkbook(file)` → `XLSX.read`
2. `sheetToRows()` scans first 10 rows for header (keyword scoring)
3. `findColumn(headers, KEYWORDS.*)` auto-maps columns to {contractor, receivable, payable, date}
4. If auto-map fails → `openMappingModal()` for manual mapping
5. `buildRecords()` → records `[{contractor, amount, date, daysOverdue, status, type:'receivable'|'payable'}]`
6. `validateRecords()` heuristic check: rejects files where 50%+ amounts look like dates or 50%+ contractor names look like БИНs (rejects single invoices misparsed as reports)
7. `saveState()` + `render()`

### PDF
1. `parsePdfFile()` tries pdf.js text-layer extraction
2. Detects single-invoice formats (ЭСФ / счёт-фактура / накладная) by marker keywords — if ≥2 markers match, throws to force AI path
3. If text-layer extraction succeeds → groups items by Y-coordinate into lines, finds header line by keyword scoring, builds column bins by X-coordinate, returns `{headers, rows}` matching the xlsx shape
4. If empty (scan) or rejected as single invoice → confirm dialog → `extractWithAI()` → POST `/api/extract`

### Image (PNG/JPG/HEIC/WEBP)
Always goes straight to AI path — `extractWithAI()`.

### `/api/extract` (Claude path)
1. Frontend base64-encodes the file, POSTs `{base64, mediaType, filename, companyName, companyBin}`
2. Server validates: size limit 8MB, `AI_GATEWAY_API_KEY` must be set (returns 503 if missing)
3. Calls `generateObject` with model `anthropic/claude-sonnet-4-6`, zod schema `ExtractedTable`, content `[{type:'text'}, {type:'file', data, mediaType}]` — sends the **PDF as a file**, not pre-rendered images
4. zod schema: `{document_type, direction_determined, warning, rows: [{contractor, receivable, payable, due_date}]}`
5. Server reshapes `rows` to `[contractor, receivable, payable, due_date]` arrays + `headers: ['Контрагент', 'Дебиторская...', 'Кредиторская...', 'Дата']` so the frontend's normal parser pipeline can consume it
6. Frontend stores `_meta` in `lastAIResponse` for the debug modal

### Company settings (`COMPANY_KEY` in localStorage)
- User sets `{name, bin}` in settings modal — 12-digit БИН validated
- Sent with every AI request so the prompt can determine direction (receivable vs payable) by comparing БИН in Section B (поставщик) vs Section C (получатель) of ЭСФ
- If unset, `direction_determined=false` and a warning is shown

---

## Prompt design (`api/extract.js`)

The Russian system prompt teaches Claude to handle THREE document classes — they're distinct, not collapsed:
- **Single-doc** (ЭСФ, счёт-фактура, накладная): compare our БИН against Section B/C → one row, assigned to receivable or payable.
- **Акт сверки** (2-party reconciliation): one row with the CLOSING balance from "Задолженность по состоянию на …". Mirrored Debit/Credit columns hold the same amount duplicated — never sum them. Direction from the "долг [сторона]" sentence at the bottom.
- **Multi-row reports** (оборотно-сальдовая, ведомость взаиморасчётов с НЕСКОЛЬКИМИ контрагентами): each table row = one output row; skip "Итого" / "Сальдо" / separators.
- Number format: digits + one dot, no spaces/currency. Empty = "0".
- Date = срок оплаты only. NOT issue date / oborot date. Empty string "" if missing.

---

## Current state (as of 2026-06-27)

**AI path is live and verified end-to-end.** Production at `credit-debit-swart.vercel.app` answers `/api/extract` correctly. Tested with акт сверки ORGANIK → 1 row, 1 238 047 ₸.

### Provider switch (2026-06-27)
Moved off Vercel AI Gateway → direct Anthropic API. Reason: user has Anthropic credits and prefers direct billing. Env var renamed `AI_GATEWAY_API_KEY` → `ANTHROPIC_API_KEY`. Provider package: `@ai-sdk/anthropic@ai-v6` (3.0.88) — the stable `4.x` line targets ai-sdk v5 spec and breaks at runtime with `ai@6`. Always pin to the `ai-v6` dist-tag.

### Routing fix (2026-06-27)
Акт сверки PDFs now force the AI path. `parsePdfFile()` detects markers (`акт сверки взаимных расчётов`, `задолженность по состоянию на`, `нижеподписавшиеся`, …) and throws, which triggers the confirm-dialog → `/api/extract`. Without this, pdf.js text-layer parsing read the mirrored Debit/Credit columns as separate contractors with doubled amounts (40 fake contractors × duplicated sums → quadrillion-scale total).

### parseNumber guard (2026-06-27)
`parseNumber()` in `index.html` detects "X X" pattern where the two halves are equal (e.g. `"120 960,00 120 960,00"` — Debit + Credit columns concatenated by AI) and keeps only the first half. Real thousand-separated numbers (`"1 234 567,00"`) are unaffected because they tokenize to an odd count.

---

## Discussed plans (not yet implemented)

| Proposed | Current | Decision |
|---|---|---|
| User-entered API key in UI (localStorage) + server env fallback | Server env only | Pending — adds CORS / browser-key-leak considerations |
| Client-side `pdf.js → canvas → PNG → {type:'image'}` | Send PDF blob as `{type:'file'}` to Claude | **Don't do this.** Claude's PDF support uses text layer + vision; rasterizing first loses text quality. Only switch if there's a concrete reason (e.g. > 32 MB PDFs, or moving off Claude file API). |
| Add `document_number` to extracted fields | Not extracted | Pending — trivial: add to zod schema + prompt. |

---

## Vercel project info

- Project ID: `prj_t8y6bi6vAm50ns772TxpR3nyNxPJ`
- Team ID: `team_aPHaO2CdcshD1kAwsLJUHyUG`
- Production domain: `credit-debit-swart.vercel.app`
- Node runtime: 24.x
- Function `api/extract.js`: `runtime: 'nodejs'`, `maxDuration: 90`
- Runtime log retention: 1h (Hobby plan) — production debugging requires reproducing the error live or upgrading plan.

---

## Conventions

- Money: integer tenge in storage, `formatMoney()` adds `₸` + thousand spaces for display.
- Dates: stored as ISO string in localStorage, parsed back with `new Date()`.
- Days overdue recomputed on every page load (`bootstrap` block at end of IIFE) since "today" changes.
- Status: `overdue` (date < today), `warning` (≤7 days to due), `ok` (else).
- Toast: 3.5s, kinds `error` / `success` / default.
- Tables: client-side search + sort, no pagination.
- All persistent state in two localStorage keys: `vzaimoraschety_v1` (records), `vzaimoraschety_company_v1` (company name + БИН).

---

## What NOT to do

- Don't split `index.html` into modules — there's no bundler. Keep it inline.
- Don't add `package.json` build scripts that aren't no-ops — Vercel runs `npm install` for the function but the static site is just `index.html`.
- Don't change the response shape from `/api/extract` (`{headers, rows, _meta}`) — frontend's column-mapping flow depends on it matching xlsx output.
- Don't commit `.vercel/` (already in `.gitignore`).
- Don't replace pdf.js text extraction with AI for text-based PDFs — local parsing is free and instant for оборотно-сальдовая reports.
