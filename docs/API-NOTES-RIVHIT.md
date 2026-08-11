# Rivhit & iCredit API — distilled notes

Working reference for the implementation. Everything in §1–§6 is from the supplied vendor
PDFs and can be relied on. §7 lists what is **not** verified and must be confirmed against a
live account before the code that depends on it is written.

---

## 1. Protocol

| | |
|---|---|
| Base URL | `https://api.rivhit.co.il/online/RivhitOnlineAPI.svc/<Method>` |
| Exception | `Accounting.AddJournal` → `https://api.rivhit.co.il/api/RivhitWebRestAPI.svc/Accounting.AddJournal` |
| Method | **POST** for every operation |
| Content | JSON or XML, both directions |
| Auth | `api_token` as a **field in the request body**. No OAuth, no header, no token exchange, no expiry. |

**Response envelope — always this shape:**

```json
{ "error_code": 0, "client_message": "", "debug_message": "", "data": { ... } }
```

- `error_code = 0` → success. **Non-zero arrives with HTTP 200.** Never branch on HTTP status.
- `client_message` — safe to display to end users.
- `debug_message` — for logs only.
- Common codes: `UNAUTHORIZED (401)` bad token, `NO_DATA_FOUND (204)` empty result.

**Obtaining a token:** Rivhit Online → הגדרות → API → הצג API TOKEN.
Vendor-published demo account (from the PDF, for development only):
`api_token = decd03e5-e35c-41e8-84f7-fba2fb483928`, user `demo`, password `123`,
company id `123`.

**Dates are `DDMMYYYY` strings.** Not ISO, not `DD/MM/YYYY`. Applies to `due_date`,
`from_date`, `to_date`, `reference_date`, `issue_date`.

## 2. Pricing and quota — a design constraint, not a footnote

Read operations are free. **Document issuance (`Document.New`, `Receipt.New`) is metered and
billed monthly**, ex-VAT:

| Documents / month | Price |
|---|---|
| 0 | free (no issuance) |
| up to 50 | ₪19 |
| up to 200 | ₪39 |
| up to 500 | ₪69 |
| up to 1000 | ₪119 |

Consequences the design must honour: no blind retries on writes, no adaptive
"try-another-total" loops, a visible monthly counter, and recovery via `Status.LastRequest`
instead of re-issuing.

Vendor contact for quota/questions: `api@rivhit.co.il`.

## 3. Methods (2015 PDF, v2.0.1.1)

### Customer — כרטיסי לקוחות
| Method | Purpose | Key params | Returns |
|---|---|---|---|
| `Customer.List` | list by card type | `customer_type` | `customer_list[]` |
| `Customer.New` | create | `last_name`* , `first_name`, `address`, `city`, `pob`, `zipcode`, `phone`, `fax`, `email`, `id_number`, `vat_number`, `agent_id`, `project_id`, `paying_customer_id`, `price_list_id`, `comments`, `customer_type`, `pal_code`, `acc_ref`, `country`, `state`, `foreign_zipcode`, `currency_id`, `exampt_vat`, `request_reference` | `customer_id` |
| `Customer.Update` | update | `customer_id`* + any of the above | `update_success` |
| `Customer.Balance` | current balance | `customer_id`* | `balance` |
| `Customer.Get` | find one | **one of** `customer_id` \| `email` \| `acc_ref` | full customer object |

\* mandatory (besides `api_token`).

- `Customer.Update` changes **only the fields you send**; omitted fields are untouched.
- `Customer.Get` with multiple identifiers matches on **all** of them.
- `acc_ref` is a free-text "foreign number" — this design stores the Zoho record id there.
- `id_number` / `vat_number` are **check-digit validated** (`INVALID_ID_NUMBER`,
  `INVALID_VAT_NUMBER`).
- `currency_id` on a customer requires a foreign-currency card (`pal_code`).

