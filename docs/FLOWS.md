# Actions and Flows

Every action the extension exposes, and every background flow it runs. Each entry states the
trigger, the sequence, what is written back to CRM, and how it fails.

Legend: **W** = widget (browser) · **D** = Deluge function (server) · **R** = Rivhit API ·
**IC** = iCredit.

---

## A. Setup

### A1 — Configure and test the connection
**Trigger:** admin opens the Settings tab.

1. **W** loads current settings via `rv_lookup{op:"settings"}` — secrets come back masked.
2. Admin enters `api_token`, environment, company id; presses **Test Connection**.
3. **D** `rv_lookup{op:"ping"}` calls **R** `Accounting.VatRate` — the cheapest authenticated
   read that proves the token works and returns something meaningful.
4. On success **W** shows the live VAT rate as confirmation, then automatically runs A2.
5. **D** `rv_save_settings` persists to org variables and reads them back to verify.

**Fails:** `UNAUTHORIZED (401)` → "token rejected"; transport error → "cannot reach Rivhit".
Nothing is saved unless the readback matches.

### A2 — Discover and map types
**Trigger:** after a successful connection test, and from a **Refresh types** button.

1. **D** `rv_lookup{op:"types"}` calls **R** `Document.TypeList`, `Receipt.TypeList`,
   `Payment.TypeList`, `Currency.List`, `Payment.BankList`, `Accounting.VatRate`.
2. **D** caches the whole set in `Type_Cache` with a fetched-at stamp.
3. **W** renders mapping tables, pre-filled by name matching:
   - CRM intent (Tax Invoice / Invoice+Receipt / Credit Note / Delivery Note / Quote / Order)
     → Rivhit `document_type`
   - CRM `Payment_Method` picklist values → Rivhit `payment_type`
4. Admin adjusts and saves. Mappings are stored as JSON in `Doc_Type_Map` / `Payment_Type_Map`.

**Why it matters:** type codes are per-company. Published vendor examples disagree with each
other on payment-type codes. Nothing downstream may assume a code.

**Fails:** an unmapped intent disables the corresponding action in the UI with an explicit
"not configured" message, rather than issuing a document with a guessed type.

### A3 — Configure iCredit *(optional)*
Admin enters test/prod `GroupPrivateToken`, test-mode flag, max payments, and — the decisive
one — **who issues the tax document** (`ICredit_Issues_Document`). The widget displays the
generated public IPN URL to paste into the iCredit back office, and states plainly which
side will issue documents in the chosen mode.

---

## B. Master data sync

### B1 — Upsert a customer (Account or Contact)
**Trigger:** the mass action "Sync to Rivhit"; also called inline by B-flows and C1 when an
invoice's customer has no `Rivhit_Customer_ID`.

**D** `rv_upsert_customer` resolves the customer through an ordered ladder — the first hit
wins, and creation is the last resort:

```
1. Rivhit_Customer_ID on the CRM record          → Customer.Update
2. Customer.Get(acc_ref = <zoho record id>)      → Customer.Update  (+ backfill the CRM id)
3. Customer.Get(...) matched on id_number/vat_number → Customer.Update
4. Customer.Get(email = ...)                      → Customer.Update
5. none matched                                   → Customer.New (acc_ref = <zoho record id>)
```

Writes back: `Rivhit_Customer_ID`, `Rivhit_Last_Sync`, and `Rivhit_Sync_Error` cleared.

**Why the ladder:** the Green Invoice bridge had a missing `await` that made its dedup branch
unreachable, so **every** sync created a new client — duplicates accumulating in a customer's
real books, latent across three major versions. The ladder is explicit, each rung is
independently testable, and creation is unreachable unless all four lookups miss.

**Note:** `Customer.Update` only changes the fields you send; omitted fields are left alone.
So send only what CRM actually owns, and never blank a field by sending an empty string.

