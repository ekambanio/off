/** EKAMBANI POS subscription backend.
 * Subscriptions sheet: A Device ID, B Start Days, C End Days   (unchanged)
 * Renewals sheet     : existing code column + existing days column + existing "Status" column (unchanged)
 * The renewal page is the Apps Script HTML file named "renewal" (renewal.html; it was previously named Index).
 * Deploy as Web App: Execute as Me; Who has access: Anyone.
 *
 * What changed in this version (nothing else was touched):
 *  - Renewal now ADDS the code's days to the remaining active days
 *    (3 days left + 30-day code = 33 days). Expired subscriptions start from the redemption date.
 *  - Code / Days / Status columns are located by their existing header names (falls back to A / B).
 *  - Code lookup is exact first, then trimmed + case-insensitive.
 *  - Redemption runs inside one script lock; if writing the subscription fails the "Used" mark is rolled back.
 *  - status / register / redeem replies also return remainingDays and serverDate (used by the POS for offline checks).
 *
 * Added in this version (nothing else was touched):
 *  - 14-day FREE TRIAL for NEW devices only. Existing rows keep exactly their dates and behaviour.
 *    The trial dates come from the server clock (the script's timezone), never from the browser.
 *  - Three optional columns are added to the right of the existing ones if missing: D "Status", E "Trial Fingerprint",
 *    F "Registered At". Columns A-C are never renamed or moved.
 *  - Trial abuse limit: at most MAX_TRIALS_PER_FINGERPRINT trials per browser/device fingerprint. A browser-only app cannot
 *    prove device identity, so this is a deterrent, not a guarantee (see the report).
 *  - Registering a device that already exists takes no lock; only the creation of a new row is locked.
 *  - Per-device throttling of renewal attempts (CacheService) to blunt code guessing.
 *  - status / register / redeem replies also return "plan": "trial" | "subscription" | "legacy".
 *
 * Added in this version (nothing else was touched):
 *  - NEW devices must also send a Phone Number and Full Name; they are saved in column G (Phone Number) and H (Full Name)
 *    of the SAME row as the Device ID. Existing rows are never modified.
 *  - Renewal clears the short Drive-eligibility cache (secForgetDevice_, defined in Security.gs).
 *  - Google Drive operations live in DriveConfig.gs / Security.gs / Drive.gs (doPost is defined in Drive.gs).
 */
const TRIAL_DAYS = 14;
const MAX_TRIALS_PER_FINGERPRINT = 3;      // trials per fingerprint inside TRIAL_FP_WINDOW_DAYS (raise it if identical phones share one shop)
const TRIAL_FP_WINDOW_DAYS = 60;
const REDEEM_MAX_ATTEMPTS = 8, REDEEM_WINDOW_SEC = 600;
const SUBS_TAB = 'Subscriptions', RENEW_TAB = 'Renewals';

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action) return api_(p);
  return HtmlService.createHtmlOutputFromFile('renewal')
    .setTitle('EKAMBANI Subscription Renewal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function api_(p) {
  const cb = String(p.callback || '');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cb)) {
    return ContentService.createTextOutput('/* invalid callback */').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  let out;
  try {
    const id = String(p.deviceId || '').trim(), a = String(p.action || '').toLowerCase();
    if (a === 'register') out = registerDevice_(id, String(p.fp || ''), String(p.phone || ''), String(p.name || ''));
    else if (a === 'status') out = status_(id);
    else if (a === 'redeem') out = renewSubscription(id, String(p.renewalCode || '').trim());
    else out = { ok: false, message: 'Unknown action' };
  } catch (err) {
    out = { ok: false, message: err && err.message ? err.message : 'Server error' };
  }
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(out).replace(/</g, '\\u003c') + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw Error('Bind this Apps Script project to the subscription spreadsheet.');
  const s = ss.getSheetByName(SUBS_TAB), r = ss.getSheetByName(RENEW_TAB);
  if (!s || !r) throw Error('Required tabs Subscriptions and Renewals were not found.');
  const h = s.getRange(1, 1, 1, 3).getDisplayValues()[0].map(x => String(x).trim().toLowerCase());
  if (h[0] !== 'device id' || h[1] !== 'start days' || h[2] !== 'end days') {
    throw Error('Set Subscriptions headers exactly: Device ID | Start Days | End Days.');
  }
  ensureExtraHeaders_(s);
  return { s: s, r: r };
}
/* Adds the optional columns D-H once (G = Phone Number, H = Full Name). Existing columns and rows are never touched. */
function ensureExtraHeaders_(s) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('hdr_ok_v2')) return;
    const r = s.getRange(1, 4, 1, 5), cur = r.getDisplayValues()[0];
    const want = ['Status', 'Trial Fingerprint', 'Registered At', 'Phone Number', 'Full Name'];
    const out = cur.map(function(v, i) { return String(v).trim() ? v : want[i]; });
    if (out.some(function(v, i) { return v !== cur[i]; })) r.setValues([out]);
    cache.put('hdr_ok_v2', '1', 21600);
  } catch (e) { /* the extra columns are optional: never block a request because of them */ }
}