### Item — פריטים
`Item.List` (`item_group_id`) · `Item.New` (`item_name`*, `item_part_num` = מק"ט, `barcode`,
`supplier_id`, `item_group_id`, `storage_id`, `cost_nis`, `sale_nis`, `currency_id`,
`exchange_rate`, `cost_mtc`, `sale_mtc`, `item_name_english`, `item_extended_description`)
→ `item_id` · `Item.Update` (`item_id`*) · `Item.Quantity` (`item_id`*, `storage_id`) →
`quantity` · `Item.Groups` · `Item.StorageList`

Omitting `storage_id` on `Item.Quantity` returns the total across all warehouses.

### Document — מסמכים
`Document.New` — the central write.

Mandatory: `api_token`, `document_type`, `customer_id`, `items[]`.

Notable optional params:

| Param | Note |
|---|---|
| `last_name`, `first_name`, `address`, `city`, `zipcode`, `phone`, `id_number` | **Overload** — override the customer card *on this document only* |
| `reference` | אסמכתא (int) |
| `order` | order reference (string) |
| `comments` | max **400 chars** (`COMMENTS_SIZE_TO_BIG`) |
| `discount_type` | `1` = percent (`discount_value` 0–100), `2` = fixed amount |
| `price_include_vat` | if omitted, the system default for that document type applies |
| `due_date` | `DDMMYYYY` |
| `currency_id`, `exchange_rate` | item currency must match the document currency |
| `reject_item_quantity` | fail if an item is out of stock |
| `no_update_inventory` | do not decrement stock even if the type says to |
| `language` | `"en"` for English, anything else = Hebrew |
| `email_to`, `email_bcc`, `send_mail` | **`send_mail` defaults to `true`** |
| `digital_signature`, `signature_pin` | requires the digital-signature module |
| `crm_user_id` | requires Rivhit's own CRM module |
| `payments[]` | **only** for `is_invoice_receipt` types; ignored elsewhere |
| `issue_date`, `issue_time` | omitted → the API call's own timestamp. The business bears full responsibility for back-dating. |
| `create_items`, `create_customer`, `find_by_mail`, `find_by_id` | on-the-fly creation / matching |
| `request_reference` + `prevent_duplicates` | idempotency (§5) |

**Items array:** `item_id`, `catalog_number`, `quantity`, `description`, `storage_id`,
`bruto_price_nis`, `price_nis`, `currency_id`, `exchange_rate`, `price_mtc`, `serial_number`,
`exempt_vat`.

Item resolution order:
- `catalog_number` set **and** `item_id` is `0` → Rivhit looks up by מק"ט; if found, uses it.
- Not found and `create_items = true` → creates the item and uses it.
- Not found and no `create_items` → falls back to the **generic item** (`item_id` 0).
- `item_id` ≠ 0 always wins over `catalog_number`.
- No description → the item card's description. No price → **0**. No storage → the card's.

**Response:** `document_type`, `document_number`, `document_identity` (GUID),
`document_link` (PDF URL), `print_status`, `customer_id`.

PDF link shape:
`https://api.rivhit.co.il/pdf/FileService.svc/GetDocument/{companyId-padded-9}/{document_identity}/true`
— reconstructible from `Company_ID` + `document_identity`.

`Document.TypeList` → per-company list of `{document_type, document_name, is_invoice_receipt,
is_accounting, price_include_vat}`. **Call this; do not hardcode.** The PDF's example
(1 = חשבונית מס, 2 = חשבונית מס קבלה, 3 = חשבונית מס זיכוי, 4 = תעודת משלוח) is one company's
configuration, not a standard.

`Document.List` → `from/to_document_type`, `from/to_customer_id`, `from/to_date` (DDMMYYYY),
`from/to_agent_id`. Returns `{document_type, document_number, document_date, document_time,
amount, customer_id, agent_id}`. **Defaults to the last 6 months. Carries no payment status.**

### Receipt — קבלות
`Receipt.New` — mandatory `receipt_type`, `customer_id`, `payments[]`. Same overload,
language, email, signature, `issue_date/time`, `create_customer`/`find_by_*`,
`request_reference`/`prevent_duplicates` options as `Document.New`.

