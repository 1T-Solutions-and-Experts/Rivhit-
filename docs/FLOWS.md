# Actions and Flows

**Revision 2** — rewritten against the verified API. The changes are concentrated in C1
(dry-run preflight), C2/C3 (real closing and cancellation endpoints), the new C5
(confirmation numbers), D2 (the 1.25-second IPN budget) and E1 (one-call reconciliation).

Legend: **W** = widget (browser) · **D** = Deluge function (server) · **R** = Rivhit API ·
**IC** = iCredit.

---

## A. Setup

### A1 — Configure and test the connection
**Trigger:** admin opens the Settings tab.

1. **W** loads current settings via `rv_lookup{op:"settings"}` — secrets come back masked.
2. Admin enters `api_token` and company id, and picks production or the demo account.
   ⚠ There is no separate sandbox host: test and production share one URL and differ only by
   which account the token belongs to. The widget states this, so nobody assumes a safety net
   that does not exist.
3. **D** `rv_lookup{op:"ping"}` calls **R** `Company.Details` — proves the token works and
   returns the business name and id to display back as confirmation.
4. On success **W** runs A2 automatically.
5. **D** `rv_save_settings` persists and reads back to verify.

**Fails:** `error_code -1`/auth failure → "token rejected"; transport error → "cannot reach
Rivhit". Nothing is saved unless the readback matches.

### A2 — Discover and map types
**Trigger:** after a successful connection test, and from a **Refresh types** button.

1. **D** `rv_lookup{op:"types"}` calls **R** `Document.TypeList`, `Receipt.TypeList`,
   `Payment.TypeList`, `Accounting.SortCodeList`, `Currency.List`, `Payment.BankList`,
   `Accounting.VatRate`.
2. Cached in `Type_Cache` with a fetched-at stamp.
3. **W** renders mapping tables pre-filled by name matching:
   - CRM intent → Rivhit `document_type`
   - CRM `Payment_Method` values → Rivhit `payment_type`
   - ⚠ VAT / exempt **sort codes** (Rivhit defaults 100 / 150, per-business)
4. Admin adjusts and saves.

**Fails:** an unmapped intent disables the corresponding action with an explicit "not
configured" message, rather than issuing with a guessed type.

### A3 — Configure iCredit *(optional)*
Test/prod `GroupPrivateToken`, test mode, max/min payments, and — the decisive one —
**who issues the tax document** (`ICredit_Issues_Document`). The widget shows the generated
public IPN URL and a distinct **failure** IPN URL to paste into the iCredit back office, and
states which side will issue documents.

⚠ Because document issuance is an iCredit *page* setting the API cannot read, the first test
charge verifies it: if the IPN returns a `DocumentNum` while the setting says `false`, the
widget flags the contradiction rather than letting it produce duplicate tax documents in
production.

---

## B. Master data

### B1 — Upsert a customer (Account or Contact)
**Trigger:** the "Sync to Rivhit" mass action; also called inline when an invoice's customer
has no `Rivhit_Customer_ID`.

**D** `rv_upsert_customer` resolves through an ordered ladder — first hit wins, creation last:

```
1. Rivhit_Customer_ID on the CRM record        → Customer.Update
2. Customer.Get(acc_ref = <9-char surrogate>)  → verify name/tax id, then Customer.Update
3. Customer.Get matched on id_number / vat_number → Customer.Update
4. Customer.Get(email = ...)                    → Customer.Update
5. none matched                                  → Customer.New (acc_ref = surrogate)
```

⚠ The surrogate replaces revision 1's "store the Zoho record id in `acc_ref`", which is
impossible: `acc_ref` holds 9 characters and Zoho ids are 18–19 digits. It is a module letter
plus 8 base-36 characters derived from a stable hash of the record id — deterministic,
recomputable, and **verified rather than trusted** when a lookup hits (rung 2 confirms name
and tax id before accepting the match).

Writes back: `Rivhit_Customer_ID`, `Rivhit_Acc_Ref`, `Rivhit_Last_Sync`, and
`Rivhit_Sync_Error` cleared.

