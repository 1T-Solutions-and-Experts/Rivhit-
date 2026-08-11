# Deployment design

**Revision 2.** What an install consists of. Written at design time because on the Green
Invoice extension these steps were rediscovered by trial and error across several releases.

Publisher: **1T Solutions and Experts** · namespace `rivhitzohocrmextension`

Sigma does **not** create custom fields, org variables, Deluge functions, or schedules from
the widget bundle. Only the widgets ship in the zip.

---

## 1. Planned repository layout

```
app/
  rv-api.js                shared client: Deluge invocation, envelope parsing,
                           field resolution, i18n, formatting  (INLINED at build time)
  rv-styles.css            shared styles                        (INLINED at build time)
  plugin-manifest.json
  widgets/
    settings/ issue_document/ record_payment/ payment_link/
    refresh_status/ cancel_document/ customer_sync/ product_sync/ ar_report/
functions/                 every Deluge body, versioned — body only, no signature line
  rv_save_settings.deluge      rv_lookup.deluge
  rv_upsert_customer.deluge    rv_issue_document.deluge
  rv_issue_receipt.deluge      rv_close_document.deluge
  rv_cancel_document.deluge    rv_confirmation.deluge
  rv_recover_request.deluge    rv_sync_products.deluge
  rv_reconcile.deluge          rv_icredit_get_url.deluge
  rv_icredit_ipn.deluge        rv_icredit_ipn_failure.deluge
tests/                     node --test, stubbed ZOHO global
docs/
build.py                   validate → test → inline → zip
```

**Widgets must be self-contained.** Zoho's widget CDN intermittently 404s shared asset files,
and absolute `/app/...` paths bypass the versioned prefix. `build.py` inlines `rv-api.js` and
`rv-styles.css` into every widget and **fails the build** if any external reference to a
bundle-local file survives.

## 2. Custom fields

Types and lengths are load-bearing — an under-sized numeric field rejects writes, and one
rejected field kills the whole `updateRecord` call.

### Sales Orders **and** Invoices — the identical set on both modules
| Label | API name | Type |
|---|---|---|
| Rivhit Document Type | `Rivhit_Document_Type` | Number |
| Rivhit Currency ID | `Rivhit_Currency_ID` | Number |
| Rivhit Exchange Rate | `Rivhit_Exchange_Rate` | Decimal (6 dp) |
| Rivhit Stock Updated | `Rivhit_Stock_Updated` | Checkbox |
| Rivhit Closed Document Number | `Rivhit_Closed_Document_Number` | Number |
| Rivhit Document Number | `Rivhit_Document_Number` | Number |
| Rivhit Document Identity | `Rivhit_Document_Identity` | Single Line |
| Rivhit Document URL | `Rivhit_Document_URL` | URL |
| Rivhit Confirmation Number | `Rivhit_Confirmation_Number` | Single Line |
| Rivhit Confirmation Status | `Rivhit_Confirmation_Status` | Picklist — `Not Required`, `Obtained`, `Missing`, `Retry Failed` |
| Rivhit Issue Date | `Rivhit_Issue_Date` | Date |
| Rivhit Due Date | `Rivhit_Due_Date` | Date |
| Rivhit Request Reference | `Rivhit_Request_Reference` | Single Line |
| Rivhit Payment Status | `Rivhit_Payment_Status` | Picklist — `Not Issued`, `Issued`, `Partially Paid`, `Paid`, `Cancelled` |
| Rivhit Paid Amount | `Rivhit_Paid_Amount` | **Currency — length 16, decimals 2** |
| Rivhit Paid Date | `Rivhit_Paid_Date` | Date |
| Rivhit Is Closed | `Rivhit_Is_Closed` | Checkbox |
| Rivhit Last Sync | `Rivhit_Last_Sync` | Date/Time |
| Rivhit Cancel Document Number | `Rivhit_Cancel_Document_Number` | Number |
| iCredit Sale ID | `ICredit_Sale_ID` | Single Line |
| iCredit Payment URL | `ICredit_Payment_URL` | URL |
| iCredit Auth Number | `ICredit_Auth_Number` | Single Line |
| iCredit Card Last4 | `ICredit_Card_Last4` | Single Line |

