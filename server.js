const http = require("node:http");
const { readFile, writeFile } = require("node:fs/promises");
const { createReadStream, existsSync } = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const ROOT = __dirname;
loadEnvFiles();

const PORT = Number(process.env.PORT || 4173);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "daisly-db.json");
const STORAGE_MODE = process.env.STORAGE_MODE === "supabase" ? "supabase" : "json";
const DAISLY_STATE_KEY = process.env.DAISLY_STATE_KEY || "default";
const SUPABASE_URL = normalizeBaseUrl(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "*").split(",").map((item) => item.trim()).filter(Boolean);
const PUBLIC_API_URL = normalizeBaseUrl(process.env.PUBLIC_API_URL || "https://api.daisly.space");
const PUBLIC_SITE_URL = normalizeBaseUrl(process.env.PUBLIC_SITE_URL || process.env.PUBLIC_APP_URL || "https://daisly.space");
const OAUTH_NATIVE_RETURN_URL = process.env.OAUTH_NATIVE_RETURN_URL || "daisly://auth";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks"
];
const APPLE_AUTH_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
let appleJwksCache = { expiresAt: 0, keys: [] };

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function loadEnvFiles() {
  for (const file of [".env", "daisly-credentials.local.env"]) {
    const filePath = path.join(ROOT, file);
    if (!existsSync(filePath)) continue;

    try {
      const raw = require("node:fs").readFileSync(filePath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match || process.env[match[1]] != null) continue;
        let value = match[2].trim();
        if (
          (value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      }
    } catch {
      // Local env files are optional; deployment should inject real environment variables.
    }
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function readDb() {
  if (STORAGE_MODE === "supabase") return readSupabaseDb();
  return readJsonDb();
}

async function writeDb(db) {
  const normalized = normalizeDb(db);
  if (STORAGE_MODE === "supabase") {
    await writeSupabaseDb(normalized);
    return;
  }
  await writeJsonDb(normalized);
}

async function readJsonDb() {
  return normalizeDb(JSON.parse(await readFile(DB_PATH, "utf8")));
}

async function writeJsonDb(db) {
  await writeFile(DB_PATH, `${JSON.stringify(normalizeDb(db), null, 2)}\n`);
}

async function readSupabaseDb() {
  assertSupabaseConfigured();
  const rows = await supabaseRequest(
    `daisly_app_state?key=eq.${encodeURIComponent(DAISLY_STATE_KEY)}&select=value`
  );

  if (Array.isArray(rows) && rows[0]?.value) return normalizeDb(rows[0].value);

  const seed = await readJsonDb();
  await supabaseRequest("daisly_app_state", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: DAISLY_STATE_KEY, value: seed })
  });
  return seed;
}

