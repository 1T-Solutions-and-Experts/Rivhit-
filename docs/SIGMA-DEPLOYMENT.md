# Sigma deployment guide — Rivhit Bridge V1.0-r1

**Ordered so the most likely failures surface first.**

The obvious order — fields, then variables, then functions, then widgets — is the wrong one.
It spends an hour creating forty custom fields before a single line of Deluge has been
compiled. This guide inverts that: everything that can fail cheaply is tested before anything
expensive is built.

| Phase | What it proves | Time | Needs Rivhit? |
|---|---|---|---|
| **A** | The code compiles and the bundle loads | 40 min | no |
| **B** | Configuration round-trips | 20 min | no |
| **C** | Rivhit answers us | 10 min | demo, reads only |
| **D** | The C1 idempotency assumption holds | 5 min | demo, 1 document |
| **E** | Fields and the receipts module exist | 60 min | no |
| **F** | Zoho-side behaviour is correct | 30 min | no |
| **G** | Documents issue end to end | 45 min | demo, real documents |
| **H** | Card payments work | 30 min | iCredit test |
| **I** | Production | 30 min | production |

**Stop at the first phase that fails.** Each one is a gate; continuing past a red gate means
debugging two problems at once.

Namespace `rivhitzohocrmextension` · Publisher **1T Solutions and Experts**

> There is no separate Rivhit sandbox host. Test and production share `api.rivhit.co.il` and
> differ only by which account the token belongs to. A production token in phase C issues real
> legal documents from your first click.

Reference tables (fields, org variables, troubleshooting) are in the appendices at the end.

---

# Phase A — does the code even parse?

Highest error yield per minute. The Deluge bodies are hand-written and have never seen a
compiler; expect to fix things here, and it is far cheaper to fix them now.

### A1. Create the extension

<https://sigma.zoho.com> → **Create Extension** → **Zoho CRM**.

- Name: `Rivhit Bridge`
- Namespace: **`rivhitzohocrmextension`** — must match exactly. Every namespaced field lookup
  and org-variable read depends on it, and a typo here fails silently everywhere later.
- **Extension for a single organisation** (private).

### A2. Paste all 15 Deluge functions

**Functions → Create Function**, one per file. Paste the **body only** — a signature line in
the body is a syntax error, because Sigma writes the wrapper itself.

Paste in this order. It is not arbitrary: the first four exercise every construct the rest
use, so a systemic problem (a Deluge dialect difference, a `Map()` idiom that does not
compile) shows up in the first ten minutes rather than the last.

| # | File | Category | Return | Argument |
|---|---|---|---|---|
| 1 | `rv_lookup.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 2 | `rv_save_settings.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 3 | `rv_issue_document.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 4 | `rv_icredit_ipn.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 5 | `rv_issue_receipt.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 6 | `rv_close_document.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 7 | `rv_cancel_document.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 8 | `rv_confirmation.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 9 | `rv_recover_request.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 10 | `rv_upsert_customer.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 11 | `rv_sync_products.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 12 | `rv_icredit_get_url.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 13 | `rv_icredit_ipn_failure.deluge` | REST API | STRING | `crmAPIRequest` (Map) |
| 14 | `rv_reconcile.deluge` | REST API | STRING | *(no arguments)* |
| 15 | `rv_log_change.deluge` | **Automation** | STRING | `recId` (String), `moduleArg` (String) |

**Save each one and confirm it compiles before moving to the next.**

> If the editor reports an error on the *last* line, you almost certainly pasted a signature
> line along with the body. Delete any leading `string rv_xxx(map crmAPIRequest)`.

### A3. Publish the two IPN endpoints

Only `rv_icredit_ipn` and `rv_icredit_ipn_failure`.

Open each → **⋯ → REST API** → enable → **API Key**. Copy both URLs:

```
https://www.zohoapis.com/crm/v2/functions/rv_icredit_ipn/actions/execute?auth_type=apikey&zapikey=…
https://www.zohoapis.com/crm/v2/functions/rv_icredit_ipn_failure/actions/execute?auth_type=apikey&zapikey=…
```

### A4. Build and upload the widgets

```bash
cd Rivhit-
python3 build.py        # → rivhit-bridge-V1.0-r1.zip
```

