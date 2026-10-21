# EasyBill — Cloudflare edition

EasyBill is a shop billing website with a Vercel-hosted frontend, Cloudflare Workers API, and Cloudflare D1 database. Turso is not used in this edition.

- Frontend: `public/index.html` and `public/admin.html`
- API: `worker.js`
- D1 schema: `backend/schema.sql`
- Worker configuration: `wrangler.jsonc`

Follow `DEPLOYMENT.md` carefully. The D1 database ID and Worker secrets must be configured in your own Cloudflare account before deployment. Never commit secrets or put them in frontend code.

The migration build includes per-shop query scoping, password hashing, account disable/reactivate behavior, bill count in the admin shop list, and a PDF endpoint designed to download the PDF directly with aligned columns. It has not been deployed to your Cloudflare account from this package; complete the smoke tests in `DEPLOYMENT.md` before live use.