async function writeSupabaseDb(db) {
  assertSupabaseConfigured();
  await supabaseRequest(`daisly_app_state?key=eq.${encodeURIComponent(DAISLY_STATE_KEY)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ value: db })
  });
}

async function supabaseRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    body: options.body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${text.slice(0, 220)}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function assertSupabaseConfigured() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("STORAGE_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
}

function normalizeDb(db) {
  return {
    profile: db?.profile || {
      username: "daisly",
      displayName: "Daisly",
      avatarInitial: "D",
      onboarded: false
    },
    settings: publicSettings(db?.settings || {}),
    integrations: db?.integrations || {},
    tasks: Array.isArray(db?.tasks) ? db.tasks : [],
    groups: Array.isArray(db?.groups) ? db.groups : [],
    nextTaskId: Number(db?.nextTaskId || 1),
    accounts: Array.isArray(db?.accounts) ? db.accounts : [],
    sessions: db?.sessions && typeof db.sessions === "object" ? db.sessions : {},
    users: db?.users && typeof db.users === "object" ? db.users : {}
  };
}

function normalizeUserState(state, fallback = {}) {
  return {
    profile: state?.profile || {
      username: fallback.profile?.username || "daisly",
      displayName: fallback.profile?.displayName || "Daisly",
      avatarInitial: fallback.profile?.avatarInitial || "D",
      onboarded: Boolean(fallback.profile?.onboarded)
    },
    settings: publicSettings(state?.settings || fallback.settings || {}),
    integrations: state?.integrations || {},
    tasks: Array.isArray(state?.tasks) ? state.tasks : (Array.isArray(fallback.tasks) ? fallback.tasks.map((task) => ({ ...task })) : []),
    groups: Array.isArray(state?.groups) ? state.groups : (Array.isArray(fallback.groups) ? JSON.parse(JSON.stringify(fallback.groups)) : []),
    nextTaskId: Number(state?.nextTaskId || fallback.nextTaskId || 1)
  };
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    provider: account.provider || "email",
    createdAt: account.createdAt
  };
}

function defaultUsernameFromEmail(email) {
  return String(email || "daisy").split("@")[0].replace(/[^a-z0-9_]/gi, "").slice(0, 18).toLowerCase() || "daisy";
}

function ensureAccountState(db, account, profile = {}) {
  if (!db.users[account.id]) {
    const username = defaultUsernameFromEmail(account.email || profile.email || `${account.provider || "user"}@daisly.app`);
    db.users[account.id] = normalizeUserState({
      profile: {
        username,
        displayName: profile.displayName || profile.name || username,
        avatarInitial: String(profile.displayName || profile.name || username || "D").slice(0, 1).toUpperCase(),
        onboarded: false
      },
      settings: publicSettings({
        ...db.settings,
        googleCalendar: account.provider === "google",
        googleTasks: account.provider === "google"
      }),
      integrations: {},
      tasks: db.tasks.map((task) => ({ ...task })),
      groups: JSON.parse(JSON.stringify(db.groups || [])),
      nextTaskId: db.nextTaskId
    }, db);
  }
  return db.users[account.id];
}

function findOrCreateOAuthAccount(db, provider, profile) {
  const providerIdKey = provider === "apple" ? "appleSub" : "googleSub";
  const providerId = profile.sub || profile.id;
  let account = db.accounts.find((item) => item.provider === provider && item[providerIdKey] === providerId);
  if (!account && profile.email) {
    account = db.accounts.find((item) => item.provider === provider && item.email === normalizeEmail(profile.email));
  }
  if (!account) {
    account = {
      id: randomId("acct"),
      email: normalizeEmail(profile.email || `${providerId}@${provider}.daisly.local`),
      provider,
      [providerIdKey]: providerId,
      displayName: profile.name || profile.displayName || "",
      createdAt: new Date().toISOString()
    };
    db.accounts.push(account);
  } else {
    account.email = normalizeEmail(profile.email || account.email);
    account[providerIdKey] = account[providerIdKey] || providerId;
    account.displayName = profile.name || profile.displayName || account.displayName || "";
  }
  ensureAccountState(db, account, profile);
  return account;
}

async function createSession(db, account) {
  const token = randomId("sess");
  db.sessions[token] = { accountId: account.id, createdAt: new Date().toISOString() };
  await writeDb(db);
  return token;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString("hex")}`;
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateEmailPassword(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("Enter a valid email");
    error.status = 400;
    throw error;
  }
  if (String(password || "").length < 8) {
    const error = new Error("Password must be at least 8 characters");
    error.status = 400;
    throw error;
  }
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Buffer.from(normalized, "base64").toString("utf8");
}

function base64UrlBuffer(value) {
  let normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Buffer.from(normalized, "base64");
}

function oauthStateSecret() {
  return process.env.OAUTH_STATE_SECRET ||
    process.env.GOOGLE_WEB_CLIENT_SECRET ||
    process.env.APPLE_SIGNIN_KEY_ID ||
    "daisly-local-oauth-state";
}

function signOAuthState(body) {
  return base64Url(crypto.createHmac("sha256", oauthStateSecret()).update(body).digest());
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function encodeOAuthState(payload) {
  const body = base64Url(JSON.stringify({ ...payload, t: Date.now() }));
  return `${body}.${signOAuthState(body)}`;
}

function decodeOAuthState(value) {
  const [body, sig] = String(value || "").split(".");
  if (!body || !sig || !safeEqualString(sig, signOAuthState(body))) {
    const error = new Error("Invalid OAuth state");
    error.status = 400;
    throw error;
  }

  const payload = JSON.parse(base64UrlDecode(body));
  if (!payload.t || Date.now() - Number(payload.t) > 20 * 60 * 1000) {
    const error = new Error("OAuth state expired");
    error.status = 400;
    throw error;
  }
  return payload;
}

function safeOAuthReturnUrl(value) {
  const fallback = PUBLIC_SITE_URL ? `${PUBLIC_SITE_URL}/` : OAUTH_NATIVE_RETURN_URL;
  const raw = String(value || fallback).trim();
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowedWebHost =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localhost") ||
      host === "daisly.space" ||
      host === "www.daisly.space" ||
      host === "api.daisly.space" ||
      host.endsWith(".onrender.com");
    if (url.protocol === "daisly:") return url.href;
    if ((url.protocol === "https:" || url.protocol === "http:") && allowedWebHost) return url.href;
  } catch {}
  return fallback;
}

function redirectWithParams(res, target, params) {
  const url = new URL(target);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  });
  res.writeHead(302, { Location: url.href, "Cache-Control": "no-store" });
  res.end();
}

function finishOAuth(res, state, params) {
  redirectWithParams(res, safeOAuthReturnUrl(state.returnUrl), {
    authProvider: state.provider,
    ...params
  });
}

function postForm(url, form) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(data.error_description || data.error || "OAuth request failed");
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

function parseJwtPayload(token) {
  const [, payload] = String(token || "").split(".");
  if (!payload) return null;
  try {
    return JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }
}

function parseJwtHeader(token) {
  const [header] = String(token || "").split(".");
  if (!header) return null;
  try {
    return JSON.parse(base64UrlDecode(header));
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const value = req?.headers?.authorization || "";
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function authContext(req, db) {
  const token = bearerToken(req);
  const session = token && db.sessions ? db.sessions[token] : null;
  const account = session ? db.accounts.find((item) => item.id === session.accountId) : null;
  if (!account) return { account: null, token: "" };
  return {
    account,
    token,
    state: normalizeUserState(db.users[account.id], db)
  };
}

function scopedState(db, auth) {
  return auth.account ? auth.state : db;
}

async function writeScopedDb(db, auth, state) {
  if (auth.account) db.users[auth.account.id] = normalizeUserState(state, db);
  await writeDb(db);
}

function authResponse(db, account, token) {
  const state = normalizeUserState(db.users[account.id], db);
  const google = googleConnection(state);
  const calendarStatus = integrationStatus(state.settings.googleCalendar, google.configured, google.connected, google.calendarScope);
  const tasksStatus = integrationStatus(state.settings.googleTasks, google.configured, google.connected, google.tasksScope);
  return {
    ok: true,
    token,
    user: publicAccount(account),
    profile: state.profile,
    settings: publicSettings(state.settings),
    tasks: state.tasks.map(publicTask),
    groups: state.groups,
    nextTaskId: state.nextTaskId,
    integrations: {
      googleCalendar: { enabled: Boolean(state.settings.googleCalendar), connected: calendarStatus === "connected", configured: google.configured, status: calendarStatus },
      googleTasks: { enabled: Boolean(state.settings.googleTasks), connected: tasksStatus === "connected", configured: google.configured, status: tasksStatus },
      googleMeet: { enabled: Boolean(state.settings.googleCalendar), connected: calendarStatus === "connected", configured: google.configured, status: calendarStatus, source: "google_calendar" },
      icloud: { connected: Boolean(state.settings.icloud), status: "native_key_value_store" }
    }
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": corsOriginFor(res.req),
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(body));
}

function corsOriginFor(req) {
  const allowed = CORS_ORIGINS.length ? CORS_ORIGINS : ["*"];
  if (allowed.includes("*")) return "*";

  const origin = req?.headers?.origin || "";
  if (origin && allowed.includes(origin)) return origin;
  if (origin === "null" && allowed.includes("null")) return "null";
  return allowed[0] || "*";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) resolve({});
      else {
        try {
          const type = String(req.headers["content-type"] || "");
          if (type.includes("application/x-www-form-urlencoded")) {
            resolve(Object.fromEntries(new URLSearchParams(raw)));
          } else {
            resolve(JSON.parse(raw));
          }
        } catch {
          reject(new Error("Invalid request body"));
        }
      }
    });
  });
}

