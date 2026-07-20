#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const loadedFiles = [];

for (const file of [".env", "daisly-credentials.local.env"]) {
  const filePath = path.join(ROOT, file);
  if (!existsSync(filePath)) continue;
  Object.assign(env, parseEnv(readFileSync(filePath, "utf8")));
  loadedFiles.push(file);
}

const required = [
  "SUPABASE_URL",
  ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
  ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"],
  "GOOGLE_IOS_CLIENT_ID",
  "GOOGLE_IOS_URL_SCHEME",
  "GOOGLE_WEB_CLIENT_ID",
  "GOOGLE_WEB_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "APPLE_TEAM_ID",
  "APPLE_BUNDLE_ID",
  "APPLE_SERVICES_ID",
  "APPLE_SIGNIN_KEY_ID",
  ["APPLE_SIGNIN_PRIVATE_KEY", "APPLE_SIGNIN_PRIVATE_KEY_PATH"],
  "APPLE_APNS_KEY_ID",
  ["APPLE_APNS_PRIVATE_KEY", "APPLE_APNS_PRIVATE_KEY_PATH"],
  "APP_STORE_CONNECT_ISSUER_ID",
  "APP_STORE_CONNECT_KEY_ID",
  ["APP_STORE_CONNECT_PRIVATE_KEY", "APP_STORE_CONNECT_PRIVATE_KEY_PATH"],
  "APPLE_APP_ID",
  "REVENUECAT_PUBLIC_SDK_KEY",
  "REVENUECAT_SECRET_API_KEY",
  "REVENUECAT_ENTITLEMENT_ID",
  "PRODUCT_ID_MONTHLY",
  "PRODUCT_ID_YEARLY",
  "PRIVACY_POLICY_URL",
  "TERMS_OF_SERVICE_URL",
  "SUPPORT_EMAIL"
];

const optional = [
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "POSTHOG_API_KEY",
  "POSTHOG_HOST"
];

const missing = required.filter((item) => !hasAny(item)).map(labelFor);
const optionalMissing = optional.filter((key) => !has(key));
const warnings = [];

for (const key of [
  "APPLE_SIGNIN_PRIVATE_KEY_PATH",
  "APPLE_APNS_PRIVATE_KEY_PATH",
  "APP_STORE_CONNECT_PRIVATE_KEY_PATH"
]) {
  if (has(key) && !existsSync(env[key])) {
    warnings.push(`${key} points to a file that does not exist`);
  }
}

if (has("PRIVACY_POLICY_URL") && env.PRIVACY_POLICY_URL.endsWith(".html")) {
  warnings.push("PRIVACY_POLICY_URL still uses .html; use the clean /privacy URL for App Store metadata");
}

if (has("TERMS_OF_SERVICE_URL") && env.TERMS_OF_SERVICE_URL.endsWith(".html")) {
  warnings.push("TERMS_OF_SERVICE_URL still uses .html; use the clean /terms URL for App Store metadata");
}

const plistPath = path.join(ROOT, "ios/Daisly/Daisly/Info.plist");
if (existsSync(plistPath)) {
  const plist = readFileSync(plistPath, "utf8");
  if (/DaislyWebAppURL[\s\S]*?(127\.0\.0\.1|localhost|192\.168\.)/.test(plist)) {
    warnings.push("iOS DaislyWebAppURL still points to a local development address");
  }
  if (/NSAllowsArbitraryLoads[\s\S]*?<true\/>/.test(plist)) {
    warnings.push("iOS Info.plist still allows arbitrary network loads; remove this for App Store release");
  }
}

for (const file of [
  "landing/index.html",
  "landing/privacy.html",
  "landing/terms.html",
  "landing/support.html",
  "supabase/schema.sql",
  ".env.example"
]) {
  if (!existsSync(path.join(ROOT, file))) {
    warnings.push(`Missing deploy file: ${file}`);
  }
}

printReport();

process.exitCode = missing.length ? 1 : 0;

function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function has(key) {
  return Boolean(env[key] && String(env[key]).trim() && !isPlaceholder(env[key]));
}

function hasAny(item) {
  return Array.isArray(item) ? item.some((key) => has(key)) : has(item);
}

function labelFor(item) {
  return Array.isArray(item) ? item.join(" or ") : item;
}

function isPlaceholder(value) {
  return /YOUR_|REPLACE|TODO|\[.+\]|example/i.test(String(value));
}

function printReport() {
  console.log("Daisly deploy check");
  console.log(`Loaded env files: ${loadedFiles.length ? loadedFiles.join(", ") : "none"}`);
  console.log("");

  if (missing.length) {
    console.log("Missing required:");
    for (const key of missing) console.log(`- ${key}`);
  } else {
    console.log("Required credentials: OK");
  }

  console.log("");
  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  } else {
    console.log("Warnings: none");
  }

  console.log("");
  if (optionalMissing.length) {
    console.log("Optional not configured:");
    for (const key of optionalMissing) console.log(`- ${key}`);
  } else {
    console.log("Optional analytics/errors: OK");
  }
}
