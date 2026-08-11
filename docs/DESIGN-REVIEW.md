# Design review — self-audit

A deliberate pass over the whole design looking for what would fail in production rather than
what reads badly on the page. Findings are ordered by severity. Each carries a fix; the three
that are genuine business calls are marked **needs a decision**.

---

## Critical — would break in production

### C1. `check_only` may consume the idempotency key

The safe-write sequence is: dry run → real call with `request_reference` + `prevent_duplicates`.
**If Rivhit registers the reference during the dry run, the real call is refused as a
duplicate** and the document is never created — while the UI reports "already issued". The
central safeguard would silently become the failure.

This is unverified either way, and it is the sharpest risk in the design because everything
else leans on that sequence.

**Fix.** Never send `request_reference` or `prevent_duplicates` on a `check_only` call. The dry
run is a pure validation of shape and arithmetic; idempotency belongs only to the call that
can actually create something. Encoded as a hard rule in `rv_issue_document`, and asserted by
a unit test on the payload builder so it cannot regress.

**Confirm on the demo account as the very first Phase-2 test**, and in the vendor question
list.

### C2. Concurrent duplicate IPNs can both pass the replay guard

Deluge has no locks or transactions. The guard is "has this `SaleId` been recorded?" — two
near-simultaneous deliveries both read *no*, then both write. Given that a Zoho REST function's
cold start alone can exceed iCredit's 1.25-second budget, near-simultaneous retries are not a
rare edge case; they are the expected traffic pattern.

The consequence is a double receipt, and in `ICredit_Issues_Document = false` mode a double
*document*.

**Fix — use the platform as the mutex.** Zoho CRM custom fields support a **unique** constraint.
Make `ICredit_Sale_ID` a unique Single Line field on `Rivhit_Receipts`, and make *claiming it*
the handler's first write, before any Rivhit call:

```
1. attempt to create a Rivhit_Receipts stub with ICredit_Sale_ID = <SaleId>
     └─ rejected by the unique constraint → already being processed → return 200 OK, stop
2. only the winner proceeds to Verify / token / amount checks
3. on success, fill the stub in; on failure, mark it Rejected (never delete — deleting
   would re-open the race for the next retry)
```

The claim is atomic at the platform level, which is the only kind of atomicity available here.

### C3. Deluge execution ceilings versus the loops

Zoho caps both the number of `invokeurl` calls per function execution and total runtime, and
the ceiling is low — tens of calls, not hundreds, and it varies by edition. The design has
three loops that will cross it at real volume:

- `rv_reconcile` — one `Document.Details` per newly closed document
- the customer mass-action sync — up to one or two calls per selected record
- the product sync and stock pull

The design says "keep loops sequential", which is right for rate-limit safety and completely
silent about the ceiling. At a few hundred records these functions will time out mid-run,
leaving a partial sync with no record of where it stopped.

**Fix — cursor-based, resumable batches.**

- A `Rivhit_Sync_State` singleton record (or an org variable holding JSON) stores the last
  processed position per job: last document number, last customer id, last run timestamp.
- Every batch job processes a **bounded** batch — sized from the measured per-call cost, with a
  conservative default — persists the cursor, and reports `processed / remaining`.
- `rv_reconcile` re-runs until the cursor clears; the 6-hourly schedule picks up where the
  previous run stopped rather than restarting.
- Mass actions show progress and a **Continue** button rather than pretending one click covers
  1,000 records.
- Never report "synced" when the cursor is non-empty. Partial completion is stated.

Establish the actual limit for the org's edition during Phase 0 and record it in the deployment
doc; do not guess it in code.

### C4. `Customer.OpenDocuments(customer_id: 0)` is unbounded

The reconciliation backbone fetches *every* open document in the business in one call. For a
business with thousands of open documents that risks the `invokeurl` response ceiling and the
function's memory, and it fails all-or-nothing — exactly when the data matters most.

**Fix.** Bound every call: chunk by `from_date`/`until_date` in rolling windows, optionally by
`document_type`, and accumulate across calls under the C3 cursor. Cap the total and **state the
cap on screen** in the AR report — a silently truncated receivables report reads as less debt
than you have. Whether the endpoint supports real pagination is in the vendor question list.

---

## Significant — would produce wrong output or wrong behaviour

### S1. Fractional quantities break the payments-equal-items invariant