**Fails:** `INVALID_ID_NUMBER` / `INVALID_VAT_NUMBER` (check-digit failures) are reported
per record with the offending value; the batch continues. Results are summarised
created/updated/failed with a downloadable list.

### B2 — Sync products to Rivhit items
**Trigger:** Products mass action.

`Rivhit_Item_ID` present → `Item.Update`; else match on `Rivhit_Catalog_Number` via
`Item.List` → `Item.Update`; else `Item.New`. Writes back `Rivhit_Item_ID`.

### B3 — Pull stock levels
**Trigger:** manual button, or the scheduled reconciliation if inventory tracking is enabled.

`Item.Quantity` per item (optionally per `storage_id`) → `Rivhit_Quantity_On_Hand` +
`Rivhit_Quantity_Updated`. Sequential, not parallel.

### B4 — Refresh customer balances
**Trigger:** Accounts mass action, and inside `rv_reconcile`.

`Customer.Balance` per account → `Rivhit_Balance` + `Rivhit_Balance_Updated`.

---

## C. Issuing documents

### C1 — Issue a tax document
**Trigger:** the **Issue in Rivhit** button on an Invoice.

**Preflight (W).** Load the invoice, its line items, and the billing Account/Contact. Block
with a clear message — before any billable call — if:
- the invoice already has a `Rivhit_Document_Number` (offer *Open*, *Refresh*, or an explicit
  *Issue again* that bumps the idempotency revision),
- no document type is mapped for the chosen intent,
- the chosen type has `is_invoice_receipt = true` but no payment method is selected,
- the customer has no resolvable identity (no tax id, no email, no `Rivhit_Customer_ID`),
- there are no line items.

**Confirm (W).** Show a summary: doc type name, customer, line items, net/VAT/gross totals,
document language, whether Rivhit will email the customer, and — if the monthly counter is
near `Monthly_Doc_Quota` — a usage warning. Issuing a tax document is irreversible; it needs
a deliberate confirmation, not a single click.

**Issue (D `rv_issue_document`).**

1. Derive `request_reference = zcrm:<record_id>:doc:<revision>`.
2. **Write `Rivhit_Request_Reference` to CRM first**, so the operation is recoverable even if
   everything after this point is lost.
3. Ensure the customer exists (calls B1 internally if needed).
4. Build the payload:
   - `document_type` from `Doc_Type_Map`; `customer_id` from the record
   - `items[]` from CRM line items → `catalog_number`, `description`, `quantity`,
     `price_nis`, optional `item_id`
   - `price_include_vat` per the type's own setting; gross prices for invoice+receipt types
   - `payments[]` only when `is_invoice_receipt = true`, summing to the gross total exactly
   - `language`, `email_to`, `send_mail`, `comments`, `reference`, `agent_id`, `project_id`
   - `request_reference`, `prevent_duplicates = true`
5. Server-side validation: payload total must equal the CRM invoice total (±0.01), and the
   payments total must equal the document total. Abort locally rather than paying for a
   rejected call.
6. POST **R** `Document.New`.
7. On `error_code = 0`: persist `Rivhit_Document_Type`, `Rivhit_Document_Number`,
   `Rivhit_Document_Identity`, `Rivhit_Document_URL`, `Rivhit_Issue_Date`,
   `Rivhit_Payment_Status` (`Paid` if the type is invoice+receipt, else `Issued`),
   `Rivhit_Paid_Amount`, `Rivhit_Last_Sync`. Critical fields in the first update; the
   timestamp in a separate best-effort update. Append the audit note. Increment the monthly
   counter.

**Fails:**
- Business errors (`CUSTOMER_NOT_EXISTS`, `INVALID_DISCOUNT_VALUE`,
  `DIFFERENT_AMOUNT_BETWEEN_INVOICE_AND_RECEIPT`, …) → show `client_message`, log
  `debug_message`, change nothing. **Never auto-retry** — each attempt is billable and may
  create a document.
- Ambiguous failure (timeout, unparseable body) → **C4 recovery**, never a retry.

