/** Security.gs — the ONLY place that decides whether a device may touch Google Drive.
 *
 * Rules (enforced on the server for EVERY Drive operation, whatever the browser says):
 *   1. The Device ID must be well formed and exist in the Subscriptions sheet (registered).
 *   2. The subscription must be ACTIVE today (server clock) and not merely "registered / awaiting activation".
 *   3. The plan must be PAID: column D = "Subscribed", or an old record with an empty column D (customers who
 *      subscribed before the free trial existed). "Trial" and "No Trial" are always rejected.
 *   4. A Drive session (HMAC signed, short lived, bound to the Device ID) must accompany every operation after the first one.
 * Every request is re-checked against the sheet (cached for a few seconds only), so expiry, a refund or a manual
 * change in the sheet takes effect almost immediately.
 */
const SEC_ELIGIBILITY_CACHE_SEC = 15;
const SEC_DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,99}$/;

function secReject_(code, message) {
  return { ok: false, allowed: false, code: code, message: message };
}

/** Returns { allowed:true, record } or { allowed:false, code, message }. Never throws. */
function checkDriveEligibility_(deviceId) {
  try {
    const id = String(deviceId || '').trim();
    if (!id || !SEC_DEVICE_ID_RE.test(id)) return secReject_('DEVICE_INVALID', 'Device ID is missing or invalid.');
    const cache = CacheService.getScriptCache();
    const ck = 'el_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, id)).slice(0, 40);
    const hit = cache.get(ck);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* recompute */ } }
    const x = sheets_();
    const row = findRow_(x.s, 1, id);
    if (row < 0) return secReject_('DEVICE_UNKNOWN', 'This device is not registered.');
    const rec = statusRow_(x.s, row, id);                   // existing function from Code.gs: dates, plan, active flag
    let res;
    if (rec.subscriptionStatus !== 'active') res = secReject_('SUBSCRIPTION_EXPIRED', 'Your subscription has expired. Renew to use Google Drive backup.');
    else if (rec.plan === 'trial') res = secReject_('TRIAL', 'Subscribe now to unlock Google Drive connection and backup. Renew your subscription to protect your data.');
    else if (rec.plan !== 'subscription' && rec.plan !== 'legacy') res = secReject_('NOT_PAID', 'A paid subscription is required for Google Drive backup.');
    else res = { ok: true, allowed: true, plan: rec.plan, endDate: rec.endDate, remainingDays: rec.remainingDays };
    try { cache.put(ck, JSON.stringify(res), SEC_ELIGIBILITY_CACHE_SEC); } catch (e) {}
    return res;
  } catch (err) {
    return secReject_('UNVERIFIED', 'The subscription could not be verified right now. Please try again.');   // fail closed
  }
}

/** Drops the short eligibility cache for one device (called after a successful renewal). */
function secForgetDevice_(deviceId) {
  try {
    const id = String(deviceId || '').trim();
    CacheService.getScriptCache().remove('el_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, id)).slice(0, 40));
  } catch (e) {}
}

function secSign_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, getSigningSecret_());
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}
function secSafeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Issues a signed session for an ELIGIBLE device only. Format: v1.<deviceIdB64>.<expEpochSec>.<signature> */
function secIssueSession_(deviceId) {
  const cfg = getPrivateDriveConfig_();
  const exp = Math.floor(Date.now() / 1000) + cfg.sessionTtlSec;
  const idPart = Utilities.base64EncodeWebSafe(deviceId).replace(/=+$/, '');
  const body = 'v1.' + idPart + '.' + exp;
  return { token: body + '.' + secSign_(body), expiresAt: exp * 1000 };
}

/** Verifies the session belongs to THIS device and has not expired. */
function secVerifySession_(deviceId, token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const body = parts.slice(0, 3).join('.');
    if (!secSafeEqual_(parts[3], secSign_(body))) return false;
    const idPart = Utilities.base64EncodeWebSafe(String(deviceId || '').trim()).replace(/=+$/, '');
    if (!secSafeEqual_(parts[1], idPart)) return false;            // another device's session cannot be reused
    return Number(parts[2]) > Math.floor(Date.now() / 1000);
  } catch (e) { return false; }
}

/** Light per-device request throttle against abuse (generous: a large backup is many calls). */
function secThrottle_(deviceId) {
  try {
    const c = CacheService.getScriptCache(), k = 'dr_' + String(deviceId).slice(0, 60), n = Number(c.get(k) || 0) + 1;
    c.put(k, String(n), 60);
    return n > 600;
  } catch (e) { return false; }
}

/** Gate used by Drive.gs. op === 'session' needs only eligibility; every other op also needs a valid session. */
function authorizeDriveRequest_(req, needSession) {
  const id = String((req && req.deviceId) || '').trim();
  if (secThrottle_(id)) return secReject_('RATE_LIMITED', 'Too many requests. Please wait a moment.');
  const el = checkDriveEligibility_(id);
  if (!el.allowed) return el;
  if (needSession && !secVerifySession_(id, req.session)) return secReject_('SESSION_INVALID', 'Google Drive session expired. Please reconnect.');
  return el;
}
