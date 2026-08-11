# Rivhit & iCredit API — distilled notes

**Revision 2 — verified against the live documentation** (`rivhit-api.readme.io`, OpenAPI
specs, retrieved 2026-08-11). Revision 1 was based on the 2015 vendor PDF, which is
substantially out of date; every correction is marked **⚠ CHANGED**.

Source of record: `https://rivhit-api.readme.io/llms.txt` indexes every page and every
OpenAPI spec. Fetch that first in any future session.

---

## 1. Protocol

| | |
|---|---|
| Base URL | `https://api.rivhit.co.il/online/RivhitOnlineAPI.svc/<Method>` |
| Method | **POST**, JSON in / JSON out |
| Auth | `api_token` as a **field in the request body**. No OAuth, no header, no expiry. |
| Environments | **⚠ CHANGED — there is no separate sandbox host.** Test and production share the same URL; you test by using a test *account*. |
| API availability | Rivhit **Online** and **Invoice Online** only. The desktop version has no API. |

**Response envelope:**

```json
{ "error_code": 0, "client_message": "", "debug_message": "", "data": { ... } }
```

- `error_code = 0` → success. **⚠ CHANGED — error codes are negative integers**
  (`-2`, `-22`, `-28` …), not the string constants in the 2015 PDF. `debug_message` carries
  the English identifier in the form `-28 : INVALID_ID_NUMBER`.
- `client_message` is Hebrew and user-facing; `debug_message` is English and for logs.
- Non-zero `error_code` may arrive with HTTP 200 **or** HTTP 500. Branch on `error_code`.
- HTTP 400 returns an **HTML** error page from the WCF layer, not JSON — usually a malformed
  body or a wrong `Content-Type`. Parse defensively.

**Selected error codes** (full table: `docs/api-error-codes`):

| Code | Meaning |
|---|---|
| `-1` | general database error |
| `-2` | `NO_DATA_FOUND` — empty result, not a failure |
| `-20` / `-22` | customer does not exist |
| `-23` / `-43` | document type does not exist |
| `-24` | item does not exist |
| `-28` / `-29` | invalid ת.ז / ע.מ (check digit) |
| `-44` | invalid אסמכתא |
| `-45` | `order` field too long (limit 80) |
| `-46` | `comments` too long (limit 400) |
| `-51` | item price code invalid — with/without VAT mismatch |
| `-52` | invalid due date |
| `-68` | mixed currencies in one foreign-currency document |
| `-73` | no VAT account defined |
| `-76` / `-77` | document does not exist / invalid number |

### Dates — ⚠ CHANGED

Not `DDMMYYYY`. Requests accept **`DD-MM-YYYY` or `DD/MM/YYYY`**; responses return
**`DD/MM/YYYY`**. Times are `HH:MM` in, `HH:MM:SS` out.

### Test account

