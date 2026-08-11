# Zoho CRM ⇄ Rivhit (רווחית) — Integration Design

Design repository for a **Zoho CRM Sigma extension** that integrates Zoho CRM with the
**Rivhit Online** accounting system (customers, items, tax documents, receipts) and with
**iCredit**, Rivhit's credit-card payment gateway.

> **Status: design only — revision 2.** No implementation code yet, and nothing here has been
> run against a live Rivhit account. Revision 2 is verified against the current vendor
> documentation and OpenAPI specs; revision 1 was based on a 2015 PDF that is substantially
> out of date.

Publisher: **1T Solutions and Experts**
Proposed extension namespace: `rivhitzohocrmextension`

---

## Read in this order

| Doc | What it answers |
|---|---|
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **The confirmed parameters** — what the client answered and what each answer changed. Authoritative where it disagrees with anything else. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it's built: components, trust boundary, data model, CRM fields, platform constraints |
| [`docs/FLOWS.md`](docs/FLOWS.md) | What it does: every user action and background flow, step by step |
| [`docs/API-NOTES-RIVHIT.md`](docs/API-NOTES-RIVHIT.md) | Verified Rivhit + iCredit reference, and the short list of what remains unconfirmed |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Install checklist: fields, org variables, functions, scopes, schedule, Rivhit-side prerequisites, acceptance tests |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Delivery phases, risk register, open questions |

## The six decisions that shape everything else

1. **The Rivhit API token never reaches the browser.** Every Rivhit call runs inside a Deluge
   function; widgets talk only to those functions. Rivhit's credential is a single static,
   non-expiring, unscoped token that can issue tax documents, delete customers, post journal
   entries and renumber a company's document series. It does not belong in widget JavaScript.

2. **Every billable write is dry-run first.** `check_only: true` asks Rivhit to validate the
   exact payload, free, creating nothing. Only then does the real call go out, carrying a
   deterministic `request_reference` and `prevent_duplicates`. Ambiguous failures are resolved
   with `Status.LastRequest`, never a retry.

3. **Issuance is metered; reads are free.** So the whole design pushes work onto reads —
   dry runs, `Customer.OpenDocuments`, `Document.Details` — and treats each real write as
   something to be spent deliberately.

4. **Nothing about the document model is hardcoded.** Document types, receipt types, payment
   types, VAT/exempt **sort codes** and the VAT rate are all per-business and discovered at
   runtime.

5. **The payment-notification endpoint trusts nothing — and expects duplicates.** iCredit
   demands a 200 OK within 1.25 seconds or it resends, which a Deluge function will often
   miss. Replay protection is therefore load-bearing for correctness, not only security.

6. **Tax Authority confirmation numbers are a first-class concern.** Under Israel's
   חשבוניות ישראל regime a qualifying invoice without an allocation number may leave the
   customer unable to deduct input VAT. It gets a field, a status, an exception report and a
   retry path — not a silent gap.

## What changed in revision 2

The vendor documentation hosts became reachable, so the design was re-verified against
`rivhit-api.readme.io` and its OpenAPI specs (all 150 pages retrieved 2026-08-11). The 2015
PDF turned out to describe a much smaller and partly different API.

**Corrections — revision 1 was wrong about these**

- **Dry runs exist.** `check_only: true` on `Document.New` / `Receipt.New` validates without
  creating. Revision 1 stated there was no preview and built total-prediction machinery
  around that gap.
- **Dates are `DD-MM-YYYY` / `DD/MM/YYYY`**, not `DDMMYYYY`.
- **`acc_ref` holds 9 characters.** Revision 1 proposed storing the 18–19 digit Zoho record id
  there as the reverse pointer. It cannot fit; a 9-character deterministic surrogate replaces
  it, and it is verified on match rather than trusted.
- **Error codes are negative integers** with Hebrew `client_message`, not string constants.
  HTTP 400 returns an HTML page, not JSON.
- **There is no sandbox host.** Test and production share one URL; you test with a test
  account, and the demo account is not connected to iCredit.
- **`sort_code` is the VAT switch** (100 with VAT / 150 exempt), not opaque metadata.
- **Cancellation is one call.** `Document.Cancel` issues the reversing credit document itself
   — but an Invoice-Receipt needs `Receipt.Cancel` as well, or the books are half-reversed.

**Resolved — the Phase 3 blocker is gone**

Revision 1 gated Phase 3 on an unverified closing mechanism. It is now fully documented:
`closed_document_type` / `closed_document_number` / `document_is_receipt` at creation,
per-item `closed_document_num` + `closed_document_line` for partial closing, `Document.Close`
retroactively (including manual settlement with `closing_type: 0`), and `Document.Reopen`.

**Rebuilt — reconciliation is far cheaper**

`Customer.OpenDocuments` returns the entire receivables position with **`paid_amount` per
document** in one free call; it is Rivhit's own debt-aging report. `Document.Details` returns
`is_closed`, `is_cancelled` and `receipt_total` for a single invoice. Revision 1's plan of
`Receipt.List` plus one `Receipt.Details` per receipt is gone.

**New**

- Tax Authority confirmation numbers (`confirmation_number`, `Document.InvoiceApproval`).
- The 1.25-second IPN budget and its consequences, plus a separate `IPNFailureURL` — without
  which failure notifications arrive at the success endpoint on every failed charge attempt.
- Field-length limits the mapper must truncate to, and `round_digits` semantics.
- Confirmation that **no rate limits are documented anywhere**, and that the document-volume
  pricing tiers are *not* published online — the 2015 figures are indicative only and need
  commercial confirmation.

## Sources

- `rivhit-api.readme.io` — full documentation set and OpenAPI specs, retrieved 2026-08-11.
  Start any future session at `https://rivhit-api.readme.io/llms.txt`, which indexes every
  page and spec.
- `Rivhit Online REST Service API` v2.0.1.1 (vendor PDF, 2015) — supplied; superseded, but
  the only source for the document-volume pricing tiers.
- `iCredit Payment Gateway Implementation` (vendor PDF) — supplied.
- Zoho Sigma/Deluge platform behaviour: the `morning-invoice-bridge` repository (Green Invoice
  extension by the same publisher), whose audit and deployment docs record the platform's
  failure modes in detail.