### C2 — Record a payment (issue a receipt)
**Trigger:** the **Record Payment** button on an issued, unpaid/partly-paid invoice.

**W** shows the outstanding balance prefilled, a payment-method picker (from
`Payment_Type_Map`), and the fields that method requires — Rivhit enforces different
mandatory fields per payment type:

| Method | Required beyond `amount_nis` |
|---|---|
| Cash | — |
| Check | `bank_code`, `branch_number`, `bank_account_number`, `check_number`, `due_date` |
| Credit card | voucher no. in `check_number`, card last-4 in `bank_account_number`, `number_of_payments` |
| Bank transfer | `bank_code`, `branch_number`, `bank_account_number` |

**D `rv_issue_receipt`** posts **R** `Receipt.New` with
`closed_document_type` / `closed_document_number` pointing at the invoice's Rivhit document —
this is what marks the invoice settled on the Rivhit side — plus its own
`request_reference` and `prevent_duplicates`.

Writes: a new `Rivhit_Receipts` record; on the invoice, `Rivhit_Paid_Amount` accumulated
across receipts, `Rivhit_Payment_Status` recomputed (`Paid` when paid ≥ total − 0.01, else
`Partially Paid`), `Rivhit_Paid_Date`, audit note.

> `number_of_payments` splits a receipt into multiple rows with consecutive monthly due
> dates. Useful for instalments; do not use it to model partial payments already received —
> those are separate receipts.

### C3 — Cancel via credit note
**Trigger:** the **Cancel in Rivhit** button on an issued invoice.

An Israeli tax invoice cannot be deleted; it is reversed by a credit note
(חשבונית מס זיכוי). **D `rv_credit_note`** issues `Document.New` with the credit-note type
mapped in `Doc_Type_Map`, mirroring the original document's lines, and closing the original
via `closed_document_type` / `closed_document_number`.

Writes: `Rivhit_Credit_Note_Number`, `Rivhit_Payment_Status = Cancelled`, audit note.
Requires a typed confirmation — it is a second billable, irreversible legal document.

### C4 — Recover an ambiguous issue
**Trigger:** automatic after any ambiguous failure in C1/C2/C3; also a manual **Recover**
button on an invoice that has a `Rivhit_Request_Reference` but no document number.

1. **D `rv_recover_request`** calls **R** `Status.LastRequest` with the stored reference.
2. A response is returned → the document *was* created. Parse it, persist exactly as a
   success, note the recovery.
3. `NO_DATA_FOUND (204)` → nothing was created. Re-issuing with the **same** reference is now
   safe, and the UI offers it.

This flow is the reason a duplicate tax document is not the default outcome of a dropped
connection.

---

## D. Payments through iCredit

### D1 — Send a payment link
**Trigger:** the **Payment Link** button on an Invoice.

**D `rv_icredit_get_url`** POSTs to **IC** `PaymentPageRequest.svc/GetUrl` with items,
customer details, `Discount`, `MaxPayments`, `DocumentLanguage`, `ExemptVAT`, the public
`IPNURL`, a `RedirectURL`, and **`Custom1` = the Zoho invoice record id** (the correlation
key that comes back in the IPN).

**W** offers: copy the URL, email it to the customer, or open it. Stores
`ICredit_Payment_URL`; status stays `Issued` (or `Not Issued`) — a link is not a payment.

### D2 — Receive and verify the IPN
**Trigger:** iCredit POSTs to the public `rv_icredit_ipn` URL after a successful charge.

```
IPN received
 ├─ 1. POST /Verify {SaleId, GroupPrivateToken, TransactionAmount} → must be "VERIFIED"
 ├─ 2. IPN GroupPrivateToken == our stored token
 ├─ 3. SaleId not already recorded            (replay protection)
 ├─ 4. TransactionAmount == invoice total ±0.01
 │
 ├─ any check fails → log, do not touch the invoice, flag for a human
 │
 └─ all pass → locate the invoice by Custom1, then:
       ICredit_Issues_Document = true
         └─ record the document iCredit already issued
            (DocumentNum, DocumentType, DocumentURL) onto the invoice
       ICredit_Issues_Document = false
         └─ call rv_issue_receipt (credit-card payment type,
            auth number, card last-4) to issue and close in Rivhit
```