**Why the ladder is spelled out:** the Green Invoice bridge had a missing `await` that made
its dedup branch unreachable, so every sync created a new client — duplicates accumulating in
a customer's real books, latent across three major versions. Each rung is independently
testable and creation is unreachable unless all four lookups miss.

**Fails:** `-28` / `-29` (invalid ת.ז / ע.מ check digit) are reported per record with the
offending value; the batch continues. Sending `validate_id: false` is offered as an explicit
admin choice — it saves the document but silently drops the bad number.

**Truncation:** `last_name` 30, `first_name` 20, `address` 30, `city` 20, `phone` 15,
`email` 50. The mapper truncates and reports what it shortened.

### B2 — Sync products to Rivhit items
`Rivhit_Item_ID` → `Item.Update`; else match `Rivhit_Catalog_Number` (≤15) via `Item.List` →
`Item.Update`; else `Item.New`. Writes back `Rivhit_Item_ID`. `Item.Details` is available for
a single-item refresh.

### B3 — Pull stock levels
`Item.Quantity` per item (optionally per `storage_id`), or `Item.StorageReport` for a
per-storage sweep → `Rivhit_Quantity_On_Hand` + `Rivhit_Quantity_Updated`. Sequential.

### B4 — Refresh customer balances
⚠ One call, not one per account: `Customer.List` returns each customer's balance inline.
`Customer.Balance` remains for a single-record refresh.

---

## C. Documents

### C1 — Issue a tax document
**Trigger:** the **Issue in Rivhit** button on an Invoice.

**Preflight (W).** Load the invoice, its line items, and the billing Account/Contact. Block —
before any call — if the invoice already has a `Rivhit_Document_Number` (offer *Open*,
*Refresh*, or an explicit *Issue again* that bumps the idempotency revision); if no document
type is mapped; if the type has `is_invoice_receipt` but no payment method is selected; if
the customer has no resolvable identity; or if there are no line items.

**Validate for free (D).** ⚠ New in this revision:

```
1. local checks      totals, mappings, field lengths, required payment fields per method
2. R Document.New with check_only: true
      → Rivhit validates the exact payload and returns status + error
      → creates nothing, costs nothing against the document quota
```

Revision 1 had no dry run and compensated with careful client-side prediction of Rivhit's
arithmetic. `check_only` removes the guesswork: the payload is either accepted by the server
or corrected before a single billable issuance is spent.

**Confirm (W).** Doc type name, customer, line items, net/VAT/gross, document language,
whether Rivhit will email the customer (`send_mail` defaults to **true**), whether a
confirmation number is expected, and a quota warning if the monthly count is near
`Monthly_Doc_Quota`. Issuing a tax document is irreversible; it needs a deliberate
confirmation.

**Issue (D `rv_issue_document`).**

1. Derive `request_reference = zcrm:<record_id>:doc:<revision>`.
2. **Write `Rivhit_Request_Reference` to CRM first** — makes the operation recoverable even
   if everything after this is lost.
3. Ensure the customer exists (calls B1 internally if needed).
4. Build the payload:
   - `document_type` from `Doc_Type_Map`; `customer_id` from the record
   - `sort_code` = the mapped VAT or exempt code
   - `price_include_vat: true` with **gross** prices; each line rounded to 2 dp
   - `items[]` → `catalog_number`, `description` (≤100), `quantity`, `price_nis`, `item_id`
   - `payments[]` only when `is_invoice_receipt`, summing to the items total **exactly**
   - `language`, `email_to`, `send_mail`, `comments` (≤400), `reference`, `order` (≤15),
     `agent_id`, `project_id`, `due_date` as `DD/MM/YYYY`
   - `request_reference`, `prevent_duplicates: true`
5. POST **R** `Document.New`.
6. On `error_code = 0`, persist: `Rivhit_Document_Type`, `Rivhit_Document_Number`,
   `Rivhit_Document_Identity`, `Rivhit_Document_URL`, `Rivhit_Issue_Date`,
   `Rivhit_Confirmation_Number` + `Rivhit_Confirmation_Status`, `Rivhit_Payment_Status`
   (`Paid` for invoice+receipt, else `Issued`), `Rivhit_Paid_Amount`, `Rivhit_Last_Sync`.
   Critical fields first; timestamps in a separate best-effort update. Audit note. Increment
   the monthly counter.
