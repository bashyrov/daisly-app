import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

async function firstExisting(paths) {
  for (const filePath of paths) {
    try {
      await access(filePath);
      return filePath;
    } catch {}
  }
  throw new Error(`Missing required file: ${paths.join(" or ")}`);
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist/.openai", { recursive: true });
await mkdir("dist/server", { recursive: true });
await mkdir("dist/privacy", { recursive: true });
await mkdir("dist/terms", { recursive: true });
await mkdir("dist/support", { recursive: true });

for (const file of ["index.html", "styles.css", "script.js", "privacy.html", "terms.html", "support.html"]) {
  await cp(file, `dist/${file}`);
}

await cp("assets", "dist/assets", { recursive: true });
await cp("privacy.html", "dist/privacy/index.html");
await cp("terms.html", "dist/terms/index.html");
await cp("support.html", "dist/support/index.html");
await cp(await firstExisting(["../.openai/hosting.json", ".openai/hosting.json"]), "dist/.openai/hosting.json");

const textFiles = [
  { path: "/", file: "index.html", type: "text/html; charset=utf-8" },
  { path: "/index.html", file: "index.html", type: "text/html; charset=utf-8" },
  { path: "/privacy", file: "privacy.html", type: "text/html; charset=utf-8" },
  { path: "/privacy/", file: "privacy.html", type: "text/html; charset=utf-8" },
  { path: "/privacy.html", file: "privacy.html", type: "text/html; charset=utf-8" },
  { path: "/privacy/index.html", file: "privacy.html", type: "text/html; charset=utf-8" },
  { path: "/terms", file: "terms.html", type: "text/html; charset=utf-8" },
  { path: "/terms/", file: "terms.html", type: "text/html; charset=utf-8" },
  { path: "/terms.html", file: "terms.html", type: "text/html; charset=utf-8" },
  { path: "/terms/index.html", file: "terms.html", type: "text/html; charset=utf-8" },
  { path: "/support", file: "support.html", type: "text/html; charset=utf-8" },
  { path: "/support/", file: "support.html", type: "text/html; charset=utf-8" },
  { path: "/support.html", file: "support.html", type: "text/html; charset=utf-8" },
  { path: "/support/index.html", file: "support.html", type: "text/html; charset=utf-8" },
  { path: "/styles.css", file: "styles.css", type: "text/css; charset=utf-8" },
  { path: "/script.js", file: "script.js", type: "application/javascript; charset=utf-8" }
];

const binaryFiles = [
  { path: "/assets/daisly-logo.png", file: "assets/daisly-logo.png", type: "image/png" },
  { path: "/assets/paywall-screen.png", file: "assets/paywall-screen.png", type: "image/png" }
];

const textAssets = {};
for (const asset of textFiles) {
  textAssets[asset.path] = {
    type: asset.type,
    body: await readFile(asset.file, "utf8")
  };
}

const binaryAssets = {};
for (const asset of binaryFiles) {
  binaryAssets[asset.path] = {
    type: asset.type,
    body: (await readFile(asset.file)).toString("base64")
  };
}

const seedDb = JSON.parse(await readFile(await firstExisting(["../data/daisly-db.json", "data/daisly-db.json"]), "utf8"));

const worker = `const TEXT_ASSETS = ${JSON.stringify(textAssets)};\n` +
  `const BINARY_ASSETS = ${JSON.stringify(binaryAssets)};\n` +
  `const SEED_DB = ${JSON.stringify(seedDb)};\n` +
  `
const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
};

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cleanPath(pathname) {
  if (pathname !== "/" && pathname.endsWith("/index.html")) return pathname.slice(0, -11) || "/";
  if (pathname !== "/" && pathname.endsWith(".html")) return pathname.slice(0, -5);
  if (pathname !== "/" && pathname.endsWith("/")) return pathname.slice(0, -1);
  return null;
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
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return prefix + "_" + Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const bytes = new TextEncoder().encode(String(salt || "") + ":" + String(password || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateEmailPassword(email, password) {
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw statusError("Enter a valid email", 400);
  if (String(password || "").length < 8) throw statusError("Password must be at least 8 characters", 400);
}

function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  const match = String(value).match(/^Bearer\\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function authContext(request, db) {
  const token = bearerToken(request);
  const session = token && db.sessions ? db.sessions[token] : null;
  const account = session ? db.accounts.find((item) => item.id === session.accountId) : null;
  if (!account) return { account: null, token: "" };
  return { account, token, state: normalizeUserState(db.users[account.id], db) };
}

function scopedState(db, auth) {
  return auth.account ? auth.state : db;
}

async function writeScopedDb(env, db, auth, state) {
  if (auth.account) db.users[auth.account.id] = normalizeUserState(state, db);
  await writeDb(env, db);
}

function authResponse(db, account, token, env) {
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
      googleCalendar: { enabled: false, connected: false, configured: googleOAuthConfigured(env), status: "needs_google_sign_in" },
      googleTasks: { enabled: false, connected: false, configured: googleOAuthConfigured(env), status: "needs_google_sign_in" },
      googleMeet: { enabled: false, connected: false, configured: googleOAuthConfigured(env), status: "needs_google_sign_in", source: "google_calendar" },
      icloud: { connected: Boolean(state.settings.icloud), status: "local_mock" }
    }
  };
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

function normalizeSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks
    .map((item) => ({ title: item.title || item.t || "", done: Boolean(item.done || item.d) }))
    .filter((item) => item.title);
}

function normalizeTask(input, id) {
  const title = String(input.title || "").trim();
  if (!title) throw statusError("Task title is required", 400);
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
    subtasks: normalizeSubtasks(input.subtasks || input.sub || []),
    groupTask: Boolean(input.groupTask),
    groupTaskId: input.groupTaskId || null
  };
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
  if ("groupTask" in input) task.groupTask = Boolean(input.groupTask);
  if ("groupTaskId" in input) task.groupTaskId = input.groupTaskId || null;
  return task;
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function corsHeaders(request, env) {
  const allowed = String(env.CORS_ORIGIN || "https://daisly.space,https://www.daisly.space,null")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin") || "";
  const allowOrigin = allowed.includes("*")
    ? "*"
    : origin && allowed.includes(origin)
      ? origin
      : origin === "null" && allowed.includes("null")
        ? "null"
        : allowed[0] || "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
  };
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function readJsonBody(request) {
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw statusError("Invalid JSON", 400);
  }
}

function supabaseConfig(env) {
  return {
    url: String(env.SUPABASE_URL || "").replace(/\\/+$/, ""),
    key: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || "",
    stateKey: env.DAISLY_STATE_KEY || "production"
  };
}

async function supabaseRequest(env, endpoint, options = {}) {
  const config = supabaseConfig(env);
  if (!config.url || !config.key) throw statusError("Supabase is not configured", 503);
  const response = await fetch(\`\${config.url}/rest/v1/\${endpoint}\`, {
    method: options.method || "GET",
    headers: {
      apikey: config.key,
      authorization: \`Bearer \${config.key}\`,
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body
  });
  const text = await response.text();
  if (!response.ok) {
    throw statusError(\`Supabase request failed (\${response.status})\`, response.status === 404 ? 503 : response.status);
  }
  return text ? JSON.parse(text) : null;
}

async function readDb(env) {
  const config = supabaseConfig(env);
  if (!config.url || !config.key) return readCacheDb(env);
  try {
    const rows = await supabaseRequest(env, \`daisly_app_state?key=eq.\${encodeURIComponent(config.stateKey)}&select=value\`);
    if (Array.isArray(rows) && rows[0]?.value) return normalizeDb(rows[0].value);
    const seed = normalizeDb(SEED_DB);
    await writeDb(env, seed);
    return seed;
  } catch {
    return readCacheDb(env);
  }
}

async function writeDb(env, db) {
  const config = supabaseConfig(env);
  if (!config.url || !config.key) {
    await writeCacheDb(env, db);
    return;
  }
  try {
    await supabaseRequest(env, "daisly_app_state?on_conflict=key", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: config.stateKey, value: normalizeDb(db) })
    });
  } catch {
    throw statusError("Persistent storage is unavailable. Run the Supabase schema and check service role credentials.", 503);
  }
}

async function readCacheDb(env) {
  return normalizeDb(SEED_DB);
}

async function writeCacheDb(env, db) {
  return;
}

function googleOAuthConfigured(env) {
  return Boolean(env.GOOGLE_WEB_CLIENT_ID && env.GOOGLE_WEB_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

function googleConnection(db, env) {
  const google = db?.integrations?.google || {};
  const connected = Boolean(google.refreshToken || google.accessToken || env.GOOGLE_REFRESH_TOKEN);
  const scopes = Array.isArray(google.scopes) ? google.scopes : [];
  const hasScope = (needle) => !scopes.length || scopes.some((scope) => String(scope).includes(needle));
  return {
    configured: googleOAuthConfigured(env),
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

function publicConfig(env) {
  const supabase = supabaseConfig(env);
  return {
    app: "Daisly",
    environment: env.NODE_ENV || "production",
    storageMode: supabase.url && supabase.key ? "supabase" : "seed",
    urls: {
      app: env.PUBLIC_APP_URL || "https://daisly.space",
      site: env.PUBLIC_SITE_URL || "https://daisly.space",
      api: env.PUBLIC_API_URL || "https://api.daisly.space",
      privacy: env.PRIVACY_POLICY_URL || "https://daisly.space/privacy",
      terms: env.TERMS_OF_SERVICE_URL || "https://daisly.space/terms"
    },
    supportEmail: env.SUPPORT_EMAIL || "support@daisly.space",
    payments: {
      entitlementId: env.REVENUECAT_ENTITLEMENT_ID || "Daisly Pro",
      monthlyProductId: env.PRODUCT_ID_MONTHLY || "daisly_pro_monthly",
      yearlyProductId: env.PRODUCT_ID_YEARLY || "daisly_pro_yearly"
    },
    google: {
      iosClientId: env.GOOGLE_IOS_CLIENT_ID || "",
      iosUrlScheme: env.GOOGLE_IOS_URL_SCHEME || "",
      redirectUri: env.GOOGLE_REDIRECT_URI || "https://api.daisly.space/auth/google/callback"
    },
    features: {
      googleOAuthConfigured: googleOAuthConfigured(env),
      supabaseConfigured: Boolean(supabase.url && supabase.key),
      revenueCatConfigured: Boolean(env.REVENUECAT_PUBLIC_SDK_KEY && env.REVENUECAT_SECRET_API_KEY),
      sentryConfigured: Boolean(env.SENTRY_DSN),
      postHogConfigured: Boolean(env.POSTHOG_API_KEY && env.POSTHOG_HOST)
    }
  };
}

async function handleApi(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    const supabase = supabaseConfig(env);
    return json({
      ok: true,
      app: "Daisly",
      storageMode: supabase.url && supabase.key ? "supabase" : "seed",
      time: new Date().toISOString()
    }, 200, request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/config") return json(publicConfig(env), 200, request, env);

  const db = await readDb(env);
  const auth = authContext(request, db);
  const appDb = scopedState(db, auth);
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];
  const id = parts[2];

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    return json({
      auth: {
        authenticated: Boolean(auth.account),
        user: publicAccount(auth.account)
      },
      profile: appDb.profile,
      settings: publicSettings(appDb.settings),
      tasks: appDb.tasks.map(publicTask),
      groups: appDb.groups,
      nextTaskId: appDb.nextTaskId
    }, 200, request, env);
  }

  if (resource === "profile" && request.method === "GET") return json(appDb.profile, 200, request, env);

  if (resource === "settings") {
    if (request.method === "GET") return json(publicSettings(appDb.settings), 200, request, env);
    if (request.method === "PATCH") {
      appDb.settings = publicSettings({ ...appDb.settings, ...(await readJsonBody(request)) });
      await writeScopedDb(env, db, auth, appDb);
      return json(publicSettings(appDb.settings), 200, request, env);
    }
  }

  if (resource === "onboarding" && request.method === "POST") {
    const body = await readJsonBody(request);
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
    await writeScopedDb(env, db, auth, appDb);
    return json({ profile: appDb.profile, settings: publicSettings(appDb.settings), tasks: appDb.tasks.map(publicTask) }, 200, request, env);
  }

  if (resource === "tasks") {
    if (request.method === "GET") {
      let tasks = appDb.tasks;
      if (url.searchParams.has("day")) {
        const day = url.searchParams.get("day");
        tasks = day === "inbox"
          ? tasks.filter((task) => task.day == null)
          : tasks.filter((task) => String(task.day) === day);
      }
      return json(tasks.map(publicTask), 200, request, env);
    }
    if (request.method === "POST") {
      const task = normalizeTask(await readJsonBody(request), appDb.nextTaskId);
      appDb.nextTaskId += 1;
      appDb.tasks.push(task);
      await writeScopedDb(env, db, auth, appDb);
      return json(publicTask(task), 201, request, env);
    }
    const task = appDb.tasks.find((item) => String(item.id) === id);
    if (!task) return json({ error: "Task not found" }, 404, request, env);
    if (request.method === "PATCH") {
      patchTask(task, await readJsonBody(request));
      await writeScopedDb(env, db, auth, appDb);
      return json(publicTask(task), 200, request, env);
    }
    if (request.method === "DELETE") {
      appDb.tasks = appDb.tasks.filter((item) => String(item.id) !== id);
      await writeScopedDb(env, db, auth, appDb);
      return json({ ok: true }, 200, request, env);
    }
  }

  if (resource === "groups") {
    if (request.method === "GET" && !id) return json(appDb.groups, 200, request, env);
    if (request.method === "POST" && !id) {
      const body = await readJsonBody(request);
      const group = {
        id: body.id || \`g-\${Date.now()}\`,
        name: body.name || "New group",
        identifier: body.identifier || "group",
        joinMode: body.joinMode || "approval",
        role: body.role || "admin",
        members: body.members || [],
        requests: body.requests || [],
        tasks: body.tasks || []
      };
      appDb.groups.push(group);
      await writeScopedDb(env, db, auth, appDb);
      return json(group, 201, request, env);
    }
    const group = appDb.groups.find((item) => item.id === id);
    if (!group) return json({ error: "Group not found" }, 404, request, env);

    const invitesIndex = parts.indexOf("invites");
    if (invitesIndex !== -1 && request.method === "POST") {
      const body = await readJsonBody(request);
      group.members = Array.isArray(group.members) ? group.members : [];
      group.members.push({ id: \`m-\${Date.now()}\`, tag: body.tag || body.email || "", status: "invited" });
      await writeScopedDb(env, db, auth, appDb);
      return json(group, 200, request, env);
    }

    const requestsIndex = parts.indexOf("requests");
    if (requestsIndex !== -1 && request.method === "POST") {
      const requestId = parts[requestsIndex + 1];
      const action = parts[requestsIndex + 2];
      group.requests = Array.isArray(group.requests) ? group.requests : [];
      group.members = Array.isArray(group.members) ? group.members : [];
      const joinRequest = group.requests.find((item) => String(item.id) === requestId);
      if (joinRequest && action === "accept") {
        group.members.push({ ...joinRequest, status: "member" });
        group.requests = group.requests.filter((item) => String(item.id) !== requestId);
      } else if (joinRequest && action === "decline") {
        group.requests = group.requests.filter((item) => String(item.id) !== requestId);
      }
      await writeScopedDb(env, db, auth, appDb);
      return json(group, 200, request, env);
    }

    const taskIndex = parts.indexOf("tasks");
    if (taskIndex !== -1) {
      group.tasks = Array.isArray(group.tasks) ? group.tasks : [];
      const groupTaskId = parts[taskIndex + 1];
      const action = parts[taskIndex + 2];
      if (request.method === "POST" && !groupTaskId) {
        const body = await readJsonBody(request);
        const groupTask = { id: body.id || \`gt-\${Date.now()}\`, status: body.status || "invited", ...body };
        group.tasks.push(groupTask);
        await writeScopedDb(env, db, auth, appDb);
        return json(groupTask, 201, request, env);
      }
      const groupTask = group.tasks.find((item) => String(item.id) === groupTaskId);
      if (!groupTask) return json({ error: "Group task not found" }, 404, request, env);
      if (request.method === "PATCH" && !action) {
        Object.assign(groupTask, await readJsonBody(request));
        await writeScopedDb(env, db, auth, appDb);
        return json(groupTask, 200, request, env);
      }
      if (request.method === "POST" && ["accept", "decline", "reinvite"].includes(action)) {
        groupTask.status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "invited";
        if (action === "accept" && !appDb.tasks.some((task) => task.groupTaskId === groupTask.id)) {
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
        await writeScopedDb(env, db, auth, appDb);
        return json({ groupTask, tasks: appDb.tasks.map(publicTask) }, 200, request, env);
      }
    }
  }

  if (resource === "integrations") {
    const google = auth.account && auth.account.provider === "email"
      ? { configured: googleOAuthConfigured(env), connected: false, calendarScope: false, tasksScope: false }
      : googleConnection(appDb, env);
    if (request.method === "GET") {
      const calendarStatus = auth.account && auth.account.provider === "email"
        ? "needs_google_sign_in"
        : integrationStatus(appDb.settings.googleCalendar, google.configured, google.connected, google.calendarScope);
      const tasksStatus = auth.account && auth.account.provider === "email"
        ? "needs_google_sign_in"
        : integrationStatus(appDb.settings.googleTasks, google.configured, google.connected, google.tasksScope);
      return json({
        googleCalendar: { enabled: Boolean(appDb.settings.googleCalendar), connected: calendarStatus === "connected", configured: google.configured, status: calendarStatus },
        googleTasks: { enabled: Boolean(appDb.settings.googleTasks), connected: tasksStatus === "connected", configured: google.configured, status: tasksStatus },
        googleMeet: { enabled: Boolean(appDb.settings.googleCalendar), connected: calendarStatus === "connected", configured: google.configured, status: calendarStatus, source: "google_calendar" },
        icloud: { connected: Boolean(appDb.settings.icloud), status: "local_mock" }
      }, 200, request, env);
    }
    if (request.method === "POST") {
      return json({
        ok: false,
        status: auth.account && auth.account.provider === "email"
          ? "needs_google_sign_in"
          : google.configured ? "needs_user_consent" : "missing_oauth_credentials",
        note: auth.account && auth.account.provider === "email"
          ? "Email accounts can use Daisly sync, but Google Calendar and Tasks require connecting a Google account."
          : google.configured
            ? "Google OAuth credentials are configured, but the user consent flow is not completed yet."
            : "Google OAuth credentials are required before Calendar, Meet, or Tasks can sync."
      }, 200, request, env);
    }
  }

  if (resource === "export" && request.method === "GET") return json(db, 200, request, env);

  return json({ error: "Not found" }, 404, request, env);
}

async function handleAuth(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  const url = new URL(request.url);

  if (url.pathname === "/auth/session" && request.method === "GET") {
    const db = await readDb(env);
    const auth = authContext(request, db);
    if (!auth.account) return json({ ok: false, error: "Not signed in" }, 401, request, env);
    return json(authResponse(db, auth.account, auth.token, env), 200, request, env);
  }

  if ((url.pathname === "/auth/email/signup" || url.pathname === "/auth/email/login") && request.method === "POST") {
    const db = await readDb(env);
    const body = await readJsonBody(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    validateEmailPassword(email, password);
    const existing = db.accounts.find((account) => account.email === email && account.provider === "email");
    let account = existing;

    if (url.pathname.endsWith("/signup")) {
      if (existing) return json({ ok: false, error: "An account with this email already exists" }, 409, request, env);
      const username = defaultUsernameFromEmail(email);
      const salt = randomId("salt");
      account = {
        id: randomId("acct"),
        email,
        provider: "email",
        passwordSalt: salt,
        passwordHash: await hashPassword(password, salt),
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
      if (!account || account.passwordHash !== await hashPassword(password, account.passwordSalt || "")) {
        return json({ ok: false, error: "Email or password is incorrect" }, 401, request, env);
      }
    }

    const token = randomId("sess");
    db.sessions[token] = { accountId: account.id, createdAt: new Date().toISOString() };
    await writeDb(env, db);
    return json(authResponse(db, account, token, env), 200, request, env);
  }

  if (url.pathname === "/auth/email/logout" && request.method === "POST") {
    const db = await readDb(env);
    const token = bearerToken(request);
    if (token && db.sessions[token]) {
      delete db.sessions[token];
      await writeDb(env, db);
    }
    return json({ ok: true }, 200, request, env);
  }

  if (url.pathname === "/auth/google/callback") {
    return json({
      error: "Google OAuth callback is reserved but not implemented yet",
      configured: googleOAuthConfigured(env)
    }, 501, request, env);
  }
  return json({ error: "Auth route not found" }, 404, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env || {});
      } catch (error) {
        return json({ error: error.message || "Server error" }, error.status || 500, request, env || {});
      }
    }
    if (url.pathname.startsWith("/auth/")) {
      try {
        return await handleAuth(request, env || {});
      } catch (error) {
        return json({ error: error.message || "Server error" }, error.status || 500, request, env || {});
      }
    }

    const redirected = cleanPath(url.pathname);
    if (redirected && redirected !== url.pathname) {
      url.pathname = redirected;
      return Response.redirect(url.toString(), 308);
    }

    const textAsset = TEXT_ASSETS[url.pathname];
    if (textAsset) {
      return new Response(textAsset.body, {
        headers: { ...HEADERS, "content-type": textAsset.type, "cache-control": "public, max-age=300" }
      });
    }

    const binaryAsset = BINARY_ASSETS[url.pathname];
    if (binaryAsset) {
      return new Response(decodeBase64(binaryAsset.body), {
        headers: { ...HEADERS, "content-type": binaryAsset.type, "cache-control": "public, max-age=31536000, immutable" }
      });
    }

    return new Response(TEXT_ASSETS["/"].body, {
      status: 404,
      headers: { ...HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" }
    });
  }
};
`;

await writeFile("dist/server/index.js", worker);
