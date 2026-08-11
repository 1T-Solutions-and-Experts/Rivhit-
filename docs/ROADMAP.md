# Roadmap, risks, and open questions

**Revision 2.** Phase 3 is no longer gated on an unknown — the closing model is documented
and verified. A new compliance workstream (confirmation numbers) has been added to Phase 2.

## 1. Delivery phases

Each phase is independently shippable. Read-only value lands before anything can issue a
billable, irreversible legal document.

### Phase 0 — Foundations
Repo skeleton, `build.py` with the test gate, `rv-api.js` shell, manifest, custom fields, org
variables, `rv_save_settings`, `rv_lookup`, settings widget, connection test, type discovery
and mapping — **including the VAT/exempt sort codes** (flows A1–A2).

**Done when:** an admin can connect, see the business name and live VAT rate, map document
types, payment types and sort codes, and have all of it survive a reload. Nothing can issue a
document yet.

### Phase 1 — Master data
Customer upsert ladder with the 9-character `acc_ref` surrogate, balances via `Customer.List`,
product/item sync, stock pull (B1–B4).

**Done when:** syncing the same account twice updates rather than duplicating — proven by a
regression test *and* on the demo account — and an `acc_ref` match is verified against name
and tax id rather than trusted.

### Phase 2 — Document issuance and compliance
`rv_issue_document` with the `check_only` → real → recover sequence, the idempotency key,
`rv_recover_request`, the issue widget with its preflight and confirmation, the audit note,
the monthly usage counter (C1, C4).

**Plus, new in this revision:** confirmation numbers (C5) — the field, the status, the
`Document.InvoiceApproval` retry, and the AR exception. For a business in the חשבוניות ישראל
regime this is not an enhancement; an invoice without an allocation number may leave the
customer unable to deduct input VAT.

**Done when:** a browser tab killed mid-issue never produces a second tax document, an invalid
payload is caught by `check_only` without spending a billable issuance, and a missing
confirmation number is visible and retryable rather than silent.

### Phase 3 — Receipts, closing, cancellation, reconciliation
`rv_issue_receipt` with `closed_document_*` + `document_is_receipt`, the `Rivhit_Receipts`
module, `rv_close_document` (retroactive, partial, and manual settlement, plus Reopen),
`rv_cancel_document` (with the mandatory `Receipt.Cancel` pair for Invoice-Receipt types),
`rv_reconcile` on `Customer.OpenDocuments`, single-invoice refresh via `Document.Details`
(C2, C2b, C3, E1, E2).

**No longer gated.** Revision 1 held this phase behind a spike because the closing mechanism
was unverified. It is now documented end to end, so the phase can be planned normally.

**Done when:** cancelling an Invoice-Receipt reverses both halves, and a receipt entered
directly in the Rivhit UI is reflected in CRM by the next scheduled run.

### Phase 4 — iCredit payments
`rv_icredit_get_url`, the payment-link widget, **two** public endpoints (success and failure)
with all four checks, and the `ICredit_Issues_Document` either/or plus its
setting-vs-reality mismatch check (D1, D2).

**Done when:** a replayed notification is absorbed silently, an amount-mismatched one is
rejected without touching the invoice, a failed charge lands on the failure endpoint and marks
nothing paid, and exactly one tax document exists per charge in each mode.

