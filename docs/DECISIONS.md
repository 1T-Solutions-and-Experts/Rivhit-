# Confirmed parameters

Answers from the client, 2026-08-11, and what each one changes in the design. This file is
the authoritative record; where it disagrees with an older statement elsewhere in the docs,
this file wins.

| # | Question | Answer |
|---|---|---|
| 1 | Which document types? | **All of them** — every type the business's Rivhit account supports |
| 2 | חשבוניות ישראל regime, Tax Authority link enabled under the token's user? | **Yes, no issues** |
| 3 | iCredit contracted? | **Yes** |
| 4 | Does the iCredit page issue the tax document itself? | **Yes** |
| 5 | Monthly volume / tier pricing | **Open** — see below |
| 6 | Where do documents originate? | **Sales Orders and Invoices** |
| 7 | Default language | **Hebrew** |
| 8 | Multi-currency / stock | **Multi-currency yes**; stock decrement is a **per-document choice** |
| 9 | One Rivhit company or several? | **One** |
| 10 | Distribution | **Private now, Marketplace later** |

---

## 1 — Support every document type

**Change: the fixed intent map is gone.** Revision 2 mapped six CRM "intents" (tax invoice,
invoice+receipt, credit note, delivery note, quote, order) onto Rivhit type codes. That
caps the extension at six of the types a business may have configured.

**Replacement: a type catalog driven by `Document.TypeList`.** The full list is cached at
setup and refreshed on demand. The issue widget renders it as a picker, in Hebrew, showing
every type the account has. Behaviour per type is derived from the flags Rivhit returns
rather than from anything the extension hardcodes:

| Flag | Drives |
|---|---|
| `is_invoice_receipt` | whether `payments[]` is **required**, and whether the payment panel appears |
| `price_include_vat` | the default price mode for that type |
| `is_accounting` | whether the document affects the books — governs the confirmation-number check, the AR report, and the strength of the confirmation prompt |

**Only three roles still need an explicit mapping**, because the code has to reason about
them semantically rather than just issue them:

- `role_credit` — the credit/refund type, used as the fallback when `Document.Cancel` is not
  applicable and a negative-amount document must be produced instead
- `role_default_sales_order` — pre-selected type on the Sales Orders widget
- `role_default_invoice` — pre-selected type on the Invoices widget

`Receipt.TypeList` gets the same treatment: full catalog, with `role_default_receipt` for the
standalone-receipt button, and `is_invoice_receipt` used to filter out receipt types that
cannot be issued standalone.

**Consequence for the org variables:** `Doc_Type_Map` is replaced by `Doc_Type_Roles` (three
entries) plus `Type_Cache` (the whole catalog). Mapping screens get shorter, not longer.

## 2 — Confirmation numbers are in scope

The business is in the חשבוניות ישראל regime and the Tax Authority link is already enabled
under the account that owns the API token. So `Confirmation_Required` ships **on**, and flow
C5 is mandatory in Phase 2 rather than conditional.

Refinement now that it is certain: the confirmation check applies **only to types where
`is_accounting = true`**. A delivery note or price quote never needs an allocation number, and
flagging one as `Missing` would be noise that trains people to ignore the exception list.

## 3 & 4 — iCredit is contracted and issues the document

`ICredit_Enabled = true` and `ICredit_Issues_Document = true` are the shipped defaults.

**This is the single most consequential answer**, because it splits the extension into two
document-producing paths that must never both fire for one sale:

| Path | Who issues | When |
|---|---|---|
| **CRM-issued** | `rv_issue_document` | any document raised from a Sales Order or Invoice that is not being paid by card |
| **iCredit-issued** | the iCredit payment page | whenever the customer pays through a payment link |

**Guards added because of this:**

