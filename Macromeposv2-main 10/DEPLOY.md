# Macrome Electronics POS — deploying

Folders: `css/`, `js/` (app code), `icons/`, `screenshots/` (install prompt), `tools/`, `vendor/` (made by tools/vendor.py), `firebase/` (cloud setup guide + security rules).

## Every time you change anything
1. Edit the files (usually `js/app.js`, `css/app.css` or `index.html`).
2. Run `python3 tools/stamp.py`  (needs only Python 3). It prints a new version when something changed.
3. Upload the whole folder. Tills update themselves and show the "update available" banner.

Never edit `VERSION` in `sw.js` or the `?v=` links in `index.html` by hand; the stamp tool owns them.

## One-time: make libraries and fonts work offline from the first launch
On a computer with internet: `python3 tools/vendor.py` (also fetches the Firebase libraries), then `python3 tools/stamp.py`, then upload including `vendor/`.
Until you do this, Macrome falls back to the CDN copies (cached after first use).

## Multi-shop (Shops A–C)
One install holds all three shops. Products and prices are shared; stock, sales and expenses are kept per shop.
Rename the shops in Settings → Shops. Owners/all-shop managers switch shops from the top bar; cashiers and shop managers
are locked to the shop set on their staff account. Old single-shop backups restore into Shop A.

## Cloud mode (Firebase) — optional
Leave `js/firebase-config.js` empty and everything above works as before (one device, nothing in the cloud).
To share sign-in, roles and shops across phones, follow `firebase/SETUP.md` (create the project, paste the config into
`js/firebase-config.js`, publish `firebase/firestore.rules`, run vendor.py + stamp.py, upload). In cloud mode the old on-device
accounts are not used; the first launch asks you to create the owner account.


## Phase 2 update
Republish `firebase/firestore.rules` in the Firebase console (keep your own setup code), run `python3 tools/stamp.py`, upload the whole folder.

## Phase 3 update
Republish `firebase/firestore.rules` (keep your setup code), run `python3 tools/stamp.py`, upload the whole folder.

## Phase 4 update
Republish `firebase/firestore.rules` (keep your setup code), run `python3 tools/stamp.py`, upload the whole folder.
