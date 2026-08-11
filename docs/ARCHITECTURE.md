# Architecture

**Revision 2.** Sections 5–9 were rewritten after the live Rivhit documentation became
readable; the changes are summarised in the README. Section 1–4 and 10–11 carry forward with
corrections marked **⚠**.

## 1. Component map

```
┌─ Zoho CRM ─────────────────────────────────────────────────────────────────┐
│                                                                            │
│  Sigma widgets (browser, sandboxed iframe)                                 │
│  ├── settings            Settings tab    credentials, mappings, test       │
│  ├── issue_document      Invoices button issue a Rivhit tax document       │
│  ├── record_payment      Invoices button issue a receipt, close the doc    │
│  ├── payment_link        Invoices button create an iCredit payment page    │
│  ├── refresh_status      Invoices button re-poll one invoice               │
│  ├── cancel_document     Invoices button cancel / credit                   │
│  ├── customer_sync       Accounts/Contacts mass action                     │
│  ├── product_sync        Products mass action                              │
│  └── ar_report           Invoices mass action  AR aging / exceptions       │
│           │                                                                │
│           │  ZOHO.CRM.FUNCTIONS.execute(...)   ← the ONLY path outward     │
│           ▼                                                                │
│  Deluge REST functions (server-side, hold the credentials)                 │
│  ├── rv_save_settings      persist org variables                           │
│  ├── rv_lookup             read-only Rivhit reads (whitelisted methods)    │
│  ├── rv_upsert_customer    Customer.Get / New / Update                     │
│  ├── rv_issue_document     Document.New  (check_only → real → recover)     │
│  ├── rv_issue_receipt      Receipt.New   (+ document closing)              │
│  ├── rv_close_document     Document.Close / Reopen                         │
│  ├── rv_cancel_document    Document.Cancel (+ Receipt.Cancel)              │
│  ├── rv_confirmation       Document.InvoiceApproval retry                  │
│  ├── rv_recover_request    Status.LastRequest / AllRequests recovery       │
│  ├── rv_sync_products      Item.* sync                                     │
│  ├── rv_reconcile          scheduled — Customer.OpenDocuments driven       │
│  ├── rv_icredit_get_url    iCredit GetUrl                                  │
│  ├── rv_icredit_ipn        PUBLIC REST endpoint — iCredit IPN listener     │
│  └── rv_log_change         WORKFLOW-triggered — post-issuance drift note   │
│                                                                            │
│  Every write function checks the caller's profile against Action_          │
│  Permissions before acting. The widget also hides what a user cannot do,   │
│  but that is courtesy — the function is the enforcement point.             │
│           │                                                                │
└───────────┼────────────────────────────────────────────────────────────────┘
            │ invokeurl (HTTPS)
            ▼
   ┌────────────────────────┐        ┌──────────────────────────────┐
   │ Rivhit Online REST API │        │ iCredit Payment Gateway      │
   │ api.rivhit.co.il/online│        │ icredit.rivhit.co.il/API     │
   │ static api_token       │        │ GroupPrivateToken            │
   └────────────────────────┘        └──────────────────────────────┘
                                              │ POST (IPN, 1.25s budget)
                                              └──► rv_icredit_ipn
```

## 2. The trust boundary — and why it moved

The Green Invoice bridge reads its API credentials into widget JavaScript and calls the
vendor from the browser through `ZOHO.CRM.HTTP.*`. That is workable there because Green
Invoice credentials are exchanged for a short-lived bearer token.

Rivhit is different in ways that matter:

| | Green Invoice (Morning) | Rivhit |
|---|---|---|
| Credential | key id + secret → **short-lived** token | **static `api_token`, no expiry, no scopes** |
| Revocation | rotate keys | regenerate the token in Rivhit (breaks every integration at once) |
| Blast radius | issue documents | issue documents, edit and **delete** customers, post journal entries, change company settings |

⚠ The blast radius is wider than revision 1 assumed: the current API also exposes
`Customer.Delete`, `Company.Update`, and `Company.SetStartNumber`. A leaked token can
renumber a company's document series.

**Rule: widgets never see `api_token` or `GroupPrivateToken`, and never call Rivhit
directly.** Widgets call named Deluge functions, which read credentials from org variables,
call Rivhit, and return only presentation-safe data.

### Why named functions, not one generic proxy

