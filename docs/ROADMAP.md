# Roadmap, risks, and open questions

## 1. Delivery phases

Each phase is independently shippable and independently useful. Read-only value lands before
anything can issue a billable, irreversible legal document.

### Phase 0 — Foundations
Repo skeleton, `build.py` with the test gate, `rv-api.js` shell, manifest, custom fields,
org variables, `rv_save_settings`, `rv_lookup`, settings widget, connection test, type
discovery and mapping (flows A1–A2).

**Done when:** an admin can install, connect, see the live VAT rate, map document and payment
types, and have all of it survive a reload. Nothing can issue a document yet.

### Phase 1 — Master data, read-only outward
Customer upsert ladder with the `acc_ref` back-pointer, `Customer.Balance`, product/item
sync, stock pull (B1–B4).

**Done when:** syncing the same account twice updates rather than duplicating — proven by a
regression test *and* on the demo account. This is the phase that quietly earns trust; get
the dedup ladder wrong and the customer's books fill with duplicates.

### Phase 2 — Document issuance
`rv_issue_document`, the idempotency key, `rv_recover_request`, the issue widget with its
preflight and confirmation, the audit note, the monthly usage counter (C1, C4).

**Spike first:** confirm on the demo account how totals and `price_include_vat` interact for
each mapped type, and capture golden payloads as test fixtures.

**Done when:** a killed browser tab mid-issue never produces a second tax document.

### Phase 3 — Receipts, closing, reconciliation
`rv_issue_receipt` with `closed_document_*`, the `Rivhit_Receipts` module, credit notes,
`rv_reconcile` and its schedule, single-invoice refresh (C2, C3, E1, E2).

**Spike first, and this one gates the phase:** confirm the exact `closed_document_type` /
`closed_document_number` parameters and the `Receipt.Details` closing-reference field names
(see [`API-NOTES-RIVHIT.md` §7](API-NOTES-RIVHIT.md#7-unverified--confirm-before-building-on-it)).
The whole settlement model rests on them and they are currently unverified.

### Phase 4 — iCredit payments
`rv_icredit_get_url`, the payment-link widget, the public `rv_icredit_ipn` endpoint with all
four security checks, and the `ICredit_Issues_Document` either/or (D1, D2).

**Done when:** a replayed IPN and an amount-mismatched IPN are both rejected without touching
the invoice, and exactly one tax document exists per charge in each mode.

### Phase 5 — Reporting
AR / open-balance report with reconciliation exceptions, explicit pagination and visible caps
(E3).

### Phase 6 — Optional, decide later
Card tokenisation and `ChargeSimple` recurring billing (D3); `Accounting.AddJournal`;
`Document.NewExtended` as an alternative to invoice-receipt types; multi-currency;
multi-warehouse inventory.

## 2. Risk register

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Duplicate tax documents from a retried or ambiguous write | Legal/accounting problem in Israel, plus a billed issuance | `request_reference` + `prevent_duplicates` + `Status.LastRequest` recovery; reference written to CRM *before* the call; no auto-retry on any write |
| R2 | Static, unscoped, non-expiring `api_token` leaks | Attacker can issue documents and post journal entries against the customer's books | Token never leaves Deluge; widgets call named functions only; escape every rendered string; secret never echoed into the settings form |
| R3 | Public IPN endpoint spoofed or replayed | Invoices marked paid without payment | Four mandatory checks: iCredit `Verify`, token match, `SaleId` replay guard, amount match |
| R4 | `closed_document_*` and `Receipt.Details` behave differently than assumed | Phase 3 settlement model is wrong | Gate Phase 3 on a demo-account spike before writing the code |
| R5 | Double issuance when iCredit is configured to issue documents itself | Customer receives two tax documents for one payment | `ICredit_Issues_Document` as an explicit either/or, stated in plain language in Settings |
| R6 | Hardcoded document / payment / VAT codes | Wrong document type or payment method on a legal document | Runtime discovery from the TypeLists and `Accounting.VatRate`; unmapped intents disable their action |
| R7 | Totals disagree with Rivhit's own arithmetic | `DIFFERENT_AMOUNT_BETWEEN_INVOICE_AND_RECEIPT`, blocked issuance, wasted attempts | Gross prices with `price_include_vat = true`, round per line before summing, validate server-side before sending, never adaptively retry |
| R8 | Monthly issuance quota exceeded unnoticed | Surprise billing or refused issuance | Counter + pre-issue warning against `Monthly_Doc_Quota` |
| R9 | Zoho silently ignores unknown field keys in an update | Writes "succeed" while persisting nothing | Runtime field-name resolution for plain **and** namespaced names; read back after write; drop-and-retry helper that logs every dropped field |
| R10 | Deluge and JS implementations of the same money logic drift | Two behaviours for one rule, both shipped | Keep money logic in Deluge only; widgets render what the function returns |
| R11 | Rate limits unknown | Throttling mid-batch, partial syncs | Sequential loops everywhere, resumable batches, ask the vendor |
| R12 | Reconciliation window misses late-entered payments | AR report understates | 35-day rolling window (configurable) plus the `Customer.Balance` cross-check to surface exceptions |
| R13 | Source of truth drifts out of git | The Green Invoice extension's worst finding, repeated | Every Deluge body versioned here; a function that exists only in Sigma does not exist |

## 3. Open questions — need a decision before Phase 2

Phases 0 and 1 can start without these. Phase 2 cannot.

1. **Which Rivhit document types does the business actually use?** Plain tax invoice, or
   invoice+receipt, or both? This decides whether the payments-equal-total invariant (R7) is
   on the critical path from day one.
2. **Is iCredit already contracted?** If not, Phase 4 drops and the design simplifies
   considerably.
3. **If iCredit is in use — does it already issue the tax document?** The single most
   consequential setting in the extension (R5).
4. **Expected monthly document volume?** Sets the quota tier and the warning threshold.
5. **Where do invoices originate — the Invoices module, or Deals / Sales Orders / Quotes?**
   Decides which modules get buttons and which scopes are requested. Scope changes force
   re-consent, so this should be settled before the first production publish.
6. **Hebrew or English as the default UI and document language?** RTL affects widget layout
   everywhere, so it is cheaper to decide now than to retrofit.
7. **Multi-currency?** If ILS-only, `currency_id` / `exchange_rate` / `*_mtc` handling drops
   out of the mapper.
8. **Inventory: should documents decrement stock?** Governs `storage_id`,
   `reject_item_quantity`, and `no_update_inventory`, and whether Phase 1's stock pull is
   real or cosmetic.
9. **One Rivhit company, or several?** Multi-company means per-company tokens and a company
   selector on every write — a structural change, not a setting.
10. **Private extension or Marketplace listing?** Marketplace raises the bar on manifest
    hygiene, escaping, privacy policy, and scope justification.

## 4. What this design deliberately does not do

- **No writes from widget JavaScript to Rivhit.** Slower to iterate on than the Green Invoice
  approach; the credential model does not allow it.
- **No journal entries (`Accounting.AddJournal`) in v1.** Highest-consequence, lowest-demand
  surface. Revisit only on a concrete request.
- **No adaptive retry on totals.** The Green Invoice bridge's `2422` handler retried with
  recalculated totals until one was accepted. Here every attempt is billable and may create a
  legal document, so a mismatch stops and reports.
- **No client-side COQL or `searchRecords`.** Unavailable in the embedded widget SDK; the
  widgets paginate `getAllRecords`, and Deluge does the querying.
- **No optimistic "assume it worked" UI.** Every write is confirmed by reading back what was
  persisted, and any dropped field is shown to the user.
