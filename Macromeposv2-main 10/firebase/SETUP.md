# Macrome cloud mode — Firebase setup (Phase 1)

Do this once. The free Firebase plan (Spark) is enough; no Cloud Functions are used.
If `js/firebase-config.js` is left empty, Macrome keeps working exactly as before (single device, nothing in the cloud).

## 1. Create the Firebase project
1. https://console.firebase.google.com → **Add project** (e.g. `macrome-pos`). Google Analytics can stay off.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable** (leave "Email link" off).
3. **Build → Firestore Database → Create database → Production mode.** Pick the region closest to you
   (`africa-south1` Johannesburg if offered, otherwise `europe-west1`). The region cannot be changed later.
4. **Project settings (gear) → General → Your apps → Web (`</>`)** → register an app named "Macrome POS".
   Copy the `firebaseConfig` values into `js/firebase-config.js` (apiKey, authDomain, projectId, storageBucket,
   messagingSenderId, appId). These are not secrets.

## 2. Security rules
1. Open `firebase/firestore.rules` and copy it.
2. **Firestore Database → Rules** → paste → find `function setupCode()` and change `CHANGE-THIS-SETUP-CODE` to a code of your
   own (letters/digits/dashes, no slashes). Do this in the console, not in the file you upload.
3. **Publish.** Remember the code: you type it once on first launch.
4. Optional but recommended: **Google Cloud console → APIs & Services → Credentials →** your browser API key →
   *Application restrictions → Websites* → add the address you host Macrome on.

## 3. Libraries and upload
```
python3 tools/vendor.py      # on a computer with internet: also downloads the Firebase libraries into vendor/
python3 tools/stamp.py
```
Upload the whole folder (including `vendor/`) as usual. Tills will show "update available".

## 4. First launch
Open Macrome on the owner's phone/computer **with internet**. It shows *Set up Macrome Electronics*: enter your name, a username,
a password and the setup code. You are now the Super Admin. Add managers and attendants in **Settings → Staff Accounts**
(pick the role and the shop). Attendants and shop managers are locked to their shop by the server rules, not just by the screen.

## Good to know
* **Offline sign-in.** Each person must sign in once **online** on a phone. After that, that same person can sign in offline on that
  phone. Someone else on the same phone needs internet for their first sign-in there.
* **Passwords.** Everyone changes their own in Settings → Change My Password. Resetting *someone else's* password needs a server
  function (paid plan) or the owner re-creating the account; it is planned for Phase 4. Until then use **Switch off** on a lost phone/leaver.
* **Switching off** an account (instead of deleting) blocks all access immediately; the username stays reserved.
* **Existing data.** Sales, stock and expenses are still stored on each device in Phase 1. Do not clear browser data on the
  old till; Phase 5 uploads it into Shop A.
* **Spam sign-ups.** Anyone who has your public API key can create a bare Firebase login, but without a staff record the rules give it
  no access to anything. Restricting the API key to your website (step 2.4) limits this further.
* The rules were written but not run against the Firebase emulator in this phase. Use **Rules → Rules Playground** in the console
  for a quick check, and re-test after each phase.

## Phase 2 — shared products and stock
* **Republish the rules** (Firestore → Rules). Paste the new `firebase/firestore.rules`, put YOUR setup code back into `setupCode()`, Publish.
* **Catalog** is shared by all shops. Only all-shops managers (owner / manager with no shop) can add, edit, delete, import CSV or transfer.
  Shop managers can receive stock into their own shop. Attendants only sell.
* **Loading your products:** use Inventory → Import CSV, with the shop selector set to ONE shop (stock goes to that shop; prices apply to all).
  Old products saved on a till are kept aside for the Phase 5 migration; they are not shown in cloud mode.
* **Sales and expenses are still stored per device** until Phase 3/4. Selling already reduces the shared stock, live on every phone.
* Offline: sales, receiving and edits are queued on the phone and sync when internet returns.

## Phase 3 — selling and receipts
* **Republish the rules again** (new: `sales`, `counters`, `costs`). Keep your own setup code in `setupCode()`.
* **Receipt numbers** look like `B-GRC-0001`: shop letter, the attendant's 3-letter code, a running number. Each attendant has their own series.
  If two phones of the same person ever use the same number, the server refuses the second and files it as `...-2`; nothing is lost.
* **Every sale is saved in one all-or-nothing write** together with the stock taken out, online or offline.
* **Who sees what:** attendants load today's sales of their shop and their own history shows only their own sales. Shop managers see their shop's
  sales for this and last month. All-shops managers see all shops for this and last month (older months arrive with the Phase 4 reports).
* **Cost prices** moved to a managers-only record. Attendants' phones no longer receive them. Existing products are tidied automatically
  the first time an all-shops manager signs in. Profit for cloud sales uses the product's *current* cost price.
* Sales and receipts are permanent records: "Clear sales" is disabled in cloud mode. Expenses are still per device until Phase 4.

## Phase 4 — manager tools
* **Republish the rules again** (new: shared `expenses`, a `month` field on stock receipts).
* **Reports for any period.** The dashboard loads this and last month. When a manager picks a longer period (this year, a custom range, All time),
  the extra months are fetched once and then stay live. Up to 24 months back. A year of busy sales is many records, which count towards Firebase's
  free daily reads (50,000), so open "This year" reports on purpose, not all day.
* **Expenses are shared.** Shop managers add and see only their own shop's. Shared head-office costs (shop = "Shared") are for all-shops managers.
  Works offline and syncs later.
* **Stock received this month** is listed under Inventory for managers (shop managers see their own shop).
* **Passwords of other people** still cannot be reset from the app: that needs Firebase's paid plan plus a server function. If someone forgets theirs,
  Switch them off and create a new account for them with a new username.
* **Shop-manager transfers.** Only all-shops managers can transfer stock between shops. Shop managers can receive stock into their own shop.