A generic `rv_call(method, payload)` would hide the credential just as well, but it would
move payload construction into the browser. Named functions let the server enforce
invariants the client cannot be trusted with: the document total must match the CRM invoice,
the Rivhit customer must be the one linked to the record, the idempotency key is derived
server-side from the CRM record id, and issuance is counted and capped.

`rv_lookup` is the one deliberately generic function, safe because it is restricted to a
**whitelist of read-only methods** (`*.TypeList`, `*.List`, `*.Details`, `Customer.Get`,
`Customer.Balance`, `Customer.OpenDocuments`, `Customer.ClosedDocuments`,
`Accounting.VatRate`, `Accounting.SortCodeList`, `Currency.List`, `Payment.BankList`,
`Item.*` reads). Anything that writes gets its own function.

## 3. Configuration store

Org variables (Sigma Custom Properties), namespace-prefixed
`rivhitzohocrmextension__<name>`. Written **only** by `rv_save_settings` — org-variable
writes from widget JS return HTTP 400 on this platform.

| Variable | Purpose |
|---|---|
| `API_Token` | Rivhit `api_token` |
| `Account_Mode` | `production` \| `demo` — ⚠ selects credentials, **not** a different host |
| `Company_ID` | Rivhit company id — used to build PDF links |
| `Doc_Type_Roles` | JSON, **three entries only**: `role_credit`, `role_default_sales_order`, `role_default_invoice`. Every other type is chosen at issue time from the catalog (§5) |
| `Receipt_Type_Roles` | JSON: `role_default_receipt` |
| `Payment_Type_Map` | JSON: CRM payment method → Rivhit `payment_type` |
| `Sort_Code_VAT` / `Sort_Code_Exempt` | ⚠ the VAT switch (Rivhit defaults 100 / 150, per-business) |
| `Type_Cache` | JSON snapshot of the **full** document and receipt type catalogs with their flags, plus VAT rate, currencies, banks and sort codes, with a fetched-at stamp |
| `Default_Language` | `he` \| `en` — document language **and** widget UI direction. **Ships `he`.** |
| `Default_Currency_ID` | Rivhit currency code used when the CRM record does not specify one |
| `Default_Update_Inventory` | initial state of the per-document "update stock" checkbox |
| `Send_Mail_Default`, `Digital_Signature` | mailing / signed-PDF defaults |
| `Agent_ID`, `Project_ID` | optional defaults stamped on documents |
| `Confirmation_Required` | ⚠ whether this business is in the חשבוניות ישראל regime |
| `Monthly_Doc_Quota` | subscribed tier, for the usage warning |
| `ICredit_Enabled` | master switch for gateway features |
| `ICredit_Group_Token_Prod` / `ICredit_Group_Token_Test`, `ICredit_Test_Mode` | gateway credentials |
| `ICredit_Issues_Document` | **critical** — `true` if the iCredit payment page is configured to issue the tax document itself (§8) |
| `ICredit_IPN_Key` | the `zapikey` embedded in the public IPN URL |
| `Reconcile_Window_Days` | rolling window for the scheduled reconciliation (default 35) |
| `Action_Permissions` | JSON matrix: action → allowed profile ids. **Enforced in Deluge, not in the widget** (§12) |
| `Sync_State` | JSON cursors for every resumable batch job (§13) |

Secrets are write-only in the UI: the settings widget renders `•••• (saved)` and only
overwrites when the admin types a new value.

## 4. CRM data model

### 4.1 Field naming and the namespacing trap

Fields created by the extension manifest get namespaced API names
(`rivhitzohocrmextension__Rivhit_Document_ID`); fields an admin creates by hand are plain.
**Both must work, per field, in the same org.** Every read and write resolves field names at
runtime by scanning `ZOHO.CRM.META.getFields` (widget) or one sample record's keys (Deluge).
This is not optional polish — it is the bug that silently discarded writes in the Green
Invoice bridge for three releases.

Avoid CRM-reserved words in API names. `Score` is reserved (learned on the Health Check
extension); prefix everything with `Rivhit_` / `ICredit_` and never use a bare noun.

### 4.2 Accounts and Contacts — ⚠ the `acc_ref` correction

