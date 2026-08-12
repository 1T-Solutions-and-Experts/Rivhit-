# Sigma deployment guide — Rivhit Bridge V1.0-r1

Click-by-click. Follow it in order: the widgets fail loudly if the fields, org
variables and functions are not already there.

Budget about **2–3 hours** for a first install, most of it creating fields.

Extension namespace: `rivhitzohocrmextension` · Publisher: **1T Solutions and Experts**

> **Do the whole thing against the Rivhit demo account first.** There is no separate
> sandbox host — test and production share `api.rivhit.co.il` and differ only by which
> account the token belongs to. A production token in step 12 issues real legal documents
> from your very first click.

---

## 0. Prerequisites

**On the Rivhit side**

| | |
|---|---|
| Rivhit **Online** or **Invoice Online** | The desktop version has no API |
| API token | Rivhit Online → הגדרות → API → הצג API TOKEN |
| Company ID | Same screen; used to build PDF links |
| Tax Authority link (חשבוניות ישראל) | Must be enabled **under the same Rivhit user that owns the API token**. Under any other user, documents issue with no allocation number and your customers cannot deduct input VAT. |

Demo credentials for the dry run: user `demo`, password `123`, VAT `123`, token
`DECD03E5-E35C-41E8-84F7-FBA2FB483928` at <https://online1.rivhit.co.il/loginmanager/login>.
The demo account is **not** connected to iCredit, so card flows need a separate iCredit test token.

**On the Zoho side**

- Administrator profile.
- Invoices, Sales Orders, Accounts, Contacts and Products modules enabled.
- Node 18+ and Python 3 locally, to run the build.

---

## 1. Build the bundle

```bash
cd Rivhit-
python3 build.py
```

The build validates the manifest, checks every Deluge body for a stray signature line and
for the `check_only` idempotency trap, **runs the test suite and refuses to zip if it is
red**, inlines the shared JS/CSS into every widget, syntax-checks each inlined block, and
asserts every widget opens RTL.

Output: `rivhit-bridge-V1.0-r1.zip` (~126 KB).

> Widgets must be self-contained: Zoho's widget CDN intermittently 404s shared asset files.
> Never edit the files in `dist/` — they are generated.

---

## 2. Create the extension in Sigma

1. <https://sigma.zoho.com> → **Create Extension** → **Zoho CRM**.
2. Name `Rivhit Bridge`, namespace **`rivhitzohocrmextension`** — it must match exactly or
   every namespaced field lookup and org-variable read breaks.
3. Choose **Extension for a single organisation** (private). The code is written to
   Marketplace standards so this can be flipped later.

---

## 3. Custom fields

Setup → **Customization → Modules and Fields**. Types and lengths are load-bearing: an
undersized numeric field rejects writes, and one rejected field kills the entire update.

### 3.1 Invoices **and** Sales Orders — identical set on both

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

### 3.2 Accounts **and** Contacts

`Rivhit_Customer_ID` (Number) · `Rivhit_Acc_Ref` (Single Line, **max 9**) ·
`Rivhit_Tax_ID` (Single Line) · `Rivhit_VAT_Number` (Single Line) ·
`Rivhit_Customer_Type` (Number) · `Rivhit_Price_List_ID` (Number) ·
`Rivhit_Agent_ID` (Number) · `Rivhit_Balance` (**Currency 16,2**) ·
`Rivhit_Balance_Updated` (Date/Time) · `Rivhit_Last_Sync` (Date/Time) ·
`Rivhit_Sync_Error` (Multi Line)

### 3.3 Products

`Rivhit_Item_ID` (Number) · `Rivhit_Catalog_Number` (Single Line, ≤15) ·
`Rivhit_Item_Group_ID` (Number) · `Rivhit_Storage_ID` (Number) ·
`Rivhit_Quantity_On_Hand` (Number) · `Rivhit_Quantity_Updated` (Date/Time)

---

## 4. Custom module `Rivhit_Receipts`

Setup → **Modules and Fields → Create Module**. Singular *Rivhit Receipt*, plural
*Rivhit Receipts*, **API name `Rivhit_Receipts`**.