function publicTask(task) {
  return {
    id: task.id,
    externalId: task.externalId || null,
    externalListId: task.externalListId || null,
    title: task.title,
    icon: task.icon,
    color: task.color,
    type: task.type,
    durationMinutes: task.durationMinutes,
    day: task.day,
    timeMinutes: task.timeMinutes,
    done: Boolean(task.done),
    locked: task.locked || null,
    repeat: task.repeat || null,
    source: task.source || null,
    meet: Boolean(task.meet),
    meetUrl: task.meetUrl || null,
    notifyBeforeMinutes: task.notifyBeforeMinutes ?? null,
    description: task.description || "",
    subtasks: task.subtasks || [],
    groupTask: Boolean(task.groupTask),
    groupTaskId: task.groupTaskId || null
  };
}

function normalizeTask(input, id) {
  const title = String(input.title || "").trim();
  if (!title) {
    const error = new Error("Task title is required");
    error.status = 400;
    throw error;
  }

  return {
    id,
    externalId: input.externalId || null,
    externalListId: input.externalListId || null,
    title,
    icon: input.icon || "briefcase",
    color: input.color || "#5E9478",
    type: input.type || "task",
    durationMinutes: Number(input.durationMinutes || input.dur || 30),
    day: input.day ?? null,
    timeMinutes: input.timeMinutes ?? input.time ?? null,
    done: Boolean(input.done),
    locked: input.locked || null,
    source: input.source || null,
    meet: Boolean(input.meet),
    meetUrl: input.meetUrl || null,
    repeat: input.repeat || null,
    description: input.description || input.desc || "",
    notifyBeforeMinutes: input.notifyBeforeMinutes ?? input.notify ?? null,
    subtasks: normalizeSubtasks(input.subtasks || input.sub || [])
  };
}

function normalizeSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks.map((item) => ({
    title: item.title || item.t || "",
    done: Boolean(item.done || item.d)
  })).filter((item) => item.title);
}

function patchTask(task, input) {
  if ("externalId" in input) task.externalId = input.externalId || null;
  if ("externalListId" in input) task.externalListId = input.externalListId || null;
  if ("title" in input) task.title = String(input.title || "").trim() || task.title;
  if ("icon" in input) task.icon = input.icon || task.icon;
  if ("color" in input) task.color = input.color || task.color;
  if ("type" in input) task.type = input.type || task.type;
  if ("durationMinutes" in input || "dur" in input) task.durationMinutes = Number(input.durationMinutes || input.dur || task.durationMinutes);
  if ("day" in input) task.day = input.day;
  if ("timeMinutes" in input || "time" in input) task.timeMinutes = input.timeMinutes ?? input.time;
  if ("done" in input) task.done = Boolean(input.done);
  if ("repeat" in input) task.repeat = input.repeat || null;
  if ("description" in input || "desc" in input) task.description = input.description || input.desc || "";
  if ("notifyBeforeMinutes" in input || "notify" in input) task.notifyBeforeMinutes = input.notifyBeforeMinutes ?? input.notify ?? null;
  if ("subtasks" in input || "sub" in input) task.subtasks = normalizeSubtasks(input.subtasks || input.sub || []);
  if ("source" in input) task.source = input.source || null;
  if ("meet" in input) task.meet = Boolean(input.meet);
  if ("meetUrl" in input) task.meetUrl = input.meetUrl || null;
  return task;
}

