# Zoho CRM ⇄ Rivhit (רווחית) — Integration Design

Design repository for a **Zoho CRM Sigma extension** that integrates Zoho CRM with the
**Rivhit Online** accounting system (customers, items, tax documents, receipts) and with
**iCredit**, Rivhit's credit-card payment gateway.

> **Status: design only.** This repo currently contains no implementation code — it defines
> the actions, flows, data model, and platform constraints that the implementation must
> follow. Nothing here has been run against a live Rivhit account.

Publisher: **1T Solutions and Experts**
Proposed extension namespace: `rivhitzohocrmextension`

---

## Read in this order

| Doc | What it answers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it's built: components, trust boundary, data model, CRM fields, platform constraints |
| [`docs/FLOWS.md`](docs/FLOWS.md) | What it does: every user action and background flow, step by step |
| [`docs/API-NOTES-RIVHIT.md`](docs/API-NOTES-RIVHIT.md) | Distilled Rivhit + iCredit API reference, and an explicit list of what we could not verify |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Install-time checklist: custom fields, org variables, functions, scopes, schedules |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Delivery phases, risk register, open questions needing a decision |

## The five decisions that shape everything else

1. **The Rivhit API token never reaches the browser.** Every Rivhit call runs inside a
   Deluge function; widgets talk only to those functions. Rivhit's credential is a single
   static, non-expiring, unscoped token that can issue legally binding tax documents —
   it does not belong in widget JavaScript. This is the main deliberate departure from
   the Green Invoice bridge.

2. **Issuing a document is idempotent by construction.** Every issue call carries a
   deterministic `request_reference` plus `prevent_duplicates=true`, and any ambiguous
   failure is resolved with `Status.LastRequest` rather than a retry. Duplicate tax
   documents are an accounting problem, not a bug — and each one costs money (see #3).

3. **Document issuance is metered and billed.** Rivhit charges by monthly document volume
   (0 free, then ~₪19/50 up to ~₪119/1000, ex-VAT). Read operations are free. So the design
   never blind-retries a write, and surfaces a monthly issuance counter.

4. **Nothing about the document model is hardcoded.** Document types, receipt types,
   payment types, and the VAT rate are all per-company and are discovered at runtime via
   `Document.TypeList`, `Receipt.TypeList`, `Payment.TypeList`, and `Accounting.VatRate`.
   Published examples already disagree with each other on payment-type codes.

5. **The IPN endpoint is public, so it trusts nothing.** Every iCredit notification is
   re-verified against iCredit's own `/Verify` endpoint, matched on amount, and de-duplicated
   on `SaleId` before it is allowed to change a CRM record.

## Sources this design is built on

- `Rivhit Online REST Service API` v2.0.1.1 (vendor PDF, 16/07/2015) — supplied
- `iCredit Payment Gateway Implementation` (vendor PDF, English) — supplied
- Endpoint names beyond the 2015 PDF (`Document.Details`, `Document.NewExtended`,
  `Receipt.Details`, `Document.Copy`, `Receipt.PostponedList`, `Company.SetStartNumber`,
  document *closing*, iCredit `ChargeSimple`/tokenisation) were identified from public
  search indexes of `rivhit-api.readme.io` and the live WCF help page. **Both hosts are
  blocked by this environment's network egress policy**, so their parameter lists could not
  be read first-hand — see the "Unverified" section of `docs/API-NOTES-RIVHIT.md`.
- Zoho Sigma/Deluge platform behaviour: the `morning-invoice-bridge` repository
  (Green Invoice extension by the same publisher), whose audit and deployment docs record
  the platform's failure modes in detail.
