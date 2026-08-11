# Architecture

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
│  ├── credit_note         Invoices button cancel via חשבונית מס זיכוי        │
│  ├── customer_sync       Accounts/Contacts mass action                     │
│  ├── product_sync        Products mass action                              │
│  └── ar_report           Invoices mass action  open-balance / AR report    │
│           │                                                                │
│           │  ZOHO.CRM.FUNCTIONS.execute(...)   ← the ONLY path outward     │
│           ▼                                                                │
│  Deluge REST functions (server-side, hold the credentials)                 │
│  ├── rv_save_settings      persist org variables                           │
│  ├── rv_lookup             read-only Rivhit reads (whitelisted methods)    │
│  ├── rv_upsert_customer    Customer.Get / New / Update                     │
│  ├── rv_issue_document     Document.New  (+ idempotency + validation)      │
│  ├── rv_issue_receipt      Receipt.New   (+ document closing)              │
│  ├── rv_credit_note        Document.New as credit note                     │
│  ├── rv_recover_request    Status.LastRequest / AllRequests recovery       │
│  ├── rv_sync_products      Item.List / New / Update / Quantity             │
│  ├── rv_reconcile          scheduled payment + balance reconciliation      │
│  ├── rv_icredit_get_url    iCredit GetUrl                                  │
│  └── rv_icredit_ipn        PUBLIC REST endpoint — iCredit IPN listener     │
│           │                                                                │
└───────────┼────────────────────────────────────────────────────────────────┘
            │ invokeurl (HTTPS)
            ▼
   ┌────────────────────────┐        ┌──────────────────────────────┐
   │ Rivhit Online REST API │        │ iCredit Payment Gateway      │
   │ api.rivhit.co.il/online│        │ icredit.rivhit.co.il/API     │
   │ static api_token       │        │ GroupPrivateToken            │
   └────────────────────────┘        └──────────────────────────────┘
                                              │ POST (IPN)
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
| Revocation | rotate keys | regenerate token in the Rivhit UI (breaks every integration at once) |
| Blast radius | issue documents | issue documents, edit customers, **post journal entries** |

A static, unscoped, non-expiring credential that can post to a company's books must not sit
in a browser context. The Green Invoice audit already found unescaped `innerHTML` sinks in
four of five widgets (finding H3); the same class of bug here would leak a permanent
credential rather than a one-hour token.

**Rule: widgets never see `api_token` or `GroupPrivateToken`, and never call Rivhit
directly.** Widgets call named Deluge functions. Those functions read the credentials from
org variables, call Rivhit, and return only presentation-safe data.

### Why named functions, not one generic proxy

A generic `rv_call(method, payload)` would solve credential exposure just as well, but it
would move all payload construction into the browser. Named functions let the server enforce
invariants the client cannot be trusted with:

- the document total must match the CRM invoice total,
- the Rivhit customer must be the one linked to the CRM record,
- the idempotency key is derived server-side from the CRM record id,
- issuance is rate-limited and counted server-side.

`rv_lookup` is the one deliberately generic function, and it is safe precisely because it is
restricted to a **whitelist of read-only methods** (`*.TypeList`, `*.List`, `Customer.Get`,
`Customer.Balance`, `Document.Details`, `Receipt.Details`, `Accounting.VatRate`,
`Currency.List`, `Payment.BankList`, `Item.*` reads). Anything that writes gets its own
function.

## 3. Configuration store

Org variables (Sigma Custom Properties), namespace-prefixed
`rivhitzohocrmextension__<name>`. Written **only** by `rv_save_settings` — org-variable
writes from widget JS return HTTP 400 on this platform.

