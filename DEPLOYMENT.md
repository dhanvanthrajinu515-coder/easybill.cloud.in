# EasyBill — Cloudflare Workers + D1, Vercel frontend

This version keeps the existing website in `public/` and uses a Cloudflare Worker for the API, Cloudflare D1 for shop/product/bill data, and Vercel as the public website/proxy. It does not use Turso or R2.

## 1. Create / confirm the Cloudflare D1 database

1. In Cloudflare Dashboard, open **Workers & Pages → D1 SQL database** and select `easybill-db`.
2. Copy the database ID.
3. Open `wrangler.jsonc` and replace `PASTE_YOUR_D1_DATABASE_ID_HERE` with the real ID. Do not paste the ID into chat.
4. Run the schema once from this project folder:

   ```bash
   npm install
   npx wrangler d1 execute easybill-db --remote --file=backend/schema.sql
   ```

   This initializes the empty D1 database. Do not rerun destructive SQL or point this at another production database without checking it first.

## 2. Configure Worker secrets and deploy

In the project folder:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put SETUP_SECRET
npx wrangler deploy
```

For each prompt, enter a long random value (at least 32 characters for `JWT_SECRET`; use a separate value for `SETUP_SECRET`). Keep these values private. They belong in Cloudflare Worker secrets, not in frontend JavaScript or GitHub.

In Cloudflare, confirm the Worker has the D1 binding named exactly `DB` connected to `easybill-db`. The `wrangler.jsonc` file defines this binding, but the database ID must be correct first.

The configured public API hostname in `vercel.json` is `easybill-api.dhanvanthrajinu515.workers.dev`. If Cloudflare assigned a different Worker hostname in your account, change the destination URL to the exact hostname shown by Cloudflare before deploying the frontend.

## 3. Create the first admin (one time)

After the schema and Worker are deployed, run this PowerShell command from your computer, replacing the placeholders with your actual Worker URL, setup secret, admin username and strong password. Do not send these values to anyone.

```powershell
$body = @{ username = "admin"; password = "REPLACE_WITH_A_STRONG_PASSWORD_12_CHARACTERS_OR_LONGER" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://YOUR-WORKER-HOST/api/setup/admin" -Headers @{ "X-Setup-Secret" = "YOUR_SETUP_SECRET" } -ContentType "application/json" -Body $body
```

The endpoint only works when `SETUP_SECRET` matches and no administrator exists yet. After it succeeds, rotate or remove `SETUP_SECRET` in Cloudflare Worker settings. The created admin can sign in at `/admin.html` on the public website.

## 4. Connect Vercel

1. Commit and push this project to your existing GitHub repository.
2. Deploy the repository in Vercel using the existing project and root directory `.`.
3. The `vercel.json` rewrite forwards `/api/*` to the Cloudflare Worker while the frontend remains on the same origin, so the HttpOnly session cookie can be used by both customer and admin pages.
4. Confirm `https://YOUR-VERCEL-DOMAIN/api/health` returns `ok: true`.

## Included changes

- Cloudflare Worker API using D1 instead of Turso.
- Shop-scoped queries for products, bills and customer-account records; customer account suspension preserves stored data.
- Admin shop list returns `bill_count`, and the admin table displays it.
- PDF download endpoint returns an attachment; PDF columns use fixed width proportions and right-aligned numeric columns to keep amounts inside the page/table width. It accepts the saved print format and a supported PNG/JPEG bill-template image.
- Empty billing rows show `–` for quantity until a product is selected; selected products start at quantity 1.

## Important verification before real use

This package is a migration build and still needs a deployment smoke test in your Cloudflare/Vercel accounts. After deployment, test: admin login, create a test shop, customer login, product CRUD, bill creation and stock deduction, bill history, direct PDF download (including the chosen print size/template), bill counts in admin, disable/reactivate, and attempts to access another shop's IDs. Do not use it for live billing until these tests pass.