function lock_() {
  const l = LockService.getScriptLock();
  if (!l.tryLock(15000)) throw Error('Subscription server is busy. Please retry shortly.');
  return l;
}

/* exact match in a column (case-sensitive first, then trimmed case-insensitive). Returns sheet row or -1. */
function findRow_(sh, col, val, loose) {
  const n = sh.getLastRow();
  if (n < 2) return -1;
  val = String(val);
  const c = sh.getRange(2, col, n - 1, 1).createTextFinder(val).matchEntireCell(true).matchCase(true).findNext();
  if (c) return c.getRow();
  if (!loose) return -1;
  const want = val.trim().toLowerCase();
  const vals = sh.getRange(2, col, n - 1, 1).getDisplayValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toLowerCase() === want) return i + 2;
  }
  return -1;
}

function tz_() { return Session.getScriptTimeZone(); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function dateString_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}
function asDate_(s) { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2], 12, 0, 0); }
function plusDays_(s, n) {
  const a = s.split('-').map(Number), d = new Date(a[0], a[1] - 1, a[2], 12, 0, 0);
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}
function daysBetween_(fromS, toS) {            // whole days from -> to (can be negative)
  const f = asDate_(fromS), t = asDate_(toS);
  return Math.round((t.getTime() - f.getTime()) / 86400000);
}

/* Phone / name for NEW registrations. Returns { phone, name } or { error }. Text that could be read as a spreadsheet formula is neutralised. */
function customerDetails_(phone, name) {
  phone = String(phone || '').trim().replace(/[\s().-]+/g, '');
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^\+?[0-9]{7,15}$/.test(phone)) return { error: 'Enter a valid Phone Number (7 to 15 digits).' };
  if (name.length < 2 || name.length > 80 || !/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/.test(name)) return { error: 'Enter your Full Name.' };
  if (/^[=+\-@]/.test(name)) name = name.replace(/^[=+\-@]+/, '');
  return { phone: phone, name: name };
}