| Variable | Purpose |
|---|---|
| `API_Token` | Rivhit `api_token` |
| `Environment` | `production` \| `demo` |
| `Company_ID` | Rivhit company id — used to build PDF links |
| `Doc_Type_Map` | JSON: CRM intent → Rivhit `document_type` (see §5) |
| `Receipt_Type_Default` | Rivhit `receipt_type` for standalone receipts |
| `Payment_Type_Map` | JSON: CRM payment method → Rivhit `payment_type` |
| `Type_Cache` | JSON snapshot of TypeLists + VAT rate + currencies + banks, with a fetched-at stamp |
| `Default_Language` | `he` \| `en` — document language **and** widget UI direction |
| `Send_Mail_Default` | whether Rivhit emails the document to the customer |
| `Price_Include_VAT` | how unit prices are expressed (see §7) |
| `Agent_ID`, `Project_ID` | optional defaults stamped on documents |
| `Monthly_Doc_Quota` | subscribed tier (50/200/500/1000) for the usage warning |
| `ICredit_Enabled` | master switch for the payment-gateway features |
| `ICredit_Group_Token_Prod` / `ICredit_Group_Token_Test` | iCredit `GroupPrivateToken` |
| `ICredit_Test_Mode` | selects test vs prod host and token |
| `ICredit_Issues_Document` | **critical** — `true` if iCredit is configured to issue the tax document itself, so the extension must not also issue one (§8) |
| `ICredit_IPN_Key` | the `zapikey` embedded in the public IPN URL |
| `Reconcile_Window_Days` | rolling window for the scheduled reconciliation (default 35) |

Secrets are write-only in the UI: the settings widget renders `•••• (saved)` and only
overwrites when the admin types a new value. (Green Invoice audit finding M2.)

## 4. CRM data model

### 4.1 Field naming and the namespacing trap

Fields created by the extension manifest get namespaced API names
(`rivhitzohocrmextension__Rivhit_Document_ID`); fields an admin creates by hand are plain.
**Both must work, per field, in the same org.** Every read and write resolves field names at
runtime by scanning `ZOHO.CRM.META.getFields` (widget) or one sample record's keys (Deluge),
exactly as `resolveFields`/`_resolveOneField` do in the Green Invoice bridge. This is not
optional polish — it is the bug that silently discarded writes there for three releases.

Avoid CRM-reserved words in API names. `Score` is reserved (learned on the Health Check
extension); prefix everything with `Rivhit_` / `ICredit_` and never use a bare noun.

### 4.2 Accounts and Contacts — the Rivhit customer card

| Field | Type | Notes |
|---|---|---|
| `Rivhit_Customer_ID` | Number | Rivhit `customer_id` — the join key |
| `Rivhit_Tax_ID` | Single Line | ת.ז / ח.פ → `id_number` |
| `Rivhit_VAT_Number` | Single Line | ע.מ → `vat_number` |
| `Rivhit_Customer_Type` | Number | `customer_type` (card type) |
| `Rivhit_Price_List_ID` | Number | `price_list_id` |
| `Rivhit_Agent_ID` | Number | `agent_id` |
| `Rivhit_Balance` | Currency 16,2 | from `Customer.Balance` |
| `Rivhit_Balance_Updated` | Date/Time | ISO 8601 **with offset** |
| `Rivhit_Last_Sync` | Date/Time | |
| `Rivhit_Sync_Error` | Multi-line | last `client_message`, cleared on success |

**`acc_ref` is the reverse pointer.** On customer creation the extension writes the Zoho
record id into Rivhit's free-text `acc_ref` field. `Customer.Get` accepts `acc_ref`, which
gives an exact, bidirectional mapping that survives a lost CRM field and does not depend on
matching by name or email.

### 4.3 Invoices — the Rivhit document

| Field | Type | Notes |
|---|---|---|
| `Rivhit_Document_Type` | Number | per-company type code |
| `Rivhit_Document_Number` | Number | `document_number` |
| `Rivhit_Document_Identity` | Single Line | GUID — stable unique key, used to build the PDF URL |
| `Rivhit_Document_URL` | URL | PDF link |
| `Rivhit_Issue_Date` | Date | |
| `Rivhit_Request_Reference` | Single Line | the idempotency key we generated (§6) |
| `Rivhit_Payment_Status` | Picklist | `Not Issued`, `Issued`, `Partially Paid`, `Paid`, `Cancelled` |
| `Rivhit_Paid_Amount` | **Currency, length 16, decimals 2** | too-short numeric fields silently reject writes |
| `Rivhit_Paid_Date` | Date | |
| `Rivhit_Last_Sync` | Date/Time | |
| `Rivhit_Credit_Note_Number` | Number | set when cancelled |
| `ICredit_Sale_ID` | Single Line | IPN `SaleId`, also the replay-dedup key |
| `ICredit_Payment_URL` | URL | last generated payment page |
| `ICredit_Auth_Number` | Single Line | `TransactionAuthNum` |
| `ICredit_Card_Last4` | Single Line | display only |

