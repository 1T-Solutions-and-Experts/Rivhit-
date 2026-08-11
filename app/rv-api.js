/* ═══════════════════════════════════════════════════════════════════════════
   Rivhit Bridge — shared widget client
   ---------------------------------------------------------------------------
   This file NEVER talks to Rivhit or iCredit. Every outbound call goes through
   a named Deluge function, because the Rivhit api_token is static, unscoped and
   non-expiring and must not exist in browser memory. See docs/ARCHITECTURE.md §2.

   Loaded as a plain <script> in every widget and INLINED by build.py — Zoho's
   widget CDN intermittently 404s shared asset files.
   ═══════════════════════════════════════════════════════════════════════════ */
var RivhitAPI = (function () {
  'use strict';

  var VERSION = 'V1.0-r1';
  var NS      = 'rivhitzohocrmextension__';

  console.log('%c[Rivhit API] BUILD ' + VERSION,
              'background:#0E6E63;color:#fff;padding:2px 6px;border-radius:3px');

  var DEBUG = (typeof location !== 'undefined') && /[?&]rvdebug=1/.test(location.search || '');
  function dbg() { if (DEBUG && typeof console !== 'undefined' && console.log) console.log.apply(console, arguments); }
  function setDebug(on) { DEBUG = !!on; }

  // ══════════════════════════════════════════════════════════════ i18n ══════
  // Hebrew is the default. English is the exception. See DECISIONS.md §7.
  var LANG = 'he';
  var STR = {
    he: {
      loading: 'טוען…', save: 'שמירה', cancel: 'ביטול', close: 'סגירה', retry: 'נסה שוב',
      back: 'חזרה', confirm: 'אישור', copy: 'העתקה', copied: 'הועתק', open: 'פתיחה',
      genericError: 'אירעה שגיאה', noPermission: 'אין לך הרשאה לפעולה זו',
      notConfigured: 'ההרחבה טרם הוגדרה. פתח את הגדרות רווחית.',
      documentNumber: 'מספר מסמך', documentType: 'סוג מסמך', confirmationNumber: 'מספר הקצאה',
      total: 'סה״כ', paid: 'שולם', balance: 'יתרה', currency: 'מטבע', customer: 'לקוח',
      issueDate: 'תאריך הפקה', dueDate: 'תאריך פירעון', status: 'סטטוס',
      openDoc: 'פתיחת המסמך ברווחית', lastSync: 'סונכרן לאחרונה',
      st_not_issued: 'טרם הופק', st_issued: 'הופק', st_partial: 'שולם חלקית',
      st_paid: 'שולם', st_cancelled: 'בוטל',
      cf_not_required: 'לא נדרש', cf_obtained: 'התקבל', cf_missing: 'חסר', cf_failed: 'ניסיון נכשל',
      dryRunOk: 'הבדיקה עברה — המסמך תקין להפקה', dryRunFail: 'הבדיקה נכשלה',
      billableWarn: 'הפקת מסמך היא פעולה חשבונאית בלתי הפיכה ומחויבת במכסה החודשית.',
      driftWarn: 'הרשומה שונתה לאחר שהמסמך הופק ברווחית. המסמך ברווחית לא השתנה.',
      instalment: 'תשלום', of: 'מתוך'
    },
    en: {
      loading: 'Loading…', save: 'Save', cancel: 'Cancel', close: 'Close', retry: 'Retry',
      back: 'Back', confirm: 'Confirm', copy: 'Copy', copied: 'Copied', open: 'Open',
      genericError: 'Something went wrong', noPermission: 'You do not have permission for this action',
      notConfigured: 'The extension is not configured yet. Open Rivhit Settings.',
      documentNumber: 'Document number', documentType: 'Document type', confirmationNumber: 'Allocation number',
      total: 'Total', paid: 'Paid', balance: 'Balance', currency: 'Currency', customer: 'Customer',
      issueDate: 'Issue date', dueDate: 'Due date', status: 'Status',
      openDoc: 'Open in Rivhit', lastSync: 'Last synced',
      st_not_issued: 'Not issued', st_issued: 'Issued', st_partial: 'Partially paid',
      st_paid: 'Paid', st_cancelled: 'Cancelled',
      cf_not_required: 'Not required', cf_obtained: 'Obtained', cf_missing: 'Missing', cf_failed: 'Retry failed',
      dryRunOk: 'Validation passed — the document is ready to issue', dryRunFail: 'Validation failed',
      billableWarn: 'Issuing a document is an irreversible accounting action and counts against the monthly quota.',
      driftWarn: 'This record changed after the document was issued. The Rivhit document is unchanged.',
      instalment: 'Payment', of: 'of'
    }
  };
  function t(key) { var s = STR[LANG] || STR.he; return (key in s) ? s[key] : ((STR.he[key]) || key); }
  function setLang(lang) {
    LANG = (lang === 'en') ? 'en' : 'he';
    var el = document.documentElement;
    el.setAttribute('lang', LANG);
    el.setAttribute('dir', LANG === 'he' ? 'rtl' : 'ltr');
  }
  function getLang() { return LANG; }

  // ══════════════════════════════════════════════════ escaping & bidi ══════
  // Every CRM value and every Rivhit client_message is attacker-controlled input.
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Document numbers, tax IDs and amounts must render left-to-right inside RTL
  // text or they scramble. The Green Invoice bridge shipped that bug for months.
  function ltrHtml(v) { return '<bdi class="ltr">' + esc(v) + '</bdi>'; }
  function ltrText(v) { return '⁦' + String(v == null ? '' : v) + '⁩'; }

  function setText(id, v) { var e = document.getElementById(id); if (e) e.textContent = String(v == null ? '' : v); }
  function setHtml(id, h) { var e = document.getElementById(id); if (e) e.innerHTML = h; }
  function show(id, on) { var e = document.getElementById(id); if (e) e.classList.toggle('hidden', !on); }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function checked(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  function on(id, evt, fn) { var e = document.getElementById(id); if (e) e.addEventListener(evt, fn); }

  // ═════════════════════════════════════════════════════════ formatting ════
  var CURRENCIES = {
    1: { iso: 'ILS', sym: '₪' },  2: { iso: 'USD', sym: '$' },  3: { iso: 'EUR', sym: '€' },
    4: { iso: 'GBP', sym: '£' },  5: { iso: 'AUD', sym: 'A$' }, 6: { iso: 'CAD', sym: 'C$' },
    7: { iso: 'CHF', sym: 'CHF' },8: { iso: 'SEK', sym: 'kr' }, 9: { iso: 'DKK', sym: 'kr' },
    10:{ iso: 'NOK', sym: 'kr' }
  };
  function currencySymbol(id) { var c = CURRENCIES[Number(id) || 1]; return c ? c.sym : ''; }
  function currencyIso(id)    { var c = CURRENCIES[Number(id) || 1]; return c ? c.iso : 'ILS'; }
  function isoToCurrencyId(iso) {
    var up = String(iso || '').toUpperCase();
    for (var k in CURRENCIES) if (CURRENCIES[k].iso === up) return Number(k);
    return 1;
  }
  function money(amount, currencyId) {
    var n = Number(amount);
    if (!isFinite(n)) n = 0;
    return currencySymbol(currencyId) + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Rivhit speaks DD/MM/YYYY. Zoho speaks YYYY-MM-DD. Neither speaks DDMMYYYY,
  // whatever the 2015 PDF said.
  function toRivhitDate(iso) {
    if (!iso) return '';
    var m = String(iso).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : '';
  }
  function fromRivhitDate(s) {
    if (!s) return '';
    var m = String(s).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) return '';
    return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  function displayDate(v) {
    if (!v) return '—';
    var iso = /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).substring(0, 10) : fromRivhitDate(v);
    return iso ? ltrText(toRivhitDate(iso)) : ltrText(v);
  }
  function displayDateTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return ltrText(v);
    function p(n) { return ('0' + n).slice(-2); }
    return ltrText(p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()));
  }
  // Zoho DateTime fields reject anything without a timezone offset.
  function zohoNow() {
    var d = new Date(), tzo = -d.getTimezoneOffset(), sign = tzo >= 0 ? '+' : '-';
    function p(n) { return ('0' + Math.abs(Math.floor(n))).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
           sign + p(tzo / 60) + ':' + p(tzo % 60);
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // ════════════════════════════════════════════ runtime field resolution ════
  // Manifest-created fields are namespaced, hand-created ones are plain, and a
  // single org can have a mix — per field. Zoho silently DISCARDS unknown keys
  // in an update, so a wrong guess looks like success and persists nothing.
  var LOGICAL_FIELDS = [
    'Rivhit_Document_Type', 'Rivhit_Document_Number', 'Rivhit_Document_Identity',
    'Rivhit_Document_URL', 'Rivhit_Confirmation_Number', 'Rivhit_Confirmation_Status',
    'Rivhit_Issue_Date', 'Rivhit_Due_Date', 'Rivhit_Request_Reference',
    'Rivhit_Payment_Status', 'Rivhit_Paid_Amount', 'Rivhit_Paid_Date',
    'Rivhit_Is_Closed', 'Rivhit_Last_Sync', 'Rivhit_Cancel_Document_Number',
    'Rivhit_Currency_ID', 'Rivhit_Exchange_Rate', 'Rivhit_Stock_Updated',
    'Rivhit_Closed_Document_Number', 'Rivhit_Instalments_Total',
    'Rivhit_Instalments_Elapsed', 'Rivhit_Instalment_Progress',
    'Rivhit_Next_Instalment_Date', 'Rivhit_Instalment_Amount',
    'Rivhit_Issued_Snapshot', 'Rivhit_Record_Drift', 'Rivhit_Drift_Detected_At',
    'Rivhit_Customer_ID', 'Rivhit_Acc_Ref', 'Rivhit_Tax_ID', 'Rivhit_VAT_Number',
    'Rivhit_Customer_Type', 'Rivhit_Price_List_ID', 'Rivhit_Agent_ID',
    'Rivhit_Balance', 'Rivhit_Balance_Updated', 'Rivhit_Sync_Error',
    'Rivhit_Item_ID', 'Rivhit_Catalog_Number', 'Rivhit_Item_Group_ID',
    'Rivhit_Storage_ID', 'Rivhit_Quantity_On_Hand', 'Rivhit_Quantity_Updated'
  ];
  var _fieldCache = {};

  // Exact plain name beats the namespaced one; a suffix match is the fallback.
  function _resolveOne(apiNames, logical) {
    if (apiNames.indexOf(logical) >= 0) return logical;
    var target = NS + logical;
    if (apiNames.indexOf(target) >= 0) return target;
    for (var i = 0; i < apiNames.length; i++) {
      var n = apiNames[i];
      if (n.length > logical.length && n.slice(-(logical.length + 2)) === '__' + logical) return n;
    }
    return logical;
  }

  async function _entityApiNames(entity) {
    var names = [];
    try {
      var meta = await ZOHO.CRM.META.getFields({ Entity: entity });
      var list = (meta && (meta.fields || meta)) || [];
      if (Array.isArray(list)) list.forEach(function (f) { if (f && f.api_name) names.push(f.api_name); });
    } catch (e) { dbg('[Rivhit] META.getFields failed for ' + entity, e); }
    if (!names.length) {
      try {
        var res = await ZOHO.CRM.API.getAllRecords({ Entity: entity, page: 1, per_page: 1 });
        var rec = res && res.data && res.data[0];
        if (rec) names = Object.keys(rec);
      } catch (e2) { dbg('[Rivhit] sample-record fallback failed for ' + entity, e2); }
    }
    return names;
  }

  async function resolveFields(entity) {
    if (_fieldCache[entity]) return _fieldCache[entity];
    var names = await _entityApiNames(entity);
    var map = {};
    LOGICAL_FIELDS.forEach(function (k) { map[k] = _resolveOne(names, k); });
    _fieldCache[entity] = map;
    dbg('[Rivhit] resolved fields for ' + entity, map);
    return map;
  }
  function fieldName(entity, logical) {
    var m = _fieldCache[entity];
    return (m && m[logical]) || logical;
  }
  function getField(entity, record, logical) {
    if (!record) return null;
    var n = fieldName(entity, logical);
    if (record[n] !== undefined) return record[n];
    if (record[logical] !== undefined) return record[logical];
    if (record[NS + logical] !== undefined) return record[NS + logical];
    return null;
  }

  // ═══════════════════════════════════════════════ the Deluge bridge ════════
  function _safeErr(e) {
    if (!e) return 'unknown';
    if (e.message) return e.message;
    if (typeof e === 'string') return e;
    try { return JSON.stringify(e); } catch (x) { return String(e); }
  }

  // Zoho wraps a function's return value in a few different shapes depending on
  // platform version. Unwrap all of them, then parse our own JSON envelope.
  function _unwrap(resp) {
    if (resp == null) throw new Error('empty response from function');
    if (typeof resp === 'string') return resp;
    var d = resp.details || resp;
    var out = d.output !== undefined ? d.output
            : d.outputs !== undefined ? d.outputs
            : (resp.output !== undefined ? resp.output : null);
    if (out == null) {
      if (resp.code && String(resp.code).toLowerCase() !== 'success') {
        throw new Error('function returned ' + resp.code + ': ' + JSON.stringify(resp).substring(0, 240));
      }
      return JSON.stringify(resp);
    }
    return typeof out === 'string' ? out : JSON.stringify(out);
  }

  /**
   * Call a Deluge function. Returns the parsed `data` on success.
   * Our functions always answer {ok, code, message, detail, data}.
   */
  async function callFn(name, payload) {
    var fq = NS + name;
    dbg('[Rivhit] → ' + fq, payload);
    var raw;
    try {
      raw = await ZOHO.CRM.FUNCTIONS.execute(fq, { arguments: JSON.stringify(payload || {}) });
    } catch (e) {
      throw new Error('לא ניתן להריץ את הפונקציה ' + name + ': ' + _safeErr(e));
    }
    var text = _unwrap(raw), env;
    try { env = JSON.parse(text); }
    catch (e) { throw new Error('תשובה לא תקינה מהפונקציה ' + name + ': ' + String(text).substring(0, 200)); }
    dbg('[Rivhit] ← ' + fq, env);
    if (!env || env.ok !== true) {
      var err = new Error((env && (env.message || env.code)) || t('genericError'));
      err.code   = env && env.code;
      err.detail = env && env.detail;
      err.data   = env && env.data;
      throw err;
    }
    return env.data;
  }

  // ═════════════════════════════════════════════════════════ settings ══════
  var _settings = null;
  var _user     = null;

  async function loadSettings(force) {
    if (_settings && !force) return _settings;
    _settings = await callFn('rv_lookup', { op: 'settings' });
    setLang(_settings.defaultLanguage === 'en' ? 'en' : 'he');
    return _settings;
  }
  function settings() { return _settings || {}; }
  function isConfigured() { return !!(_settings && _settings.configured); }

  async function currentUser() {
    if (_user) return _user;
    try {
      var r = await ZOHO.CRM.CONFIG.getCurrentUser();
      _user = (r && r.users && r.users[0]) || r || {};
    } catch (e) { _user = {}; }
    return _user;
  }

  /**
   * UX-level permission check. The real enforcement is inside every Deluge
   * function — a hidden button is a courtesy, not a control.
   */
  function can(action) {
    var s = settings();
    if (!s.permissions) return true;                       // not configured yet → server decides
    var allowed = s.permissions[action];
    if (!allowed || !allowed.length) return false;
    var prof = (_user && (_user.profile && (_user.profile.id || _user.profile.name))) || null;
    if (!prof) return true;                                // unknown profile → let the server refuse
    return allowed.indexOf(String(prof)) >= 0 ||
           allowed.indexOf(String(_user.profile && _user.profile.name)) >= 0;
  }
  function gate(action, buttonId) {
    var ok = can(action);
    var el = document.getElementById(buttonId);
    if (el) { el.disabled = !ok; el.title = ok ? '' : t('noPermission'); }
    return ok;
  }

  // ═════════════════════════════════════════ document-type helpers ═════════
  // Behaviour comes from the flags Rivhit returns, never from a hardcoded table.
  function docTypes()      { return (settings().documentTypes) || []; }
  function receiptTypes()  { return (settings().receiptTypes) || []; }
  function paymentTypes()  { return (settings().paymentTypes) || []; }
  function docType(code) {
    var c = Number(code), list = docTypes();
    for (var i = 0; i < list.length; i++) if (Number(list[i].document_type) === c) return list[i];
    return null;
  }
  function typeNeedsPayments(code) { var d = docType(code); return !!(d && d.is_invoice_receipt); }
  function typeIsAccounting(code)  { var d = docType(code); return !!(d && d.is_accounting); }
  function typeName(code) {
    var d = docType(code);
    return d ? d.document_name : ('#' + code);
  }
  function role(name) { return (settings().roles || {})[name] || null; }

  function fillSelect(id, items, valueKey, labelKey, selected) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = String(it[valueKey]);
      o.textContent = it[labelKey] + '  (' + it[valueKey] + ')';
      if (selected != null && String(selected) === String(it[valueKey])) o.selected = true;
      el.appendChild(o);
    });
  }

  // ═════════════════════════════════════════════════ status rendering ══════
  function statusLabel(code) {
    var map = {
      'Not Issued': 'st_not_issued', 'Issued': 'st_issued',
      'Partially Paid': 'st_partial', 'Paid': 'st_paid', 'Cancelled': 'st_cancelled'
    };
    return map[code] ? t(map[code]) : (code || '—');
  }
  function statusChip(code) {
    var cls = { 'Paid': 'chip-ok', 'Partially Paid': 'chip-warn', 'Issued': 'chip-accent',
                'Cancelled': 'chip-err', 'Not Issued': 'chip-neutral' }[code] || 'chip-neutral';
    return '<span class="chip ' + cls + '">' + esc(statusLabel(code)) + '</span>';
  }
  function confirmationChip(code) {
    var map = { 'Not Required': ['cf_not_required', 'chip-neutral'], 'Obtained': ['cf_obtained', 'chip-ok'],
                'Missing': ['cf_missing', 'chip-warn'], 'Retry Failed': ['cf_failed', 'chip-err'] };
    var m = map[code];
    if (!m) return '<span class="chip chip-neutral">—</span>';
    return '<span class="chip ' + m[1] + '">' + esc(t(m[0])) + '</span>';
  }

  // ═════════════════════════════════════════════════════════ alerts ════════
  function alertHtml(kind, title, detail) {
    return '<div class="alert alert-' + kind + '">' +
           '<strong>' + esc(title) + '</strong>' +
           (detail ? '<div class="detail">' + esc(detail) + '</div>' : '') +
           '</div>';
  }
  function showError(containerId, e) {
    var msg = (e && e.message) || t('genericError');
    var det = (e && e.detail) ? String(e.detail) : '';
    setHtml(containerId, alertHtml('error', msg, det));
    if (e) console.error('[Rivhit]', e);
  }

  // ═══════════════════════════════════════════════════ CRM read/write ══════
  async function getRecord(module, id) {
    var r = await ZOHO.CRM.API.getRecord({ Entity: module, RecordID: id });
    return (r && r.data && r.data[0]) || null;
  }

  // One rejected field kills the entire updateRecord call, so drop the field
  // Zoho names and retry the rest — loudly.
  async function crmUpdateResilient(module, data) {
    var payload = JSON.parse(JSON.stringify(data)), dropped = [];
    for (var attempt = 0; attempt < 8; attempt++) {
      var resp;
      try {
        resp = await ZOHO.CRM.API.updateRecord({ Entity: module, APIData: payload });
      } catch (e) {
        resp = (e && e.data) ? e : { data: [{ code: 'EXCEPTION', message: _safeErr(e) }] };
      }
      var row = resp && resp.data && resp.data[0];
      if (row && String(row.code).toUpperCase() === 'SUCCESS') return { ok: true, dropped: dropped };
      var bad = row && row.details && row.details.api_name;
      if (bad && bad !== 'id' && Object.prototype.hasOwnProperty.call(payload, bad)) {
        dropped.push(bad + (row.message ? ' (' + row.message + ')' : ''));
        console.warn('[Rivhit] dropping rejected field ' + bad);
        delete payload[bad];
        if (Object.keys(payload).filter(function (k) { return k !== 'id'; }).length === 0) {
          return { ok: false, dropped: dropped, resp: resp };
        }
        continue;
      }
      return { ok: false, dropped: dropped, resp: resp };
    }
    return { ok: false, dropped: dropped };
  }

  // ═══════════════════════════════════════════════════ widget bootstrap ════
  /**
   * Standard widget start-up: SDK init, entity capture, settings, user, fields.
   * `opts.entities` is a list of modules whose field maps to pre-resolve.
   */
  function boot(opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var ctx = { module: null, recordId: null, ids: [] };
      ZOHO.embeddedApp.on('PageLoad', function (data) {
        ctx.module   = (data && (data.Entity || data.module)) || opts.defaultModule || 'Invoices';
        ctx.recordId = (data && (data.EntityId || data.entityId)) || null;
        if (Array.isArray(ctx.recordId)) { ctx.ids = ctx.recordId; ctx.recordId = ctx.recordId[0]; }
        else if (ctx.recordId) { ctx.ids = [ctx.recordId]; }
        (async function () {
          try {
            await loadSettings();
            await currentUser();
            var ents = opts.entities || (ctx.module ? [ctx.module] : []);
            for (var i = 0; i < ents.length; i++) await resolveFields(ents[i]);
            var marker = document.createElement('div');
            marker.className = 'build-marker';
            marker.textContent = 'BUILD ' + VERSION;
            document.body.appendChild(marker);
            resolve(ctx);
          } catch (e) { reject(e); }
        })();
      });
      ZOHO.embeddedApp.init();
    });
  }

  function closeReload() { try { ZOHO.CRM.UI.Popup.closeReload(); } catch (e) { ZOHO.CRM.UI.Popup.close(); } }
  function closePopup() { try { ZOHO.CRM.UI.Popup.close(); } catch (e) { /* standalone */ } }

  // ═════════════════════════════════════════════════════════ exports ═══════
  return {
    VERSION: VERSION, NS: NS,
    setDebug: setDebug, dbg: dbg,
    t: t, setLang: setLang, getLang: getLang,
    esc: esc, ltrHtml: ltrHtml, ltrText: ltrText,
    setText: setText, setHtml: setHtml, show: show, val: val, checked: checked, on: on,
    money: money, round2: round2, currencySymbol: currencySymbol, currencyIso: currencyIso,
    isoToCurrencyId: isoToCurrencyId, CURRENCIES: CURRENCIES,
    toRivhitDate: toRivhitDate, fromRivhitDate: fromRivhitDate,
    displayDate: displayDate, displayDateTime: displayDateTime, zohoNow: zohoNow,
    resolveFields: resolveFields, fieldName: fieldName, getField: getField,
    _resolveOne: _resolveOne, _unwrap: _unwrap,
    callFn: callFn, loadSettings: loadSettings, settings: settings,
    isConfigured: isConfigured, currentUser: currentUser, can: can, gate: gate,
    docTypes: docTypes, receiptTypes: receiptTypes, paymentTypes: paymentTypes,
    docType: docType, typeNeedsPayments: typeNeedsPayments, typeIsAccounting: typeIsAccounting,
    typeName: typeName, role: role, fillSelect: fillSelect,
    statusLabel: statusLabel, statusChip: statusChip, confirmationChip: confirmationChip,
    alertHtml: alertHtml, showError: showError,
    getRecord: getRecord, crmUpdateResilient: crmUpdateResilient,
    boot: boot, closeReload: closeReload, closePopup: closePopup
  };
})();

/* Node test harness support — ignored in the browser. */
if (typeof module !== 'undefined' && module.exports) { module.exports = RivhitAPI; }