The rule is "round each line to 2 dp and make the payments total equal the items total". With a
fractional quantity that is not sufficient: `0.5 × 33.33 = 16.665`. Rivhit computes its own
total from unit price × quantity, so ours can differ in the third decimal and the document is
rejected with a mismatch — on a payload that looks correct.

**Fix, in two parts.**

1. Compute the line total the way Rivhit does — unit × quantity — and round **once**, at
   document level, rather than per unit price.
2. **An adaptive loop is now legitimate, because it runs against `check_only`.** Revision 2
   forbade adaptive retry on totals, and that ban stands for real calls, where every attempt is
   billable and may create a legal document. A dry run costs nothing and creates nothing, so
   converging on the accepted total *before* the real call is free. Cap the loop at a small
   number of iterations and surface the arithmetic if it does not converge.

That distinction — adaptive at validation time, never at issue time — should be written into the
code comments, because it looks like a contradiction to anyone who reads only one of the rules.

### S2. Zoho's line-item model is not mapped to Rivhit's

The design says "items from CRM line items" and never confronts that the two systems model
lines differently:

| Zoho `Product_Details` | Rivhit item |
|---|---|
| `list_price`, `quantity` | `price_nis` / `price_mtc`, `quantity` |
| per-line `Discount` | `bruto_price_nis` (before) + `price_nis` (after) |
| per-line `Tax` | *no equivalent* — Rivhit derives VAT from `sort_code` + `price_include_vat` |
| record-level `Discount` | `discount_type` + `discount_value` |
| `Product_Name`, `Product_Code` | `description` (≤100), `catalog_number` (≤15) |

The mapping is lossy in both directions, and per-line discount display has documented
preconditions in Rivhit (a specific document format, no foreign currency, no English document).

**Fix.** Define one canonical mapping and make anything it cannot express an **explicit refusal**
rather than a silent distortion:

- per-line discount → `bruto_price_nis` + `price_nis`, with a fallback to a discount line item
  when the document format does not support per-line display
- record-level discount → `discount_type` / `discount_value`
- Zoho per-line tax → **ignored by design**, because Rivhit derives VAT from the document's
  `sort_code`; a record with mixed per-line tax rates is refused with a clear reason
- golden-payload fixtures for each shape, so the mapping cannot drift

### S3. Multi-currency was never wired into the iCredit path

Multi-currency was specified for `Document.New` and forgotten for payments. `GetUrl` has its own
`Currency`, `ConvertToNIS` and `ExchangeRate`. A USD invoice must produce a USD payment page and
a USD document — and the iCredit page has its own configured currency set that may not include it.

**Fix.** Pass the record's currency and rate into `GetUrl`; block the payment-link button with an
explicit reason when the record's currency is not one the payment page accepts, rather than
letting it silently charge in shekels.

### S4. Card instalments versus payment status — **needs a decision**

A 12-instalment card sale is settled with Rivhit and the customer immediately, but the cash
arrives over a year. `Rivhit_Payment_Status = Paid` on authorisation is correct from the tax
document's point of view and misleading from a cash-flow point of view.

**Options.** (a) Paid on authorisation — simplest, matches the document. (b) Paid, plus
`Rivhit_Instalments_Remaining` and an expected-cash column in the AR report. (c) Partially Paid
until instalments complete — accurate on cash, but contradicts the receipt.

Recommendation: **(a) for the payment status, with (b)'s extra field** so the AR report can show
expected cash without lying about the document. Needs confirmation.

### S5. The CRM record drifts after issuance

A Rivhit tax document is immutable. The CRM invoice it came from is not — anyone can edit line
items afterwards, and the two silently diverge with no indication which is authoritative.

**Fix.** Store a hash of the issued payload in `Rivhit_Issued_Hash`. On every widget open,
recompute and compare; on mismatch show *"this record has changed since it was issued in
Rivhit"* with the differing fields, and offer only the legitimate paths — cancel and re-issue,
or revert the record. **Needs a decision** on whether to go further and lock the record's line
items after issuance via a validation rule; that is more correct and more intrusive.

### S6. `Custom1` must carry the module, not just the id

Documents now originate from Sales Orders *and* Invoices, so a bare record id is ambiguous in
the IPN. Use `Invoices:554023000000123456` / `Sales_Orders:554023000000123456`. `Custom1` is
unbounded, so there is no cost to the prefix.

### S7. Three systems all think they should email the customer

`send_mail` defaults to **true** on `Document.New`. iCredit emails on successful payment. The
iCredit page can also email the document it issues. On the card path a customer can plausibly
receive three messages for one purchase.