### 4.4 Products — the Rivhit item

`Rivhit_Item_ID`, `Rivhit_Catalog_Number` (מק"ט), `Rivhit_Item_Group_ID`,
`Rivhit_Storage_ID`, `Rivhit_Quantity_On_Hand` (Number), `Rivhit_Quantity_Updated` (Date/Time).

### 4.5 New custom module: `Rivhit_Receipts`

One record per receipt, related to the Invoice. A receipt is a distinct legal document with
its own number and PDF; folding it into invoice fields loses partial-payment history — the
exact gap the Green Invoice bridge had to patch with linked-document scanning.

Fields: `Receipt_Type`, `Receipt_Number`, `Receipt_Identity`, `Receipt_Amount`
(Currency 16,2), `Receipt_Date`, `Payment_Method`, `Receipt_URL`, `Closed_Document_Type`,
`Closed_Document_Number`, lookup → Invoice, lookup → Account, `Source`
(`CRM` | `iCredit` | `Rivhit`).

> Naming caution: `Receipt_Number` and `Receipt_Amount` are safe, but validate every API
> name against Zoho's reserved-word list before creating the module.

### 4.6 Audit trail

Every write-side operation appends a CRM **Note** to the invoice recording: operation,
`request_reference`, resulting document type/number, and the Rivhit `client_message`. This
is the human-readable reconciliation trail when someone asks "why are there two invoices in
Rivhit for this deal".

## 5. Type discovery — nothing is hardcoded

Rivhit document/receipt/payment type codes are **defined per company**, not by the platform.
The vendor's own materials already conflict: the 2015 PDF's `Payment.TypeList` example shows
`2 = מזומן` and `4 = ישראכרט`, while the current Payments Guide shows `1 = check`,
`4 = credit card`, `9 = bank transfer`.

At setup, and on a refresh button, the extension calls `Document.TypeList`,
`Receipt.TypeList`, `Payment.TypeList`, `Currency.List`, `Payment.BankList` and
`Accounting.VatRate`, caches them in `Type_Cache`, and asks the admin to map:

- CRM intent → Rivhit document type, for: Tax Invoice, Invoice+Receipt, Credit Note,
  Delivery Note, Price Quote, Order
- CRM `Payment_Method` picklist values → Rivhit `payment_type`

Mapping is pre-filled by name matching and is always admin-overridable. The
`is_invoice_receipt` flag from `Document.TypeList` tells the code whether a `payments[]`
array is **required**; `price_include_vat` tells it how that type expects prices.

The Green Invoice bridge shipped a whole release cycle of broken documents because it
assumed one VAT enum applied at two different levels of the payload. Type discovery is the
structural fix for that class of bug.

## 6. Idempotency and recovery

Rivhit provides a real idempotency mechanism, and the design leans on it hard.

- **`request_reference`** — a caller-supplied identifier attached to a write.
- **`prevent_duplicates=true`** — Rivhit rejects a second write carrying a
  `request_reference` it has already seen.
- **`Status.LastRequest` / `Status.AllRequests`** — replay the original *response* for a
  given `request_reference`.

Key derivation (server-side, deterministic):

```
request_reference = "zcrm:" + <crm_record_id> + ":" + <intent> + ":" + <revision>
        intent   ∈ doc | receipt | credit
        revision  = 1, bumped only by an explicit, confirmed "issue again" action
```

The failure that matters is **the ambiguous one**: the HTTP call times out, or the response
is unreadable, and the caller cannot tell whether a tax document now exists. Retrying is the
wrong move — it risks a duplicate legal document and burns another metered issuance.

```
issue → timeout / unparseable / transport error
      └─► rv_recover_request(request_reference)
            ├── Status.LastRequest returns the original response
            │     └─► the document exists: persist it to CRM, report success
            └── NO_DATA_FOUND (204)
                  └─► nothing was created: safe to retry the SAME reference
```

`Rivhit_Request_Reference` is written to the CRM record **before** the call, so recovery is
possible even if the browser tab is closed mid-flight.

## 7. Totals, VAT, and the amount-mismatch trap

For any type where `is_invoice_receipt = true`, Rivhit rejects the document unless the
`payments[]` total equals the document total **including VAT**
(`DIFFERENT_AMOUNT_BETWEEN_INVOICE_AND_RECEIPT`). There is no preview endpoint, so the
extension cannot ask Rivhit what the total will be before committing.

This is the same shape as the Green Invoice `2422` saga, which cost several release cycles.
The mitigation here is to remove the disagreement rather than to guess at it:

1. Send `price_include_vat = true` and pass **gross** unit prices for invoice+receipt types.
   Then the document total is a plain sum of `price_nis × quantity` and rounding is ours to
   control, not a server-side re-derivation we have to predict.
2. Round every line to 2 decimals *before* summing, and make the single payment row equal
   that sum exactly.
3. Take the VAT rate from `Accounting.VatRate` (cached, with a TTL), never from a constant.
   Israeli VAT has changed twice in recent years; the Green Invoice client still has
   `0.18`/`0.17` literals in it.
4. On `DIFFERENT_AMOUNT_...`, show the computed total, the payment total, and the difference,
   and stop. Do not adaptively retry — every attempt is billable.

For non-payment types (plain tax invoice, quote, delivery note) the payments array is omitted
entirely and Rivhit ignores it.

## 8. iCredit and the double-issue hazard

iCredit can be configured, on the Rivhit side, to **issue the tax document itself** when a
charge succeeds — the IPN carries `DocumentURL`, `DocumentNum`, `DocumentType`. If the
extension also calls `Document.New`, the customer gets two tax documents for one payment.

`ICredit_Issues_Document` makes this an explicit, mutually exclusive setting:

- **`true`** — iCredit issues. The IPN handler *records* the document onto the CRM invoice.
  The extension never calls `Document.New` for iCredit-paid invoices.
- **`false`** — the extension issues. The IPN handler records the payment, then calls
  `rv_issue_receipt` (or `rv_issue_document` for invoice+receipt) itself.

The settings widget states which mode is active in plain language, because getting it wrong
is visible to the end customer.

### IPN endpoint security

`rv_icredit_ipn` is a Deluge REST function published with a `zapikey`, i.e. a public URL.
The vendor's reference C# listener leaves its security checks as `// TODO` comments. All
four are mandatory here, in order, before any CRM write:

1. **Verify with iCredit** — POST `SaleId`, `GroupPrivateToken`, `TransactionAmount` to
   `/API/PaymentPageRequest.svc/Verify`; require `Status == "VERIFIED"`.
2. **Confirm the token is ours** — the IPN's `GroupPrivateToken` must equal the stored one.
3. **Replay protection** — reject a `SaleId` already present in `ICredit_Sale_ID` or in
   `Rivhit_Receipts`.
4. **Amount check** — `TransactionAmount` must match the invoice total within ±0.01.

`Custom1` carries the Zoho invoice record id out and back, which is how the IPN finds its
record. Anything that fails a check is logged and left for a human; the invoice is never
silently marked paid.

## 9. Reconciliation model

Rivhit has no per-document "is it paid" flag. Payment state is derived:

- **Payments we initiate** — we issue the receipt with `closed_document_type` /
  `closed_document_number`, so the linkage is known at write time and written straight to CRM.
- **Payments recorded directly in Rivhit** by the bookkeeper — discovered by the scheduled
  `rv_reconcile`: pull `Receipt.List` for a rolling window, fetch `Receipt.Details` for
  receipts not yet in `Rivhit_Receipts`, read the closed-document reference, match to the CRM
  invoice on `(document_type, document_number)`, and update status and paid amount.
- **Coarse safety net** — refresh `Customer.Balance` per active Account. A CRM account showing
  invoices fully paid while Rivhit reports a non-zero balance is a reconciliation exception
  worth surfacing in the AR report.

`Receipt.Details`' exact closing-reference field names are **unverified** (§ API notes) and
are the first thing to confirm in the Phase-3 spike.

## 10. Platform constraints these designs must respect

Collected from `morning-invoice-bridge` and the Health Check extension. Each has cost a
release cycle at least once.

**Widget side**
- Widgets must be **self-contained**. Zoho's widget CDN intermittently 404s shared asset
  files, so a build step inlines shared JS/CSS into every widget HTML. No external
  `<script src>` / `<link>` to bundle-local files.
- `ZOHO.CRM.API.coql` and `searchRecords` are **unavailable** in the embedded widget SDK.
  Use `getAllRecords` with `page`/`per_page` pagination. (Both *are* available in Deluge.)
- Org-variable **writes** from widget JS return 400. Reads work.
- The SDK sometimes rejects promises with bare objects (no `.message`) — normalise before
  displaying, or the user sees `[object Object]`.
- Ship a build marker and log it; it is the only reliable proof the new bundle actually loaded.

**Deluge side**
- Paste the **body only**. A signature line in the body is a syntax error — Sigma generates
  the wrapper.
- Arguments arrive inside `crmAPIRequest`; `arguments.get()` does not compile. Check
  `.get("body")`, `.get("params")`, and `.get("arguments")` — which one is populated varies
  by platform version and call form.
- Every function needs a **guaranteed top-level `return`**. A return inside `try/catch` does
  not satisfy the compiler.
- `sendmail` must be followed by `return "done";`.
- `addAll` is unreliable; build lists with explicit `add` in a loop.
- External HTTP is `invokeurl`, not `ZOHO.CRM.HTTP`.

**CRM writes**
- One rejected field kills the **entire** `updateRecord` call. Write critical fields first,
  then best-effort extras (timestamps) in a separate call, and use a
  drop-the-rejected-field-and-retry helper that logs every drop.
- DateTime fields require ISO 8601 **with a timezone offset**; `YYYY-MM-DD HH:mm:ss` is
  `INVALID_DATA`.
- Currency fields must be declared long enough (16,2) or writes fail silently-ish.

**Rivhit protocol**
- Errors come back as **HTTP 200 with `error_code != 0`**. Never branch on HTTP status alone.
- Show `client_message` to users; log `debug_message` only — the API explicitly separates them.
- `204 NO_DATA_FOUND` on a `*.List` call means "empty", not "broken".
- Dates are `DDMMYYYY` strings. Not ISO. Not `DD/MM/YYYY`.
- `Accounting.AddJournal` lives on a **different base URL**
  (`/api/RivhitWebRestAPI.svc/`) than everything else (`/online/RivhitOnlineAPI.svc/`).

## 11. Build, test, and source-of-truth discipline

The Green Invoice audit's top finding was that the source of truth was a zip file passed
through chat sessions. This repo starts the other way round.

- **Everything versioned here**: widget sources, all Deluge bodies, docs, build script.
  A Deluge function that exists only inside Sigma does not exist.
- **`build.py`** validates the manifest, syntax-checks every inline script block after
  inlining, enforces a single `VERSION` constant across manifest/markers/zip, and **refuses
  to build if unit tests fail**.
- **Unit tests (`node --test`, stub `ZOHO` global)** cover the pure functions that carry the
  financial risk, because they are the cheap 20% that causes 80% of the damage:
  - `mapInvoiceToRivhitDocument` — golden-payload fixture
  - line/VAT/total arithmetic and the payments-equal-total invariant
  - `request_reference` derivation and stability
  - payment-method → `payment_type` mapping, including the unmapped case
  - Rivhit envelope parsing (`error_code`, 204, HTTP-200-with-error)
  - `DDMMYYYY` formatting and parsing
  - IPN verification decision logic (all four checks, each failing independently)
- **Logic duplicated between JS and Deluge must be tested on both sides or not duplicated.**
  In the Green Invoice bridge, `parseDocumentStatus` and its Deluge twin drifted and shipped
  the same wrong enum in both. Prefer keeping money logic in Deluge only, and letting widgets
  render what the function returns.