function googleOAuthConfigured() {
  return Boolean(process.env.GOOGLE_WEB_CLIENT_ID && process.env.GOOGLE_WEB_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function applePrivateKey() {
  const inline = process.env.APPLE_SIGNIN_PRIVATE_KEY || process.env.APPLE_SIGN_IN_PRIVATE_KEY || "";
  if (inline) {
    const value = inline.includes("BEGIN PRIVATE KEY")
      ? inline
      : Buffer.from(inline, "base64").toString("utf8");
    return value.replace(/\\n/g, "\n");
  }

  const filePath = process.env.APPLE_SIGNIN_PRIVATE_KEY_PATH || process.env.APPLE_SIGN_IN_PRIVATE_KEY_PATH || "";
  if (filePath && existsSync(filePath)) return require("node:fs").readFileSync(filePath, "utf8");
  return "";
}

function appleRedirectUri() {
  return process.env.APPLE_REDIRECT_URI || `${PUBLIC_API_URL}/auth/apple/callback`;
}

function appleSignInConfigured() {
  return Boolean(
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_SERVICES_ID &&
    process.env.APPLE_SIGNIN_KEY_ID &&
    applePrivateKey()
  );
}

function appleClientSecret() {
  const privateKey = applePrivateKey();
  if (!privateKey) {
    const error = new Error("Apple Sign In private key is missing");
    error.status = 503;
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({
    alg: "ES256",
    kid: process.env.APPLE_SIGNIN_KEY_ID
  }));
  const payload = base64Url(JSON.stringify({
    iss: process.env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 60 * 60 * 24 * 30,
    aud: "https://appleid.apple.com",
    sub: process.env.APPLE_SERVICES_ID
  }));
  const input = `${header}.${payload}`;
  const signer = crypto.createSign("sha256");
  signer.update(input);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${base64Url(signature)}`;
}

async function appleJwks() {
  if (appleJwksCache.expiresAt > Date.now() && appleJwksCache.keys.length) {
    return appleJwksCache.keys;
  }

  const response = await fetch(APPLE_JWKS_URL);
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.keys)) {
    const error = new Error("Could not load Apple public keys");
    error.status = response.status || 503;
    throw error;
  }

  appleJwksCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, keys: data.keys };
  return appleJwksCache.keys;
}

async function verifyAppleIdentityToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  const header = parseJwtHeader(idToken);
  const payload = parseJwtPayload(idToken);
  if (!header || !payload || header.alg !== "RS256") return null;

  const keys = await appleJwks();
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) return null;

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(publicKey, base64UrlBuffer(parts[2]))) return null;

  if (
    payload.iss !== "https://appleid.apple.com" ||
    payload.aud !== process.env.APPLE_SERVICES_ID ||
    Number(payload.exp || 0) * 1000 < Date.now()
  ) {
    return null;
  }

  return payload;
}

function googleConnection(db) {
  const google = db?.integrations?.google || {};
  const connected = Boolean(google.refreshToken || google.accessToken || process.env.GOOGLE_REFRESH_TOKEN);
  const scopes = Array.isArray(google.scopes) ? google.scopes : [];
  const hasScope = (needle) => !scopes.length || scopes.some((scope) => String(scope).includes(needle));
  return {
    configured: googleOAuthConfigured(),
    connected,
    calendarScope: connected && hasScope("calendar"),
    tasksScope: connected && hasScope("tasks")
  };
}

function dateOffset(date) {
  const today = new Date();
  const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((target.getTime() - localToday.getTime()) / 86400000);
}

function minutesFromDate(date) {
  return date.getHours() * 60 + Math.round(date.getMinutes() / 5) * 5;
}

function stableExternalId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 16)}`;
}

function mergeExternalTasks(state, source, imported) {
  const existing = new Map((state.tasks || [])
    .filter((task) => task.source === source && task.externalId)
    .map((task) => [task.externalId, task]));
  const nextImported = imported.map((task) => {
    const prev = existing.get(task.externalId);
    return prev ? { ...task, done: Boolean(prev.done), description: prev.description || task.description } : task;
  });
  state.tasks = (state.tasks || []).filter((task) => task.source !== source).concat(nextImported);
}

async function googleRequest(pathname, accessToken, query = {}, options = {}) {
  const url = new URL(pathname);
  Object.entries(query).forEach(([key, value]) => {
    if (value != null) url.searchParams.set(key, String(value));
  });
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {})
  };
  if (options.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(url.href, {
    method: options.method || "GET",
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error?.message || data.error || "Google API request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function googleFetch(pathname, accessToken, query = {}) {
  return googleRequest(pathname, accessToken, query);
}

async function refreshGoogleAccessToken(state) {
  const google = state?.integrations?.google || {};
  if (google.accessToken && Number(google.expiresAt || 0) > Date.now() + 60 * 1000) {
    return google.accessToken;
  }
  if (!google.refreshToken || !googleOAuthConfigured()) return google.accessToken || "";

  const tokenData = await postForm(GOOGLE_TOKEN_URL, {
    client_id: process.env.GOOGLE_WEB_CLIENT_ID,
    client_secret: process.env.GOOGLE_WEB_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: google.refreshToken
  });

  state.integrations.google = {
    ...google,
    accessToken: tokenData.access_token,
    tokenType: tokenData.token_type || google.tokenType || "Bearer",
    scopes: tokenData.scope ? String(tokenData.scope).split(/\s+/).filter(Boolean) : (google.scopes || []),
    expiresAt: Date.now() + Math.max(60, Number(tokenData.expires_in || 3600) - 60) * 1000,
    refreshedAt: new Date().toISOString()
  };
  return state.integrations.google.accessToken;
}

function rememberGoogleSyncError(state, message) {
  state.integrations = state.integrations || {};
  state.integrations.google = state.integrations.google || {};
  const current = Array.isArray(state.integrations.google.lastSyncErrors)
    ? state.integrations.google.lastSyncErrors
    : [];
  state.integrations.google.lastSyncErrors = [String(message || "Google sync failed"), ...current].slice(0, 3);
}

async function syncGoogleCalendar(state, accessToken) {
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 1);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 45);
  const data = await googleFetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", accessToken, {
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "80",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString()
  });
  const imported = (data.items || [])
    .filter((event) => event.status !== "cancelled" && event.start?.dateTime && event.end?.dateTime)
    .map((event) => {
      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      const duration = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000 / 5) * 5);
      return {
        id: stableExternalId("gcal", event.id),
        externalId: event.id,
        title: event.summary || "Google Calendar event",
        icon: event.hangoutLink || event.conferenceData ? "video" : "briefcase",
        color: "#5F9EA0",
        type: "event",
        durationMinutes: duration,
        day: dateOffset(start),
        timeMinutes: minutesFromDate(start),
        done: false,
        source: "google_calendar",
        meet: Boolean(event.hangoutLink),
        meetUrl: event.hangoutLink || null,
        repeat: null,
        description: event.description || "",
        notifyBeforeMinutes: null,
        subtasks: []
      };
    })
    .filter((task) => task.day >= -1 && task.day <= 45);
  mergeExternalTasks(state, "google_calendar", imported);
}