| Field | Type | Notes |
|---|---|---|
| `Rivhit_Customer_ID` | Number | Rivhit `customer_id` — **the authoritative join key** |
| `Rivhit_Acc_Ref` | Single Line (9) | the short surrogate written into Rivhit's `acc_ref` |
| `Rivhit_Tax_ID` | Single Line | ת.ז / ח.פ → `id_number` |
| `Rivhit_VAT_Number` | Single Line | ע.מ → `vat_number` |
| `Rivhit_Customer_Type` | Number | 1 customer · 20 supplier · 40–59 income/expense · 60 agent |
| `Rivhit_Price_List_ID`, `Rivhit_Agent_ID` | Number | |
| `Rivhit_Balance` | Currency 16,2 | |
| `Rivhit_Balance_Updated`, `Rivhit_Last_Sync` | Date/Time | ISO 8601 **with offset** |
| `Rivhit_Sync_Error` | Multi-line | last `client_message`, cleared on success |

> **Revision 1 was wrong about `acc_ref`.** It proposed storing the Zoho record id there as a
> bidirectional key. `acc_ref` is limited to **9 characters** and Zoho record ids are 18–19
> digits, so this cannot work.
>
> **Replacement.** `acc_ref` carries a 9-character surrogate: a module letter (`A` account,
> `C` contact) plus 8 base-36 characters derived from a stable 41-bit hash of the full Zoho
> record id. That is ~2.8 × 10¹² values, so collisions are negligible at any realistic org
> size, and it is deterministic — recomputable without storing anything.
>
> It is a **recovery hint, not the key**. `Rivhit_Customer_ID` in CRM stays authoritative,
> and the surrogate is also mirrored into `Rivhit_Acc_Ref` so a lookup can be verified rather
> than trusted. Any match found via `acc_ref` is confirmed against name and tax id before it
> is used.

### 4.3 Sales Orders and Invoices — the Rivhit document

⚠ **Both modules carry the identical field set.** Documents originate from either, and a
CRM Sales Order → Invoice progression maps onto Rivhit's Order → Invoice closing chain
(see `DECISIONS.md` §6). Everywhere the flows say "the invoice", read "the source record".

| Field | Type | Notes |
|---|---|---|
| `Rivhit_Document_Type` | Number | per-company type code |
| `Rivhit_Currency_ID` | Number | 1 NIS · 2 USD · 3 EUR · 4 GBP · 5 AUD · 6 CAD · 7 CHF · 8 SEK · 9 DKK · 10 NOK |
| `Rivhit_Exchange_Rate` | Decimal | sent for non-ILS documents |
| `Rivhit_Stock_Updated` | Checkbox | whether this document decremented inventory |
| `Rivhit_Closed_Document_Number` | Number | the order document this one closed, if any |
| `Rivhit_Document_Number` | Number | |
| `Rivhit_Document_Identity` | Single Line | GUID — stable key, builds the PDF URL |
| `Rivhit_Document_URL` | URL | |
| `Rivhit_Confirmation_Number` | Single Line | ⚠ **new** — Israel Tax Authority allocation number |
| `Rivhit_Confirmation_Status` | Picklist | ⚠ **new** — `Not Required`, `Obtained`, `Missing`, `Retry Failed` |
| `Rivhit_Issue_Date` | Date | |
| `Rivhit_Due_Date` | Date | |
| `Rivhit_Request_Reference` | Single Line | idempotency key (§6) |
| `Rivhit_Payment_Status` | Picklist | `Not Issued`, `Issued`, `Partially Paid`, `Paid`, `Cancelled` |
| `Rivhit_Paid_Amount` | **Currency, length 16, decimals 2** | from `paid_amount` / `receipt_total` |
| `Rivhit_Paid_Date` | Date | |
| `Rivhit_Is_Closed` | Checkbox | ⚠ **new** — Rivhit's own `is_closed` |
| `Rivhit_Last_Sync` | Date/Time | |
| `Rivhit_Cancel_Document_Number` | Number | the reversing document |
| `ICredit_Sale_ID` | Single Line | IPN `SaleId`, also the replay-dedup key |
| `ICredit_Payment_URL` | URL | |
| `ICredit_Auth_Number`, `ICredit_Card_Last4` | Single Line | |
| `Rivhit_Instalments_Total` | Number | count of payment rows on the Rivhit document |
| `Rivhit_Instalments_Elapsed` | Number | rows whose `due_date` has passed |
| `Rivhit_Instalment_Progress` | Single Line | the `"3/12"` display |
| `Rivhit_Next_Instalment_Date` | Date | earliest future `due_date` |
| `Rivhit_Instalment_Amount` | Currency 16,2 | amount of the next row |
| `Rivhit_Issued_Snapshot` | Multi-line (long) | compact snapshot of what was issued; degrades to a hash above a size threshold |
| `Rivhit_Record_Drift` | Checkbox | the record changed after issuance |
| `Rivhit_Drift_Detected_At` | Date/Time | |