1. Once a payment link is generated for a record, the **Issue in Rivhit** button is disabled
   with an explicit reason ("a payment link is outstanding — iCredit will issue the document
   on payment"). It can be re-enabled by voiding the link.
2. Conversely, once a document exists on the record, the **Payment Link** button warns that
   iCredit will issue a *second* document, and offers "record a payment against the existing
   document" (flow C2) instead.
3. The IPN handler in `ICredit_Issues_Document = true` mode **records** `DocumentNum`,
   `DocumentType`, `DocumentURL` onto the CRM record and never calls `Document.New`.
4. The first test charge cross-checks the setting: an IPN arriving with no `DocumentNum` while
   the setting says `true` means the iCredit page is misconfigured, and the widget says so.

**Also:** because iCredit issues the document, its `confirmation_number` does not come back in
the IPN. After recording an iCredit-issued document, the handler resolves the full record via
`Document.Details` to capture the confirmation number and totals.

## 5 — Volume and tier: still open

The tiers in the 2015 PDF (0 free · ₪19/50 · ₪39/200 · ₪69/500 · ₪119/1000, ex-VAT) are not
published in the current documentation, so they may be stale or absorbed into the Rivhit
Online subscription. Needed: expected documents per month, and the tier actually in force.

Not a blocker. `Monthly_Doc_Quota` defaults to unset, in which case the usage counter is shown
but no warning threshold fires. If issuance turns out to be included in the subscription the
counter stays as an informational figure. Every other safeguard — dry runs, idempotency,
no blind retries — is justified by the irreversibility of a tax document regardless of price.

## 6 — Sales Orders and Invoices

**Change: a second host module, and a real document chain.**

Zoho's Sales Order → Invoice progression maps directly onto Rivhit's Order → Invoice closing
chain, which the design already supports but did not previously use:

```
CRM Sales Order ──issue──► Rivhit order-type document        (open)
       │
       └─ converted to ──► CRM Invoice ──issue──► Rivhit invoice
                                                   closing the order document
                                                   (closed_document_type / _number)
```

When a document is issued from an Invoice that came from a Sales Order already carrying a
Rivhit document number, the issue flow offers to close the order document with it, pre-ticked.
The user can decline — partial fulfilment is normal, and per-line partial closing
(`closed_document_num` + `closed_document_line`) covers it.

**Consequences:** the full Rivhit field set is duplicated on Sales Orders; the issue,
refresh, cancel and payment-link widgets are registered on both modules; scopes gain
`ZohoCRM.modules.salesorders.READ` and `.UPDATE`; and everything that reads "the invoice" in
the flows now reads "the source record".

## 7 — Hebrew first

**Change: RTL is the default, not a localisation layer.**

- Widgets render `dir="rtl"` and Hebrew strings by default; English is the alternate.
- `language: "he"` on every document unless the record says otherwise.
- Document type and receipt type names come from Rivhit already in Hebrew — display them
  as-is rather than translating.
- Rivhit's `client_message` is Hebrew and user-facing; it goes straight to the UI.
- **Bidirectional text is a real defect source.** Document numbers, identities, tax IDs and
  currency amounts must be wrapped so they render left-to-right inside RTL text — the Green
  Invoice bridge shipped scrambled document IDs until this was fixed, and it is on the QA
  list here from the start.
- The design docs stay in English; the product is Hebrew.

## 8 — Multi-currency and per-document stock control

### Multi-currency

Rivhit currency codes: `1` NIS · `2` USD · `3` EUR · `4` GBP · `5` AUD · `6` CAD · `7` CHF ·
`8` SEK · `9` DKK · `10` NOK. `Currency.List` returns the account's configured set.

Mapper rules:

- Document carries `currency_id` and, for non-ILS, `exchange_rate`.
- Items in ILS send `price_nis`; items in another currency send `price_mtc` **plus** matching
  `currency_id`.
- **Every item must share the document's currency** — mixing them returns error `-68`. This is
  validated locally before the call and caught again by the `check_only` dry run.
- Payments carry `amount_mtc` alongside or instead of `amount_nis`.
- A Rivhit customer card can be pinned to a foreign currency, but that requires the card to be
  set up for it (`pal_code`). The customer sync does **not** change a customer's currency; it
  reports a mismatch instead of silently rewriting an accounting record.

New fields: `Rivhit_Currency_ID` and `Rivhit_Exchange_Rate` on Sales Orders and Invoices. The
CRM record's own currency drives the default; the issue widget shows it and allows an override
with the rate.

### Stock decrement

Exposed as a per-document choice, as requested, with an org-level default:

| Control | Effect |
|---|---|
| **Update stock** (checkbox, per document) | unchecked sends `no_update_inventory: true`, so the document does not reduce inventory even if its type normally would |
| `Default_Update_Inventory` (org variable) | the checkbox's initial state |
| **Block if out of stock** (checkbox) | sends `reject_item_quantity: true` — Rivhit refuses to produce the document when an item is short |
| `Rivhit_Storage_ID` per line | which warehouse the stock leaves from; falls back to the item card's |

Both flags are recorded on the CRM record and in the audit note, because "why did stock not
move" is otherwise unanswerable after the fact.

## 9 — One Rivhit company

No company selector, no per-company credentials. `Company_ID` stays a single org variable used
to build PDF links. The design does not preclude multi-company later, but nothing is built for
it now.

## 10 — Private now, Marketplace later

Build to Marketplace standards from the start, list later. Concretely, these are treated as
requirements rather than deferred polish:

- Every rendered string escaped — CRM field values and Rivhit `client_message` alike.
- Manifest hygiene: no declared variables the code does not read, one `VERSION` across
  manifest, build markers and zip.
- Least-privilege scopes, each justifiable in a listing.
- A privacy policy covering what leaves CRM for Rivhit and iCredit, and what is stored back —
  including `ICredit_Card_Last4`.
- No hardcoded business-specific values anywhere; everything through settings and runtime
  discovery.

The one thing deferred: screenshots and listing copy.

---

## Still open

1. **Monthly document volume and the tier in force** (question 5 above).
2. **Which Rivhit document type is the account's order type**, and which is its credit type —
   answered at setup by the admin from the type catalog, not by us in advance.
3. **Rate limits** — undocumented; ask `api@rivhit.co.il`.
4. **`Status.LastRequest` retention window** — how long recovery stays possible.