**Payments array:** `payment_type`* , `amount_nis`* , `due_date` (DDMMYYYY), `description`,
`bank_code`, `branch_number`, `bank_account_number`, `check_number`, `amount_mtc`,
`number_of_payments`.

- Checks require the full set: `bank_code`, `branch_number`, `bank_account_number`,
  `check_number`.
- Credit cards: voucher number → `check_number`; card last-4 → `bank_account_number`.
- `number_of_payments` splits the receipt into rows with consecutive monthly due dates.
- A receipt type that is part of an invoice-receipt cannot be issued standalone.

`Receipt.TypeList` → `{receipt_type, receipt_name, is_invoice_receipt}`.
`Receipt.List` → same window/filters as `Document.List`; last 6 months by default.

### Accounting / Currency / Payment
- `Accounting.VatRate` → `vat_rate`. **The only correct source of the VAT rate.**
- `Accounting.AddJournal` — journal entries (different base URL). Out of scope for v1.
- `Currency.List` → `{currency_id, currency_name, iso_code}` (1 = ILS, 2 = USD, 3 = EUR in
  the example).
- `Payment.TypeList` → `{payment_type, payment_name, type_code}` — **per company**.
- `Payment.BankList` → `{bank_code, bank_name}`.

### Status — request recovery
- `Status.LastRequest/{FORMAT}` — `request_reference`* → replays the **last** response for
  that reference.
- `Status.AllRequests/{FORMAT}` — → array of **all** responses for that reference.
- `{FORMAT}` is `XML` or `JSON` in the path, e.g.
  `.../Status.LastRequest/JSON`.

## 4. Invoice-receipt rules (`is_invoice_receipt = true`)

1. `payments[]` is required; it is ignored by all other document types.
2. The payments total **must equal the document total including VAT**, or
   `DIFFERENT_AMOUNT_BETWEEN_INVOICE_AND_RECEIPT`.
3. Determine which types qualify from `Document.TypeList` → `is_invoice_receipt`.
4. Other relevant errors: `RECEIPT_MISSING_PAYMENTS_RECORDS`,
   `DOCUMENT_CREATE_RECEIPT_ERROR`.

## 5. Idempotency

`request_reference` (string, caller-supplied) + `prevent_duplicates = true`: a second write
carrying the same reference is refused with a duplicate-operation error. `Status.LastRequest`
then returns what the first attempt produced. Supported on `Customer.New`, `Customer.Update`,
`Item.New`, `Item.Update`, `Document.New`, `Receipt.New`, `Accounting.AddJournal`.

This is the single most important feature of the API for this integration: it converts
"the connection dropped mid-issue" from a duplicate tax document into a recoverable state.

## 6. iCredit payment gateway

| | |
|---|---|
| Test | `https://testicredit.rivhit.co.il/API/PaymentPageRequest.svc/` |
| Prod | `https://icredit.rivhit.co.il/API/PaymentPageRequest.svc/` |
| Auth | `GroupPrivateToken` in the body |
| Ops | `GetUrl`, `Verify`, `ChargeSimple` |

**`GetUrl`** → returns a payment-page URL, displayable as redirect, iframe, or popup.
Request: `GroupPrivateToken`, `Items[]` (`Id` always 0, `CatalogNumber`, `UnitPrice`,
`Quantity`, `Description`), `RedirectURL`, `IPNURL`, `ExemptVAT`, `MaxPayments`,
`CreditFromPayment`, customer fields (`CustomerLastName`, `CustomerFirstName`,
`EmailAddress`, `Address`, `POB`, `City`, `Zipcode`, `PhoneNumber`, `PhoneNumber2`,
`FaxNumber`, `IdNumber`, `VatNumber`, `Comments`), `HideItemList`, `DocumentLanguage`,
`CreateToken`, `Discount`, `Custom1`–`Custom9`, `Reference`, `Order`, `EmailBcc`,
`CustomerId`, `AgentId`, `ProjectId`.

`Zipcode`, `IdNumber`, `VatNumber` should only be sent when the country is IL.