**Widgets → Upload** the zip → confirm 15 registrations appear → **Publish (major)** →
install into the org → **accept the scopes** (Appendix C).

### A5. 🚦 GATE — open Settings

Setup → **Marketplace → Installed → Rivhit Bridge → Settings**.

Three things must be true:

1. The widget **renders**, in Hebrew, right-to-left.
2. The console shows **`[Rivhit API] BUILD V1.0-r1`**. An older marker means the publish or
   cache did not take — fix that now, or you will spend the next hour debugging code that is
   not running.
3. It says the extension is not configured yet. That message is a *success*: it means
   `rv_lookup` was called, returned a valid envelope, and reported no token.

Passing A5 proves the manifest is valid, the bundle loads, `rv-api.js` parses in the browser,
RTL works, the Deluge bridge works, and `rv_lookup` compiles and runs — for well under an hour
and without touching Rivhit or creating a single field.

---

# Phase B — does configuration round-trip?

Still no Rivhit. This phase catches namespace typos, which otherwise break everything
silently and are miserable to diagnose later.

### B1. Create the organisation variables

Sigma editor → **Storage → Organisation Variables**. All **Text**, all values left blank.
Full list in Appendix B — 29 of them.

### B2. 🚦 GATE — save and reload

In Settings, set **Account type = demo**, **Language = Hebrew**, `Sort code VAT = 100`, then
**Save**.

- A green "נשמר" means `rv_save_settings` wrote *and read back* every variable. It verifies
  its own writes; a mismatch is reported rather than assumed away.
- Reload the widget. The values must still be there.

If a variable reports `mismatch`, its name is wrong or it was never created. Compare against
Appendix B character by character.

---

# Phase C — does Rivhit answer?

Free reads only. Nothing is created.

### C1. Connect the demo account

| | |
|---|---|
| API token | `DECD03E5-E35C-41E8-84F7-FBA2FB483928` |
| User / password | `demo` / `123` |
| VAT number | `123` |

Paste the token → **Test Connection**.

### C2. 🚦 GATE — green, with a business name

Green plus the business name proves: `invokeurl` works from Deluge, the Rivhit response
envelope parses, `error_code` is read correctly, and Hebrew comes back readable rather than
as mojibake.

### C3. Refresh the catalog

**Document types → Refresh catalog from Rivhit.** Every document type, receipt type, payment
type, currency, bank and sort code in the demo account should appear with its flags
(`is_invoice_receipt`, `is_accounting`, `price_include_vat`).

An empty or partial catalog means one of the seven TypeList calls failed — check the function
execution log for the `debug_message`.

> Do **not** map roles yet. The demo account's type codes are not yours; role mapping happens
> against the production catalog in phase I.

---

# Phase D — settle the C1 idempotency question

Five minutes, one document on the demo account, before anything is built on the assumption.

Using any REST client:

```
Step 1 — dry run WITH the idempotency key
POST https://api.rivhit.co.il/online/RivhitOnlineAPI.svc/Document.New
{
  "api_token": "DECD03E5-E35C-41E8-84F7-FBA2FB483928",
  "document_type": 1, "customer_id": 0, "last_name": "בדיקת C1",
  "price_include_vat": true,
  "items": [{ "item_id": 0, "quantity": 1, "price_nis": 1, "description": "בדיקה" }],
  "check_only": true,
  "request_reference": "c1-probe-001",
  "prevent_duplicates": true
}

Step 2 — the real call: same body, same reference, remove "check_only"
```

| Step 2 returns | Meaning |
|---|---|
| `error_code: 0` + a document number | The dry run did **not** consume the key. Safe either way. |
| a duplicate-operation error | The dry run **did** consume it — the code's defence is load-bearing, not precautionary. Keep it exactly as written. |

Then call `Status.LastRequest` with `c1-probe-001`: it confirms whether the reference was
recorded, and starts the clock on the retention question.

Either outcome is fine — the shipped code never sends the key on a dry run. This phase exists
so that fact is *known* rather than assumed. Record the answer in
`docs/VENDOR-QUESTIONS.md`.

---

# Phase E — build the data model

Now, and not before. If phases A–D had failed, you would have saved this hour.

### E1. Custom fields

