# Build state — resume here

Implementation started 2026-08-11. Design is complete and frozen; this tracks the code.

Branch: `claude/zoho-rivhit-integration-design-jvuppp`
Version marker in progress: **`V1.0-r1`** (must match across `rv-api.js`, every widget,
`plugin-manifest.json` and the zip name once `build.py` exists).

---

## Done

| File | What it is |
|---|---|
| `app/plugin-manifest.json` | 15 widget registrations (both Sales Orders and Invoices), 16 scopes incl. `settings.profiles.READ` + `users.READ` |
| `app/rv-styles.css` | RTL-first shared stylesheet, light/dark-neutral, `bdi.ltr` for document numbers |
| `app/rv-api.js` | Shared widget client: Deluge bridge, envelope unwrapping, runtime field resolution, i18n (he default), bidi helpers, currency/date formatting, permission gating (UX layer), `crmUpdateResilient`, widget bootstrap |
| `functions/rv_lookup.deluge` | Read-only whitelist + `op:settings` + `op:types` catalog refresh + `op:profiles` |
| `functions/rv_save_settings.deluge` | Org-variable persistence, blank-secret-keeps-existing, **no-self-lockout guard**, write-then-readback verification |
| `functions/rv_issue_document.deluge` | The core write. Type flags from catalog, line-item mapper with line-total rounding, inline customer matching, **dry run without the idempotency key (review C1)**, key persisted before the call, ambiguity → recover, confirmation-number capture, snapshot, audit note, usage counter |
| `functions/rv_issue_receipt.deluge` | Receipt that closes the source document (`closed_document_*` + `document_is_receipt`), same safe-write sequence, `Rivhit_Receipts` child row, `internal:true` bypass so the IPN handler can call it |

## Remaining

**Deluge functions (11)**

- `rv_close_document` — `Document.Close` / `Reopen`; manual settlement (`closing_type:0`)
- `rv_cancel_document` — `Document.Cancel`, **plus `Receipt.Cancel` when the type is
  invoice-receipt** — both as one unit of work
- `rv_confirmation` — `Document.InvoiceApproval` retry for a missing allocation number
- `rv_recover_request` — `Status.LastRequest`, with `Document.List` + `filter_fields` on
  `reference` as the independent second path (review W1)
- `rv_upsert_customer` — the five-rung ladder, 9-char `acc_ref` surrogate, verified on match
- `rv_sync_products` — `Item.*`, cursor-batched
- `rv_reconcile` — scheduled; `Customer.OpenDocuments` windowed, cursor-resumable (review C3/C4),
  instalment progress from the document's payment rows, token health check (review W3)
- `rv_icredit_get_url` — `GetUrl` with currency pass-through, both IPN URLs, `Custom1` =
  `Module:recordId`
- `rv_icredit_ipn` — **claim `ICredit_Sale_ID` on the unique field first** (review C2), then
  Verify → token → replay → amount; records the iCredit-issued document, then `Document.Details`
  for the confirmation number
- `rv_icredit_ipn_failure` — records declined attempts, changes nothing else
- `rv_log_change` — workflow-triggered drift note (Automation category, record argument)

**Widgets (9)** — `settings` (largest: connection, catalog, roles, payment map, iCredit,
permissions matrix), `issue_document`, `record_payment`, `payment_link`, `refresh_status`,
`cancel_document`, `customer_sync`, `product_sync`, `ar_report`

**Tooling** — `build.py` (validate → `node --test` gate → inline shared assets → syntax-check
every inline block → zip), `tests/` (the pure functions in `rv-api.js`: `_resolveOne`,
`_unwrap`, date conversion both ways, currency, `acc_ref` surrogate, permission evaluation,
`esc`), and `docs/SIGMA-DEPLOYMENT.md` — the full click-by-click Sigma guide.

---

## Conventions already established — keep these

- **Deluge functions are self-contained.** Sigma has no shared library, so the ~45-line
  argument-extraction prologue is copy-pasted verbatim into every function. Keep it identical;
  `build.py` should assert that.
- **Envelope:** every function returns `{ok, code, message, data}` as a JSON string, and always
  from a guaranteed **top-level** `return` — a return inside `try/catch` does not compile.
- **Field resolution:** scan the fetched record's own keys with `endsWith("Rivhit_...")` rather
  than assuming plain or namespaced names.
- **Two-stage CRM writes:** critical fields first, timestamps and long text in a separate
  best-effort call, because one rejected field kills the whole update.
- **Hebrew is the default**; every user-facing string in the functions is Hebrew
  (`client_message` passes straight through), and the docs stay English.
- **Never send `request_reference` / `prevent_duplicates` on a `check_only` call.**