**IPN** — POSTed to `IPNURL` after a successful charge. Carries `SaleId`,
`GroupPrivateToken`, `NumberOfItmes` *(sic — the vendor's spelling)*, `ItemIdN` /
`ItemCatalogNumberN` / `ItemQuantityN` / `ItemUnitPriceN` / `ItemDescriptionN`,
`Reference`, `Order`, all customer fields, `Custom1`–`Custom9`, `CustomerId`,
`DocumentURL`, `DocumentNum`, `DocumentType`, and the `Transaction*` set
(`TransactionAmount`, `TransactionAuthNum`, `TransactionCardName`, `TransactionCardNum`,
`TransactionCreditTerms`, `TransactionNumOfPayment`, `TransactionStatus`,
`TransactionDateTime`, `TransactionType`, `TransactionCurrency`, `TransactionToken`, …).

**`Verify`** — POST `{GroupPrivateToken, SaleId, TotalAmount}` → `{Status}`; require
`"VERIFIED"`.

> The vendor's reference IPN listener (Appendix B of the PDF) leaves its security checks as
> literal `// TODO` comments: *check that GroupId belongs to me*, *check that the transaction
> has not been previously processed*, *check that amounts are correct*. All three, plus the
> `Verify` call, are mandatory in this design — see `ARCHITECTURE.md` §8.

**iframe/popup note:** the payment page cannot redirect the parent window cross-origin, so a
same-origin transition page must do `window.top.location.href = …`. If the extension only
ever shows the URL as a link or an email, this does not apply.

## 7. Unverified — confirm before building on it

The supplied PDF is dated **2015**. Public indexes of the current documentation
(`rivhit-api.readme.io`) and the live WCF help page list operations that are not in it. Both
hosts are **blocked by this environment's egress policy**, so the details below come from
search-result summaries and have **not** been read first-hand.

| Item | What we believe | Why it matters | How to confirm |
|---|---|---|---|
| `closed_document_type` / `closed_document_number` | Params on `Receipt.New` (and probably `Document.New`) that close an existing document by issuing a receipt/invoice against it | **This is the settlement mechanism the whole payment model rests on** | Read the "Closing Documents" page; issue a receipt against a demo invoice and inspect the result |
| `Document.Details` | Full document detail by `document_type` + `document_number`; response includes agent/company/customer fields | Single-invoice refresh (flow E2) | Call it on the demo account and capture the response |
| `Receipt.Details` | Receipt detail, expected to expose which document a receipt closed | Reconciliation (flow E1) depends on it | Same |
| `Document.NewExtended` | Creates a document **and** a receipt in one call | Possible simpler alternative to invoice-receipt types | Compare against a type-2 document on demo |
| `Document.Copy` | Pull an existing document into a new one of the same type | Could simplify credit notes | Low priority |
| `Receipt.PostponedList` | Postponed / deferred (המחאות דחויות) receipts | Affects AR ageing accuracy | Low priority |
| `Company.SetStartNumber`, `User.New`, `Receipt.Page` | Exist; purpose unconfirmed | Probably out of scope | — |
| Payment type codes | Current docs suggest `1` check, `4` credit card, `9` bank transfer — the 2015 PDF shows `2` cash, `4` ישראכרט | Wrong code ⇒ wrong payment method on a legal receipt | **Already handled**: always read `Payment.TypeList` |
| iCredit `ChargeSimple` + tokenisation | Direct/token charges, recurring billing, charges on hold | Phase 6 only | Read the Direct Payments docs |
| Rate limiting | No documented requests-per-second limit | Loop pacing | Ask `api@rivhit.co.il`; keep loops sequential meanwhile |
| Webhooks from Rivhit core | None found — only iCredit's IPN | Forces polling for bookkeeper-entered payments | Ask the vendor |

**Practical note for whoever builds this:** the environment used to write this design could
not reach `rivhit.co.il` or `rivhit-api.readme.io`. A first implementation session should
start by fetching `https://rivhit-api.readme.io/llms.txt` (an index of all doc pages and an
OpenAPI spec) from an unrestricted network and committing the relevant extracts here.