Setup → **Customization → Modules and Fields**. Appendix A has the complete tables:

- **Invoices and Sales Orders** — the identical 32-field set on both
- **Accounts and Contacts** — 11 fields on both
- **Products** — 6 fields

Types and lengths are load-bearing. An undersized Currency field rejects writes, and one
rejected field kills the entire update call.

### E2. The `Rivhit_Receipts` module

Appendix A.4. One field needs special attention:

> ### ⚠ `ICredit_Sale_ID` must be created with **Unique** ticked
>
> iCredit requires a 200 OK within **1.25 seconds** or it resends, and a Zoho function's cold
> start alone can exceed that — duplicate deliveries are normal traffic, not an attack. Deluge
> has no locks, so this constraint **is** the mutex: the IPN handler claims the sale id as its
> first write and the loser of a race is rejected by the platform. Without it, two concurrent
> deliveries both proceed and the customer is credited twice.

### E3. The workflow rule

Setup → **Automation → Workflow Rules → Create Rule**, on **both** Invoices and Sales Orders:

| | |
|---|---|
| Rule name | `Rivhit — log post-issuance changes` |
| When | On a record action → **Edit** → repeat whenever a record is edited |
| Condition | `Rivhit Document Number` **is not empty** |
| Action | Function → `rv_log_change` |
| Arguments | `recId` → the record Id · `moduleArg` → literal `Invoices` (or `Sales_Orders`) |

The condition is not decoration. Without it the rule fires on ordinary pre-issue editing and
buries every record in notes.

### E4. The schedule

Setup → **Automation → Actions → Schedules → + Configure Schedule** → name
`Rivhit Payment Reconciliation` → **every 6 hours** → function `rv_reconcile` → save and
**activate**.

Without it nothing syncs and payment status is manual only.

### E5. Place the buttons

Setup → **Modules and Fields → Invoices → Links and Buttons**. Confirm all five appear in the
**Detail Page** layout, then repeat for Sales Orders. Check the mass actions on Accounts,
Contacts and Products.

---

# Phase F — Zoho-side behaviour

No Rivhit. These are the tests people usually skip and then discover in production.

### F1. The unique constraint really is unique

Create a `Rivhit_Receipts` record with `ICredit_Sale_ID = test-123`. Create a second with the
same value. **The second must be rejected.** If it saves, phase E2 did not take — go back, or
the IPN handler has no concurrency guard at all.

### F2. Duplicate IPN handling

```bash
curl -X POST "<your rv_icredit_ipn URL>" -d "SaleId=probe-001&TransactionAmount=1"
curl -X POST "<your rv_icredit_ipn URL>" -d "SaleId=probe-001&TransactionAmount=1"
```

First call: claims the sale, then rejects it at the Verify check (no real sale exists) and
returns JSON. Second call: `"code":"duplicate"`. Both return HTTP 200.

If the second call is *not* a duplicate, the claim is not working. If either returns an HTML
error page instead of JSON, the function threw — which in production would trigger a resend
storm.

### F3. Post-issuance drift notes

On a test invoice, type a fake number into `Rivhit_Document_Number` by hand. Save. Now edit a
line item. **A note should appear** naming the field, old → new, and who changed it. Then
clear the number and edit again — **no note** this time.

### F4. Escaping

Set an invoice `Subject` to `<img src=x onerror=alert(1)>` and open the issue widget. It must
render as inert text. No alert.

### F5. Field-rejection handling

Temporarily shorten `Rivhit_Paid_Amount` to a length that cannot hold the value, run a refresh,
and confirm you get a **"saved, but field X skipped"** warning rather than a silent failure.
Restore it to Currency 16,2.

### F6. Permission enforcement

In Settings → Permissions, untick a non-admin profile for *Issue document*. Log in as a user
with that profile and press the button. It should be **disabled** — and if the function is
invoked directly, it must return a refusal. Hiding a button is not access control; the
function is the boundary.

---

# Phase G — documents, on the demo account

### G1. Dry runs first — free, create nothing

For each mapped document type, open an invoice and press **בדיקה בלבד**. This validates real
payloads against the real API without issuing anything and without touching the quota. Fix
every failure here before issuing once.

### G2. Then issue

