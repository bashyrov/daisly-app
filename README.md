# Daisly

Local full-stack prototype for the Daisly day planner.

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:4173/
```

The app serves the Daisly design prototype and a local JSON API from the same server.

## Files

- `index.html` — Daisly frontend prototype and UI logic.
- `support.js`, `ios-frame.jsx`, `uploads/` — Daisly runtime/assets copied from the design folder.
- `server.js` — local backend API and static file server.
- `data/daisly-db.json` — persistent local data store.
- `legacy-daisly-assets/` — previous Structure/Mealgram-style prototype backup.

## API

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/profile`
- `POST /api/onboarding`
- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/tasks`
- `GET /api/tasks?day=0`
- `GET /api/tasks?day=inbox`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `GET /api/groups`
- `PATCH /api/groups/:groupId/tasks/:taskId`
- `POST /api/groups/:groupId/tasks/:taskId/accept`
- `POST /api/groups/:groupId/tasks/:taskId/decline`
- `POST /api/groups/:groupId/tasks/:taskId/reinvite`
- `GET /api/integrations`
- `POST /api/integrations`
- `GET /api/export`

## Current Scope

This is a turnkey prototype: frontend, backend routes, persistence, and design are wired together. Local mode stores data in `data/daisly-db.json`; deployed mode can use Supabase by setting `STORAGE_MODE=supabase` and applying `supabase/schema.sql`.

## Deployment

- Safe env template: `.env.example`
- Supabase schema: `supabase/schema.sql`
- Deployment notes: `deploy/DEPLOYMENT.md`
- Preflight check: `npm run deploy:check`