**Fix.** One owner of customer email per path, chosen in settings and stated in plain language:
on the card path iCredit owns it and the extension sends `SendMail` accordingly; on the manual
path Rivhit owns it. Never both, and the settings screen shows which is active.

---

## Worth fixing

### W1. A second, independent recovery path

Everything currently depends on `Status.LastRequest`, whose retention window is unknown. Two
independent answers to "did this actually get created" already exist in the API:

- `Document.Last` — the last document produced, comparable against the intended one
- `Document.List` with `filter_fields` on `reference`

`reference` (אסמכתא) is an integer up to 999999999. Setting it to a numeric derivative of the
CRM record id makes every document searchable by its origin, which is useful for recovery *and*
for the reconciliation's unlinked-document detection. Cheap to add, and it removes a single
point of failure.

### W2. The retry rule needs stating explicitly

Two failure classes need opposite responses, and conflating them causes either duplicate
documents or stuck records:

- **Business validation failure** (negative `error_code`) — deterministic, created nothing.
  Safe to correct the payload and retry under a **new** revision.
- **Ambiguous failure** (timeout, unparseable, HTML error page) — must go to recovery and
  **reuse** the same reference.

Write it in the code, not only in the docs. Whether `prevent_duplicates` registers a reference
on a failed call is in the vendor question list; until answered, assume it might and bump the
revision after business failures.

### W3. Token rotation is silent

Regenerating the token in Rivhit breaks every flow at once with no signal until a user hits an
error. **Fix:** `rv_reconcile` performs one cheap authenticated read at the top of each run; on
auth failure it writes a visible "credentials rejected" state that the settings widget surfaces
as a banner, and notifies the admin. Cheap, and turns a mystery outage into a message.

### W4. Hebrew through Deluge `invokeurl`

Hebrew payloads through `invokeurl` are a classic encoding failure — mojibake in the customer
name printed on a legal document. Set the charset explicitly, and put a Hebrew round-trip case
(customer name, item description, comment) in the test harness rather than discovering it on a
real invoice.

### W5. The demo account cannot validate role mapping

The demo account's type catalog is not the client's, so role mapping and per-type behaviour
cannot be meaningfully tested there. **Fix:** after connecting the production token, run a
`check_only` pass over one document of each mapped role. It is free, uses the real catalog, and
creates nothing — a production dress rehearsal with no consequences.

### W6. Anyone with the button can issue a tax document — **needs a decision**

The design never restricts who may click Issue or Cancel. Both create legally binding, billable,
irreversible documents.

Recommendation: restrict the issue, cancel and payment-link widgets to selected profiles,
defaulting to Administrator plus a Finance profile, configurable in settings. Read-only widgets
(refresh, AR report) stay open to everyone. Needs confirmation of the profile list.

---

## Consolidated vendor questions

To send to `api@rivhit.co.il` in one message:

1. How long is a `request_reference` retained and retrievable via `Status.LastRequest`?
2. Does `check_only: true` register the `request_reference` when `prevent_duplicates: true` is
   also sent? *(C1)*
3. Does `check_only` return the computed document `amount`, or only pass/fail? *(S1)*
4. Are there request-rate limits — per second, minute or day?
5. Does `prevent_duplicates` register a reference when a call fails validation, or only on
   success? *(W2)*
6. Does `Customer.OpenDocuments` support pagination, or is a date/customer range the only way to
   bound the response? *(C4)*
7. Are the document-volume pricing tiers still in force, and what are the current figures?

## Changes this review makes to the plan

- **Phase 0** gains: establishing the org's Deluge execution limits, and the `Rivhit_Sync_State`
  cursor infrastructure that every later batch job depends on.
- **Phase 2** gains: the C1 verification as its first test, the S1 adaptive dry-run loop, the S2
  line-item mapping with golden fixtures, and `Rivhit_Issued_Hash` drift detection.
- **Phase 3** gains: resumable reconciliation and bounded `OpenDocuments` windows — these are
  not optimisations, they are what makes the phase work at all beyond demo data.
- **Phase 4** gains: the unique-field IPN claim, currency pass-through, and the email-ownership
  setting.
- New fields: `Rivhit_Issued_Hash`, `Rivhit_Instalments_Remaining` (pending S4), and the
  `ICredit_Sale_ID` **unique** constraint on `Rivhit_Receipts`.