### Accounts and Contacts (both)
`Rivhit_Customer_ID` (Number) · `Rivhit_Acc_Ref` (Single Line, 9) · `Rivhit_Tax_ID`
(Single Line) · `Rivhit_VAT_Number` (Single Line) · `Rivhit_Customer_Type` (Number) ·
`Rivhit_Price_List_ID` (Number) · `Rivhit_Agent_ID` (Number) · `Rivhit_Balance`
(**Currency 16,2**) · `Rivhit_Balance_Updated` (Date/Time) · `Rivhit_Last_Sync` (Date/Time) ·
`Rivhit_Sync_Error` (Multi-line)

### Products
`Rivhit_Item_ID` (Number) · `Rivhit_Catalog_Number` (Single Line, ≤15) ·
`Rivhit_Item_Group_ID` (Number) · `Rivhit_Storage_ID` (Number) ·
`Rivhit_Quantity_On_Hand` (Number) · `Rivhit_Quantity_Updated` (Date/Time)

### Custom module `Rivhit_Receipts`
`Receipt_Type` (Number) · `Receipt_Number` (Number) · `Receipt_Identity` (Single Line) ·
`Receipt_Amount` (**Currency 16,2**) · `Receipt_Date` (Date) · `Payment_Method` (Picklist) ·
`Receipt_URL` (URL) · `Closed_Document_Type` (Number) · `Closed_Document_Number` (Number) ·
`Invoice` (Lookup → Invoices) · `Account` (Lookup → Accounts) ·
`Source` (Picklist — `CRM`, `iCredit`, `Rivhit`)

> Validate every API name against Zoho's reserved words before creating the module. `Score`
> is reserved — that cost a rework on the Health Check extension.

> Fields created by the **manifest** are namespaced
> (`rivhitzohocrmextension__Rivhit_Document_ID`); fields created **by hand** are plain. The
> code resolves both, per field, at runtime.

## 3. Organization variables

