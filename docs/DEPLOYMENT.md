# Deployment design

What an install consists of. Written now, at design time, because on the Green Invoice
extension these steps were rediscovered by trial and error across several releases.

Publisher: **1T Solutions and Experts** · namespace `rivhitzohocrmextension`

Sigma does **not** create custom fields, org variables, Deluge functions, or schedules from
the widget bundle. Only the widgets ship in the zip; everything else is configured in the
Sigma / Extension editor and in CRM setup.

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
    refresh_status/ credit_note/ customer_sync/ product_sync/ ar_report/
functions/                 every Deluge body, versioned — body only, no signature line
  rv_save_settings.deluge      rv_lookup.deluge
  rv_upsert_customer.deluge    rv_issue_document.deluge
  rv_issue_receipt.deluge      rv_credit_note.deluge
  rv_recover_request.deluge    rv_sync_products.deluge
  rv_reconcile.deluge          rv_icredit_get_url.deluge
  rv_icredit_ipn.deluge
tests/                     node --test, stubbed ZOHO global
docs/
build.py                   validate → test → inline → zip
```

**Widgets must be self-contained.** Zoho's widget CDN intermittently 404s shared asset files,
and absolute `/app/...` paths bypass the versioned prefix. `build.py` inlines `rv-api.js` and
`rv-styles.css` into every widget HTML and **fails the build** if any external reference to a
bundle-local file survives.

## 2. Custom fields

Types and lengths are load-bearing — an under-sized numeric field rejects writes, and one
rejected field kills the whole `updateRecord` call.

### Invoices
| Label | API name | Type |
|---|---|---|
| Rivhit Document Type | `Rivhit_Document_Type` | Number |
| Rivhit Document Number | `Rivhit_Document_Number` | Number |
| Rivhit Document Identity | `Rivhit_Document_Identity` | Single Line |
| Rivhit Document URL | `Rivhit_Document_URL` | URL |
| Rivhit Issue Date | `Rivhit_Issue_Date` | Date |
| Rivhit Request Reference | `Rivhit_Request_Reference` | Single Line |
| Rivhit Payment Status | `Rivhit_Payment_Status` | Picklist — `Not Issued`, `Issued`, `Partially Paid`, `Paid`, `Cancelled` |
| Rivhit Paid Amount | `Rivhit_Paid_Amount` | **Currency — length 16, decimals 2** |
| Rivhit Paid Date | `Rivhit_Paid_Date` | Date |
| Rivhit Last Sync | `Rivhit_Last_Sync` | Date/Time |
| Rivhit Credit Note Number | `Rivhit_Credit_Note_Number` | Number |
| iCredit Sale ID | `ICredit_Sale_ID` | Single Line |
| iCredit Payment URL | `ICredit_Payment_URL` | URL |
| iCredit Auth Number | `ICredit_Auth_Number` | Single Line |
| iCredit Card Last4 | `ICredit_Card_Last4` | Single Line |

### Accounts and Contacts (both)
`Rivhit_Customer_ID` (Number) · `Rivhit_Tax_ID` (Single Line) · `Rivhit_VAT_Number`
(Single Line) · `Rivhit_Customer_Type` (Number) · `Rivhit_Price_List_ID` (Number) ·
`Rivhit_Agent_ID` (Number) · `Rivhit_Balance` (**Currency 16,2**) ·
`Rivhit_Balance_Updated` (Date/Time) · `Rivhit_Last_Sync` (Date/Time) ·
`Rivhit_Sync_Error` (Multi-line)

### Products
`Rivhit_Item_ID` (Number) · `Rivhit_Catalog_Number` (Single Line) ·
`Rivhit_Item_Group_ID` (Number) · `Rivhit_Storage_ID` (Number) ·
`Rivhit_Quantity_On_Hand` (Number) · `Rivhit_Quantity_Updated` (Date/Time)

### Custom module `Rivhit_Receipts`
`Receipt_Type` (Number) · `Receipt_Number` (Number) · `Receipt_Identity` (Single Line) ·
`Receipt_Amount` (**Currency 16,2**) · `Receipt_Date` (Date) · `Payment_Method` (Picklist) ·
`Receipt_URL` (URL) · `Closed_Document_Type` (Number) · `Closed_Document_Number` (Number) ·
`Invoice` (Lookup → Invoices) · `Account` (Lookup → Accounts) ·
`Source` (Picklist — `CRM`, `iCredit`, `Rivhit`)

> Validate every API name against Zoho's reserved words before creating the module. `Score`
> is reserved — that cost a rework on the Health Check extension. Keep the `Rivhit_` /
> `ICredit_` prefixes and avoid bare nouns.

> Fields created by the **manifest** are namespaced
> (`rivhitzohocrmextension__Rivhit_Document_ID`); fields created **by hand** are plain. The
> code resolves both, per field, at runtime — so either origin works, and a mixed org works.

## 3. Organization variables

Created as Sigma Custom Properties, prefixed `rivhitzohocrmextension__`. Full list and
purposes in [`ARCHITECTURE.md` §3](ARCHITECTURE.md#3-configuration-store). Written only by
`rv_save_settings`; direct writes from widget JS return 400.

Optional variables must be treated as **best-effort** by the save function: a missing
optional property must never fail the save of the core settings.

## 4. Deluge functions

Category **REST API**, return type **STRING**, argument `crmAPIRequest` (except the scheduled
one, which takes none). Paste the **body only** — a signature line in the body is a syntax
error, because Sigma generates the wrapper from the function's settings.

| Function | Args | Notes |
|---|---|---|
| `rv_save_settings` | `crmAPIRequest` | |
| `rv_lookup` | `crmAPIRequest` | read-only whitelist |
| `rv_upsert_customer` | `crmAPIRequest` | |
| `rv_issue_document` | `crmAPIRequest` | billable |
| `rv_issue_receipt` | `crmAPIRequest` | billable |
| `rv_credit_note` | `crmAPIRequest` | billable |
| `rv_recover_request` | `crmAPIRequest` | |
| `rv_sync_products` | `crmAPIRequest` | |
| `rv_reconcile` | *(none)* | scheduled |
| `rv_icredit_get_url` | `crmAPIRequest` | |
| `rv_icredit_ipn` | `crmAPIRequest` | **published publicly with a `zapikey`** |

Every function needs a guaranteed **top-level return** — a return inside `try/catch` does not
satisfy the compiler. Arguments arrive inside `crmAPIRequest`; check `.get("body")`,
`.get("params")` and `.get("arguments")`, because which one is populated varies by platform
version and call form. `arguments.get()` does not compile.

### The IPN endpoint

`rv_icredit_ipn` is published as a REST function with an API key, giving a URL of the form:

```
https://www.zohoapis.com/crm/v2/functions/rv_icredit_ipn/actions/execute?auth_type=apikey&zapikey=<KEY>
```

That URL goes into the iCredit back office as `IPNURL`. Treat the `zapikey` as a secret:
store it in `ICredit_IPN_Key`, show it once in Settings with a regenerate hint, and rely on
the four in-function checks (verify / token / replay / amount) rather than on URL secrecy.

## 5. Connected-app scopes

Least privilege, matching what the flows actually do:

```
ZohoCRM.modules.invoices.READ        ZohoCRM.modules.invoices.UPDATE
ZohoCRM.modules.accounts.READ        ZohoCRM.modules.accounts.UPDATE
ZohoCRM.modules.contacts.READ        ZohoCRM.modules.contacts.UPDATE
ZohoCRM.modules.products.READ        ZohoCRM.modules.products.UPDATE
ZohoCRM.modules.custom.ALL           # Rivhit_Receipts
ZohoCRM.modules.notes.CREATE         # audit trail
ZohoCRM.org.variables.ALL
ZohoCRM.settings.fields.READ
```

Add `ZohoCRM.modules.deals.READ` only if invoices are to be raised from Deals. Any scope
change forces admin re-consent on update, so decide the final set before the first
production publish.

## 6. Scheduled function — required, not optional

`rv_reconcile` does nothing until someone schedules it:

CRM → **Setup → Automation → Actions → Schedules → + Configure Schedule** → name
`Rivhit Payment Reconciliation` → every 6 hours → function `rv_reconcile` → save and
**activate**, then confirm the first run in the execution log.

If the schedule is not created, the UI copy must say payment status is **manual only**. The
Green Invoice extension advertised "syncs automatically every 6 hours" while shipping without
a schedule; do not repeat that.

## 7. Install and verification order

1. Create custom fields (§2) and the `Rivhit_Receipts` module.
2. Create org variables (§3).
3. Paste all Deluge bodies (§4); publish `rv_icredit_ipn` and capture its URL.
4. Upload the widget zip, publish, update the install, re-consent scopes.
5. Open any widget → confirm the console shows the **current build marker**. An old marker
   means the publish or the cache did not take — stop and fix that first.
6. Settings → token + company id → **Test Connection** → **Refresh types** → map document
   and payment types → Save → reload and confirm persistence.
7. Create the scheduled function (§6).
8. If using iCredit: paste the IPN URL into the iCredit back office, set test mode, and run a
   test charge end to end.

## 8. Acceptance testing — run against the demo company first

Money documents are irreversible and billable. Everything below runs on the vendor demo
account (`api_token` in [`API-NOTES-RIVHIT.md` §1](API-NOTES-RIVHIT.md#1-protocol)) before
any production token is entered.

**Setup** — build marker current in every widget · test connection green · types discovered
and mapped · settings persist across reload · secret never echoed back into the form.

**Customers** — new account creates one Rivhit customer with `acc_ref` set · **syncing the
same account twice updates, never creates a second** · a bad `id_number` fails that record
only and the batch continues.

**Documents** — issue each mapped type · an invoice+receipt type with no payment method is
blocked before any call · totals on the Rivhit PDF match the CRM invoice to the agora ·
`send_mail` behaves as configured · reopening an issued invoice shows the already-issued card,
not the issue form · document number renders left-to-right in a Hebrew UI.

**Idempotency** — issue, then attempt the same issue again → refused, no second document ·
kill the browser tab mid-issue, reopen, press **Recover** → the existing document is found
and linked, and no second document exists.

**Receipts** — full payment moves the invoice to Paid · a partial payment moves it to
Partially Paid with the right amount · two partials sum correctly · each receipt appears in
`Rivhit_Receipts` and the invoice is closed in Rivhit.

**Credit note** — cancelling issues a credit note linked to the original and sets status
`Cancelled`.

**iCredit** — payment link opens · a test charge fires the IPN · a **replayed** IPN is
rejected · an IPN with a mismatched amount is rejected and the invoice is untouched · with
`ICredit_Issues_Document = true` exactly **one** tax document exists afterwards.

**Reconciliation** — a receipt created directly in the Rivhit UI is picked up by the next
scheduled run and updates the CRM invoice.

**Robustness** — a deliberately misconfigured CRM field produces a "saved, but field X
skipped" warning rather than a silent failure · an invoice `Subject` of
`<img src=x onerror=alert(1)>` renders inert everywhere it is displayed.

## 9. Marketplace listing

Privacy policy covering what is transmitted to Rivhit and iCredit and what is stored in CRM —
including `ICredit_Card_Last4` and, if Phase 6 ships, `TransactionToken` (a charge credential:
restrict field-level permissions and disclose it). Screenshots per widget. Support email.
Requested scopes must match §5 and be justified in the listing.