### Phase 5 — Reporting
AR aging built on `Customer.OpenDocuments` (Rivhit's own דו"ח גיול חובות) plus the exceptions
section, with explicit pagination and visible caps (E3).

### Phase 6 — Optional, decide later
iCredit tokenisation, recurring sales, pending/J5, refunds, 3DS, Google/Apple Pay, PIN-pad.
Rivhit `Accounting.AddJournal` and the reporting endpoints (`PnLReport`, `VatReport`,
`JournalsReport`, `Customer.JournalReport`). `Document.NewExtended`, price lists,
multi-warehouse, multi-currency.

## 2. Risk register

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Duplicate tax documents from a retried or ambiguous write | Legal/accounting problem, plus a billed issuance | `request_reference` + `prevent_duplicates` + `Status.LastRequest`; reference written to CRM *before* the call; no auto-retry on any write |
| R2 | Static, unscoped, non-expiring `api_token` leaks | Attacker can issue documents, **delete customers**, post journal entries, and renumber document series via `Company.SetStartNumber` | Token never leaves Deluge; widgets call named functions only; escape every rendered string; secret never echoed into the settings form |
| R3 | Public IPN endpoint spoofed | Invoices marked paid without payment | Four mandatory checks: `Verify`, token match, replay guard, amount match |
| R4 | ~~Closing mechanism unverified~~ | — | **Closed.** `closed_document_*`, `document_is_receipt`, `Document.Close`/`Reopen` and per-line partial closing are all documented and captured in the design |
| R5 | Double issuance when iCredit issues documents itself | Customer receives two tax documents for one payment | `ICredit_Issues_Document` either/or; the setting is on the iCredit page and unreadable by API, so the first test charge cross-checks it and the widget flags a mismatch |
| R6 | Hardcoded document / payment / sort / VAT codes | Wrong document type, payment method, or VAT treatment on a legal document | Runtime discovery from every TypeList plus `Accounting.SortCodeList` and `Accounting.VatRate`; unmapped intents disable their action |
| R7 | Totals disagree with Rivhit's arithmetic | Rejected issuance | `price_include_vat: true` with gross prices so items equal payments by construction, **plus** a free `check_only` dry run before every billable call |
| R8 | Monthly issuance quota exceeded unnoticed | Surprise billing or refused issuance | Counter + pre-issue warning. ⚠ The tier prices are only in the 2015 PDF and are not published online — confirm commercially |
| R9 | Zoho silently ignores unknown field keys in an update | Writes "succeed" while persisting nothing | Runtime field-name resolution for plain **and** namespaced names; read back after write; drop-and-retry helper that logs every dropped field |
| R10 | Deluge and JS implementations of money logic drift | Two behaviours for one rule, both shipped | Money logic in Deluge only; widgets render what the function returns |
| R11 | Rate limits unknown | Throttling mid-batch | ⚠ Confirmed: **nothing is documented** across all 150 doc pages. Sequential loops, resumable batches, ask the vendor |
| R12 | IPN cannot be acknowledged within 1.25s | Resend storms, repeated processing | ⚠ **New.** Treat duplicate deliveries as normal: replay guard first, every path returns a top-level value, never throw |
| R13 | Source of truth drifts out of git | The Green Invoice extension's worst finding, repeated | Every Deluge body versioned here |
| R14 | Missing Tax Authority confirmation number | ⚠ **New.** Compliance defect — the customer may be unable to deduct input VAT | Field + status + AR exception + `Document.InvoiceApproval` retry; deployment check that the Tax Authority link is enabled **under the token's own user account** |
| R15 | Cancelling only half an Invoice-Receipt | ⚠ **New.** Books left half-reversed | The cancel flow detects `is_invoice_receipt` and issues `Document.Cancel` **and** `Receipt.Cancel` as one unit of work |
| R16 | `Document.List` called without a date range | ⚠ **New.** Silently returns only today's documents; reconciliation appears clean while missing everything | Always send explicit `from_date`/`to_date`; covered by a unit test |
| R17 | Testing against production | ⚠ **New.** There is no sandbox host — a mis-set token issues real legal documents | `Account_Mode` is shown prominently in every write widget; production mode requires an extra confirmation |

## 3. Open questions

**Nine of the ten were answered on 2026-08-11** — see [`DECISIONS.md`](DECISIONS.md) for the
answers and what each one changed. Summary: all document types supported via a catalog rather
than a fixed map; confirmation numbers in scope; iCredit contracted **and** issuing documents
itself; Sales Orders and Invoices both host the flows; Hebrew default; multi-currency with a
per-document stock toggle; one company; private now with Marketplace intent.

Still open, none of them blocking:

1. **Expected monthly document volume, and the tier actually in force.** The 2015 tiers are
   not in the current documentation and may be stale or absorbed into the subscription.
   `Monthly_Doc_Quota` ships unset — the counter displays, no threshold fires — until this is
   known.
2. **Which type in the account is the order type, and which is the credit type.** Answered by
   the admin at setup from the type catalog, not by us in advance.
3. **Rate limits** — undocumented across all 150 vendor pages. Ask `api@rivhit.co.il`.
4. **`Status.LastRequest` retention window** — how long recovery stays possible.

## 4. What this design deliberately does not do

- **No writes from widget JavaScript to Rivhit.** Slower to iterate on; the credential model
  does not allow it.
- **No `ChargeSimple` / card fields in a widget.** Card data in a browser widget cannot meet
  PCI requirements, and iCredit's own guidance reserves direct payment for locally installed
  applications. The hosted payment page is the only supported path here.
- **No journal entries in v1.** Highest consequence, lowest demand.
- **No adaptive retry on totals.** With `check_only` available for free, guessing is not just
  risky but unnecessary.
- **No client-side COQL or `searchRecords`.** Unavailable in the embedded widget SDK.
- **No optimistic "assume it worked" UI.** Every write is confirmed by reading back what was
  persisted, and any dropped field is shown to the user.
