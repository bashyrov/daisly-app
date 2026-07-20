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
      googleCalendar: { enabled: false, connected: false, configured: googleOAuthConfigured(), status: "needs_google_sign_in" },
      googleTasks: { enabled: false, connected: false, configured: googleOAuthConfigured(), status: "needs_google_sign_in" },
      googleMeet: { enabled: false, connected: false, configured: googleOAuthConfigured(), status: "needs_google_sign_in", source: "google_calendar" },
      icloud: { connected: Boolean(state.settings.icloud), status: "local_mock" }
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
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      }
    });
  });
}

function publicTask(task) {
  return {
    id: task.id,
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
    features: {
      googleOAuthConfigured: googleOAuthConfigured(),
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
    return sendJson(res, 200, {
      auth: {
        authenticated: Boolean(auth.account),
        user: publicAccount(auth.account)
      },
      profile: appDb.profile,
      settings: publicSettings(appDb.settings),
      tasks: appDb.tasks.map(publicTask),
      groups: appDb.groups,
      nextTaskId: appDb.nextTaskId
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
      await writeScopedDb(db, auth, appDb);
      return sendJson(res, 200, publicTask(task));
    }

    if (req.method === "DELETE") {
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
        icloud: { connected: Boolean(appDb.settings.icloud), status: "local_mock" }
      });
    }
    if (req.method === "POST") {
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

  if (url.pathname === "/auth/google/callback") {
    return sendJson(res, 501, {
      error: "Google OAuth callback is reserved but not implemented yet",
      configured: googleOAuthConfigured()
    });
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
