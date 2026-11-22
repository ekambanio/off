/** Drive.gs — Google Drive operations executed on the server, behind Security.gs.
 *
 * The browser (GitHub Pages) never talks to Google Drive any more. It POSTs to this Web App (the SAME /exec URL
 * used for subscriptions) and this file:
 *   1. authorizes the request (Security.gs: registered device + active PAID subscription + signed session),
 *   2. validates that the requested Drive call is one of the few calls the backup system uses,
 *   3. performs it with the user's own Google access token (so backups stay in the customer's own Google Drive,
 *      in the same folders and with the same file names, formats and structure as before),
 *   4. returns Google's status and body unchanged, so the existing backup/restore code behaves exactly as before.
 *
 * doPost() lives here so that Code.gs (the working subscription system) does not need to be edited for routing.
 *
 * Operations (field "op"):
 *   eligibility  - may this device use Drive?                (no session needed, returns no configuration)
 *   session      - start a Drive session (eligible only)     (returns signed session + OAuth client ID)
 *   drive        - one validated Drive REST call             (needs session)  -> connect, save, list, retrieve, restore, folder checks
 *   backupStatus - metadata of the backup file               (needs session)
 */
function doPost(e) {
  let out = null, req = null;
  try {
    let raw = (e && e.postData && e.postData.contents) || '';
    if (!raw && e && e.parameter && e.parameter.payload) raw = String(e.parameter.payload);     // form-style fallback
    if (raw.length > getPrivateDriveConfig_().maxRequestBytes) out = secReject_('TOO_LARGE', 'Request too large.');
    else req = JSON.parse(raw);
  } catch (err) {
    out = { ok: false, allowed: true, code: 'BAD_REQUEST', status: 400, message: 'The request body was not valid JSON, so the server could not read it.' };
  }
  if (!out) {
    try { out = routeDriveRequest_(req); }
    catch (err) {
      // A real server-side failure: report what happened (tokens removed) instead of a misleading "could not be read".
      try { console.error('Drive request failed: ' + String(err && err.message)); } catch (x) {}
      out = { ok: false, allowed: true, code: 'SERVER_ERROR', status: 500, message: 'Drive server error: ' + driveSafeMessage_(err) };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function driveSafeMessage_(err) {
  return String((err && err.message) || err || 'unknown').replace(/ya29\.[A-Za-z0-9._-]+/g, '[token]').replace(/Bearer\s+\S+/g, 'Bearer [token]').replace(/AIza[0-9A-Za-z_-]+/g, '[key]').slice(0, 220);
}

function routeDriveRequest_(req) {
  if (!req || typeof req !== 'object') return secReject_('BAD_REQUEST', 'Invalid request.');
  const op = String(req.op || '');
  if (op === 'eligibility') {
    const a = authorizeDriveRequest_(req, false);
    return a.allowed ? { ok: true, allowed: true, plan: a.plan, endDate: a.endDate, remainingDays: a.remainingDays } : a;
  }
  if (op === 'session') {
    const a = authorizeDriveRequest_(req, false);
    if (!a.allowed) return a;
    const s = secIssueSession_(String(req.deviceId).trim());
    return { ok: true, allowed: true, session: s.token, expiresAt: s.expiresAt, config: getPublicDriveConfig_(), plan: a.plan, remainingDays: a.remainingDays };
  }
  if (op === 'drive') {
    const a = authorizeDriveRequest_(req, true);
    if (!a.allowed) return a;
    return driveCall_(req);
  }
  if (op === 'backupStatus') {
    const a = authorizeDriveRequest_(req, true);
    if (!a.allowed) return a;
    return backupStatus_(req);
  }
  return secReject_('UNKNOWN_OP', 'Unknown operation.');
}

/* ---------- validation: only the Drive calls the backup system really makes ---------- */
const DRIVE_ALLOWED_QUERY = { fields: 1, q: 1, orderBy: 1, pageSize: 1, pageToken: 1, alt: 1, uploadType: 1 };

function parseDriveUrl_(url, cfg) {
  url = String(url || '');
  let base, rest, upload = false;
  if (url.indexOf(cfg.uploadApi + '/') === 0) { base = cfg.uploadApi; upload = true; }
  else if (url.indexOf(cfg.driveApi + '/') === 0) { base = cfg.driveApi; }
  else return null;
  rest = url.substring(base.length);
  const qi = rest.indexOf('?');
  const path = qi < 0 ? rest : rest.substring(0, qi);
  const qs = qi < 0 ? '' : rest.substring(qi + 1);
  const params = {};
  if (qs) {
    const pairs = qs.split('&');
    for (let i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      const eq = pairs[i].indexOf('=');
      const k = decodeURIComponent(eq < 0 ? pairs[i] : pairs[i].substring(0, eq));
      const v = eq < 0 ? '' : decodeURIComponent(pairs[i].substring(eq + 1).replace(/\+/g, '%20'));
      if (!DRIVE_ALLOWED_QUERY[k] || k in params) return null;     // unknown or repeated parameter
      params[k] = v;
    }
  }
  const keys = Object.keys(params), enc = [];
  for (let i = 0; i < keys.length; i++) enc.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(params[keys[i]]));
  return { upload: upload, path: path, params: params, query: enc.join('&') };   // re-encoded cleanly (e.g. "modifiedTime desc")
}

/** Returns an error string, or '' when the call is one the backup system uses. */
function validateDriveCall_(method, u) {
  const p = u.path, fileRe = /^\/files\/[A-Za-z0-9_-]{5,200}$/;
  if (u.params.alt && u.params.alt !== 'media') return 'alt';
  if (u.params.uploadType && u.params.uploadType !== 'multipart') return 'uploadType';
  if (u.upload) {
    if (u.params.uploadType !== 'multipart') return 'uploadType';
    if (method === 'POST' && p === '/files') return '';
    if (method === 'PATCH' && fileRe.test(p)) return '';
    return 'path';
  }
  if (u.params.uploadType) return 'uploadType';
  if (method === 'GET' && p === '/about') return '';
  if (method === 'GET' && (p === '/files' || fileRe.test(p))) return '';
  if (method === 'POST' && p === '/files') return '';
  if ((method === 'PATCH' || method === 'DELETE') && fileRe.test(p)) return '';
  return 'path';
}

function driveCall_(req) {
  const cfg = getPrivateDriveConfig_();
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'POST', 'PATCH', 'DELETE'].indexOf(method) < 0) return secReject_('BAD_CALL', 'This Drive operation is not allowed.');
  const token = String(req.accessToken || '');
  if (!/^[A-Za-z0-9._~+\/=-]{20,4096}$/.test(token)) return { ok: false, allowed: true, code: 'NEEDS_AUTH', status: 401, message: 'Google access token missing.' };
  let u;
  try { u = parseDriveUrl_(req.url, cfg); } catch (e) { u = null; }
  if (!u || validateDriveCall_(method, u)) return secReject_('BAD_CALL', 'This Drive operation is not allowed.');
  const ct = String(req.contentType || '');
  if (ct && !/^(application\/json(; charset=UTF-8)?|multipart\/related; boundary=[A-Za-z0-9_.-]{1,70})$/.test(ct)) return secReject_('BAD_CALL', 'This Drive operation is not allowed.');
  let url = (u.upload ? cfg.uploadApi : cfg.driveApi) + u.path + (u.query ? '?' + u.query : '');
  if (cfg.apiKey) url += (u.query ? '&' : '?') + 'key=' + encodeURIComponent(cfg.apiKey);     // optional restricted key, added only on the server
  const opts = { method: method.toLowerCase(), headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true, followRedirects: true };
  if (req.body !== undefined && req.body !== null && method !== 'GET' && method !== 'DELETE') { opts.payload = String(req.body); opts.contentType = ct || 'application/json'; }
  if (method === 'POST' && !u.upload && u.path === '/files' && opts.payload) {
    let b = null; try { b = JSON.parse(opts.payload); } catch (e) { b = null; }
    if (b && b.mimeType === 'application/vnd.google-apps.folder') {
      const marker = driveFolderMarker_(b);
      if (marker) return createFolderOnce_(url, opts, marker, token, cfg);
    }
  }
  return driveFetchSafe_(url, opts, method === 'GET');
}