| Test | Expect |
|---|---|
| Issue a document | PDF total matches the CRM invoice to the agora |
| Reopen the invoice | The already-issued card, not the form |
| Document number in the Hebrew UI | Renders left-to-right, not scrambled |
| Issue again | Refused as a duplicate; no second document |
| Kill the tab mid-issue, reopen, **Recover** | Finds the document; no duplicate |
| Record a partial payment | `Partially Paid`, correct amount |
| A second partial completes it | `Paid`; both receipts in `Rivhit_Receipts` |
| **Mark as settled** | Closes with no document; quota unchanged. **Reopen** reverses it |
| Cancel an **invoice-receipt** | **Both** halves reversed in Rivhit |
| Sync the same account twice | Updated, never a second customer |
| AR report | Totals match Rivhit's own aging report |
| Hebrew customer name and item description | Correct on the PDF, no mojibake |

---

# Phase H — iCredit

Needs a separate iCredit test token; the Rivhit demo account is not connected to it.

1. Settings → iCredit tab → enable, test mode, paste the group tokens.
2. Paste both IPN URLs from A3 and a thank-you page URL.
3. **Set "iCredit issues the document" to match how the payment page is actually
   configured.** Getting this wrong produces two tax documents for one payment, and the
   customer sees both.
4. In the iCredit back office: set **IPN URL** and **IPN Failure URL** separately. Left unset,
   declines arrive at the success endpoint — once per failed attempt.
5. Test: a real test charge fires the IPN · a **replayed** IPN changes nothing · a **declined**
   card marks nothing paid · **exactly one** tax document exists afterwards.

Optional allowlist: iCredit posts from `82.80.194.52`, `81.218.62.41`, `31.168.238.28`.

---

# Phase I — production

1. Phases F–H clean on demo.
2. Settings → replace the token → **Account type = production**.
3. **Refresh the catalog again.** The demo account's type codes are not yours.
4. **Now map the roles** — default for Invoices, default for Sales Orders, credit type,
   default receipt type — and map every CRM payment method to a Rivhit code. Do not assume the
   defaults; codes differ per business.
5. Confirm the VAT / exempt sort codes against your Rivhit configuration.
6. If you are in the חשבוניות ישראל regime: tick it, enter the approver's ת.ז, and confirm the
   Tax Authority link is enabled in Rivhit **under the same user that owns the API token**.
   Under any other user, documents issue with no allocation number and your customers cannot
   deduct input VAT.
7. **Dry run one document of each mapped role against production.** Free, real catalog,
   creates nothing — a production rehearsal with no consequences.
8. Issue one real low-value document and verify it end to end in Rivhit.
9. Confirm the schedule has run at least once.

---
---

# Appendix A — custom fields

## A.1 Invoices **and** Sales Orders (identical on both)