Either branch then writes `ICredit_Sale_ID`, `ICredit_Auth_Number`, `ICredit_Card_Last4`,
`Rivhit_Paid_Amount`, `Rivhit_Paid_Date`, `Rivhit_Payment_Status = Paid`, creates the
`Rivhit_Receipts` record with `Source = iCredit`, and appends the audit note.

The function always returns a top-level value; a Deluge REST function that throws returns an
error page to iCredit and may trigger vendor-side retries.

### D3 — Token / recurring charges *(later phase)*
With `CreateToken = true`, the IPN returns a `TransactionToken` that can be charged later via
`ChargeSimple` without the cardholder. That enables subscription billing from CRM, and it
also means the stored token is a charge credential: restrict field-level permissions, never
render it in a widget, and treat it in the privacy policy as payment data.

---

## E. Background and reporting

### E1 — Scheduled reconciliation (`rv_reconcile`)
**Trigger:** a Zoho CRM **Scheduled Function**, every 6 hours. *(A scheduled function is a
manual setup step — the function does nothing until an admin creates the schedule. The Green
Invoice extension advertised automatic sync for months while shipping without one.)*

1. `Receipt.List` for the last `Reconcile_Window_Days` days.
2. For each receipt not already in `Rivhit_Receipts`: `Receipt.Details` → read its
   closed-document reference → match the CRM invoice on `(document_type, document_number)`.
3. Recompute `Rivhit_Paid_Amount` / `Rivhit_Payment_Status`; create the `Rivhit_Receipts`
   record with `Source = Rivhit`.
4. `Document.List` for the same window to catch documents issued directly in Rivhit against
   CRM-known customers, and flag them as unlinked.
5. Refresh `Customer.Balance` for active accounts.
6. Emit a run summary: scanned / matched / updated / unmatched / errors.

All reads, so this costs nothing against the document quota. Loops are sequential.

### E2 — Refresh one invoice
**Trigger:** the **Refresh Status** button. Runs the E1 logic for a single invoice via
`Document.Details` plus its receipts, for a user who does not want to wait for the schedule.

### E3 — AR / open-balance report
**Trigger:** Invoices mass action.

Table of open invoices: customer, document number, issue date, total, paid, outstanding, age
bucket. Plus a **reconciliation exceptions** section:
- invoices marked Paid in CRM whose Rivhit customer still shows a balance,
- Rivhit documents with no CRM invoice,
- CRM invoices with a `Rivhit_Request_Reference` but no document number (C4 candidates).

Pagination is explicit and any cap is stated on screen — a silently truncated AR report reads
as "you have less debt than you do".

---

## F. Failure taxonomy

How the extension is required to behave, by failure class.

| Class | Example | Behaviour |
|---|---|---|
| Auth | `UNAUTHORIZED (401)` | Stop everything, tell the admin the token needs re-entry. Do not retry. |
| Validation (ours) | totals disagree before sending | Block locally, show the arithmetic, spend nothing. |
| Validation (Rivhit) | `INVALID_ID_NUMBER`, `DIFFERENT_AMOUNT_...` | Show `client_message`, log `debug_message`, change nothing, no retry. |
| Empty result | `NO_DATA_FOUND (204)` on a List | Normal. Render "none", not an error. |
| Ambiguous write | timeout / unparseable body | **C4 recovery.** Never a retry. |
| Transport, read-only call | timeout on a `*.List` | Safe to retry with backoff, sequentially. |
| CRM write rejected | one bad field kills the update | Drop the named field, retry the rest, log the drop loudly, show a "saved, but field X skipped" warning. |
| Quota | monthly issuance near the tier limit | Warn before issuing; never silently exceed. |
