# VacuKart — Portable 3-in-1 Vacuum Cleaner

COD landing page + admin dashboard, cloned from the Vaidyakart template and rebranded/re-themed for a portable 3-in-1 vacuum cleaner (home + car + crevice).

## Stack
- Backend: Node.js/Express + Mongoose (MongoDB) — `server.js`
- Frontend: static HTML/CSS/JS — `index.html`
- Admin panel: static HTML/CSS/JS — `admin/index.html`
- Pincode lookup: local DB (`pc.json`, `pincode_data.json`, `pincode_db.json`) + live API fallback
- Shipping: Selloship integration (connect via admin → Settings)

## Files
```
index.html          customer-facing landing page
admin/index.html     admin dashboard (orders, products, testimonials, settings, shipping)
server.js            Express API + MongoDB models
package.json, Procfile, render.yaml   deploy config (Render)
pc.json, pincode_data.json, pincode_db.json   pincode → city/state data
.env.example         required environment variables
```

## Deploy (Render)
1. Push this folder to a GitHub repo.
2. In Render: New → Web Service → connect the repo. `render.yaml` auto-fills build/start commands.
3. Set these env vars in the Render dashboard (Settings → Environment), NOT in the repo:
   - `MONGODB_URI` — see `.env.example` for the corrected connection string (the `@` in your password had to be URL-encoded to `%40`)
   - `ADMIN_USER` / `ADMIN_PASS` — pick your own admin login
   - `PORT` — `5000` (already in render.yaml)
   - `BACKEND_URL` — fill in after first deploy, once you have your Render URL
4. Deploy. Render gives you a live URL like `https://vacukart.onrender.com`.
5. **Replace the placeholder** `https://hrkmart.onrender.com` with that real URL in:
   - `index.html` → `const API_BASE = ...` (near top of the `<script>` block)
   - `admin/index.html` → the backend URL field on first login (saved to browser storage, or edit the default in the JS)
6. Re-deploy / re-upload frontend files (or just host `index.html` + `admin/` as static files anywhere — Netlify, Vercel, S3, or Render's own static hosting — pointing at the backend URL from step 4).
7. First time only: hit `POST /api/seed` on your live backend once to create the default product (VacuKart 3-in-1 Vacuum Cleaner, ₹799). You can also add/edit products directly from the admin panel → Products.
8. Log into `/admin` with `ADMIN_USER`/`ADMIN_PASS`, connect Selloship under Settings if you want automated shipping.

## What changed vs. the original Vaidyakart site
- Full rebrand: copy, hero, benefits, features/specs grid (was "ingredients"), FAQ, testimonials, footer, modal — all rewritten for a vacuum cleaner instead of an Ayurvedic sugar powder.
- Color palette: green/gold Ayurvedic theme → blue/cyan/orange tech-gadget theme (CSS variables + all hardcoded hex/rgba swept and swapped).
- Font: Cormorant Garamond (serif) → Space Grotesk (geometric sans) for headings.
- Fixed a pricing bug from the original: the "3-pack" quantity option ignored quantity and always charged the base single-unit price. Bundle pricing is now explicit (1 unit ₹799 / 2 units ₹1,499 / 3 units ₹1,999).
- Backend: brand strings, seed product data, and default API URLs updated. All order/product/testimonial/shipping/pincode logic is unchanged — it's product-agnostic.