| Label | API name | Type |
|---|---|---|
| Rivhit Document Type | `Rivhit_Document_Type` | Number |
| Rivhit Document Number | `Rivhit_Document_Number` | Number |
| Rivhit Document Identity | `Rivhit_Document_Identity` | Single Line |
| Rivhit Document URL | `Rivhit_Document_URL` | URL |
| Rivhit Confirmation Number | `Rivhit_Confirmation_Number` | Single Line |
| Rivhit Confirmation Status | `Rivhit_Confirmation_Status` | Picklist — `Not Required`, `Obtained`, `Missing`, `Retry Failed` |
| Rivhit Issue Date | `Rivhit_Issue_Date` | Date |
| Rivhit Due Date | `Rivhit_Due_Date` | Date |
| Rivhit Request Reference | `Rivhit_Request_Reference` | Single Line (255) |
| Rivhit Payment Status | `Rivhit_Payment_Status` | Picklist — `Not Issued`, `Issued`, `Partially Paid`, `Paid`, `Cancelled` |
| Rivhit Paid Amount | `Rivhit_Paid_Amount` | **Currency — length 16, decimals 2** |
| Rivhit Paid Date | `Rivhit_Paid_Date` | Date |
| Rivhit Is Closed | `Rivhit_Is_Closed` | Checkbox |
| Rivhit Last Sync | `Rivhit_Last_Sync` | Date/Time |
| Rivhit Cancel Document Number | `Rivhit_Cancel_Document_Number` | Number |
| Rivhit Currency ID | `Rivhit_Currency_ID` | Number |
| Rivhit Exchange Rate | `Rivhit_Exchange_Rate` | Decimal (6 dp) |
| Rivhit Stock Updated | `Rivhit_Stock_Updated` | Checkbox |
| Rivhit Closed Document Number | `Rivhit_Closed_Document_Number` | Number |
| Rivhit Instalments Total | `Rivhit_Instalments_Total` | Number |
| Rivhit Instalments Elapsed | `Rivhit_Instalments_Elapsed` | Number |
| Rivhit Instalment Progress | `Rivhit_Instalment_Progress` | Single Line |
| Rivhit Next Instalment Date | `Rivhit_Next_Instalment_Date` | Date |
| Rivhit Instalment Amount | `Rivhit_Instalment_Amount` | **Currency 16,2** |
| Rivhit Issued Snapshot | `Rivhit_Issued_Snapshot` | Multi Line — **Large (32,000)** |
| Rivhit Record Drift | `Rivhit_Record_Drift` | Checkbox |
| Rivhit Drift Detected At | `Rivhit_Drift_Detected_At` | Date/Time |
| iCredit Sale ID | `ICredit_Sale_ID` | Single Line |
| iCredit Payment URL | `ICredit_Payment_URL` | URL |
| iCredit Auth Number | `ICredit_Auth_Number` | Single Line |
| iCredit Card Last4 | `ICredit_Card_Last4` | Single Line |

## A.2 Accounts **and** Contacts

`Rivhit_Customer_ID` (Number) · `Rivhit_Acc_Ref` (Single Line, **max 9**) ·
`Rivhit_Tax_ID` (Single Line) · `Rivhit_VAT_Number` (Single Line) ·
`Rivhit_Customer_Type` (Number) · `Rivhit_Price_List_ID` (Number) ·
`Rivhit_Agent_ID` (Number) · `Rivhit_Balance` (**Currency 16,2**) ·
`Rivhit_Balance_Updated` (Date/Time) · `Rivhit_Last_Sync` (Date/Time) ·
`Rivhit_Sync_Error` (Multi Line)

## A.3 Products

`Rivhit_Item_ID` (Number) · `Rivhit_Catalog_Number` (Single Line, ≤15) ·
`Rivhit_Item_Group_ID` (Number) · `Rivhit_Storage_ID` (Number) ·
`Rivhit_Quantity_On_Hand` (Number) · `Rivhit_Quantity_Updated` (Date/Time)

## A.4 Custom module `Rivhit_Receipts`

Singular *Rivhit Receipt*, plural *Rivhit Receipts*, **API name `Rivhit_Receipts`**.

| Label | API name | Type |
|---|---|---|
| Receipt Name | `Name` | Single Line (default record-name field) |
| iCredit Sale ID | `ICredit_Sale_ID` | Single Line — **tick “Unique”** |
| Processing State | `Processing_State` | Picklist — `Claimed`, `Applied`, `Rejected` |
| Rejection Reason | `Rejection_Reason` | Multi Line |
| Receipt Type | `Receipt_Type` | Number |
| Receipt Number | `Receipt_Number` | Number |
| Receipt Identity | `Receipt_Identity` | Single Line |
| Receipt Amount | `Receipt_Amount` | **Currency 16,2** |
| Receipt Date | `Receipt_Date` | Date |
| Payment Method | `Payment_Method` | Single Line |
| Receipt URL | `Receipt_URL` | URL |
| Closed Document Type | `Closed_Document_Type` | Number |
| Closed Document Number | `Closed_Document_Number` | Number |
| Invoice | `Invoice` | Lookup → Invoices |
| Account | `Account` | Lookup → Accounts |
| Source | `Source` | Picklist — `CRM`, `iCredit`, `Rivhit` |

---

# Appendix B — organisation variables

All **Text**, created blank. Sigma prefixes each with `rivhitzohocrmextension__`.