7. If `Confirmation_Required` and no `confirmation_number` came back → set status `Missing`
   and hand off to **C5**.

**Fails:**
- Business errors (negative `error_code`) → show `client_message` (Hebrew, user-facing), log
  `debug_message`, change nothing, **no auto-retry**.
- Ambiguous failure (timeout, unparseable body, HTML error page) → **C4**, never a retry.

### C2 — Record a payment (issue a receipt and close the document)
**Trigger:** the **Record Payment** button on an issued, unpaid or partly-paid invoice.

**W** prefills the outstanding balance (from `Document.Details.receipt_total` vs
`document_total`), offers the mapped payment methods, and shows only the fields that method
requires:

| Method | Required beyond `amount_nis` |
|---|---|
| Cash | — |
| Check | `bank_code`, `branch_number`, `bank_account_number`, `check_number`, `due_date` |
| Credit card | `bank_account_number` = card last 4, `check_number` = voucher no., `number_of_payments` |
| Bank transfer | `bank_code`, `branch_number`, `bank_account_number`, `check_number` = reference |
| Custom types | behaves like cash |

**D `rv_issue_receipt`** runs `check_only` first, then posts **R** `Receipt.New` with
`closed_document_type`, `closed_document_number`, and ⚠ **`document_is_receipt: true`** —
the parameter revision 1 did not know about. Rivhit auto-appends a comment naming the closed
document.

Writes: a `Rivhit_Receipts` record; on the invoice, `Rivhit_Paid_Amount`,
`Rivhit_Payment_Status`, `Rivhit_Paid_Date`, `Rivhit_Is_Closed`, audit note.

> `number_of_payments` replicates one equal payment across consecutive months with
> consecutive check numbers. Use it for instalments — never to model partial payments already
> received, which are separate receipts.

### C2b — Close without a receipt
**Trigger:** **Mark as settled** on an issued invoice, for payments settled entirely outside
the system.

⚠ New in this revision. **D `rv_close_document`** calls **R** `Document.Close` with
`closing_type: 0`, `closing_number: 0`, `document_is_receipt: true`, an `amount_close`
(partial allowed) and a `closing_date`. **`Document.Reopen`** backs it out. Neither creates a
legal document, so neither is billable.

This also covers retroactive closing against a document issued elsewhere:
`closing_type` / `closing_number` naming the closer.

### C3 — Cancel a document
**Trigger:** the **Cancel in Rivhit** button.

⚠ Substantially simpler than revision 1, which hand-built a credit note.
**D `rv_cancel_document`** calls **R** `Document.Cancel` with the type and number; Rivhit
issues the reversing credit document itself and returns
`cancel_document_type/number/identity/link`.

> **An Invoice-Receipt (type 2) needs both** `Document.Cancel` **and** `Receipt.Cancel`, each
> with the same number — one reverses the invoice half, the other the receipt half. The flow
> checks `is_invoice_receipt` and issues both as a single unit of work with a shared audit
> note. Doing only one leaves the books half-reversed.

Writes `Rivhit_Cancel_Document_Number`, `Rivhit_Payment_Status = Cancelled`, audit note.
Requires typed confirmation — it is billable and irreversible.

**Partial or modified refunds** are a different flow: `Document.New` / `Receipt.New` with
**negative** amounts on the credit document type, plus a comment linking to the original.

### C4 — Recover an ambiguous issue
**Trigger:** automatic after any ambiguous failure in C1/C2/C3; also a manual **Recover**
button on an invoice holding a `Rivhit_Request_Reference` but no document number.

1. **D `rv_recover_request`** calls **R** `Status.LastRequest` with the stored reference.
2. A response is returned → the document *was* created. Parse and persist as a success, note
   the recovery.