/* One UrlFetch with a clear error report. Only GET is retried (a retried POST/PATCH could duplicate work). */
function driveFetchSafe_(url, opts, canRetry) {
  let lastErr = null;
  for (let i = 0; i < (canRetry ? 2 : 1); i++) {
    try {
      const r = UrlFetchApp.fetch(url, opts);
      return { ok: true, allowed: true, status: r.getResponseCode(), body: r.getContentText() };
    } catch (err) { lastErr = err; if (i === 0 && canRetry) Utilities.sleep(400); }
  }
  return { ok: false, allowed: true, code: 'SERVER_ERROR', status: 502, message: 'Google Drive could not be reached from the server: ' + driveSafeMessage_(lastErr) };
}

/* The backup folder of each module carries its own marker (POS: ekambaniBackup, Finance: ekambaniFinanceBackup, Phone Repair:
   ekambaniPhoneBackup). Only these markers are accepted, so a module can never claim another module's folder. */
function driveFolderMarker_(body) {
  const ap = body && body.appProperties; if (!ap || typeof ap !== 'object') return '';
  const keys = Object.keys(ap);
  for (let i = 0; i < keys.length; i++) if (/^ekambani[A-Za-z]{0,20}Backup$/.test(keys[i]) && String(ap[keys[i]]) === '1') return keys[i];
  return '';
}