| Name | Purpose |
|---|---|
| `API_Token` | Rivhit api_token |
| `Company_ID` | builds PDF links |
| `Account_Mode` | `demo` / `production` |
| `Default_Language` | `he` / `en` |
| `Type_Cache` | JSON catalog snapshot (written by the app) |
| `Doc_Type_Roles` | JSON, the four role mappings |
| `Payment_Type_Map` | JSON, CRM method → Rivhit code |
| `Action_Permissions` | JSON permissions matrix |
| `Sort_Code_VAT` | default `100` |
| `Sort_Code_Exempt` | default `150` |
| `Default_Currency_ID` | default `1` |
| `Default_Update_Inventory` | `true` / `false` |
| `Send_Mail_Default` | `true` / `false` |
| `Digital_Signature` | `true` / `false` |
| `Confirmation_Required` | `true` / `false` |
| `Approver_ID_Number` | ת.ז for retroactive allocation numbers |
| `Monthly_Doc_Quota` | blank = no warning threshold |
| `Reconcile_Window_Days` | default `35` |
| `ICredit_Enabled` | `true` / `false` |
| `ICredit_Issues_Document` | `true` / `false` |
| `ICredit_Test_Mode` | `true` / `false` |
| `ICredit_Group_Token_Prod` | |
| `ICredit_Group_Token_Test` | |
| `ICredit_IPN_URL` | from phase A3 |
| `ICredit_IPN_Failure_URL` | from phase A3 |
| `ICredit_Redirect_URL` | thank-you page |
| `Usage_Counter` | JSON, written by the app |
| `Sync_State` | JSON cursor, written by the app |
| `Health_State` | written by the reconciler |

---

# Appendix C — scopes

```
ZohoCRM.modules.invoices.READ / UPDATE
ZohoCRM.modules.salesorders.READ / UPDATE
ZohoCRM.modules.accounts.READ / UPDATE
ZohoCRM.modules.contacts.READ / UPDATE
ZohoCRM.modules.products.READ / UPDATE
ZohoCRM.modules.custom.ALL          (Rivhit_Receipts)
ZohoCRM.modules.notes.CREATE        (audit trail + drift notes)
ZohoCRM.org.variables.ALL
ZohoCRM.settings.fields.READ
ZohoCRM.settings.profiles.READ      (permissions matrix)
ZohoCRM.users.READ                  (resolve the caller's profile)
```

Scope changes force admin re-consent on update, so settle the set before the first production
publish.

---

# Appendix D — troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Function errors on its last line | A signature line was pasted with the body | Paste the **body only** |
| Console shows an old build marker | Publish or cache did not take | Re-publish as major, hard-refresh |
| “ההרחבה טרם הוגדרה” everywhere | `API_Token` missing or blank | Phase B1, then C1 |
| Save reports success but values vanish | Org variable missing or misnamed | Compare to Appendix B exactly — the save function reads back and reports mismatches |
| `updateRecord` succeeds but fields stay empty | Field API name mismatch | The code resolves plain and namespaced names — check the field exists on **both** Invoices and Sales Orders |
| “saved, but field X skipped” | That field is misconfigured, usually a short Currency field | Recreate as Currency 16,2 |
| Document number scrambled in Hebrew | Rendered without bidi isolation | Report it — every number should go through `ltrHtml` |
| Duplicate receipts from one card payment | `ICredit_Sale_ID` is not Unique | Phase E2. This is the entire concurrency guard. |
| Payment marked paid on a declined card | `IPNFailureURL` not set | Phases A3 and H |
| Two tax documents per card payment | `ICredit_Issues_Document` disagrees with the iCredit page | Phase H3 |
| Invoices never move to Paid | Schedule never created or activated | Phase E4 |
| Reconciliation reports “deferred” each run | Volume exceeds the per-run detail budget | Normal — it resumes. Raise the frequency if the backlog does not clear. |
| “האסימון של רווחית נדחה” banner | Token regenerated in Rivhit | Re-enter it in Settings |
| Invoice with a request reference but no document | An issue was interrupted | Issue widget → **Recover**. Never just issue again. |

**Debug mode:** append `?rvdebug=1` to a widget URL for verbose console logging. Build markers,
warnings and errors always print.

**Logs:** Deluge `info` output goes to the function's execution log in Sigma, and to the
Schedules log for `rv_reconcile`. Every Rivhit `debug_message` lands there; only the Hebrew
`client_message` is ever shown to a user.