async function syncGoogleTasks(state, accessToken) {
  const lists = await googleFetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken, {
    maxResults: "20"
  });
  const imported = [];
  for (const list of lists.items || []) {
    const tasks = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks`, accessToken, {
      showCompleted: "true",
      showHidden: "false",
      maxResults: "100"
    });
    for (const item of tasks.items || []) {
      if (item.deleted || item.hidden) continue;
      const due = item.due ? new Date(item.due) : null;
      imported.push({
        id: stableExternalId("gtask", `${list.id}:${item.id}`),
        externalId: item.id,
        externalListId: list.id,
        title: item.title || "Google Task",
        icon: "pen",
        color: "#2E8B57",
        type: "task",
        durationMinutes: 30,
        day: due ? dateOffset(due) : null,
        timeMinutes: null,
        done: item.status === "completed",
        source: "google_tasks",
        meet: false,
        meetUrl: null,
        repeat: null,
        description: item.notes || "",
        notifyBeforeMinutes: null,
        subtasks: []
      });
    }
  }
  mergeExternalTasks(state, "google_tasks", imported);
}

async function syncGoogleData(state) {
  const accessToken = await refreshGoogleAccessToken(state);
  if (!accessToken) return;
  const google = state?.integrations?.google || {};
  const scopes = Array.isArray(google.scopes) ? google.scopes.join(" ") : String(google.scopes || "");
  const errors = [];
  if (scopes.includes("calendar")) {
    try { await syncGoogleCalendar(state, google.accessToken); } catch (error) { errors.push(error.message); }
  }
  if (scopes.includes("tasks")) {
    try { await syncGoogleTasks(state, google.accessToken); } catch (error) { errors.push(error.message); }
  }
  state.integrations.google.lastSyncAt = new Date().toISOString();
  state.integrations.google.lastSyncErrors = errors.slice(0, 3);
}

async function syncGoogleTaskMutation(state, task, deleted = false) {
  if (!task || task.source !== "google_tasks" || !task.externalId || !task.externalListId) return;
  const accessToken = await refreshGoogleAccessToken(state);
  if (!accessToken) return;

  const endpoint = `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(task.externalListId)}/tasks/${encodeURIComponent(task.externalId)}`;
  if (deleted) {
    await googleRequest(endpoint, accessToken, {}, { method: "DELETE" });
    return;
  }

  const body = {
    title: task.title || "Daisly task",
    notes: task.description || "",
    status: task.done ? "completed" : "needsAction"
  };
  if (task.done) body.completed = new Date().toISOString();
  if (task.day != null) {
    const today = new Date();
    const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(task.day || 0), 0, 0, 0, 0);
    body.due = due.toISOString();
  }

  await googleRequest(endpoint, accessToken, {}, { method: "PATCH", body });
}

function integrationStatus(enabled, configured, connected, scoped) {
  if (!enabled) return "disabled";
  if (!configured) return "missing_oauth_credentials";
  if (!connected) return "needs_user_consent";
  if (!scoped) return "missing_scope";
  return "connected";
}

function publicSettings(settings) {
  return {
    icloud: Boolean(settings.icloud),
    googleCalendar: Boolean(settings.googleCalendar),
    googleTasks: Boolean(settings.googleTasks),
    notifications: Boolean(settings.notifications),
    sound: settings.sound || "Chime",
    warnBeforeMinutes: settings.warnBeforeMinutes ?? 15,
    taskStartAlert: Boolean(settings.taskStartAlert),
    taskEndAlert: Boolean(settings.taskEndAlert),
    morningPlanning: Boolean(settings.morningPlanning),
    overdueTasks: Boolean(settings.overdueTasks),
    language: settings.language || "English",
    theme: settings.theme || "Sage"
  };
}

function publicConfig() {
  return {
    app: "Daisly",
    environment: process.env.NODE_ENV || "development",
    storageMode: STORAGE_MODE,
    urls: {
      app: process.env.PUBLIC_APP_URL || "",
      site: process.env.PUBLIC_SITE_URL || "",
      api: process.env.PUBLIC_API_URL || "",
      privacy: process.env.PRIVACY_POLICY_URL || "https://daisly.space/privacy",
      terms: process.env.TERMS_OF_SERVICE_URL || "https://daisly.space/terms"
    },
    supportEmail: process.env.SUPPORT_EMAIL || "support@daisly.space",
    payments: {
      entitlementId: process.env.REVENUECAT_ENTITLEMENT_ID || "Daisly Pro",
      monthlyProductId: process.env.PRODUCT_ID_MONTHLY || "daisly_pro_monthly",
      yearlyProductId: process.env.PRODUCT_ID_YEARLY || "daisly_pro_yearly"
    },
    google: {
      iosClientId: process.env.GOOGLE_IOS_CLIENT_ID || "",
      iosUrlScheme: process.env.GOOGLE_IOS_URL_SCHEME || "",
      redirectUri: process.env.GOOGLE_REDIRECT_URI || ""
    },
    apple: {
      servicesId: process.env.APPLE_SERVICES_ID || "",
      redirectUri: appleRedirectUri()
    },
    features: {
      googleOAuthConfigured: googleOAuthConfigured(),
      appleSignInConfigured: appleSignInConfigured(),
      nativeICloudSync: true,
      supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY),
      revenueCatConfigured: Boolean(process.env.REVENUECAT_PUBLIC_SDK_KEY && process.env.REVENUECAT_SECRET_API_KEY),
      sentryConfigured: Boolean(process.env.SENTRY_DSN),
      postHogConfigured: Boolean(process.env.POSTHOG_API_KEY && process.env.POSTHOG_HOST)
    }
  };
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      app: "Daisly",
      storageMode: STORAGE_MODE,
      time: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, publicConfig());
  }

  const db = await readDb();
  const auth = authContext(req, db);
  const appDb = scopedState(db, auth);
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];
  const id = parts[2];

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const google = googleConnection(appDb);
    const calendarStatus = integrationStatus(appDb.settings.googleCalendar, google.configured, google.connected, google.calendarScope);
    const tasksStatus = integrationStatus(appDb.settings.googleTasks, google.configured, google.connected, google.tasksScope);
    return sendJson(res, 200, {
      auth: {
        authenticated: Boolean(auth.account),
        user: publicAccount(auth.account)
      },
      profile: appDb.profile,
      settings: publicSettings(appDb.settings),
      tasks: appDb.tasks.map(publicTask),
      groups: appDb.groups,
      nextTaskId: appDb.nextTaskId,
      integrations: {
        googleCalendar: { enabled: Boolean(appDb.settings.googleCalendar), connected: calendarStatus === "connected", configured: google.configured, status: calendarStatus },
        googleTasks: { enabled: Boolean(appDb.settings.googleTasks), connected: tasksStatus === "connected", configured: google.configured, status: tasksStatus },
        googleMeet: { enabled: Boolean(appDb.settings.googleCalendar), connected: calendarStatus === "connected", configured: google.configured, status: calendarStatus, source: "google_calendar" },
        icloud: { connected: Boolean(appDb.settings.icloud), status: "native_key_value_store" }
      }
    });
  }

  if (resource === "profile" && req.method === "GET") {
    return sendJson(res, 200, appDb.profile);
  }

  if (resource === "settings") {
    if (req.method === "GET") return sendJson(res, 200, publicSettings(appDb.settings));
    if (req.method === "PATCH") {
      appDb.settings = publicSettings({ ...appDb.settings, ...(await readBody(req)) });
      await writeScopedDb(db, auth, appDb);
      return sendJson(res, 200, publicSettings(appDb.settings));
    }
  }

  if (resource === "onboarding" && req.method === "POST") {
    const body = await readBody(req);
    appDb.profile = {
      ...appDb.profile,
      onboarded: true,
      username: body.username || appDb.profile.username,
      displayName: body.displayName || body.username || appDb.profile.displayName,
      avatarInitial: String(body.username || appDb.profile.username || "U").slice(0, 1).toUpperCase()
    };
    if (body.wakeTimeMinutes != null || body.sleepTimeMinutes != null) {
      appDb.tasks = appDb.tasks.map((task) => {
        if (task.locked === "wake" && body.wakeTimeMinutes != null) return { ...task, timeMinutes: body.wakeTimeMinutes };
        if (task.locked === "sleep" && body.sleepTimeMinutes != null) return { ...task, timeMinutes: body.sleepTimeMinutes };
        return task;
      });
    }
    if (body.settings) appDb.settings = publicSettings({ ...appDb.settings, ...body.settings });
    await writeScopedDb(db, auth, appDb);
    return sendJson(res, 200, {
      profile: appDb.profile,
      settings: publicSettings(appDb.settings),
      tasks: appDb.tasks.map(publicTask)
    });
  }

  if (resource === "tasks") {
    if (req.method === "GET") {
      let tasks = appDb.tasks;
      if (url.searchParams.has("day")) {
        const day = url.searchParams.get("day");
        tasks = day === "inbox"
          ? tasks.filter((task) => task.day == null)
          : tasks.filter((task) => String(task.day) === day);
      }
      return sendJson(res, 200, tasks.map(publicTask));
    }

    if (req.method === "POST") {
      const task = normalizeTask(await readBody(req), appDb.nextTaskId);
      appDb.nextTaskId += 1;
      appDb.tasks.push(task);
      await writeScopedDb(db, auth, appDb);
      return sendJson(res, 201, publicTask(task));
    }

    const task = appDb.tasks.find((item) => String(item.id) === id);
    if (!task) return sendJson(res, 404, { error: "Task not found" });

    if (req.method === "PATCH") {
      patchTask(task, await readBody(req));
      try {
        await syncGoogleTaskMutation(appDb, task);
      } catch (error) {
        rememberGoogleSyncError(appDb, error.message);
      }
      await writeScopedDb(db, auth, appDb);
      return sendJson(res, 200, publicTask(task));
    }

    if (req.method === "DELETE") {
      try {
        await syncGoogleTaskMutation(appDb, task, true);
      } catch (error) {
        rememberGoogleSyncError(appDb, error.message);
      }
      appDb.tasks = appDb.tasks.filter((item) => String(item.id) !== id);
      await writeScopedDb(db, auth, appDb);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (resource === "groups" && req.method === "GET") {
    return sendJson(res, 200, appDb.groups);
  }

  if (resource === "groups" && id) {
    const group = appDb.groups.find((item) => item.id === id);
    if (!group) return sendJson(res, 404, { error: "Group not found" });
    const taskIndex = parts.indexOf("tasks");
    if (taskIndex !== -1) {
      const groupTaskId = parts[taskIndex + 1];
      const action = parts[taskIndex + 2];
      const groupTask = group.tasks.find((item) => String(item.id) === groupTaskId);
      if (!groupTask) return sendJson(res, 404, { error: "Group task not found" });

      if (req.method === "PATCH" && !action) {
        Object.assign(groupTask, await readBody(req));
        await writeScopedDb(db, auth, appDb);
        return sendJson(res, 200, groupTask);
      }

      if (req.method === "POST" && ["accept", "decline", "reinvite"].includes(action)) {
        groupTask.status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "invited";
        if (action === "accept") {
          const exists = appDb.tasks.some((task) => task.groupTaskId === groupTask.id);
          if (!exists) {
            appDb.tasks.push({
              id: appDb.nextTaskId++,
              title: groupTask.title,
              icon: groupTask.icon,
              color: groupTask.color,
              type: groupTask.type,
              durationMinutes: groupTask.durationMinutes,
              day: 0,
              timeMinutes: groupTask.timeMinutes,
              done: false,
              groupTask: true,
              groupTaskId: groupTask.id
            });
          }
        }
        await writeScopedDb(db, auth, appDb);
        return sendJson(res, 200, { groupTask, tasks: appDb.tasks.map(publicTask) });
      }
    }
  }

  if (resource === "integrations") {
    const google = auth.account && auth.account.provider === "email"
      ? { configured: googleOAuthConfigured(), connected: false, calendarScope: false, tasksScope: false }
      : googleConnection(appDb);
    if (req.method === "GET") {
      const calendarStatus = auth.account && auth.account.provider === "email"
        ? "needs_google_sign_in"
        : integrationStatus(appDb.settings.googleCalendar, google.configured, google.connected, google.calendarScope);
      const tasksStatus = auth.account && auth.account.provider === "email"
        ? "needs_google_sign_in"
        : integrationStatus(appDb.settings.googleTasks, google.configured, google.connected, google.tasksScope);
      return sendJson(res, 200, {
        googleCalendar: {
          enabled: Boolean(appDb.settings.googleCalendar),
          connected: calendarStatus === "connected",
          configured: google.configured,
          status: calendarStatus
        },
        googleTasks: {
          enabled: Boolean(appDb.settings.googleTasks),
          connected: tasksStatus === "connected",
          configured: google.configured,
          status: tasksStatus
        },
        googleMeet: {
          enabled: Boolean(appDb.settings.googleCalendar),
          connected: calendarStatus === "connected",
          configured: google.configured,
          status: calendarStatus,
          source: "google_calendar"
        },
        icloud: { connected: Boolean(appDb.settings.icloud), status: "native_key_value_store" }
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const provider = body.provider || "google";
      if (provider === "google") {
        const google = googleConnection(appDb);
        if (auth.account && google.connected) {
          await syncGoogleData(appDb);
          await writeScopedDb(db, auth, appDb);
          return sendJson(res, 200, {
            ok: true,
            status: "connected",
            tasks: appDb.tasks.map(publicTask),
            syncedAt: appDb.integrations.google?.lastSyncAt || new Date().toISOString()
          });
        }
        if (google.configured) {
          const returnUrl = safeOAuthReturnUrl(body.returnUrl || (body.native ? OAUTH_NATIVE_RETURN_URL : ""));
          const start = new URL(`${PUBLIC_API_URL}/auth/google/start`);
          start.searchParams.set("returnUrl", returnUrl);
          if (body.native) start.searchParams.set("native", "1");
          return sendJson(res, 200, {
            ok: false,
            status: "needs_user_consent",
            authUrl: start.href,
            note: "Open Google consent to connect Calendar, Meet, and Tasks."
          });
        }
      }
      return sendJson(res, 200, {
        ok: false,
        status: auth.account && auth.account.provider === "email"
          ? "needs_google_sign_in"
          : google.configured ? "needs_user_consent" : "missing_oauth_credentials",
        note: auth.account && auth.account.provider === "email"
          ? "Email accounts can use Daisly sync, but Google Calendar and Tasks require connecting a Google account."
          : google.configured
            ? "Google OAuth credentials are configured, but the user consent flow is not completed yet."
          : "Google OAuth credentials are required before Calendar, Meet, or Tasks can sync."
      });
    }
  }

  if (resource === "export" && req.method === "GET") {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_EXPORT !== "true") {
      return sendJson(res, 403, { error: "Export is disabled in production" });
    }
    return sendJson(res, 200, db);
  }

  return sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  const safePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(ROOT, safePath));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache"
  });
  createReadStream(filePath).pipe(res);
}

async function handleAuth(req, res, url) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  if (url.pathname === "/auth/google/start" && req.method === "GET") {
    if (!googleOAuthConfigured()) return sendJson(res, 503, { ok: false, error: "Google OAuth is not configured" });
    const returnUrl = safeOAuthReturnUrl(url.searchParams.get("returnUrl") || (url.searchParams.get("native") === "1" ? OAUTH_NATIVE_RETURN_URL : ""));
    const state = encodeOAuthState({ provider: "google", returnUrl });
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set("client_id", process.env.GOOGLE_WEB_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", process.env.GOOGLE_REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);
    res.writeHead(302, { Location: authUrl.href, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (url.pathname === "/auth/apple/start" && req.method === "GET") {
    if (!appleSignInConfigured()) return sendJson(res, 503, { ok: false, error: "Apple Sign In is not configured" });
    const returnUrl = safeOAuthReturnUrl(url.searchParams.get("returnUrl") || (url.searchParams.get("native") === "1" ? OAUTH_NATIVE_RETURN_URL : ""));
    const state = encodeOAuthState({ provider: "apple", returnUrl });
    const authUrl = new URL(APPLE_AUTH_URL);
    authUrl.searchParams.set("client_id", process.env.APPLE_SERVICES_ID);
    authUrl.searchParams.set("redirect_uri", appleRedirectUri());
    authUrl.searchParams.set("response_type", "code id_token");
    authUrl.searchParams.set("response_mode", "form_post");
    authUrl.searchParams.set("scope", "name email");
    authUrl.searchParams.set("state", state);
    res.writeHead(302, { Location: authUrl.href, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (url.pathname === "/auth/session" && req.method === "GET") {
    const db = await readDb();
    const auth = authContext(req, db);
    if (!auth.account) return sendJson(res, 401, { ok: false, error: "Not signed in" });
    return sendJson(res, 200, authResponse(db, auth.account, auth.token));
  }

  if ((url.pathname === "/auth/email/signup" || url.pathname === "/auth/email/login") && req.method === "POST") {
    const db = await readDb();
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    validateEmailPassword(email, password);

    const existing = db.accounts.find((account) => account.email === email && account.provider === "email");
    let account = existing;

    if (url.pathname.endsWith("/signup")) {
      if (existing) return sendJson(res, 409, { ok: false, error: "An account with this email already exists" });
      const username = defaultUsernameFromEmail(email);
      const salt = randomId("salt");
      account = {
        id: randomId("acct"),
        email,
        provider: "email",
        passwordSalt: salt,
        passwordHash: hashPassword(password, salt),
        createdAt: new Date().toISOString()
      };
      db.accounts.push(account);
      db.users[account.id] = normalizeUserState({
        profile: {
          username,
          displayName: body.displayName || username,
          avatarInitial: username.slice(0, 1).toUpperCase(),
          onboarded: false
        },
        settings: publicSettings({ ...db.settings, googleCalendar: false, googleTasks: false }),
        integrations: {},
        tasks: db.tasks.map((task) => ({ ...task })),
        groups: JSON.parse(JSON.stringify(db.groups || [])),
        nextTaskId: db.nextTaskId
      }, db);
    } else {
      if (!account || account.passwordHash !== hashPassword(password, account.passwordSalt || "")) {
        return sendJson(res, 401, { ok: false, error: "Email or password is incorrect" });
      }
    }

    const token = randomId("sess");
    db.sessions[token] = { accountId: account.id, createdAt: new Date().toISOString() };
    await writeDb(db);
    return sendJson(res, 200, authResponse(db, account, token));
  }

  if (url.pathname === "/auth/email/logout" && req.method === "POST") {
    const db = await readDb();
    const token = bearerToken(req);
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      await writeDb(db);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/auth/google/callback" && req.method === "GET") {
    const state = decodeOAuthState(url.searchParams.get("state"));
    const oauthError = url.searchParams.get("error");
    if (oauthError) return finishOAuth(res, state, { authError: oauthError });
    const code = url.searchParams.get("code");
    if (!code) return finishOAuth(res, state, { authError: "Missing Google authorization code" });

    const tokenData = await postForm(GOOGLE_TOKEN_URL, {
      client_id: process.env.GOOGLE_WEB_CLIENT_ID,
      client_secret: process.env.GOOGLE_WEB_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code
    });
    const userInfo = await googleFetch(GOOGLE_USERINFO_URL, tokenData.access_token);
    if (!userInfo.sub) return finishOAuth(res, state, { authError: "Google profile is missing" });

    const db = await readDb();
    const account = findOrCreateOAuthAccount(db, "google", {
      sub: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name || userInfo.given_name || defaultUsernameFromEmail(userInfo.email)
    });
    const userState = ensureAccountState(db, account, {
      email: account.email,
      name: account.displayName || userInfo.name
    });
    const scopes = String(tokenData.scope || GOOGLE_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
    userState.integrations.google = {
      provider: "google",
      email: account.email,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || userState.integrations.google?.refreshToken || "",
      scopes,
      tokenType: tokenData.token_type || "Bearer",
      expiresAt: Date.now() + Math.max(60, Number(tokenData.expires_in || 3600) - 60) * 1000,
      connectedAt: new Date().toISOString()
    };
    userState.settings = publicSettings({
      ...userState.settings,
      googleCalendar: scopes.some((scope) => scope.includes("calendar")),
      googleTasks: scopes.some((scope) => scope.includes("tasks"))
    });
    await syncGoogleData(userState);
    db.users[account.id] = normalizeUserState(userState, db);
    const sessionToken = await createSession(db, account);
    return finishOAuth(res, state, { authToken: sessionToken });
  }

  if (url.pathname === "/auth/apple/callback" && (req.method === "GET" || req.method === "POST")) {
    const body = req.method === "POST" ? await readBody(req) : {};
    const state = decodeOAuthState(body.state || url.searchParams.get("state"));
    const oauthError = body.error || url.searchParams.get("error");
    if (oauthError) return finishOAuth(res, state, { authError: oauthError });
    const code = body.code || url.searchParams.get("code");
    if (!code) return finishOAuth(res, state, { authError: "Missing Apple authorization code" });

    const tokenData = await postForm(APPLE_TOKEN_URL, {
      client_id: process.env.APPLE_SERVICES_ID,
      client_secret: appleClientSecret(),
      redirect_uri: appleRedirectUri(),
      grant_type: "authorization_code",
      code
    });
    const appleProfile = await verifyAppleIdentityToken(tokenData.id_token);
    if (!appleProfile) {
      return finishOAuth(res, state, { authError: "Apple profile could not be verified" });
    }

    let submittedUser = {};
    try { submittedUser = body.user ? JSON.parse(body.user) : {}; } catch {}
    const first = submittedUser?.name?.firstName || "";
    const last = submittedUser?.name?.lastName || "";
    const name = `${first} ${last}`.trim() || defaultUsernameFromEmail(appleProfile.email || "apple@daisly.app");
    const db = await readDb();
    const account = findOrCreateOAuthAccount(db, "apple", {
      sub: appleProfile.sub,
      email: appleProfile.email,
      name
    });
    const userState = ensureAccountState(db, account, {
      email: account.email,
      name: account.displayName || name
    });
    userState.integrations.apple = {
      provider: "apple",
      email: account.email,
      sub: appleProfile.sub,
      connectedAt: new Date().toISOString()
    };
    db.users[account.id] = normalizeUserState(userState, db);
    const sessionToken = await createSession(db, account);
    return finishOAuth(res, state, { authToken: sessionToken });
  }

  return sendJson(res, 404, { error: "Auth route not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  res.req = req;
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (url.pathname.startsWith("/auth/")) await handleAuth(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Daisly backend listening on http://127.0.0.1:${PORT}`);
});