function registerDevice_(id, fp, phone, name) {
  id = String(id || '').trim();
  if (!id || id.length > 100) return { ok: false, message: 'Invalid Device ID' };
  const x0 = sheets_();
  let row = findRow_(x0.s, 1, id);                       // existing devices: no lock, no changes
  if (row > 0) return statusRow_(x0.s, row, id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,99}$/.test(id)) return { ok: false, message: 'Invalid Device ID' };   // also keeps spreadsheet-formula text out
  fp = String(fp || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  const cd = customerDetails_(phone, name);                // new devices only: both values are required
  if (cd.error) return { ok: false, needsDetails: true, message: cd.error };
  const l = lock_();
  try {
    const x = sheets_();
    row = findRow_(x.s, 1, id);                          // another request may have created it while we waited
    if (row < 0) {
      const t = today_();
      let grant = true;
      if (fp) grant = trialsForFingerprint_(x.s, fp, t) < MAX_TRIALS_PER_FINGERPRINT;
      const end = grant ? plusDays_(t, TRIAL_DAYS) : t;  // denied: stays "awaiting activation" (needs a renewal code)
      row = Math.max(2, x.s.getLastRow() + 1);
      x.s.getRange(row, 7, 1, 2).setNumberFormat('@');       // G, H stay plain text (a phone number starting with + is not a formula)
      x.s.getRange(row, 1, 1, 8).setValues([[id, asDate_(t), asDate_(end), grant ? 'Trial' : 'No Trial', fp, Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'), cd.phone, cd.name]]);
      x.s.getRange(row, 2, 1, 2).setNumberFormat('yyyy-mm-dd');
      SpreadsheetApp.flush();
    }
    return statusRow_(x.s, row, id);
  } finally { l.releaseLock(); }
}
/* How many trials this fingerprint already received inside the window. */
function trialsForFingerprint_(sh, fp, today) {
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const found = sh.getRange(2, 5, n - 1, 1).createTextFinder(fp).matchEntireCell(true).matchCase(true).findAll();
  if (!found.length) return 0;
  const since = plusDays_(today, -TRIAL_FP_WINDOW_DAYS);
  let c = 0;
  found.forEach(function(cell) {
    const v = sh.getRange(cell.getRow(), 4, 1, 3).getValues()[0];
    if (String(v[0]) !== 'Trial') return;
    const reg = String(v[2] || '').slice(0, 10);
    if (!reg || reg >= since) c++;
  });
  return c;
}

function status_(id) {
  id = String(id || '').trim();
  if (!id) return { ok: false, message: 'Device ID missing' };
  const x = sheets_(), row = findRow_(x.s, 1, id);
  if (row < 0) return { ok: false, subscriptionStatus: 'unregistered', message: 'Device not registered' };
  return statusRow_(x.s, row, id);
}

function statusRow_(sh, row, id) {
  const v = sh.getRange(row, 1, 1, 4).getValues()[0], start = dateString_(v[1]), end = dateString_(v[2]), today = today_();
  const tag = String(v[3] || '').trim(), plan = tag === 'Trial' ? 'trial' : (tag === 'Subscribed' ? 'subscription' : 'legacy');
  const initial = !!start && start === end;                 // freshly registered, awaiting first activation
  const active = !!start && !!end && !initial && end >= today;
  const remaining = active ? Math.max(0, daysBetween_(today, end)) : 0;
  return {
    ok: true, deviceId: id, startDate: start, endDate: end, serverDate: today, remainingDays: remaining, plan: plan,
    subscriptionStatus: active ? 'active' : 'expired',
    message: active ? 'Subscription active' : 'Subscription expired or awaiting activation'
  };
}

/* Locate the existing Code / Days / Status columns of the Renewals sheet by header, falling back to A / B. */
function renewCols_(sh) {
  const last = Math.max(2, sh.getLastColumn());
  const heads = sh.getRange(1, 1, 1, last).getDisplayValues()[0].map(h => String(h).trim().toLowerCase());
  let code = heads.findIndex(h => h === 'code' || h === 'renewal code' || h === 'renewal' || /\bcode\b/.test(h));
  let days = heads.findIndex(h => h === 'days' || /\bdays?\b/.test(h));
  let status = heads.findIndex(h => h === 'status');
  if (code < 0) code = 0;
  if (days < 0 || days === code) days = 1;
  if (status < 0) { status = last; sh.getRange(1, status + 1).setValue('Status'); }
  return { code: code, days: days, status: status };
}

function renewSubscription(id, code) {
  id = String(id || '').trim();
  code = String(code || '').trim();
  if (!id) return { ok: false, status: false, message: 'Device ID missing' };
  if (!code) return { ok: false, status: false, message: 'Enter Renewal Code' };
  if (tooManyAttempts_(id)) return { ok: false, status: false, message: 'Too many attempts. Please try again in a few minutes.' };
  const l = lock_();
  try {
    const x = sheets_();
    const sr = findRow_(x.s, 1, id);
    if (sr < 0) return { ok: false, status: false, message: 'Device ID not found in Subscriptions' };

    const c = renewCols_(x.r);
    const rr = findRow_(x.r, c.code + 1, code, true);
    if (rr < 0) return { ok: false, status: false, message: 'Invalid Renewal Code!' };

    const width = Math.max(c.code, c.days, c.status) + 1;
    const row = x.r.getRange(rr, 1, 1, width).getValues()[0];
    if (String(row[c.status] || '').trim().toLowerCase() === 'used') {
      return { ok: false, status: false, message: 'This Renewal Code has already been used!' };
    }
    const days = parseInt(row[c.days], 10);
    if (!Number.isFinite(days) || days <= 0) return { ok: false, status: false, message: 'Renewal code has an invalid number of days' };

    // Current subscription -> decide where the new period starts.
    const cur = x.s.getRange(sr, 2, 1, 2).getValues()[0];
    const curStart = dateString_(cur[0]), curEnd = dateString_(cur[1]), today = today_();
    const wasInitial = !!curStart && curStart === curEnd;
    const stillActive = !!curStart && !!curEnd && !wasInitial && curEnd >= today;
    const start = stillActive ? curStart : today;                       // keep original start while active
    const end = stillActive ? plusDays_(curEnd, days) : plusDays_(today, days);   // remaining days are preserved

    // 1) mark the code Used first (inside the lock), 2) write the subscription, 3) roll back the mark on failure.
    const statusCell = x.r.getRange(rr, c.status + 1);
    const prevStatus = statusCell.getValue();
    statusCell.setValue('Used').setFontColor('white').setBackground('red');
    SpreadsheetApp.flush();
    try {
      x.s.getRange(sr, 2, 1, 2).setValues([[asDate_(start), asDate_(end)]]).setNumberFormat('yyyy-mm-dd');
      SpreadsheetApp.flush();
    } catch (err) {
      statusCell.setValue(prevStatus).setFontColor(null).setBackground(null);
      SpreadsheetApp.flush();
      throw Error('Could not save the subscription. The code was not consumed. Please retry.');
    }
    try { x.s.getRange(sr, 4).setValue('Subscribed'); } catch (e) { /* the status label is informational only */ }
    try { secForgetDevice_(id); } catch (e) { /* Drive eligibility cache only */ }
    const remaining = Math.max(0, daysBetween_(today, end));
    return {
      ok: true, status: true, deviceId: id, startDate: start, endDate: end, serverDate: today,
      remainingDays: remaining, addedDays: days, subscriptionStatus: 'active', plan: 'subscription',
      message: 'Subscription renewed successfully!\nAdded: ' + days + ' days\nStart: ' + start + '\nEnd: ' + end + '\nRemaining: ' + remaining + ' days'
    };
  } finally { l.releaseLock(); }
}

/* Per-device attempt counter (not global, so unrelated devices never wait for each other). */
function tooManyAttempts_(id) {
  try {
    const c = CacheService.getScriptCache(), k = 'rd_' + id, n = Number(c.get(k) || 0) + 1;
    c.put(k, String(n), REDEEM_WINDOW_SEC);
    return n > REDEEM_MAX_ATTEMPTS;
  } catch (e) { return false; }
}

function registerDeviceForHtml(id, phone, name) { return registerDevice_(id, '', phone, name); }

function testSubscriptionSetup() {
  const x = sheets_();
  return { subscriptions: x.s.getName(), renewals: x.r.getName(), headers: x.s.getRange(1, 1, 1, 3).getDisplayValues()[0], renewalColumns: renewCols_(x.r) };
}