### 4.4 Products

`Rivhit_Item_ID`, `Rivhit_Catalog_Number` (מק"ט, ≤15), `Rivhit_Item_Group_ID`,
`Rivhit_Storage_ID`, `Rivhit_Quantity_On_Hand`, `Rivhit_Quantity_Updated`.

### 4.5 Custom module `Rivhit_Receipts`

One record per receipt, related to the Invoice — a receipt is a distinct legal document with
its own number and PDF, and folding it into invoice fields loses partial-payment history.

`Receipt_Type`, `Receipt_Number`, `Receipt_Identity`, `Receipt_Amount` (Currency 16,2),
`Receipt_Date`, `Payment_Method`, `Receipt_URL`, `Closed_Document_Type`,
`Closed_Document_Number`, lookup → Invoice, lookup → Account, `Source`
(`CRM` | `iCredit` | `Rivhit`).

### 4.6 Audit trail

Every write-side operation appends a CRM **Note** to the invoice: operation,
`request_reference`, resulting document type/number, confirmation number, and Rivhit's
`client_message`. This is the human-readable trail when someone asks why there are two
invoices in Rivhit for one deal.

## 5. The type catalog — every type the account supports

⚠ Revision 3 replaced the fixed six-intent map with a **catalog**. The extension supports
*every* document and receipt type the business has configured, not a curated subset.

At setup, and behind a refresh button, it calls `Document.TypeList`, `Receipt.TypeList`,
`Payment.TypeList`, `Accounting.SortCodeList`, `Currency.List`, `Payment.BankList` and
`Accounting.VatRate`, and caches the whole result in `Type_Cache`. The issue widget renders
the document catalog as a picker, using Rivhit's own Hebrew names.

**Behaviour comes from the flags Rivhit returns, never from a hardcoded table:**

| Flag | Drives |
|---|---|
| `is_invoice_receipt` | whether `payments[]` is required, and whether the payment panel appears |
| `price_include_vat` | the default price mode for that type |
| `is_accounting` | whether the document affects the books — governs the confirmation-number check, inclusion in the AR report, and how strong the confirmation prompt is |

**Only three document roles need an explicit mapping**, because the code reasons about them
semantically rather than merely issuing them: `role_credit` (the negative-amount fallback when
`Document.Cancel` does not apply), `role_default_sales_order`, and `role_default_invoice`.
Receipts add `role_default_receipt`; receipt types with `is_invoice_receipt = true` are
filtered out of the standalone-receipt picker because they cannot be issued alone.

Admins also map CRM `Payment_Method` values → Rivhit `payment_type`, and the VAT / exempt
**sort codes**. All mappings are pre-filled by name matching and always overridable.

## 5a. Multi-currency

Documents carry `currency_id` and, when not ILS, `exchange_rate`. Items in ILS send
`price_nis`; items in another currency send `price_mtc` with a matching `currency_id`.
Payments carry `amount_mtc`.

**Every item must share the document's currency** — mixing them returns error `-68`. That is
validated locally before the call and caught again by the `check_only` dry run.

A Rivhit customer card can be pinned to a foreign currency, but only if it was set up for one
(`pal_code`). The customer sync **never rewrites a customer's currency**; it reports the
mismatch instead of silently altering an accounting record.

## 5b. Stock control

Per-document, as a deliberate choice rather than a global setting:

| Control | Effect |
|---|---|
| **Update stock** checkbox | unchecked → `no_update_inventory: true`; the document does not decrement inventory even if its type normally would |
| `Default_Update_Inventory` | the checkbox's initial state |
| **Block if out of stock** | `reject_item_quantity: true` — Rivhit refuses to produce the document when an item is short |
| `Rivhit_Storage_ID` per line | which warehouse stock leaves from; falls back to the item card |

Both flags are persisted on the record and written into the audit note — "why did stock not
move" is otherwise unanswerable after the fact.

Rivhit's documented defaults, for pre-filling only: payment types 1 check, 2 cash, 4 Isracard,
5 Visa, 4–8 credit cards generally, 9 bank transfer. Currencies 1 NIS, 2 USD, 3 EUR, 4 GBP,
5 AUD, 6 CAD, 7 CHF, 8 SEK, 9 DKK, 10 NOK.

## 6. Idempotency, dry runs, and recovery — ⚠ strengthened

Rivhit provides three mechanisms, and the design uses all three.

- **`check_only: true`** — ⚠ *new to this revision.* A full server-side validation of a
  `Document.New` / `Receipt.New` payload that creates nothing and costs nothing. Revision 1
  wrongly stated no preview existed and built elaborate client-side total-guessing around
  that gap.
- **`request_reference` + `prevent_duplicates`** — a second write with the same reference is
  refused. Also available on `Document.Close` and `Document.Cancel`.
- **`Status.LastRequest` / `Status.AllRequests`** — replay the original response for a
  reference.

Key derivation (server-side, deterministic):

```
request_reference = "zcrm:" + <crm_record_id> + ":" + <intent> + ":" + <revision>
        intent   ∈ doc | receipt | close | cancel
        revision  = 1, bumped only by an explicit, confirmed "issue again"
```

**The write sequence for every billable operation:**

```
1. validate locally        totals, mappings, required fields
2. check_only: true        Rivhit validates — free, creates nothing
3. real call               + request_reference + prevent_duplicates
4. ambiguous failure?      → Status.LastRequest, NEVER a retry
```

Step 2 turns "we think this payload is right" into "Rivhit agrees this payload is right"
before a single billable issuance is spent. Step 4 handles the failure that actually matters:

```
issue → timeout / unparseable / transport error
      └─► rv_recover_request(request_reference)
            ├── response returned → the document exists: persist it, report success
            └── NO_DATA_FOUND (-2) → nothing was created: safe to retry the SAME reference
```

`Rivhit_Request_Reference` is written to CRM **before** the call, so recovery works even if
the browser tab is closed mid-flight.

## 7. Totals and VAT — ⚠ resolved

Two independent switches, now confirmed:

- **`sort_code`** — whether the document charges VAT (100 with / 150 exempt, per-business).
- **`price_include_vat`** — whether the prices you send already include VAT.

**The design sends `price_include_vat: true` with gross prices, and makes the `payments[]`
total exactly equal the items total.** The vendor's VAT guide confirms this is the intended
shape for invoice-receipt types: Rivhit extracts and displays the VAT itself, so there is no
arithmetic for the two sides to disagree about. Round each line to 2 decimals before summing.

The VAT *rate* comes from `Accounting.VatRate`, cached with a TTL — needed for display, never
for computing what to send. (The Green Invoice client still carries `0.18`/`0.17` literals;
Israeli VAT has changed twice in recent years.)

`round_digits` (automatic rounding) requires `price_include_vat: false` and only works on
document types without a receipt, so it is incompatible with the above. Round in the mapper
instead.

Revision 1 treated `DIFFERENT_AMOUNT_BETWEEN_INVOICE_AND_RECEIPT` as an unavoidable hazard
requiring careful prediction. With `check_only` it is now caught for free, before committing.

## 8. iCredit

### The double-issue hazard

The iCredit payment page can be configured — **on the iCredit page settings, not per
request** — to issue the tax document itself when a charge succeeds. The IPN then carries
`DocumentURL`, `DocumentNum`, `DocumentType`. If the extension also calls `Document.New`, the
customer receives two tax documents for one payment.

`ICredit_Issues_Document` makes this an explicit either/or:

- **`true`** — iCredit issues; the IPN handler *records* the document onto the CRM invoice.
- **`false`** — the extension issues; the IPN handler records the payment and calls
  `rv_issue_receipt`.

Because it is a page-level setting the extension cannot read, the settings screen states the
active mode in plain language and the first test charge verifies it: if the IPN returns a
`DocumentNum` while the setting says `false`, the widget flags the mismatch.

### The IPN endpoint — ⚠ now shaped by a 1.25-second budget

`rv_icredit_ipn` is a Deluge REST function published with a `zapikey`, i.e. a public URL.

> iCredit requires a **200 OK within 1.25 seconds** or it **resends the message**.

A Deluge function that verifies with iCredit and then writes to CRM will frequently miss that
window. **Duplicate IPNs are therefore normal operation, not an attack.** Three consequences:

1. **Replay protection is load-bearing for correctness**, not just security. It must be the
   first thing the handler does after identifying the sale, and it must be atomic enough that
   two concurrent deliveries of the same `SaleId` cannot both proceed.
2. **The handler always returns a top-level value**, fast, on every path. A Deluge function
   that throws returns an error page and guarantees a resend storm.
3. **`IPNFailureURL` is always set to a distinct endpoint.** Failure notifications otherwise
   arrive at the same URL, and they fire on *every* failed charge attempt — a customer
   mistyping a card three times would otherwise look like three events to reconcile.

The four checks, in order, before any CRM write:

1. **Verify with iCredit** — POST `SaleId`, `GroupPrivateToken`, `TransactionAmount` to
   `/API/PaymentPageRequest.svc/Verify`; require `Status == "VERIFIED"`.
2. **Confirm the token is ours** — the IPN's `GroupPrivateToken` must equal the stored one.
3. **Replay guard** — reject a `SaleId` already recorded.
4. **Amount check** — `TransactionAmount` must match the invoice total within ±0.01.

`Custom1` carries the Zoho invoice record id out and back; it is unbounded, so the full id
fits. Anything failing a check is logged and left for a human — the invoice is never silently
marked paid.

Published iCredit source IPs (`82.80.194.52`, `81.218.62.41`, `31.168.238.28`) are recorded
in the deployment doc for customers who front Zoho with an allowlist; the function itself
cannot see the source IP and does not rely on it.

## 9. Reconciliation — ⚠ rebuilt, and far cheaper

Revision 1 assumed payment state had to be reconstructed by listing receipts and fetching
each one's detail. The current API exposes it directly.

**`Customer.OpenDocuments` is the backbone.** One free call with `customer_id: 0` returns
every open document in the business with `total_amount`, **`paid_amount`**, `balance`,
`due_date` and `issue_date` — the entire receivables position, partial payments included.

```
rv_reconcile (scheduled, every 6h)
  1. Customer.OpenDocuments(customer_id: 0, accounting_only: true)
       → match rows to CRM invoices on (document_type, document_number)
       → set Rivhit_Paid_Amount, Rivhit_Payment_Status, Rivhit_Is_Closed = false
  2. CRM invoices that are issued-but-absent from the open list
       → they closed since the last run: Document.Details to confirm
         (is_closed, is_cancelled, receipt_total) and finalise
  3. Document.List over the window
       → catch documents issued directly in Rivhit; flag as unlinked
       → catch confirmation_number gaps on CRM-known invoices
  4. Customer.List → refresh balances inline (one call, not one per account)
  5. Emit a run summary: scanned / matched / updated / unmatched / errors
```

**Single-invoice refresh** uses `Document.Details`, which returns `is_closed`,
`is_cancelled`, `document_total`, `receipt_total`, `total_vat`, `confirmation_number`, and
per-item `is_closed` — everything the UI needs in one call.

**Payments we initiate** are known at write time: the receipt is issued with
`closed_document_type` / `closed_document_number` / `document_is_receipt`, so CRM is updated
from the response without waiting for a poll.

All of the above are reads, so reconciliation costs nothing against the document quota.
Loops stay sequential.

### Closing model

Documents are created **open**. The design uses:

- **at creation** — `closed_document_type` + `closed_document_number` + `document_is_receipt`
- **partial, by line** — item-level `closed_document_type` / `closed_document_num` /
  `closed_document_line` (note the `_num` vs `_number` inconsistency)
- **retroactive** — `Document.Close` with `closing_type` / `closing_number` / `amount_close`
- **manual settlement** — `Document.Close` with `closing_type: 0`, `closing_number: 0`,
  `document_is_receipt: true` — for payments settled entirely outside the system
- **`Document.Reopen`** to reverse a close

### Cancellation

`Document.Cancel` issues the reversing credit document itself and returns its type, number,
identity and link — revision 1's hand-built credit note is only needed for **partial**
refunds, which still require `Document.New` with negative amounts.

> An **Invoice-Receipt (type 2) requires both** `Document.Cancel` and `Receipt.Cancel`, each
> with the same number. Calling only one leaves the books half-reversed. The cancel flow
> checks `is_invoice_receipt` and issues both, treating them as a single unit of work with a
> shared audit note.

### Israel Tax Authority confirmation numbers

For businesses in the חשבוניות ישראל regime, a qualifying invoice without an allocation
number is a compliance defect — the customer may be unable to deduct input VAT.

- `Document.New` returns `confirmation_number`; it is persisted and shown on the invoice.
- Missing on a qualifying document → `Rivhit_Confirmation_Status = Missing`, surfaced in the
  AR report's exceptions section, and retried by `rv_confirmation` via
  `Document.InvoiceApproval`.
- `rv_reconcile` re-checks for gaps using `Document.List`, which returns
  `confirmation_number` in bulk.
- The integration must run under the **same Rivhit user account that owns the API token**, or
  numbers are never issued at all. This is a deployment check, not a runtime one.

## 10. Platform constraints these designs must respect

Collected from `morning-invoice-bridge` and the Health Check extension. Each has cost a
release cycle at least once.

**Widget side**
- Widgets must be **self-contained**. Zoho's widget CDN intermittently 404s shared asset
  files, so a build step inlines shared JS/CSS into every widget HTML.
- `ZOHO.CRM.API.coql` and `searchRecords` are **unavailable** in the embedded widget SDK. Use
  `getAllRecords` with pagination. (Both *are* available in Deluge.)
- Org-variable **writes** from widget JS return 400. Reads work.
- The SDK sometimes rejects promises with bare objects (no `.message`) — normalise before
  displaying, or the user sees `[object Object]`.
- Ship a build marker and log it; it is the only reliable proof the new bundle loaded.

**Deluge side**
- Paste the **body only**. A signature line in the body is a syntax error.
- Arguments arrive inside `crmAPIRequest`; `arguments.get()` does not compile. Check
  `.get("body")`, `.get("params")` and `.get("arguments")`.
- Every function needs a **guaranteed top-level `return`**. A return inside `try/catch` does
  not satisfy the compiler.
- `sendmail` must be followed by `return "done";`.
- `addAll` is unreliable; build lists with explicit `add` in a loop.
- External HTTP is `invokeurl`, not `ZOHO.CRM.HTTP`.

**CRM writes**
- One rejected field kills the **entire** `updateRecord` call. Write critical fields first,
  then best-effort extras in a separate call, with a drop-the-rejected-field-and-retry helper
  that logs every drop.
- DateTime fields require ISO 8601 **with a timezone offset**.
- Currency fields must be declared 16,2 or writes fail.

**Rivhit protocol**
- Errors arrive as **HTTP 200 or 500 with a negative `error_code`**. Never branch on HTTP
  status alone. HTTP 400 returns **HTML**, not JSON — parse defensively.
- Show `client_message` (Hebrew, user-facing); log `debug_message` (English identifier).
- `error_code -2` (`NO_DATA_FOUND`) on a list call means "empty", not "broken".
- ⚠ Dates are **`DD-MM-YYYY` or `DD/MM/YYYY`**, not `DDMMYYYY`. Responses return
  `DD/MM/YYYY`.
- ⚠ `Document.List` / `Receipt.List` default to **the current day** if no range is sent.
  Always send an explicit `from_date` / `to_date`.
- `send_mail` defaults to **true** — it emails the customer unless told otherwise.
- Truncate every string to the documented field length before sending.

## 11. Build, test, and source-of-truth discipline

The Green Invoice audit's top finding was that the source of truth was a zip file passed
through chat sessions. This repo starts the other way round.

- **Everything versioned here**: widget sources, all Deluge bodies, docs, build script. A
  Deluge function that exists only inside Sigma does not exist.
- **`build.py`** validates the manifest, syntax-checks every inline script block after
  inlining, enforces one `VERSION` across manifest/markers/zip, and refuses to build if unit
  tests fail.
- **Unit tests (`node --test`, stub `ZOHO` global)** over the pure functions that carry the
  financial risk:
  - `mapInvoiceToRivhitDocument` — golden-payload fixture
  - line/VAT/total arithmetic and the payments-equal-items invariant
  - `request_reference` derivation and stability
  - the 9-character `acc_ref` surrogate — determinism and collision behaviour
  - payment-method → `payment_type` mapping, including the unmapped case
  - envelope parsing: `error_code 0`, negative codes, `-2`, HTTP-500-with-body, HTML-on-400
  - `DD/MM/YYYY` formatting and parsing, both directions
  - field-length truncation
  - IPN decision logic — all four checks, each failing independently, plus the duplicate-
    delivery path
- **Money logic lives in Deluge only.** In the Green Invoice bridge, `parseDocumentStatus`
  and its Deluge twin drifted and shipped the same wrong enum in both. Widgets render what
  the function returns.