3. `error_code -2` (`NO_DATA_FOUND`) → nothing was created. Re-issuing with the **same**
   reference is safe, and the UI offers it.

This is why a dropped connection does not default to a duplicate tax document.

### C5 — Obtain a missing confirmation number
⚠ New in this revision, and the most consequential addition.

Israel's *חשבוניות ישראל* regime requires a Tax Authority allocation number on qualifying
invoices. Without one the customer may be unable to deduct input VAT — a compliance defect,
not a sync glitch.

**Trigger:** automatically after C1 when `Confirmation_Required` is on and no
`confirmation_number` came back; from a **Get confirmation number** button on the invoice;
and from the AR report's exceptions list.

**D `rv_confirmation`** calls **R** `Document.InvoiceApproval` with `document_type`,
`document_number`, and the approver's `id_number`. On success it writes
`Rivhit_Confirmation_Number` and sets `Rivhit_Confirmation_Status = Obtained`; on failure,
`Retry Failed`, with the reason shown.

`rv_reconcile` re-checks for gaps in bulk, since `Document.List` returns
`confirmation_number` for every row.

---

## D. Payments through iCredit

### D1 — Send a payment link
**Trigger:** the **Payment Link** button on an Invoice.

**D `rv_icredit_get_url`** POSTs to **IC** `PaymentPageRequest.svc/GetUrl` with `Items[]`,
customer fields, `Discount`, `Currency`, `MaxPayments`, `DocumentLanguage`, `SendMail`, the
public `IPNURL`, a distinct `IPNFailureURL`, a `RedirectURL`, and **`Custom1` = the Zoho
invoice record id**. Response gives `URL`, `PrivateSaleToken`, `PublicSaleToken`.

**W** offers copy / email / open. Stores `ICredit_Payment_URL`. Status stays `Issued` — a
link is not a payment.

`GetUrl` is the right method here: the hosted page carries PCI compliance, which a widget
collecting card details never could. `ChargeSimple` is for locally installed applications and
is out of scope.

### D2 — Receive and verify the notification
**Trigger:** iCredit POSTs to the public `rv_icredit_ipn` URL.

⚠ **The handler is shaped by a 1.25-second response budget.** iCredit resends if it does not
get a 200 OK in time, and a Deluge function that verifies and then writes to CRM will
frequently miss that window. **Duplicate deliveries are normal operation, not an attack** —
the replay guard is load-bearing for correctness, not just security.

```
IPN received
 ├─ return a top-level value on EVERY path — a thrown Deluge function
 │  returns an error page and guarantees a resend storm
 │
 ├─ 1. POST /Verify {SaleId, GroupPrivateToken, TransactionAmount} → "VERIFIED"
 ├─ 2. IPN GroupPrivateToken == our stored token
 ├─ 3. SaleId not already recorded            (replay / duplicate delivery)
 ├─ 4. TransactionAmount == invoice total ±0.01
 │
 ├─ any check fails → log, do not touch the invoice, flag for a human
 │
 └─ all pass → locate the invoice by Custom1, then:
       ICredit_Issues_Document = true
         └─ record the document iCredit already issued
            (DocumentNum, DocumentType, DocumentURL)
       ICredit_Issues_Document = false
         └─ call rv_issue_receipt (credit-card payment type, auth number,
            card last-4) to issue and close in Rivhit
```

Either branch writes `ICredit_Sale_ID`, `ICredit_Auth_Number`, `ICredit_Card_Last4`,
`Rivhit_Paid_Amount`, `Rivhit_Paid_Date`, `Rivhit_Payment_Status = Paid`, a `Rivhit_Receipts`
record with `Source = iCredit`, and the audit note.

⚠ **Failure notifications are a separate endpoint.** Left unset, `IPNFailureURL` defaults to
the success URL and fires on *every* failed charge attempt — a customer mistyping a card
three times would look like three events. The design always sets a distinct failure endpoint,
which records the attempt on the invoice's audit trail and changes nothing else.

