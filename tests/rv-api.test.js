/* ═══════════════════════════════════════════════════════════════════════════
   Unit tests for the pure functions in rv-api.js.

   These cover the 20% of the code that carries the financial and compliance
   risk: date conversion in both directions, money rounding, the field-name
   resolver that silently discarded writes in the predecessor extension, the
   response-envelope unwrapper, and the acc_ref surrogate.

   build.py refuses to produce a zip when this suite is red.
   ═══════════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');

// rv-api.js expects a browser. Give it the minimum it touches at load time.
global.window = global;
global.location = { search: '' };
global.document = {
  documentElement: { setAttribute() {} },
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {} }),
  body: { appendChild() {} },
  querySelectorAll: () => []
};
global.ZOHO = { CRM: { META: {}, API: {}, CONFIG: {}, FUNCTIONS: {}, UI: { Popup: {} } }, embeddedApp: {} };

const R = require('../app/rv-api.js');

// ── dates ─────────────────────────────────────────────────────────────────
test('toRivhitDate converts ISO to DD/MM/YYYY', () => {
  assert.strictEqual(R.toRivhitDate('2026-08-11'), '11/08/2026');
  assert.strictEqual(R.toRivhitDate('2026-01-05T10:30:00+03:00'), '05/01/2026');
});

test('toRivhitDate returns empty for junk rather than guessing', () => {
  assert.strictEqual(R.toRivhitDate(''), '');
  assert.strictEqual(R.toRivhitDate(null), '');
  assert.strictEqual(R.toRivhitDate('11/08/2026'), '');
});

test('fromRivhitDate parses both slash and dash forms', () => {
  assert.strictEqual(R.fromRivhitDate('11/08/2026'), '2026-08-11');
  assert.strictEqual(R.fromRivhitDate('5-1-2026'), '2026-01-05');
});

test('date conversion round-trips', () => {
  const iso = '2026-12-31';
  assert.strictEqual(R.fromRivhitDate(R.toRivhitDate(iso)), iso);
});

test('DDMMYYYY — the format the 2015 PDF specified — is rejected, not misparsed', () => {
  assert.strictEqual(R.fromRivhitDate('11082026'), '');
});

// ── money ─────────────────────────────────────────────────────────────────
test('round2 rounds to two decimals', () => {
  assert.strictEqual(R.round2(16.665), 16.67);
  assert.strictEqual(R.round2(10), 10);
  assert.strictEqual(R.round2(0.1 + 0.2), 0.3);
});

test('fractional quantities land on 2dp when the LINE total is rounded', () => {
  // 0.5 x 33.33 = 16.665. Rounding the unit price instead of the line total is
  // what makes the payments array disagree with Rivhit's own arithmetic.
  const qty = 0.5, unit = 33.33;
  const lineTotal = R.round2(unit * qty);
  assert.strictEqual(lineTotal, 16.67);
  const twoLines = R.round2(lineTotal + lineTotal);
  assert.strictEqual(twoLines, 33.34);
});

test('money formats with the right symbol and thousands separators', () => {
  assert.strictEqual(R.money(1234.5, 1), '₪1,234.50');
  assert.strictEqual(R.money(99, 2), '$99.00');
  assert.strictEqual(R.money(0, 3), '€0.00');
});

test('currency id and ISO map both ways', () => {
  assert.strictEqual(R.currencyIso(1), 'ILS');
  assert.strictEqual(R.currencyIso(3), 'EUR');
  assert.strictEqual(R.isoToCurrencyId('USD'), 2);
  assert.strictEqual(R.isoToCurrencyId('nok'), 10);
  assert.strictEqual(R.isoToCurrencyId('ZZZ'), 1, 'unknown currency falls back to shekels');
});

// ── field resolution ──────────────────────────────────────────────────────
// The predecessor extension shipped three releases where updateRecord reported
// SUCCESS and persisted nothing, because manifest-created fields are namespaced
// and hand-created ones are not.
test('_resolveOne prefers the exact plain name', () => {
  const names = ['Rivhit_Document_Number', 'rivhitzohocrmextension__Rivhit_Document_Number'];
  assert.strictEqual(R._resolveOne(names, 'Rivhit_Document_Number'), 'Rivhit_Document_Number');
});

test('_resolveOne finds the namespaced name when no plain one exists', () => {
  const names = ['Subject', 'rivhitzohocrmextension__Rivhit_Document_Number'];
  assert.strictEqual(R._resolveOne(names, 'Rivhit_Document_Number'),
                     'rivhitzohocrmextension__Rivhit_Document_Number');
});

test('_resolveOne matches a foreign namespace via the __ suffix', () => {
  const names = ['someothernamespace__Rivhit_Paid_Amount'];
  assert.strictEqual(R._resolveOne(names, 'Rivhit_Paid_Amount'),
                     'someothernamespace__Rivhit_Paid_Amount');
});

test('_resolveOne does not confuse a field that merely ends in the same word', () => {
  const names = ['Legacy_Rivhit_Document_Number'];
  // No "__" separator, so this is a different field and must not be adopted.
  assert.strictEqual(R._resolveOne(names, 'Rivhit_Document_Number'), 'Rivhit_Document_Number');
});

test('_resolveOne falls back to the logical name when nothing matches', () => {
  assert.strictEqual(R._resolveOne(['Subject', 'Owner'], 'Rivhit_Is_Closed'), 'Rivhit_Is_Closed');
});

// ── response envelope ─────────────────────────────────────────────────────
test('_unwrap handles the details.output shape', () => {
  const resp = { code: 'success', details: { output: '{"ok":true}' } };
  assert.strictEqual(R._unwrap(resp), '{"ok":true}');
});

test('_unwrap handles a bare string', () => {
  assert.strictEqual(R._unwrap('{"ok":true}'), '{"ok":true}');
});

test('_unwrap handles output at the top level', () => {
  assert.strictEqual(R._unwrap({ output: '{"ok":false}' }), '{"ok":false}');
});

test('_unwrap throws on an empty response rather than returning undefined', () => {
  assert.throws(() => R._unwrap(null), /empty response/);
});

test('_unwrap surfaces a non-success function code', () => {
  assert.throws(() => R._unwrap({ code: 'failure', details: {} }), /failure/);
});

// ── escaping and bidi ─────────────────────────────────────────────────────
test('esc neutralises HTML in CRM values and Rivhit messages alike', () => {
  assert.strictEqual(R.esc('<img src=x onerror=alert(1)>'),
                     '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(R.esc('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
});

test('esc turns null and undefined into an empty string', () => {
  assert.strictEqual(R.esc(null), '');
  assert.strictEqual(R.esc(undefined), '');
});

test('ltrHtml isolates numbers so they do not scramble inside Hebrew', () => {
  const out = R.ltrHtml(1234);
  assert.match(out, /^<bdi class="ltr">1234<\/bdi>$/);
});

test('ltrHtml still escapes its content', () => {
  assert.match(R.ltrHtml('<b>'), /&lt;b&gt;/);
});

// ── zohoNow ───────────────────────────────────────────────────────────────
test('zohoNow emits ISO 8601 with an offset', () => {
  // Zoho DateTime fields reject anything without one, and one rejected field
  // kills the whole updateRecord call.
  assert.match(R.zohoNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

// ── acc_ref surrogate ─────────────────────────────────────────────────────
// Mirrors the Deluge implementation: module letter + last 8 digits of the id.
// acc_ref holds 9 characters; Zoho ids are 18-19 digits and cannot fit.
function surrogate(module, id) {
  return (module === 'Contacts' ? 'C' : 'A') + String(id).slice(-8);
}

test('acc_ref surrogate is exactly 9 characters', () => {
  assert.strictEqual(surrogate('Accounts', '554023000000123456').length, 9);
  assert.strictEqual(surrogate('Contacts', '554023000000987654').length, 9);
});

test('acc_ref surrogate is deterministic', () => {
  const a = surrogate('Accounts', '554023000000123456');
  const b = surrogate('Accounts', '554023000000123456');
  assert.strictEqual(a, b);
});

test('acc_ref surrogate separates the two customer modules', () => {
  assert.notStrictEqual(surrogate('Accounts', '554023000000123456'),
                        surrogate('Contacts', '554023000000123456'));
});

test('acc_ref surrogate distinguishes ids that differ in the last 8 digits', () => {
  assert.notStrictEqual(surrogate('Accounts', '554023000000123456'),
                        surrogate('Accounts', '554023000000123457'));
});

// ── request_reference derivation ──────────────────────────────────────────
function reqRef(module, id, intent, revision) {
  return 'zcrm:' + module + ':' + id + ':' + intent + ':' + revision;
}

test('request_reference is stable for the same operation', () => {
  assert.strictEqual(reqRef('Invoices', '123', 'doc', 1), reqRef('Invoices', '123', 'doc', 1));
});

test('request_reference separates intents and revisions', () => {
  assert.notStrictEqual(reqRef('Invoices', '123', 'doc', 1), reqRef('Invoices', '123', 'receipt', 1));
  assert.notStrictEqual(reqRef('Invoices', '123', 'doc', 1), reqRef('Invoices', '123', 'doc', 2));
});

test('request_reference separates the two host modules', () => {
  assert.notStrictEqual(reqRef('Invoices', '123', 'doc', 1), reqRef('Sales_Orders', '123', 'doc', 1));
});

test('the revision suffix survives a round trip through split', () => {
  const ref = reqRef('Invoices', '123', 'doc', 7);
  const parts = ref.split(':');
  assert.strictEqual(Number(parts[parts.length - 1]) + 1, 8);
});

// ── status rendering ──────────────────────────────────────────────────────
test('statusChip renders every documented status', () => {
  ['Not Issued', 'Issued', 'Partially Paid', 'Paid', 'Cancelled'].forEach(s => {
    const html = R.statusChip(s);
    assert.match(html, /^<span class="chip chip-/);
  });
});

test('statusChip degrades safely on an unexpected value', () => {
  assert.match(R.statusChip('Something Else'), /chip-neutral/);
});
