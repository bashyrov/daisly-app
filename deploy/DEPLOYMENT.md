# Daisly Deployment

This project is currently a production-ready prototype path:

- `server.js` serves the app API.
- `landing/` contains the public marketing/legal site.
- `ios/Daisly/` is the native iPhone WebView shell and bundles the web app during Xcode builds.

## 1. Supabase

Run `supabase/schema.sql` in Supabase SQL Editor.

For the current prototype backend, set:

```env
STORAGE_MODE=supabase
DAISLY_STATE_KEY=production
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

The backend will keep the same API shape but store the app state in Supabase instead of `data/daisly-db.json`.

## 2. Backend Hosting

Deploy the root project as a Node web service.

Useful files:

- `.env.example` - safe env template.
- `render.yaml` - Render blueprint starter.
- `Dockerfile` - generic container deployment.

Health check:

```text
GET /api/health
```

Expected production URL:

```text
https://api.daisly.space
```

Set `CORS_ORIGIN` to:

```env
https://daisly.space,https://www.daisly.space,null
```

The `null` origin is needed for the bundled iPhone WebView when it loads local `file://` app files and calls the production API.

## 3. Landing / Legal Site

Deploy the `landing/` folder as the public website:

```text
https://daisly.space
https://daisly.space/privacy
https://daisly.space/terms
https://daisly.space/support
```

For local clean URLs:

```bash
python3 clean_server.py
```

## 4. iOS Before TestFlight

The app loads bundled `web/index.html` first. `DaislyWebAppURL` in `ios/Daisly/Daisly/Info.plist` is only a production HTTPS fallback.

For App Store release:

- Remove `NSAllowsArbitraryLoads`.
- Keep only HTTPS production URLs.
- Confirm bundle id is `com.daisly.app`.
- Confirm Team ID is the Daisly team.
- Archive from Xcode and upload to App Store Connect.

## 5. Preflight Check

Run:

```bash
npm run deploy:check
```

The check prints missing key names and warnings only. It does not print secret values.
