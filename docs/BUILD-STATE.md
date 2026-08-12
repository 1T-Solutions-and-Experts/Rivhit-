# Build state

**V1.0-r1 — feature complete, never executed.** Every file the design calls for exists and
the build is green. Nothing here has run against a live Rivhit account, a real Deluge
compiler, or a Zoho org.

Branch: `claude/zoho-rivhit-integration-design-jvuppp`

---

## What exists

```
app/
  plugin-manifest.json      15 widget registrations, 16 scopes
  rv-api.js                 shared client (inlined into every widget at build)
  rv-styles.css             RTL-first stylesheet
  widgets/                  9 widgets
    settings/               connection · catalog · defaults · iCredit · permissions
    issue_document/         dry run → confirm → issue, with recovery and drift banner
    record_payment/         receipt, or manual settlement / reopen
    payment_link/           iCredit GetUrl with the double-issue guard
    refresh_status/         one Document.Details call
    cancel_document/        typed confirmation, both halves for invoice-receipt
    customer_sync/          cursor-batched, Continue button
    product_sync/           cursor-batched, optional stock pull
    ar_report/              Customer.OpenDocuments + exceptions
functions/                  15 Deluge bodies
tests/rv-api.test.js        34 tests
build.py                    validate → hygiene → test gate → inline → zip
docs/SIGMA-DEPLOYMENT.md    click-by-click install
```

`python3 build.py` → `rivhit-bridge-V1.0-r1.zip` (126 KB).

## What the build gate enforces

Beyond the obvious (manifest valid, JS parses, marker present, every widget RTL):

- **No signature line** in any Deluge body — Sigma writes the wrapper, and a signature is a
  syntax error on the last line.
- **Every REST function carries the argument-extraction prologue.** Sigma has no shared
  library, so the ~45-line prologue is copy-pasted; the build asserts it rather than trusting
  discipline. Exempt: `rv_reconcile` and `rv_log_change` (no `crmAPIRequest`), and the two IPN
  endpoints (form-encoded vendor POSTs, not the widget's `arguments` wrapper).
- **No `addAll`** — unreliable on this platform.
- **A guaranteed `return`** in every body.
- **The C1 trap**: a `check_only` dry run must never set `request_reference` or
  `prevent_duplicates` before `check_only` is removed, and `check_only` must always be
  removed. If Rivhit registers the key during validation, the real call is refused as a
  duplicate and no document is ever created — the safeguard becoming the failure.
- **Tests must pass** or no zip is produced.
- Manifest and disk must agree on the widget list, both directions.

## Before this is trusted with real money

In order. Do not skip ahead.

1. **Paste `rv_lookup` and `rv_save_settings` into Sigma and get Settings connecting.**
   Nothing else can be tested until the config round-trips. Expect Deluge compile errors on
   first paste — the bodies have never seen a compiler.
2. **Answer C1 with the vendor** (`docs/DESIGN-REVIEW.md`): does `check_only` register the
   `request_reference` when `prevent_duplicates` is also sent? The build guards the *shape*
   of the call, but the assumption underneath is still unverified.
3. **Measure the org's Deluge integration-task ceiling.** `rv_reconcile` uses a
   `DETAIL_BUDGET` of 15 and the sync functions default to batches of 12; both are
   conservative guesses, not measurements.
4. Work the smoke test in `SIGMA-DEPLOYMENT.md` §14 on the demo account.
5. Only then §15, production.

## Known gaps

- **`Rivhit_Receipts` field API names are assumed.** The Deluge writes them directly
  (`Receipt_Number`, `Processing_State`, …) rather than resolving them at runtime the way the
  Invoice fields are resolved. If Zoho namespaces them on creation, those writes fail
  silently. Verify after step 4 of the guide and add resolution if needed.
- **`rv_lookup op:profiles`** tries a v5 REST call with a named connection, then falls back to
  `invokeConnector`. Neither path is verified; the permissions matrix degrades to a warning
  if both fail, and server-side enforcement continues on the stored config.
- **Instalment progress** is only refreshed by `rv_reconcile` and the refresh widget, so a
  card sale's `1/12` will not advance until the next scheduled run after each due date.
- **The AR report's exception scan** pages `getAllRecords` with a 5-page cap per module and
  states the cap on screen. Above ~1,000 records per module it under-reports, by design
  rather than silently.
- **No Hebrew round-trip test through `invokeurl`.** Encoding failures would show up as
  mojibake on a real invoice; worth an explicit test on the demo account.