Sigma Custom Properties prefixed `rivhitzohocrmextension__`. Full list in
[`ARCHITECTURE.md` §3](ARCHITECTURE.md#3-configuration-store). Written only by
`rv_save_settings`; direct writes from widget JS return 400. Optional variables are
**best-effort** — a missing optional property must never fail the save of the core settings.

## 4. Deluge functions

Category **REST API**, return type **STRING**, argument `crmAPIRequest` (except the scheduled
one). Paste the **body only** — a signature line in the body is a syntax error.

| Function | Args | Notes |
|---|---|---|
| `rv_save_settings` | `crmAPIRequest` | |
| `rv_lookup` | `crmAPIRequest` | read-only whitelist |
| `rv_upsert_customer` | `crmAPIRequest` | |
| `rv_issue_document` | `crmAPIRequest` | billable — runs `check_only` first |
| `rv_issue_receipt` | `crmAPIRequest` | billable — runs `check_only` first |
| `rv_close_document` | `crmAPIRequest` | not billable (Close / Reopen) |
| `rv_cancel_document` | `crmAPIRequest` | billable — Cancel, plus Receipt.Cancel for type-2 |
| `rv_confirmation` | `crmAPIRequest` | `Document.InvoiceApproval` retry |
| `rv_recover_request` | `crmAPIRequest` | |
| `rv_sync_products` | `crmAPIRequest` | |
| `rv_reconcile` | *(none)* | scheduled |
| `rv_icredit_get_url` | `crmAPIRequest` | |
| `rv_icredit_ipn` | `crmAPIRequest` | **public**, `zapikey` |
| `rv_icredit_ipn_failure` | `crmAPIRequest` | **public**, `zapikey`, separate URL |

Every function needs a guaranteed **top-level return** — a return inside `try/catch` does not
satisfy the compiler. Arguments arrive inside `crmAPIRequest`; check `.get("body")`,
`.get("params")` and `.get("arguments")`. `arguments.get()` does not compile.

### The IPN endpoints

Published as REST functions with an API key:

```
https://www.zohoapis.com/crm/v2/functions/rv_icredit_ipn/actions/execute?auth_type=apikey&zapikey=<KEY>
https://www.zohoapis.com/crm/v2/functions/rv_icredit_ipn_failure/actions/execute?auth_type=apikey&zapikey=<KEY>
```

The first goes into iCredit as `IPNURL`, the second as **`IPNFailureURL`**. Setting the
failure URL separately is not optional: left unset, failure notifications arrive at the
success endpoint on every failed charge attempt.

**iCredit requires a 200 OK within 1.25 seconds or it resends.** A Deluge function will often
miss that, so duplicate deliveries are expected and the handler's replay guard must absorb
them silently. Only ports 80 and 443 are accepted by iCredit, and the whole URL path must be
publicly reachable — both are satisfied by the Zoho endpoint above.

iCredit source IPs, for customers who operate an egress allowlist: `82.80.194.52`,
`81.218.62.41`, `31.168.238.28`.

Treat the `zapikey` as a secret, but never as the security boundary — the four in-function
checks are.

## 5. Connected-app scopes

```
ZohoCRM.modules.invoices.READ        ZohoCRM.modules.invoices.UPDATE
ZohoCRM.modules.salesorders.READ     ZohoCRM.modules.salesorders.UPDATE
ZohoCRM.modules.accounts.READ        ZohoCRM.modules.accounts.UPDATE
ZohoCRM.modules.contacts.READ        ZohoCRM.modules.contacts.UPDATE
ZohoCRM.modules.products.READ        ZohoCRM.modules.products.UPDATE
ZohoCRM.modules.custom.ALL           # Rivhit_Receipts
ZohoCRM.modules.notes.CREATE         # audit trail
ZohoCRM.org.variables.ALL
ZohoCRM.settings.fields.READ
```

Sales Orders are in scope because documents originate from both modules. Deals are **not** —
add `ZohoCRM.modules.deals.READ` only if that changes. Scope changes force admin re-consent
on update, so settle the final set before the first production publish; the extension is
private now but is built to Marketplace standards, and a listing will require each scope to
be justified.

## 6. Scheduled function — required, not optional

CRM → **Setup → Automation → Actions → Schedules → + Configure Schedule** → name
`Rivhit Payment Reconciliation` → every 6 hours → function `rv_reconcile` → save and
**activate**, then confirm the first run in the execution log.

Without it, the UI copy must say payment status is **manual only**.

## 7. Rivhit-side prerequisites

Three things that are configured in Rivhit, not in Zoho, and that silently break the
integration if missed.

1. **API access requires Rivhit Online or Invoice Online.** The desktop version has no API.
2. **⚠ There is no separate sandbox host.** Test and production share
   `api.rivhit.co.il`; you test by using a test *account*. The demo account is
   `demo` / `123`, VAT `123`, token `DECD03E5-E35C-41E8-84F7-FBA2FB483928`, at
   <https://online1.rivhit.co.il/loginmanager/login>. Its data is visible to every other test
   user, and **it is not connected to iCredit**, so card flows need a separate iCredit test
   token.
3. **⚠ Confirmation numbers (חשבוניות ישראל).** If the business is in scope, enable the Tax
   Authority link in Rivhit Online settings **under the same user account that owns the API
   token**. Under any other account, documents issue without an allocation number and the
   customer cannot deduct input VAT. Verify this before go-live, not after.

## 8. Install and verification order

1. Create custom fields (§2) and the `Rivhit_Receipts` module.
2. Create org variables (§3).
3. Paste all Deluge bodies (§4); publish both IPN functions and capture their URLs.
4. Upload the widget zip, publish, update the install, re-consent scopes.
5. Open any widget → confirm the console shows the **current build marker**. An old marker
   means the publish or cache did not take — stop and fix that first.
6. Settings → token + company id → **Test Connection** → **Refresh types** → map document
   types, payment types and **VAT/exempt sort codes** → Save → reload and confirm persistence.
7. Create the scheduled function (§6).
8. Confirm the Rivhit-side prerequisites (§7).
9. If using iCredit: paste both IPN URLs into the iCredit back office, set test mode, and run
   a test charge end to end.

## 9. Acceptance testing — on the demo account first

Money documents are irreversible and billable. Everything below runs on the demo account
before a production token is entered.

**Setup** — build marker current in every widget · connection test green and naming the
business · types discovered and mapped, including sort codes · settings persist across
reload · secret never echoed back into the form.

**Customers** — a new account creates one Rivhit customer with a 9-character `acc_ref` ·
**syncing the same account twice updates, never creates a second** · an `acc_ref` match is
verified against name/tax id before being accepted · a bad `id_number` (`-28`) fails that
record only and the batch continues · over-long names are truncated, and the truncation is
reported.

**Dry run** — an invoice with a deliberate error (unmapped payment type, mismatched totals)
is rejected by `check_only` and **no document is created** · the monthly counter does not move.

**Documents** — issue each mapped type · an invoice+receipt type with no payment method is
blocked before any call · totals on the Rivhit PDF match the CRM invoice to the agora ·
`send_mail` behaves as configured (it defaults to **true**) · a reopened issued invoice shows
the already-issued card, not the issue form · the document number renders left-to-right in a
Hebrew UI.

**Confirmation numbers** — with the Tax Authority link on, `confirmation_number` is returned
and stored · with it deliberately off, the invoice shows `Missing` and appears in the AR
exceptions · **Get confirmation number** retroactively obtains one and flips the status.

**Idempotency** — issue, then attempt the same issue again → refused, no second document ·
kill the browser tab mid-issue, reopen, press **Recover** → the existing document is found and
linked, and no second document exists · `Status.LastRequest` on an unused reference returns
`-2` and the UI offers a safe re-issue.

**Receipts and closing** — a full payment closes the invoice and moves it to Paid · a partial
payment moves it to Partially Paid with the right amount · two partials sum correctly · each
receipt appears in `Rivhit_Receipts` · **Mark as settled** closes without creating a document
and does not increment the quota counter · **Reopen** reverses it.

**Cancellation** — cancelling a plain invoice produces the credit document and links it ·
**cancelling an Invoice-Receipt calls both `Document.Cancel` and `Receipt.Cancel`, and both
halves show as reversed in Rivhit** · a partial refund produces a negative-amount document
commented back to the original.

**iCredit** — payment link opens · a test charge fires the IPN · a **replayed** IPN is
absorbed silently and changes nothing · an IPN with a mismatched amount is rejected and the
invoice is untouched · a **failed** charge reaches the failure endpoint and does not mark the
invoice paid · with `ICredit_Issues_Document = true` exactly **one** tax document exists
afterwards, and the setting-vs-reality mismatch check fires when it is configured wrong.

**Reconciliation** — a receipt created directly in the Rivhit UI is picked up by the next
scheduled run · `Customer.OpenDocuments` figures match the CRM invoices · a document issued
directly in Rivhit appears in the exceptions list · `Document.List` is always called with an
explicit date range (it defaults to *today*).

**Robustness** — a deliberately misconfigured CRM field produces a "saved, but field X
skipped" warning rather than a silent failure · an HTTP 400 HTML error page from Rivhit is
handled without a crash · an invoice `Subject` of `<img src=x onerror=alert(1)>` renders inert
everywhere it is displayed.

## 10. Marketplace listing

Privacy policy covering what is transmitted to Rivhit and iCredit and what is stored in CRM —
including `ICredit_Card_Last4` and, if the token phase ships, the card token (a charge
credential: restrict field-level permissions and disclose it). Screenshots per widget. Support
email. Requested scopes must match §5 and be justified in the listing.
