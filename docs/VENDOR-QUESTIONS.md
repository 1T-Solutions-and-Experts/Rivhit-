# Questions for Rivhit / iCredit support

Everything the design and build rest on that the public documentation does not answer.
Ready to send to `api@rivhit.co.il` — Hebrew version at the bottom.

> **Question 1 does not need to wait for a reply.** It can be settled empirically on the demo
> account in about five minutes; see "Answering Q1 yourself" below. Send the email anyway,
> but do not block on it.

---

## Blocking

**1. Does `check_only: true` register the `request_reference` when `prevent_duplicates: true`
is also sent?**

If it does, a dry run would consume the idempotency key and the subsequent real call would be
refused as a duplicate — no document would ever be created, while the UI reported "already
issued". The whole safe-write sequence is built on the answer being *no*, and the code
defends against it by never sending the key on a dry run. Confirmation would let us simplify.

## Important

2. **What does a successful `check_only` return** — only a pass/fail status, or also the
   computed document `amount`? If it returns the amount we can converge on Rivhit's own
   arithmetic for free instead of predicting it.
3. **How long is a `request_reference` retained** and retrievable via `Status.LastRequest`?
   This is our recovery window after an ambiguous write.
4. **Does `prevent_duplicates` register a reference when the call fails validation**, or only
   on success? Determines whether a corrected retry can reuse the same key.
5. **Are there request-rate limits** — per second, per minute, per day? Nothing is documented,
   so every loop in the integration is sequential as a precaution.
6. **Does `Customer.OpenDocuments` support pagination?** If not, what is the recommended way
   to bound the response for a business with thousands of open documents?
7. **What are the current API document-issuance charges?** The tiers we have are from 2015 and
   do not appear in the online documentation.

## Technical

8. **Cancelling a חשבונית מס קבלה**: does `Document.Cancel` reverse only the invoice half, so
   `Receipt.Cancel` is also required? Our reading of the docs says yes and the code issues
   both — confirmation would be good, since getting it wrong leaves the books half-reversed.
9. **`Document.Close` on a חשבונית מס קבלה** — does the close apply to the invoice half only?
10. **Is the `reference` (אסמכתא) sent in `Document.New` filterable via `filter_fields` in
    `Document.List`?** We use it as a secondary recovery path when `Status.LastRequest` is
    unavailable.
11. **`acc_ref`** — is the limit genuinely 9 characters, and does `Customer.Get` by `acc_ref`
    do an exact match?
12. **The `order` field** — the OpenAPI spec says 15 characters, the error table says 80.
    Which is enforced?
13. **Foreign currency** — is `exchange_rate` required at document level only, or on each
    item row as well?
14. **`number_of_payments` in `Receipt.New`** — do the generated rows with their due dates
    come back in `Document.Details` / `Receipt.Details`? Our instalment display reads them.
15. **Allocation numbers (חשבוניות ישראל)** — from what amount does Rivhit request one
    automatically, and does it differ by document type?