| Label | API name | Type | Notes |
|---|---|---|---|
| Receipt Name | `Name` | Single Line | the module's default record-name field |
| iCredit Sale ID | `ICredit_Sale_ID` | Single Line — **tick “Unique”** | ⚠ see below |
| Processing State | `Processing_State` | Picklist — `Claimed`, `Applied`, `Rejected` | |
| Rejection Reason | `Rejection_Reason` | Multi Line | |
| Receipt Type | `Receipt_Type` | Number | |
| Receipt Number | `Receipt_Number` | Number | |
| Receipt Identity | `Receipt_Identity` | Single Line | |
| Receipt Amount | `Receipt_Amount` | **Currency 16,2** | |
| Receipt Date | `Receipt_Date` | Date | |
| Payment Method | `Payment_Method` | Single Line | |
| Receipt URL | `Receipt_URL` | URL | |
| Closed Document Type | `Closed_Document_Type` | Number | |
| Closed Document Number | `Closed_Document_Number` | Number | |
| Invoice | `Invoice` | Lookup → Invoices | |
| Account | `Account` | Lookup → Accounts | |
| Source | `Source` | Picklist — `CRM`, `iCredit`, `Rivhit` | |

> ### ⚠ `ICredit_Sale_ID` must be Unique. This is not optional.
>
> iCredit requires a 200 OK within **1.25 seconds** or it resends the notification, and a
> Zoho function's cold start alone can exceed that. Duplicate deliveries are normal traffic.
> Deluge has no locks, so the unique constraint **is** the mutex: the IPN handler's first
> action is to claim the sale id, and the loser of a concurrent race is rejected by the
> platform and stops. Without the constraint, two simultaneous deliveries both proceed and
> the customer is credited twice.

---

## 5. Organisation variables

Sigma editor → **Storage → Organisation Variables**. Create every one as **Text**. Sigma
prefixes them automatically with `rivhitzohocrmextension__`.

| Name | Purpose |
|---|---|
| `API_Token` | Rivhit api_token |
| `Company_ID` | for PDF links |
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
| `Approver_ID_Number` | ת.ז used for retroactive allocation numbers |
| `Monthly_Doc_Quota` | blank = no warning threshold |
| `Reconcile_Window_Days` | default `35` |
| `ICredit_Enabled` | `true` / `false` |
| `ICredit_Issues_Document` | `true` / `false` — **the most consequential setting** |
| `ICredit_Test_Mode` | `true` / `false` |
| `ICredit_Group_Token_Prod` | |
| `ICredit_Group_Token_Test` | |
| `ICredit_IPN_URL` | filled in at step 7 |
| `ICredit_IPN_Failure_URL` | filled in at step 7 |
| `ICredit_Redirect_URL` | thank-you page |
| `Usage_Counter` | JSON, written by the app |
| `Sync_State` | JSON cursor, written by the app |
| `Health_State` | written by the scheduled reconciler |

Leave the values blank — step 12 fills them through the Settings widget.

---

## 6. Deluge functions

Sigma editor → **Functions → Create Function**. For each one: paste the **body only** from
`functions/<name>.deluge`. A signature line in the body is a syntax error — Sigma generates
the wrapper itself.

| # | Function name | Category | Return | Argument |
|---|---|---|---|---|
| 1 | `rv_lookup` | REST API | STRING | `crmAPIRequest` |
| 2 | `rv_save_settings` | REST API | STRING | `crmAPIRequest` |
| 3 | `rv_issue_document` | REST API | STRING | `crmAPIRequest` |
| 4 | `rv_issue_receipt` | REST API | STRING | `crmAPIRequest` |
| 5 | `rv_close_document` | REST API | STRING | `crmAPIRequest` |
| 6 | `rv_cancel_document` | REST API | STRING | `crmAPIRequest` |
| 7 | `rv_confirmation` | REST API | STRING | `crmAPIRequest` |
| 8 | `rv_recover_request` | REST API | STRING | `crmAPIRequest` |
| 9 | `rv_upsert_customer` | REST API | STRING | `crmAPIRequest` |
| 10 | `rv_sync_products` | REST API | STRING | `crmAPIRequest` |
| 11 | `rv_reconcile` | REST API | STRING | *(none)* |
| 12 | `rv_icredit_get_url` | REST API | STRING | `crmAPIRequest` |
| 13 | `rv_icredit_ipn` | REST API | STRING | `crmAPIRequest` |
| 14 | `rv_icredit_ipn_failure` | REST API | STRING | `crmAPIRequest` |
| 15 | `rv_log_change` | **Automation** | STRING | `recId` (String), `moduleArg` (String) |

`crmAPIRequest` is type **Map**. For #15 the two arguments are mapped by the workflow rule
in step 9.

Save each one and confirm it compiles before moving on. If a function reports an error on
its last line, you almost certainly pasted a signature line with it.

---

## 7. Publish the two IPN endpoints

Only `rv_icredit_ipn` and `rv_icredit_ipn_failure`.

1. Open the function → **⋯ → REST API** → enable it → choose **API Key**.
2. Copy the generated URL. It looks like:

```
https://www.zohoapis.com/crm/v2/functions/rv_icredit_ipn/actions/execute?auth_type=apikey&zapikey=1003.xxxx
```

3. Keep both URLs — they go into Settings (step 12) and the iCredit back office (step 13).

> Only ports 80 and 443 are accepted by iCredit, and the whole path must be publicly
> reachable; the Zoho endpoint satisfies both. Treat the `zapikey` as a secret, but never as
> the security boundary — the four checks inside the function are.

---

## 8. Upload the widgets

1. Sigma editor → **Widgets → Upload** → `rivhit-bridge-V1.0-r1.zip`.
2. Confirm all 15 widget registrations appear (9 widgets; the record-level ones are
   registered twice, once per host module).
3. **Publish** → **Major version** → install/update into the org.
4. When prompted, **accept the scopes**. The extension requests:

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

5. Open any widget and check the browser console for **`[Rivhit API] BUILD V1.0-r1`**.
   An older marker means the publish or the cache did not take — **stop and fix that before
   continuing**, or you will debug code that is not running.

---

## 9. Workflow rule — post-issuance change notes

Create on **both** Invoices and Sales Orders.

Setup → **Automation → Workflow Rules → Create Rule**

| | |
|---|---|
| Module | Invoices *(then repeat for Sales Orders)* |
| Rule name | `Rivhit — log post-issuance changes` |
| When | **On a record action → Edit** → *Repeat this workflow whenever a record is edited* |
| Condition | `Rivhit Document Number` **is not empty** |
| Action | **Function → `rv_log_change`** |

Map the arguments: `recId` → **Invoice Id** (or Sales Order Id), `moduleArg` → the literal
string `Invoices` (or `Sales_Orders`).

> The condition is not decoration. Without it the rule fires on ordinary pre-issue editing
> and buries every record in notes.

---

## 10. Scheduled reconciliation

Setup → **Automation → Actions → Schedules → + Configure Schedule**

| | |
|---|---|
| Name | `Rivhit Payment Reconciliation` |
| Frequency | Every 6 hours |
| Function | `rv_reconcile` |

Save, **activate**, and confirm the first run in the execution log.

> Without this schedule nothing syncs and payment status is manual only. Say so to users if
> you choose not to create it.

---

## 11. Add the buttons

The manifest registers the button widgets, but Zoho still needs them placed.

Setup → **Customization → Modules and Fields → Invoices → Links and Buttons**. Confirm
these exist and are visible in the **Detail Page** layout:

- הפקת מסמך ברווחית
- רישום תשלום / קבלה
- קישור לתשלום (iCredit)
- רענון סטטוס מרווחית
- ביטול מסמך ברווחית

Repeat for **Sales Orders**. For **Accounts**, **Contacts** and **Products**, confirm the
mass-action buttons appear in the list view's **Actions** menu.

---

## 12. Configure through the Settings widget

Setup → **Marketplace → Installed → Rivhit Bridge → Settings** (or the extension's
Settings tab).

**Connection tab**
1. Paste the API Token and Company ID. Set **Account type** — this is displayed on every
   write widget, so get it right.
2. **Test Connection.** Green with the business name means the token works.
3. Type discovery runs automatically on success.

**Document types tab**
4. **Refresh catalog from Rivhit.** Every document and receipt type your account has
   appears, with its flags.
5. Set the four roles: default for Invoices, default for Sales Orders, credit type, default
   receipt type. Only these need mapping — everything else is chosen at issue time.
6. Map each CRM payment method to a Rivhit payment code. **Do not assume the defaults** —
   codes differ per business.

**Document defaults tab**
7. Confirm the VAT / exempt sort codes against your Rivhit configuration (Rivhit's defaults
   are 100 / 150).
8. Set the default currency, stock behaviour, mail and signature options.
9. If you are in the חשבוניות ישראל regime, tick **Confirmation numbers** and enter the
   approver's ת.ז.

**iCredit tab**
10. Enable, set test mode, paste both group tokens.
11. Paste the two IPN URLs from step 7 and a thank-you page URL.
12. **Set “iCredit issues the document” to match how the payment page is actually
    configured.** Read the explanation the widget shows — getting this wrong produces two
    tax documents for one payment, and the customer sees both.

**Permissions tab**
13. Tick which profiles may perform each action. Defaults are Administrator-only for
    everything that writes. You cannot remove your own Settings access.

14. **Save**, reload the widget, and confirm every value persisted.

---

## 13. iCredit back office

Log in to iCredit → payment page settings:

1. **IPN URL** → the `rv_icredit_ipn` URL.
2. **IPN Failure URL** → the `rv_icredit_ipn_failure` URL. Do not skip this: left unset,
   declines arrive at the success endpoint, once per failed attempt.