Same production URL, with these credentials
(<https://online1.rivhit.co.il/loginmanager/login>):

| | |
|---|---|
| API token | `DECD03E5-E35C-41E8-84F7-FBA2FB483928` |
| User / password | `demo` / `123` |
| VAT number | `123` |

> All test-account data is visible to every other test user — never put real customer data
> in it, and never issue real legal documents from it. **The demo account is not connected to
> iCredit**, so card flows cannot be tested there; a separate iCredit test token is required.

### Rate limits and pricing

- **No rate limits are documented anywhere** in the current documentation (verified by an
  exhaustive search of all 150 pages). Keep loops sequential and ask `api@rivhit.co.il`.
- **The document-volume pricing tiers are not in the online documentation either.** The
  figures in revision 1 (₪19/50 … ₪119/1000, ex-VAT) come only from the 2015 PDF and should be
  treated as indicative — confirm the current commercial terms before relying on them. The
  *principle* stands regardless: issuance is metered, reads are not.

## 2. Method inventory

Far larger than the 2015 PDF suggested. Full list in `llms.txt`; the ones that matter here:

**Documents** — `New`, `Details`, `Last`, `List`, `Cancel`, `Close`, `Reopen`, `Copy`,
`Copies`, `TypeList`, `InvoiceApproval`
**Receipts** — `New`, `Details`, `Last`, `List`, `Cancel`, `Copy`, `Copies`, `TypeList`
**Customers** — `New`, `Get`, `List`, `Update`, `Delete`, `Balance`, `TypeList`,
`OpenDocuments`, `ClosedDocuments`, `JournalReport`
**Items** — `New`, `List`, `Details`, `Update`, `Delete`, `History`, `Quantity`,
`SaleReport`, `StorageReport`, `Groups`; `ItemGroup.New/Update/Delete`
**Reference** — `Payment.TypeList`, `Payment.BankList`, `Payment.Report`, `Currency.List`,
`PriceList.List/Items`, `Storage.New/List`, `Project.New/List`,
`Accounting.SortCodeList`
**Accounting** — `AddJournal`, `JournalsReport`, `PnLReport`, `VatReport`
**Company** — `Details`, `Update`, `SetStartNumber`, `SummaryReport`
**Recovery** — `Status.LastRequest/{FORMAT}`, `Status.AllRequests/{FORMAT}`

## 3. `Document.New` — the central write

Mandatory: `api_token`, `document_type`, `customer_id`, `items[]`.

### Parameters this design depends on

| Param | Notes |
|---|---|
| `check_only` | **⚠ NEW — dry run.** Validates and returns status + error without creating anything. Revision 1 wrongly claimed no preview exists. |
| `request_reference` + `prevent_duplicates` | Idempotency (§6) |
| `sort_code` | **⚠ NEW meaning — this is the VAT switch.** `100` = with VAT, `150` = exempt. Defaults are per-business. |
| `price_include_vat` | Whether item prices include VAT (§5) |
| `round_digits` | **⚠ NEW.** `0` = X.00, `1` = X.X0, `2` = X.XX. **Only works with `price_include_vat:false`**, and only on document types without a receipt. The rounding remainder is posted into the discount line. |
| `closed_document_type` / `closed_document_number` | Close an existing document with this one (§7) |
| `discount_type` / `discount_value` | `1` = percent, `2` = amount |
| `currency_id` | `1` NIS · `2` USD · `3` EUR · `4` GBP · `5` AUD · `6` CAD · `7` CHF · `8` SEK · `9` DKK · `10` NOK |
| `language` | `he` / `en` (default `he`) |
| `email_to`, `email_bcc`, `send_mail`, `default_email`, `digital_signature`, `signature_pin`, `thermal_print` | Mailing and PDF options (§8) |
| `create_customer`, `find_by_mail`, `find_by_id`, `find_by_phone`, `find_by_acc_ref` | **⚠ `find_by_phone` and `find_by_acc_ref` are new** — inline customer matching |
| `validate_id` | `false` = a malformed ת.ז/ע.מ is dropped instead of failing the call |
| `document_number` | Sets the starting number — first document only |
| `issue_date` / `issue_time` | Omitted → the time of the call. Back-dating is the business's legal responsibility. |
| `reject_item_quantity`, `no_update_inventory`, `storage_id` | Inventory behaviour |
| `logo_url`, `crm_user_id`, `agent_id`, `project_id`, `paying_customer_id`, `reference`, `order` | Metadata |

**Overload fields** (`last_name`, `first_name`, `address`, `city`, `zipcode`, `phone`,
`id_number`, `acc_ref`, `country`, `state`, `foreign_zipcode`) override the customer card for
this document only.

### Items array

`item_id`, `catalog_number`, `quantity`, `description`, `storage_id`, `bruto_price_nis`,
`price_nis`, `currency_id`, `exchange_rate`, `price_mtc`, `serial_number`, `exempt_vat`,
plus the partial-closing trio `closed_document_type`, **`closed_document_num`**,
`closed_document_line`.

> ⚠ Note the inconsistency: item level is `closed_document_num`, document level is
> `closed_document_number`. Getting this wrong silently skips the closing.

Resolution order: `item_id ≠ 0` wins; else `catalog_number` is looked up; else
`create_items:true` creates it; else the generic item (`item_id 0`) is used. No description →
the item card's; no price → **0**; no storage → the item card's.

### Response

`document_type`, `document_number`, `document_identity` (GUID), `document_link` (PDF),
`print_status`, `customer_id`, **`amount`** (the total as Rivhit computed it), and
**`confirmation_number`** (§4).

### Field length limits — the mapper must truncate

`last_name` 30 · `first_name` 20 · `address` 30 · `city` 20 · `phone` 15 · `email` 50 ·
`comments` 400 · `order` 15 (the error table says 80 — treat 15 as safe) ·
item `description` 100 · `catalog_number` 15 · `serial_number` 6 · payment `description` 30 ·
**`acc_ref` 9** (§9).

## 4. Israel Tax Authority confirmation number — ⚠ NEW, and legally significant

Israel's *חשבוניות ישראל* regime requires an allocation number (מספר הקצאה) from the Tax
Authority for invoices above a rolling threshold. Rivhit brokers this:

- Enabled per account in Rivhit Online / Invoice Online settings. **The integration must run
  under the same user account that owns the API token** — otherwise numbers are not issued.
- `Document.New` returns `confirmation_number` in its response.
- If a document is issued **without** one because the Tax Authority link was down,
  `Document.InvoiceApproval` (`document_type`, `document_number`, `id_number` of the
  approver) acquires it retroactively and returns `confirmation_number`.
- `Document.Details` and `Document.List` both return `confirmation_number`, so the gap is
  detectable in bulk.

A missing confirmation number on a qualifying invoice is a **compliance defect**, not a sync
glitch: the customer may be unable to deduct the input VAT. It needs a CRM field, a visible
state, and a retry path.

## 5. VAT and totals — the rules, verified

Two independent switches:

- **`sort_code`** — whether the *document* charges VAT. `100` with VAT, `150` exempt.
- **`price_include_vat`** — whether the *prices you send* already include VAT.

| Document shape | `price_include_vat` | What you must send |
|---|---|---|
| With `payments[]` (Invoice-Receipt) | `true` | Items total **equals** payments total. Rivhit extracts and displays the VAT. |
| With `payments[]` | `false` | Items total **excludes** VAT; payments total **includes** it. You compute the VAT. |
| Items only (Invoice, Delivery Note…) | `true` | Total is exactly what you sent. |
| Items only | `false` | Rivhit adds VAT on top of what you sent. |

**This confirms revision 1's recommendation:** send `price_include_vat: true` with gross
prices and make the payments total equal the items total exactly. Rivhit then derives the VAT
itself and there is nothing to disagree about. Take the rate from `Accounting.VatRate` when
you need to *display* it — never from a constant.

`round_digits` is incompatible with that choice (it requires `price_include_vat:false`), so
automatic rounding is only available on non-receipt document types. Round in the mapper
instead.

## 6. Idempotency and recovery — confirmed and extended

`request_reference` (unique string) + `prevent_duplicates: true` on `Document.New`,
`Receipt.New`, and **also** `Document.Close` and `Document.Cancel`. `Status.LastRequest` /
`Status.AllRequests` replay the original response for a reference.

The vendor's own guidance matches this design: generate a fresh key per distinct operation,
never reuse across unrelated operations, store keys with their results, and only retry in a
way that respects the mechanism.

**With `check_only` available, the safe write sequence becomes:**

```
1. check_only:true   → validate; free, creates nothing
2. real call          → with request_reference + prevent_duplicates
3. on ambiguity       → Status.LastRequest, never a retry
```

## 7. Closing documents — ⚠ RESOLVED (was the biggest unknown)

Every document is created **open**. Closing marks payment received (closed by a receipt) or
goods delivered (closed by an invoice). Typical chains: Order → Invoice or Invoice-Receipt;
Invoice → Receipt; Delivery Note → Invoice-Receipt.

**At creation** — on `Document.New` / `Receipt.New`:
`closed_document_type`, `closed_document_number`, and `document_is_receipt`
(`true` = closing with a receipt, `false` = with a document; default `false`).
Rivhit auto-appends a comment naming the closed document.

**Partial, by item line** — in the items array: `closed_document_type`,
`closed_document_num`, `closed_document_line` (1-based position in the source document).

**Retroactively** — `Document.Close`:
`document_type` + `document_number` (to close), `closing_type` + `closing_number` (the
closer), `amount_close`, `closing_date`, `document_is_receipt`, `request_reference`.
Returns `data.status`.

**Manually, with no closing document** — `Document.Close` with `closing_type: 0`,
`closing_number: 0`, `document_is_receipt: true`, and an `amount_close`. This supports
partial manual settlement.

**`Document.Reopen`** reverses a close.

## 8. Cancellation and refunds — ⚠ CHANGED

**Full cancellation** — `Document.Cancel` / `Receipt.Cancel`. Send type + number; Rivhit
issues the reversing document itself (a credit invoice, type 3 by default) and auto-comments
the link. Response gives `cancel_document_type`, `cancel_document_number`,
`cancel_document_identity`, `cancel_document_link`. Also accepts `cancellation_date`,
`cancellation_time`, `language`, `email_to`, `comments`, `request_reference`.

> **An Invoice-Receipt (type 2) needs BOTH calls** — `Document.Cancel` reverses the invoice
> part, `Receipt.Cancel` the receipt part, each with the same number. Doing only one leaves
> the books half-reversed.

**Partial or modified refunds** still require `Document.New` / `Receipt.New` with **negative**
amounts, using the credit document type, and a comment linking back to the original.

Revision 1's "build the credit note by hand" flow is therefore only needed for partial
refunds.

## 9. Customers — ⚠ one design-breaking constraint

`Customer.New/Get/List/Update/Delete/Balance/TypeList`. `Customer.Get` matches on
`customer_id` | `email` | `acc_ref`. `Customer.Update` only changes the fields you send.
`Customer.Delete` works only if the customer has no documents.

Inline matching on `Document.New`/`Receipt.New`: `create_customer` plus any of
`find_by_mail`, `find_by_id`, `find_by_phone`, **`find_by_acc_ref`**. Passing
`customer_id: 0` forces creation.

Customer types: `1` customers · `20` suppliers · `40–59` income/expense codes · `60` agents.

> ### ⚠ `acc_ref` is limited to 9 characters
>
> Revision 1 proposed storing the Zoho CRM record id in `acc_ref` as a bidirectional key.
> **Zoho record ids are 18–19 digits and do not fit.** See `ARCHITECTURE.md` §4.2 for the
> replacement scheme.

## 10. Reading payment state — ⚠ RESOLVED, and much cheaper than planned

Revision 1 assumed payment state had to be reconstructed from `Receipt.List` plus a
`Receipt.Details` call per receipt. It does not.

**`Customer.OpenDocuments`** — the AR aging report (דו"ח גיול חובות) in one call.
Request: `customer_id` (`0` = all), `document_type`, `from_date`, `until_date`,
`by_produce_date`, `accounting_only`, `no_accounting`, `agent_id`.
Each row returns `document_type`, `document_number`, `issue_date`, `due_date`,
**`total_amount`**, **`paid_amount`**, `balance`, `customer_id`, `customer_name`,
`currency_id`, `reference`, `order`.

That is the entire receivables position, with per-document partial-payment amounts, in a
single free call.

**`Document.Details`** — everything about one document: `is_closed`, `is_cancelled`,
`document_total`, **`receipt_total`**, `total_vat`, `total_without_vat`, `vat_percent`,
`confirmation_number`, `sort_code`, `price_include_vat`, discount fields, the full `items[]`
(each with its own `is_closed` and `line`), and the full `payments[]`.

**`Document.List`** — bulk listing, now also returning `is_closed`, `is_cancelled`,
`confirmation_number`, `document_link`, `due_date`, `total_vat`, `amount`, `amount_exempt`,
`document_type_name`, `is_accounting`. Filters include `from/to_document_number` and a
generic `filter_fields[]` array. Dates default to the current day, so always send an explicit
range.

**`Customer.ClosedDocuments`**, **`Customer.JournalReport`** (כרטסת), **`Payment.Report`**,
**`Accounting.VatReport`**, **`Accounting.PnLReport`**, **`Company.SummaryReport`** are
available for richer reporting. `Customer.List` returns each customer's balance inline, so
bulk balance refresh is one call, not one per account.

## 11. Payments array

`payment_type`*, `amount_nis`*, `due_date`, `description` (≤30), `bank_code`,
`branch_number`, `bank_account_number`, `check_number`, `amount_mtc`, `number_of_payments`.

Rivhit's **default** type codes — still per-business, still discover via `Payment.TypeList`:

| Method | `payment_type` | Also required |
|---|---|---|
| Check | `1` | `bank_code`, `branch_number`, `bank_account_number`, `check_number` |
| Cash | `2` | — |
| Credit card | `4`–`8` (4 Isracard, 5 Visa) | `bank_account_number` = last 4 digits, `check_number` = voucher no. |
| Bank transfer | `9` | `bank_code`, `branch_number`, `bank_account_number`, `check_number` = reference |
| Custom types | as configured | behaves like cash |

`number_of_payments` replicates one equal payment row across consecutive months, generating
consecutive check numbers.

## 12. Mailing and PDFs

`send_mail` (default **true** — it will email the customer unless you say otherwise),
`email_to`, `email_bcc` (only sent if `email_to` is set), `default_email` (pull from the
customer card, only when `email_to` is empty), `digital_signature` (also required to get a
signed original PDF link back in the response), `signature_pin`, `thermal_print`.

PDF link shape:
`https://api.rivhit.co.il/pdf/FileService.svc/GetDocument/{companyId}/{document_identity}/true`

## 13. iCredit

| | |
|---|---|
| Test | `https://testicredit.rivhit.co.il/API/...` |
| Prod | `https://icredit.rivhit.co.il/API/...` |
| Auth | `GroupPrivateToken` |

**Choosing a method.** For a CRM widget the answer is **`GetUrl`** — the hosted page carries
PCI compliance, creates the sale in iCredit's sales report, can auto-issue the
document/receipt, emails the customer, and fires the IPN. `ChargeSimple` collects card data
on your own page and is only appropriate for locally installed applications; it also does
*not* create a sale record, only a transaction.

**`GetUrl`** request highlights: `Items[]`, `RedirectURL`, `IPNURL`, `IPNFailureURL`,
`IPNMethod` (1 POST / 2 GET), `ExemptVAT`, `PriceIncludeVAT`, `MaxPayments`, `MinPayments`,
`NumberOfPayments`, `CreditFromPayment`, `DocumentLanguage`, `SendMail`, `Discount`,
`Currency`, `CreateCustomer`/`FindByMail`/`FindById`/`FindByPhone`, `CustomerId`,
`FailRedirectURL` + `MaxFailedAttempts`, `SaleType` (1 immediate / 2 pending J5 / 3 token
only), `Custom1`–`Custom9`.
Response: `Status` (0 = success), `URL`, `PrivateSaleToken`, `PublicSaleToken`, `DebugMessage`.

> `Custom1`–`Custom9` are unbounded, so a Zoho record id fits comfortably. This is the
> correlation key that comes back in the IPN.

**`Verify`** — POST `{GroupPrivateToken, SaleId, TotalAmount}` → `{Status}`; require
`"VERIFIED"`.

**Other operations**: `SaleDetails`, `CancelSale`, `SaleChargeToken` (charge a saved token),
`CreateSale`/`CompleteSale`, `ChargeSimple` and `ChargeSimple/Full`, refunds, full recurring-
sale CRUD, pending/J5 (`ChargePendingSale`, `ReleaseJ5`), 3DS authentication, Google Pay,
Apple Pay, and PIN-pad devices. iCredit has its own idempotency pair: `RequestReference` +
`PreventDuplicates`.

### IPN — ⚠ the 1.25-second rule

> The merchant server must return **200 OK within 1.25 seconds**, or iCredit **resends** the
> message.

A Zoho Deluge REST function will frequently not answer that fast. **Duplicate IPNs are
therefore normal operation, not an attack.** Replay protection stops being purely a security
control and becomes load-bearing for correctness.

Other facts that shape the handler:

- **Failures go to `IPNURL` too** unless a separate `IPNFailureURL` is supplied — and a
  failure IPN fires on *every* failed charge attempt. The handler must distinguish success
  from failure, or the design must always set `IPNFailureURL`.
- Only ports **80** and **443** are allowed; the whole URL path must be publicly reachable.
- iCredit source IPs: `82.80.194.52`, `81.218.62.41`, `31.168.238.28`.
- `IPNMethod: 2` (GET) sends **only** `SaleId`; fetch the rest with `SaleDetails`.
- Payload varies by sale type (immediate / J5 / token-only / recurring).
- Verification is always `Verify` with `GroupPrivateToken`, `SaleId`, `TotalAmount`.

## 14. Still unverified

Short list now, and none of it blocks Phase 3.

| Item | Why it matters | How to close it |
|---|---|---|
| Current document-volume pricing | Quota warnings and the commercial case | Ask `api@rivhit.co.il`; not published online |
| Rate limits | Loop pacing | Ask the vendor; nothing documented |
| Whether Rivhit core emits webhooks | Would remove polling for bookkeeper-entered payments | Ask the vendor; only iCredit has an IPN |
| `Document.Close` on an Invoice-Receipt | Whether closing applies to the invoice half only | Test on the demo account |
| Confirmation-number threshold behaviour | When Rivhit does and does not request one | Test on the demo account with the setting on |
| `Status.LastRequest` retention window | How long recovery stays possible | Ask the vendor |