/* Create-only-once: under a lock, look for this account's existing folder with the module's marker and return it instead of
   creating another one. Simultaneous requests (double tap, two devices) therefore cannot create duplicate folders. */
function createFolderOnce_(url, opts, marker, token, cfg) {
  let lock = null; try { lock = LockService.getDocumentLock(); } catch (e) { lock = null; }   // separate from the registration/renewal lock
  if (!lock) lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, allowed: true, code: 'BUSY', status: 503, message: 'The server is busy. Please try again in a moment.' };
  try {
    const q = "mimeType='application/vnd.google-apps.folder' and appProperties has { key='" + marker + "' and value='1' } and 'me' in owners and trashed=false";
    const sUrl = cfg.driveApi + '/files?fields=' + encodeURIComponent('files(id,name,trashed,ownedByMe)') + '&orderBy=createdTime&pageSize=5&q=' + encodeURIComponent(q);
    const f = driveFetchSafe_(sUrl, { method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }, true);
    if (f.ok && f.status === 200) {
      let list = []; try { list = JSON.parse(f.body).files || []; } catch (e) { list = []; }
      for (let i = 0; i < list.length; i++) if (!list[i].trashed && list[i].ownedByMe !== false) return { ok: true, allowed: true, status: 200, body: JSON.stringify({ id: list[i].id, name: list[i].name, existing: true }) };
    } else if (f.ok === false || (f.status && f.status !== 200)) {
      return f;                       // do not create blindly when the existence check itself failed
    }
    return driveFetchSafe_(url, opts, false);
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function backupStatus_(req) {
  const cfg = getPrivateDriveConfig_();
  const token = String(req.accessToken || ''), fileId = String(req.fileId || '');
  if (!/^[A-Za-z0-9._~+\/=-]{20,4096}$/.test(token) || !/^[A-Za-z0-9_-]{5,200}$/.test(fileId)) return secReject_('BAD_CALL', 'Backup status needs a Google token and file ID.');
  const r = UrlFetchApp.fetch(cfg.driveApi + '/files/' + encodeURIComponent(fileId) + '?fields=id,name,modifiedTime,size,trashed', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  let meta = null; try { meta = JSON.parse(r.getContentText()); } catch (e) {}
  return { ok: true, allowed: true, status: r.getResponseCode(), file: r.getResponseCode() === 200 ? meta : null };
}

/** Run from the editor to confirm the security layer rejects unknown / trial devices (changes nothing in the sheet). */
function testDriveSecurity() {
  const out = {};
  out.unknownDevice = routeDriveRequest_({ op: 'session', deviceId: 'TEST-UNKNOWN-DEVICE-0000' }).code;
  out.badDevice = routeDriveRequest_({ op: 'session', deviceId: '=1+1' }).code;
  out.noSession = routeDriveRequest_({ op: 'drive', deviceId: 'TEST-UNKNOWN-DEVICE-0000', method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?fields=user' }).code;
  out.badOp = routeDriveRequest_({ op: 'wipe' }).code;
  Logger.log(JSON.stringify(out));
  return out;
}