16. **Are there webhooks on the Rivhit side** (as opposed to iCredit's IPN) for document or
    payment events? We found none, so bookkeeper-entered payments require polling.
17. **Can we get a private test account?** The `demo` account is shared, visible to all
    developers, and not connected to iCredit.

## iCredit

18. **What is the IPN resend policy** — how many attempts, over what interval? We know the
    timeout is 1.25 seconds; we do not know the retry ceiling.
19. **Can the payment page's "issue a document" setting be read through the API?** Right now
    it is a setting our code cannot verify, and a mismatch produces two tax documents for one
    payment.
20. **Which currencies does the payment page support**, and is there a separate configuration
    per currency?

---

## Answering Q1 yourself

Five minutes on the demo account, no vendor reply needed. Any REST client will do.

```
Step 1 — dry run WITH the key
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

Step 2 — the real call, SAME reference, no check_only
   (identical body, remove "check_only", keep the reference)
```

**Reading the result**

| Step 2 returns | Meaning |
|---|---|
| `error_code: 0` and a document number | The dry run did **not** consume the key. Q1 is answered: safe either way. |
| a duplicate-operation error | The dry run **did** consume it. Our defence is load-bearing — never send the key on a dry run. |

Either way, run `Status.LastRequest` with `c1-probe-001` afterwards: it tells you whether the
reference was recorded, and starts the clock on question 3.

Use a fresh `request_reference` for each attempt, and note that step 2 creates a real document
in the shared demo company.

---

## Hebrew — ready to send

> **נושא:** שאלות טכניות על ה-API — אינטגרציה מול Zoho CRM
>
> שלום,
>
> אנחנו מפתחים אינטגרציה בין Zoho CRM לרווחית ול-iCredit. ריכזנו כמה שאלות שלא מצאנו להן תשובה בתיעוד.
>
> **חוסם**
>
> 1. האם קריאה עם `check_only: true` רושמת את ה-`request_reference` כאשר נשלח גם `prevent_duplicates: true`? כלומר — אם נריץ בדיקה עם מפתח מסוים ואז נשלח את הקריאה האמיתית עם אותו מפתח, האם האמיתית תידחה ככפילות?
>
> **חשוב**
>
> 2. מה מחזירה קריאת `check_only` מוצלחת — רק סטטוס, או גם את סכום המסמך המחושב?
> 3. לכמה זמן נשמר `request_reference` וניתן לאחזור דרך `Status.LastRequest`?
> 4. האם `prevent_duplicates` רושם את המפתח גם כשהקריאה נכשלת בוולידציה, או רק בהצלחה?
> 5. האם קיימות מגבלות קצב (בקשות לשנייה / לדקה / ליום)?
> 6. האם `Customer.OpenDocuments` תומך בעימוד? אם לא — מה הדרך המומלצת להגביל את גודל התשובה בעסק עם אלפי מסמכים פתוחים?
> 7. מהם התעריפים הנוכחיים להפקת מסמכים דרך ה-API? התעריפים שבידינו הם משנת 2015 ואינם מופיעים בתיעוד המקוון.
>
> **טכני**
>
> 8. ביטול "חשבונית מס קבלה": האם `Document.Cancel` מבטל רק את חלק החשבונית ונדרש בנוסף `Receipt.Cancel`?
> 9. `Document.Close` על חשבונית מס קבלה — האם הסגירה חלה על חלק החשבונית בלבד?
> 10. האם השדה `reference` (אסמכתא) שנשלח ב-`Document.New` ניתן לסינון באמצעות `filter_fields` ב-`Document.List`?
> 11. `acc_ref` — האם המגבלה היא אכן 9 תווים, והאם `Customer.Get` לפי `acc_ref` מבצע התאמה מדויקת?
> 12. השדה `order` — ב-OpenAPI מצוין 15 תווים ובטבלת השגיאות 80. מה נאכף בפועל?
> 13. מטבע חוץ: האם `exchange_rate` נדרש ברמת המסמך בלבד או גם בכל שורת פריט?
> 14. `number_of_payments` ב-`Receipt.New` — האם השורות שנוצרות עם תאריכי הפירעון חוזרות ב-`Document.Details` / `Receipt.Details`?
> 15. מספרי הקצאה (חשבוניות ישראל): מאיזה סכום רווחית מבקשת מספר הקצאה אוטומטית, והאם יש הבדל בין סוגי מסמכים?
> 16. האם קיימים webhooks בצד רווחית (להבדיל מ-IPN של iCredit) על אירועי מסמך או תשלום?
> 17. האם ניתן לקבל חשבון בדיקה פרטי? חשבון ה-demo משותף, גלוי לכל המפתחים, ואינו מחובר ל-iCredit.
>
> **iCredit**
>
> 18. מהי מדיניות השליחה החוזרת של הודעות IPN — כמה ניסיונות ובאיזה מרווח זמן? ידוע לנו על ה-timeout של 1.25 שניות, אך לא על תקרת הניסיונות.
> 19. האם ניתן לקרוא דרך ה-API את ההגדרה של דף התשלום בנוגע להפקת מסמך אוטומטית?
> 20. אילו מטבעות נתמכים בדף התשלום, והאם נדרשת הגדרה נפרדת לכל מטבע?
>
> תודה רבה,