3. Confirm whether the page issues a document, and make it agree with step 12.
4. Optional allowlist: iCredit posts from `82.80.194.52`, `81.218.62.41`, `31.168.238.28`.

---

## 14. Smoke test — on the demo account

Work through `DEPLOYMENT.md` §9 for the full acceptance list. The minimum before going near
production:

| # | Test | Pass |
|---|---|---|
| 1 | Console shows `BUILD V1.0-r1` in every widget | ☐ |
| 2 | Test Connection green, catalog loads with your real types | ☐ |
| 3 | Settings survive a reload; the secret is never echoed back | ☐ |
| 4 | **Dry run** on an invoice with a deliberate error is rejected and **no document is created** | ☐ |
| 5 | Issue a document; the PDF total matches the CRM invoice to the agora | ☐ |
| 6 | Reopen the invoice → the already-issued card shows, not the form | ☐ |
| 7 | Document number renders left-to-right inside the Hebrew UI | ☐ |
| 8 | Issue again → refused as a duplicate, no second document | ☐ |
| 9 | Kill the tab mid-issue, reopen → **Recover** finds the document, no duplicate | ☐ |
| 10 | Record a partial payment → status `Partially Paid`, right amount | ☐ |
| 11 | Second partial completes it → `Paid`, receipts appear in `Rivhit_Receipts` | ☐ |
| 12 | Mark as settled closes without creating a document; Reopen reverses it | ☐ |
| 13 | Cancel an **invoice-receipt** → *both* halves reversed in Rivhit | ☐ |
| 14 | Sync the same account twice → updated, never a second customer | ☐ |
| 15 | Edit an issued invoice → a note appears naming the change | ☐ |
| 16 | A non-permitted profile gets a refusal, not a document | ☐ |
| 17 | AR report totals match Rivhit's own aging report | ☐ |
| 18 | With iCredit: test charge fires the IPN; a **replayed** IPN changes nothing; a declined card marks nothing paid; **exactly one** tax document exists | ☐ |

---

## 15. Going to production

1. Re-run the smoke test on the demo account until it is clean.
2. Settings → replace the token, set **Account type = production**.
3. **Refresh the catalog again** — the demo account's type codes are not yours, so the role
   mapping must be redone against the real catalog.
4. Run a **dry run** (`check_only`) on one document of each mapped role. It is free, uses the
   real catalog, and creates nothing — a production rehearsal with no consequences.
5. Issue one real low-value document and verify it in Rivhit end to end.
6. Confirm the scheduled function has run at least once.

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Console shows an old build marker | Publish or cache did not take | Re-publish as a major version, hard-refresh, re-open |
| “ההרחבה טרם הוגדרה” everywhere | `API_Token` org variable missing or blank | Step 5, then step 12 |
| Function fails to compile on its last line | A signature line was pasted with the body | Paste the **body only** |
| Settings save reports success but values vanish | Org variable not created, or the name is misspelled | Compare against step 5 exactly; the save function reads back and reports mismatches |
| `updateRecord` succeeds but fields stay empty | Field API name mismatch | The code resolves plain and namespaced names — check the field actually exists on **both** Invoices and Sales Orders |
| “saved, but field X skipped” warning | That field is misconfigured — usually a Currency field too short | Recreate it as Currency 16,2 |
| Document number renders scrambled in Hebrew | Value rendered without bidi isolation | Report it — every number should go through `ltrHtml` |
| Duplicate receipts from one card payment | `ICredit_Sale_ID` is not marked Unique | Step 4. This is the whole concurrency guard. |
| Payment marked paid on a declined card | `IPNFailureURL` not set, so declines hit the success endpoint | Steps 7 and 13 |
| Two tax documents per card payment | `ICredit_Issues_Document` disagrees with the iCredit page | Step 12 |
| Invoices never move to Paid | The schedule was never created or activated | Step 10 |
| Reconciliation reports “deferred” every run | Volume exceeds the per-run detail budget | Normal — it resumes next run. Raise the frequency if the backlog does not clear. |
| “האסימון של רווחית נדחה” banner | The token was regenerated in Rivhit | Re-enter it in Settings |
| Invoice with no document but a request reference | An issue was interrupted | Open the issue widget → **Recover**. Never just issue again. |

**Debug mode.** Append `?rvdebug=1` to a widget URL for verbose console logging. Build
markers, warnings and errors always print.

**Where the logs are.** Deluge `info` output goes to the function's execution log in Sigma
(and to the Schedules log for `rv_reconcile`). Every Rivhit `debug_message` is logged there;
only the Hebrew `client_message` is ever shown to a user.