### D3 — Tokens, recurring, refunds *(later phase)*
iCredit also offers card tokenisation (`SaleType: 3`, then `SaleChargeToken`), full recurring-
sale CRUD, pending/J5 authorisations, refunds, 3DS, Google Pay, Apple Pay and PIN-pad
devices. A stored token is a charge credential: restrict field-level permissions, never render
it in a widget, and disclose it in the privacy policy.

---

## E. Background and reporting

### E1 — Scheduled reconciliation (`rv_reconcile`)
**Trigger:** a Zoho CRM **Scheduled Function**, every 6 hours. *(A scheduled function is a
manual setup step — the function does nothing until an admin creates the schedule. The Green
Invoice extension advertised automatic sync for months while shipping without one.)*

⚠ Rebuilt on `Customer.OpenDocuments`, which returns the whole receivables position —
including **`paid_amount` per document** — in a single free call. Revision 1's design of
`Receipt.List` plus one `Receipt.Details` per receipt is gone.

1. `Customer.OpenDocuments(customer_id: 0, accounting_only: true)` → match rows to CRM
   invoices on `(document_type, document_number)` → update `Rivhit_Paid_Amount`,
   `Rivhit_Payment_Status`, `Rivhit_Is_Closed = false`.
2. CRM invoices marked issued but **absent** from the open list closed since the last run →
   `Document.Details` to confirm `is_closed` / `is_cancelled` / `receipt_total`, then
   finalise.
3. `Document.List` over the window (⚠ always with an explicit date range — it defaults to
   *today*) → flag documents issued directly in Rivhit with no CRM invoice, and detect
   `confirmation_number` gaps in bulk.
4. `Customer.List` → refresh balances inline.
5. Emit a run summary: scanned / matched / updated / unmatched / errors.

All reads, so nothing counts against the document quota. Loops sequential.

### E2 — Refresh one invoice
**Trigger:** the **Refresh Status** button. ⚠ One call: `Document.Details` returns
`is_closed`, `is_cancelled`, `document_total`, `receipt_total`, `total_vat`, `vat_percent`,
`confirmation_number`, the full `items[]` (each with its own `is_closed`) and `payments[]`.

### E3 — AR report and exceptions
**Trigger:** Invoices mass action.

⚠ The report *is* `Customer.OpenDocuments` — Rivhit's own debt-aging report (דו"ח גיול חובות)
— rather than a client-side reconstruction. Columns: customer, document number, issue date,
due date, total, paid, balance, age bucket.

Exceptions section:
- CRM invoices with a `Rivhit_Request_Reference` but no document number (C4 candidates)
- ⚠ invoices with `Rivhit_Confirmation_Status = Missing` (C5 candidates)
- Rivhit documents with no CRM invoice
- CRM invoices marked Paid whose Rivhit customer still shows a balance

Pagination is explicit and any cap is stated on screen — a silently truncated AR report reads
as "you have less debt than you do".

---

## F. Failure taxonomy

| Class | Example | Behaviour |
|---|---|---|
| Auth | token rejected | Stop, tell the admin to re-enter. No retry. |
| Validation (ours) | totals disagree pre-send | Block locally, show the arithmetic, spend nothing. |
| Validation (Rivhit, dry run) | `check_only` returns an error | Show it, correct the payload, still nothing spent. |
| Validation (Rivhit, live) | negative `error_code` | Show `client_message`, log `debug_message`, change nothing, no retry. |
| Empty result | `error_code -2` on a list | Normal. Render "none", not an error. |
| Ambiguous write | timeout / unparseable / HTML error page | **C4 recovery.** Never a retry. |
| Transport, read-only | timeout on a list | Retry with backoff, sequentially. |
| CRM write rejected | one bad field kills the update | Drop the named field, retry the rest, log loudly, show "saved, but field X skipped". |
| Duplicate IPN | second delivery of one `SaleId` | Expected. Replay guard absorbs it silently. |
| Compliance | no `confirmation_number` on a qualifying invoice | Flag on the record and in the AR report; retry via C5. Never hide it. |
| Quota | monthly issuance near the tier limit | Warn before issuing; never silently exceed. |
