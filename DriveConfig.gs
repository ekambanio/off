/** DriveConfig.gs — private Google Drive configuration (server side only).
 *
 * Nothing in this file is ever sent to the browser except what getPublicDriveConfig_() returns, and that is
 * returned ONLY after Security.gs has confirmed the device has an active PAID subscription.
 *
 * WHERE TO PUT THE REAL VALUES (do this once, in the Apps Script editor):
 *   Project Settings (gear icon) -> Script Properties -> Add script property
 *     DRIVE_OAUTH_CLIENT_ID   = (optional) overrides the built-in client ID below; must end in .apps.googleusercontent.com
 *     DRIVE_API_KEY           = (optional) a Google Cloud API key restricted to "Google Drive API" only
 *     DRIVE_HMAC_SECRET       = (optional) any long random text; if missing, one is generated automatically on first use
 *   You can also run setupDriveProperties() once after editing the values below, then delete the values from this file.
 */
const DRIVE_DEFAULTS = {
  // Your existing Google OAuth client ID (the one the app used before). A client ID is PUBLIC by design (Google shows it in every
  // sign-in window), so it is safe as the built-in default. A Script Property named DRIVE_OAUTH_CLIENT_ID overrides it.
  OAUTH_CLIENT_ID: '91062929087-i8mhcncd17gg6fbfrfkuqidepga9j2eo.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',   // same scope the app already used: only files the app itself created
  DRIVE_API: 'https://www.googleapis.com/drive/v3',
  DRIVE_UPLOAD_API: 'https://www.googleapis.com/upload/drive/v3',
  SESSION_TTL_SEC: 20 * 60,                  // a Drive session is valid for 20 minutes and is renewed after a fresh subscription check
  MAX_REQUEST_BYTES: 40 * 1024 * 1024        // refuse bodies larger than this
};

function driveProp_(name) {
  try { return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim(); } catch (e) { return ''; }
}

/** One-time helper: copy the values you typed below into Script Properties. Run it once from the editor. */
function setupDriveProperties() {
  const props = PropertiesService.getScriptProperties();
  const CLIENT_ID_TO_STORE = '';   // <- paste the OAuth client ID here, run this function once, then clear it again
  const API_KEY_TO_STORE = '';     // <- optional restricted Drive API key
  if (CLIENT_ID_TO_STORE) props.setProperty('DRIVE_OAUTH_CLIENT_ID', CLIENT_ID_TO_STORE);
  if (API_KEY_TO_STORE) props.setProperty('DRIVE_API_KEY', API_KEY_TO_STORE);
  if (!props.getProperty('DRIVE_HMAC_SECRET')) props.setProperty('DRIVE_HMAC_SECRET', Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid());
  return 'Drive properties stored. Client ID set: ' + !!props.getProperty('DRIVE_OAUTH_CLIENT_ID');
}

const DRIVE_CLIENT_ID_RE = /^[0-9]{6,}-[A-Za-z0-9_]{10,}\.apps\.googleusercontent\.com$/;

/** Finds the OAuth client ID. Accepts the property names people commonly use, trims quotes/spaces, and only accepts a value that
 *  really looks like a Google OAuth client ID (so an API key pasted into the wrong property is ignored instead of breaking sign-in). */
function resolveClientId_() {
  const names = ['DRIVE_OAUTH_CLIENT_ID', 'OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'CLIENT_ID', 'DRIVE_CLIENT_ID', 'GDRIVE_CLIENT_ID'];
  for (let i = 0; i < names.length; i++) {
    const v = driveProp_(names[i]).replace(/^["'\s]+|["'\s]+$/g, '');
    if (DRIVE_CLIENT_ID_RE.test(v)) return v;
  }
  const d = String(DRIVE_DEFAULTS.OAUTH_CLIENT_ID || '').trim();
  return DRIVE_CLIENT_ID_RE.test(d) ? d : '';
}

/** Run from the editor to see what the server actually reads (shows no secret values). */
function checkDriveConfig() {
  const c = getPrivateDriveConfig_();
  const r = { clientIdFound: !!c.oauthClientId, clientIdEndsWith: c.oauthClientId ? c.oauthClientId.slice(-30) : '', apiKeySet: !!c.apiKey, hmacSecretSet: !!driveProp_('DRIVE_HMAC_SECRET'), scopes: c.scopes };
  Logger.log(JSON.stringify(r)); return r;
}

/** Server-only configuration used by Drive.gs and Security.gs. NEVER return this object to the browser. */
function getPrivateDriveConfig_() {
  return {
    oauthClientId: resolveClientId_(),
    apiKey: /^AIza[0-9A-Za-z_-]{20,}$/.test(driveProp_('DRIVE_API_KEY')) ? driveProp_('DRIVE_API_KEY') : '',
    scopes: DRIVE_DEFAULTS.SCOPES,
    driveApi: DRIVE_DEFAULTS.DRIVE_API,
    uploadApi: DRIVE_DEFAULTS.DRIVE_UPLOAD_API,
    sessionTtlSec: DRIVE_DEFAULTS.SESSION_TTL_SEC,
    maxRequestBytes: DRIVE_DEFAULTS.MAX_REQUEST_BYTES
  };
}

/** The ONLY configuration the browser receives, and only for an eligible paid device.
 *  The OAuth client ID is public by design (Google shows it in every sign-in popup); it is still withheld from
 *  trial / expired devices so they cannot even start Google authorization through this app. The API key and the
 *  signing secret are NEVER included. */
function getPublicDriveConfig_() {
  const c = getPrivateDriveConfig_();
  return { clientId: c.oauthClientId, scopes: c.scopes };
}

/** Secret used to sign Drive sessions. Created once and kept in Script Properties. */
function getSigningSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('DRIVE_HMAC_SECRET');
  if (!s) {
    const l = LockService.getScriptLock();
    l.waitLock(10000);
    try {
      s = props.getProperty('DRIVE_HMAC_SECRET');
      if (!s) { s = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid(); props.setProperty('DRIVE_HMAC_SECRET', s); }
    } finally { l.releaseLock(); }
  }
  return s;
}
