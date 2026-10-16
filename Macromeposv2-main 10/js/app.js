// Cloud mode (Firebase) is on when js/firebase-config.js holds a config; js/cloud.js defines window.Cloud.
const CL=window.Cloud||{on:false,broken:false};
// Cloud mode keeps the products/stock in Firebase. Anything found in this device's old saved data is held here
// untouched (and written back with every save) so Phase 5 can upload it; it is never shown as live stock.
const CLOUD_LEGACY={prods:[],transfers:[],sales:[],expenses:[]};
let CAT={}, STK={}, COSTS={}, SALE_SRC={}, EXP_SRC={}, RECEIPTS=[], SALES_DAY='', CLOUD_READY={p:false,s:false}, _scrubbed={};   // cloud: product docs by id, stock qty by '<shop>_<id>'

// ── STOCK LIST ───────────────────────────────────────────
// Fields: id, n=name, s=SKU, c=category, e=emoji, r=retail price (KES), w=cost price (KES), q=quantity in stock
// This list is populated from the Macrome Electronics stock-taking sheet.
const PRODS=[
];
const EXPENSES=[]; // {id,date:'YYYY-MM-DD',cat,desc,amt,by,shop}  shop = 'A'..'C', or '' for shared / head-office costs

// ── MULTI-SHOP ───────────────────────────────────────────
// One product list shared by every shop; stock is kept per shop (p.qs = {A,B,C,D}).
// SCOPE is the shop being worked in ('A'..'C') or 'ALL' (managers only: all shops combined, read-only for stock).
// p.q always means "stock in the current scope", so the rest of the app reads p.q exactly as before.
const SHOP_IDS=['A','B','C'];
const SHOPS=SHOP_IDS.map(id=>({id,name:'Shop '+id,loc:''}));
const TRANSFERS=[]; // {id,date,pid,n,from,to,qty,by}
let SCOPE='A', LAST_SHOP='A';
function shopName(id){const s=SHOPS.find(x=>x.id===id);return s?s.name:(id||'Shared');}
function scopeLabel(){return SCOPE==='ALL'?'All shops':shopName(SCOPE);}
function mkProd(o){
  const qs={};
  SHOP_IDS.forEach(i=>{qs[i]=Math.max(0,Math.floor(Number(o.qs&&o.qs[i]))||0);});
  if(!o.qs&&o.q!=null)qs.A=Math.max(0,Math.floor(Number(o.q))||0);   // old single-shop data = Shop A
  const p={id:o.id,n:o.n,s:o.s,c:o.c,e:o.e,r:o.r,w:o.w};
  Object.defineProperty(p,'qs',{value:qs,enumerable:false,writable:true});
  Object.defineProperty(p,'q',{enumerable:true,configurable:true,
    get(){return SCOPE==='ALL'?SHOP_IDS.reduce((t,i)=>t+qs[i],0):qs[SCOPE];},
    set(v){if(SCOPE!=='ALL')qs[SCOPE]=Math.max(0,Math.floor(Number(v))||0);}});
  return p;
}
function prodPlain(p){return {id:p.id,n:p.n,s:p.s,c:p.c,r:p.r,w:p.w,qs:Object.assign({},p.qs)};}
const saleShop=s=>(s&&s.shop)||'A';
function scopedSales(){return SCOPE==='ALL'?cashierSales:cashierSales.filter(s=>saleShop(s)===SCOPE);}
function scopedExpenses(){return SCOPE==='ALL'?EXPENSES:EXPENSES.filter(e=>(e.shop===undefined?'A':e.shop)===SCOPE);}
// Which shops can the signed-in person work in?  Cashiers and shop-managers: only their own.  Owners / all-shop managers: any, or ALL.
function userShop(u){u=u||currentUser;if(!u)return '';if(u.role==='super')return '';if(u.role==='cashier')return SHOP_IDS.includes(u.shop)?u.shop:'A';return SHOP_IDS.includes(u.shop)?u.shop:'';}
function scopeLocked(){return !!userShop();}
function needShop(){if(SCOPE!=='ALL')return true;showToast('Pick a single shop first (top bar)','error');return false;}
function setScope(s){
  if(s!=='ALL'&&!SHOP_IDS.includes(s))return;
  const lock=userShop();if(lock)s=lock;
  if(s==='ALL'&&!isMgr())s=LAST_SHOP;
  if(s===SCOPE){renderShopCtl();return;}
  SCOPE=s;if(s!=='ALL')LAST_SHOP=s;
  cart=[];try{renderCart();resetPayExtra();}catch(_){}
  renderShopCtl();
  try{setDate();refreshStockViews();initDash();initRep();renderShopCompare();
    const cur=document.querySelector('.page.show,.page-wrap.show');
    if(cur){const id=cur.id;if(id==='profit')renderProfit();else if(id==='reports')renderBestSellers();else if(id==='tot-report')renderTOTReport();else if(id==='expenses')renderExpenses();else if(id==='cashier-history')renderCashierHistory();}
  }catch(e){console.error(e);}
}
function renderShopCtl(){
  const box=document.getElementById('shop-ctl');if(!box)return;
  const sub=document.getElementById('tb-sub');if(sub)sub.textContent=currentUser?scopeLabel():'';
  if(!currentUser){box.innerHTML='';return;}
  if(scopeLocked()){box.innerHTML='<div class="shop-badge" title="Your shop">'+MI('storefront','mi-inline')+' <span>'+pfEsc(shopName(SCOPE))+'</span></div>';return;}
  const opts=SHOPS.map(s=>`<option value="${s.id}"${SCOPE===s.id?' selected':''}>${pfEsc(s.name)}</option>`).join('')+`<option value="ALL"${SCOPE==='ALL'?' selected':''}>All shops</option>`;
  box.innerHTML='<label class="shop-sel">'+MI('storefront','mi-inline')+'<select aria-label="Switch shop" onchange="setScope(this.value)">'+opts+'</select></label>';
}
// Dashboard: every shop side by side (managers who can see all shops)
function renderShopCompare(){
  const card=document.getElementById('dash-shops-card'),box=document.getElementById('dash-shops');if(!card||!box)return;
  if(!currentUser||scopeLocked()){card.style.display='none';return;}
  card.style.display='';
  const now=new Date(),sod=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const rows=SHOPS.map(sh=>{
    const S=cashierSales.filter(s=>saleShop(s)===sh.id);
    const t=S.filter(s=>new Date(s.date)>=sod),m=S.filter(s=>{const d=new Date(s.date);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
    const sum=a=>a.reduce((x,y)=>x+y.tot,0);
    const units=PRODS.reduce((x,p)=>x+p.qs[sh.id],0),low=PRODS.filter(p=>p.qs[sh.id]<=LOW_STOCK).length;
    return {sh,today:sum(t),month:sum(m),tx:m.length,units,low};
  });
  box.innerHTML='<table style="min-width:420px"><thead><tr><th>Shop</th><th>Today</th><th>This month</th><th>Sales</th><th>Units in stock</th><th>Low / out</th></tr></thead><tbody>'+
    rows.map(r=>`<tr style="cursor:pointer" onclick="setScope('${r.sh.id}')"><td style="font-weight:700">${pfEsc(r.sh.name)}</td><td>KES ${MAC_FMT(r.today)}</td><td style="font-weight:700;color:var(--text-brand)">KES ${MAC_FMT(r.month)}</td><td>${r.tx}</td><td>${r.units}</td><td>${r.low?'<span class="badge bw">'+r.low+'</span>':'<span class="badge bg">0</span>'}</td></tr>`).join('')+
    `<tr style="font-weight:800"><td>All shops</td><td>KES ${MAC_FMT(rows.reduce((t,r)=>t+r.today,0))}</td><td>KES ${MAC_FMT(rows.reduce((t,r)=>t+r.month,0))}</td><td>${rows.reduce((t,r)=>t+r.tx,0)}</td><td>${rows.reduce((t,r)=>t+r.units,0)}</td><td></td></tr></tbody></table>`;
}
const LOW_STOCK=5; // flag items at or below this quantity as "Low stock" (big-ticket goods move slowly)
const CAT_EMOJI=CAT_ICON; // category -> Material icon name (see js/icons.js)
let cart=[],posCat='All',payM='cash';

// ── ROLE ACCESS CONTROL ─────────────────────────────────
let currentRole = 'none';
let currentUser = null;

const ROLE_ACCESS = {
  admin:   ['dashboard','pos','inventory','reports','profit','tot-report','customers','suppliers','expenses','settings'],
  super:   ['dashboard','pos','inventory','reports','profit','tot-report','customers','suppliers','expenses','settings'],
  cashier: ['pos','cashier-history'],
};

// Sidebar nav pages hidden for cashier
const CASHIER_HIDDEN = ['dashboard','inventory','reports','profit','tot-report','customers','suppliers','expenses','settings'];

// ── BACK BUTTON (installed app has no browser back) ─────
let _sid=0, histPage='', _popNav=false, _exitArmed=false;
function curPage(){const el=document.querySelector('.page.show,.page-wrap.show');return el?(el.id==='pos-page'?'pos':el.id):'';}
function closeTopOverlay(){
  const sc=document.getElementById('scan-ov');
  if(sc&&sc.style.display==='flex'){try{closeScanner();}catch(_){}return true;}
  if(document.getElementById('overlay').classList.contains('show')){try{newSale();}catch(_){}return true;}
  const modals=[['prod-modal',closeProdModal],['stock-modal',closeStockModal],['transfer-modal',closeTransferModal],['staff-modal',closeStaffModal],['pw-modal',closePwModal]];
  for(const [id,fn] of modals){const m=document.getElementById(id);if(m&&m.classList.contains('show')){fn();return true;}}
  if(document.getElementById('drawer').classList.contains('open')){closeDrawer();return true;}
  if(document.getElementById('sidebar').classList.contains('open')){closeSB();return true;}
  return false;
}
function histPush(page){try{history.pushState({mac:1,sid:_sid,page},'');}catch(_){}}
window.addEventListener('popstate',e=>{
  if(!currentUser)return;
  if(closeTopOverlay()){histPush(histPage);return;}          // back closes sheets/menus first
  const st=e.state;
  const mine=st&&st.sid===_sid&&st.mac===1&&(ROLE_ACCESS[currentRole]||[]).includes(st.page);
  if(mine){_popNav=true;try{goPage(st.page);}finally{_popNav=false;}return;}
  // reached the start of this session: ask once before leaving the app
  if(_exitArmed){_exitArmed=false;try{history.back();}catch(_){}return;}
  _exitArmed=true;setTimeout(()=>{_exitArmed=false;},2200);
  showToast('Press back again to exit');
  histPush(histPage);
});

function enterApp(user){
  const r = user.role;
  currentRole = r; currentUser = user;
  if(CL.on) cloudSessionStart(user);
  // Which shop? Cashiers / shop managers are locked to theirs; owners start in the last shop they used
  SCOPE = userShop() || LAST_SHOP || 'A'; if(SCOPE!=='ALL') LAST_SHOP = SCOPE;
  renderShopCtl();

  // User info
  document.getElementById('uname').textContent = user.name;
  document.getElementById('urole').textContent = MAC_ROLE_LBL[r];
  document.getElementById('av').textContent = user.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

  // Show app
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Apply restrictions
  applyRoleUI(r);

  // Initialise data
  setGreet(r); setDate(); renderCatPills(); renderProds(); renderInv(); renderLive();

  _sid=Date.now();histPage=(r==='cashier')?'pos':'dashboard';
  try{history.replaceState({mac:0,sid:_sid},'');histPush(histPage);}catch(_){}
  if(r === 'cashier'){
    // Go straight to POS — cashier never sees dashboard
    goPage('pos');
    // Hide hamburger — cashier has no sidebar to open
    const ham = document.querySelector('.ham');
    if(ham) ham.style.display = 'none';
  } else {
    const ham = document.querySelector('.ham');
    if(ham) ham.style.display = '';
    goPage('dashboard');
    setTimeout(()=>{ initDash(); initRep(); renderLive(); renderShopCompare(); }, 100);
  }
  // Open a ?page=… shortcut once the person is signed in
  if(window.__pendingPage){
    const pg = window.__pendingPage; window.__pendingPage = null;
    setTimeout(()=>go(pg, document.querySelector('[data-page="'+pg+'"]')), 300);
  }
}

function applyRoleUI(role){
  const isCashier = role === 'cashier';
  document.body.classList.toggle('is-cashier', isCashier);

  // ── Sidebar nav items ──
  CASHIER_HIDDEN.forEach(page => {
    const ni = document.querySelector(`.ni[data-page="${page}"]`);
    if(ni) ni.style.display = isCashier ? 'none' : '';
  });

  // ── Sidebar section headings ──
  document.querySelectorAll('.sb-sec').forEach(s => s.style.display = isCashier ? 'none' : '');

  // ── Sidebar itself ──
  document.getElementById('sidebar').style.display = isCashier ? 'none' : '';

  // ── Bottom nav: hide all admin tabs for cashier ──
  ['bn-dashboard','bn-inventory','bn-reports','bn-settings'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = isCashier ? 'none' : '';
  });

  // ── Bottom nav: show "My Sales" only for cashier ──
  const bnHist = document.getElementById('bn-cashier-history');
  if(bnHist) bnHist.style.display = isCashier ? 'flex' : 'none';

  // ── Inventory action buttons (edit / delete / add) ──
  // Re-run after renderInv() too — see renderInv()
  document.querySelectorAll('.ab.edit, .ab.del, .inv-bar .btn, .icbtn').forEach(el => {
    el.style.display = isCashier ? 'none' : '';
  });
}

function requestLogout(){
  if(cart&&cart.length&&!confirm('There are items in the current sale. Log out and discard them?'))return;
  logout();
}
function logout(){
  if(CL.on){ CL.stopSession(); MAC_USERS=[]; PRODS.length=0; TRANSFERS.length=0; CAT={}; STK={}; COSTS={}; SALE_SRC={}; EXP_SRC={}; RECEIPTS=[]; SALES_DAY=''; cashierSales.length=0; EXPENSES.length=0; CLOUD_READY={p:false,s:false}; _scrubbed={}; clearTimeout(_cloudRefT); }   // the Firebase login stays on this phone (so offline sign-in and syncing keep working)
  _sid=0;try{history.replaceState({mac:-1},'');}catch(_){}
  currentRole = 'none'; currentUser = null;
  if(SCOPE==='ALL') SCOPE = LAST_SHOP;       // never leave the till in "All shops" for the next person
  try{ renderShopCtl(); }catch(e){}
  cart = []; try{ renderCart(); }catch(e){}
  ['prod-modal','stock-modal','staff-modal','pw-modal','transfer-modal'].forEach(id=>{const m=document.getElementById(id);if(m)m.classList.remove('show');});
  try{ refreshLoginMode(); }catch(e){}
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.body.classList.remove('is-cashier');
  // Reset sidebar + hamburger visibility
  document.getElementById('sidebar').style.display = '';
  const ham = document.querySelector('.ham');
  if(ham) ham.style.display = '';
}

function setRole(r, el){
  document.getElementById('lr').value = r;
  document.querySelectorAll('.role-chip').forEach(c => c.classList.remove('on'));
  el.classList.add('on');
}

function setGreet(role){
  const h = new Date().getHours();
  const time = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const name = (currentUser && currentUser.name.split(' ')[0]) || 'there';
  const el = document.getElementById('greeting');
  if(el) el.innerHTML = `Good ${time}, ${String(name).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))} ${MI('waving_hand','mi-inline')}`;
}

function setDate(){
  const d = document.getElementById('dash-date');
  if(d) d.textContent = new Date().toLocaleDateString('en-KE',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) + ' · ' + scopeLabel();
}

// ── NAVIGATION ─────────────────────────────────────────
const pgNames = {
  dashboard:'Dashboard', pos:'Point of Sale', inventory:'Inventory',
  reports:'Reports', 'tot-report':'TOT Report', customers:'Customers', suppliers:'Suppliers',
  expenses:'Expenses', profit:'Profit Report', settings:'Settings', 'cashier-history':'My Sales'
};

// Internal page switch (no role guard — called from doLogin)
function goPage(page){
  // Selling needs one specific shop
  if(page==='pos' && SCOPE==='ALL'){ SCOPE=LAST_SHOP; renderShopCtl(); try{setDate();refreshStockViews();}catch(_){} showToast('Switched to '+shopName(SCOPE)+' to sell','success'); }
  document.querySelectorAll('.page, .page-wrap').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.ni').forEach(n => n.classList.remove('active'));
  const pageId = page === 'pos' ? 'pos-page' : page;
  const t = document.getElementById(pageId);
  if(t) t.classList.add('show');
  const ni = document.querySelector(`.ni[data-page="${page}"]`);
  if(ni) ni.classList.add('active');
  const titleEl = document.getElementById('page-title');
  if(titleEl) titleEl.textContent = pgNames[page] || page;
  if(currentUser&&!_popNav&&page!==histPage)histPush(page);
  histPage=page;
  setBN(page);
  if(page === 'inventory') setTimeout(renderInv, 50);
  if(page === 'dashboard' || page === 'reports') setTimeout(renderLive, 50);
  if(page === 'cashier-history') renderCashierHistory();
  if(page === 'reports') renderBestSellers();
  if(page === 'tot-report') renderTOTReport();
  if(page === 'profit') renderProfit();
  if(page === 'expenses') renderExpenses();
  if(page === 'settings'){ updateBackupUI(); renderStaff(); renderShopSettings(); }
  if(page === 'inventory') renderTransfers();
  if(window.innerWidth <= 640) closeSB();
}

// Public nav — enforces role guard
function go(page, el){
  const allowed = ROLE_ACCESS[currentRole] || [];
  if(!allowed.includes(page)){
    showToast('⛔ Access restricted for your role', 'error');
    return;
  }
  goPage(page);
  // Sync sidebar active state from external caller
  if(el){ document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active')); el.classList.add('active'); }
}

function setBN(p){
  document.querySelectorAll('.bn-i').forEach(b => b.classList.remove('active'));
  const b = document.getElementById('bn-' + p);
  if(b) b.classList.add('active');
}
function toggleSB(){
  const sb = document.getElementById('sidebar');
  sb.classList.toggle('open');
  const ov = document.getElementById('sbOv');
  ov.style.cssText = sb.classList.contains('open')
    ? 'display:block;opacity:1;pointer-events:all'
    : 'display:none;opacity:0;pointer-events:none';
}
function closeSB(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sbOv').style.cssText = 'display:none;opacity:0;pointer-events:none';
}

// MOBILE DETECT
function checkMobile(){
  const lo=document.querySelector('.form-brand-mark');
  const art=document.querySelector('.login-art');
  if(window.innerWidth<=640){if(lo)lo.style.display='flex';if(art)art.style.display='none';}
  else{if(lo)lo.style.display='none';if(art)art.style.display='flex';}
}
window.addEventListener('resize',checkMobile);checkMobile();

// POS
function renderProds(){
  const g=document.getElementById('pgrid');
  const q=document.getElementById('pos-search').value.toLowerCase();
  const f=PRODS.filter(p=>{const ms=!q||p.n.toLowerCase().includes(q)||p.s.toLowerCase().includes(q);const mc=posCat==='All'||p.c===posCat;return ms&&mc;});
  g.innerHTML=f.map(p=>{
    const sc=p.q===0?'oos':p.q<=LOW_STOCK?'low':'ok';
    const sl=p.q===0?'Out of stock':p.q<=LOW_STOCK?`${p.q} left`:`${p.q} in stock`;
    return `<div class="pcard${p.q===0?' oos':''}" onclick="addToCart(${p.id})">
      <div class="afl" id="f-${p.id}"></div>
      <div class="pce">${catIcon(p.c)}</div><div class="pcn">${p.n}</div><div class="pcs">${p.s}</div>
      <div class="pcb"><div class="pcp">KES ${p.r.toLocaleString()}</div><div class="pcst ${sc}">${sl}</div></div>
    </div>`;
  }).join('')||'<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--g200);font-size:13px">'+(PRODS.length?'No products found':'No stock loaded yet')+'</div>';
}
function setCat(c,el){posCat=c;document.querySelectorAll('.cpill').forEach(p=>p.classList.remove('on'));el.classList.add('on');renderProds();}
function filterProds(){renderProds();}
// ── BARCODE SCANNING ─────────────────────────────────────
// A product's barcode is matched against its SKU / code field, so enter the barcode number as the SKU.
function scanLookup(code){
  const q=String(code||'').trim().toLowerCase();if(!q)return false;
  const p=PRODS.find(x=>String(x.s).toLowerCase()===q);
  if(!p)return false;
  if(p.q===0){showToast('⚠️ '+p.n+' is out of stock','error');return true;}
  addToCart(p.id);showToast('Added '+p.n,'success',1500);return true;
}
// Enter in the search box: exact code adds the item; a single match adds it too
function posSearchKey(e){
  if(e.key!=='Enter')return;
  const inp=e.target,q=inp.value.trim().toLowerCase();if(!q)return;
  e.preventDefault();
  if(scanLookup(q)){inp.value='';renderProds();return;}
  const m=PRODS.filter(p=>p.n.toLowerCase().includes(q)||String(p.s).toLowerCase().includes(q));
  if(m.length===1&&m[0].q>0){addToCart(m[0].id);inp.value='';renderProds();}
  else showToast(m.length?'Several products match — tap the one you want':'No product with that code','error',2500);
}
// USB / Bluetooth scanners type like a very fast keyboard: catch it even when no box is focused
let scanBuf='',scanLast=0;
document.addEventListener('keydown',e=>{
  const pos=document.getElementById('pos-page');if(!pos||!pos.classList.contains('show'))return;
  const tag=(e.target&&e.target.tagName)||'';if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const now=Date.now();
  if(e.key==='Enter'){if(scanBuf.length>=4&&scanLookup(scanBuf))e.preventDefault();scanBuf='';return;}
  if(e.key.length===1){if(now-scanLast>80)scanBuf='';scanBuf+=e.key;scanLast=now;}
});
// Phone camera (Chrome on Android supports BarcodeDetector)
let scanStream=null,scanTimer=null,scanBad='';
async function openScanner(){
  if(!('BarcodeDetector' in window)||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    showToast('Camera scanning is not supported in this browser — use a barcode scanner or type the code','error',4000);return;
  }
  const ov=document.getElementById('scan-ov'),v=document.getElementById('scan-video');
  try{
    scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    v.srcObject=scanStream;await v.play();ov.style.display='flex';
    const det=new BarcodeDetector();
    scanBad='';
    scanTimer=setInterval(async()=>{
      try{
        const r=await det.detect(v);
        if(!r.length)return;
        const code=r[0].rawValue;
        if(scanLookup(code))closeScanner();
        else if(code!==scanBad){scanBad=code;showToast('No product with code '+code,'error',2500);}
      }catch(_){}
    },300);
  }catch(err){closeScanner();showToast('Could not open the camera: '+(err.message||err.name),'error',4000);}
}
function closeScanner(){
  clearInterval(scanTimer);scanTimer=null;
  if(scanStream){scanStream.getTracks().forEach(t=>t.stop());scanStream=null;}
  const ov=document.getElementById('scan-ov');if(ov)ov.style.display='none';
}
try{if(!('BarcodeDetector' in window)){const b=document.getElementById('scan-cam-btn');if(b)b.style.display='none';}}catch(_){}


function addToCart(id){
  if(SCOPE==='ALL')return needShop();
  const p=PRODS.find(x=>x.id===id);if(!p||p.q===0)return;
  const f=document.getElementById('f-'+id);if(f){f.style.opacity='1';setTimeout(()=>f.style.opacity='0',350);}
  const ex=cart.find(x=>x.id===id);
  if(ex)ex.qty=Math.min(ex.qty+1,p.q);else cart.push({...p,qty:1});
  renderCart();
}
function cartItemsHTML(){
  if(!cart.length)return`<div class="cart-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg><p>Cart is empty</p><small>Tap a product to add</small></div>`;
  return cart.map(i=>`<div class="ci">
    <div class="ci-e">${catIcon((PRODS.find(x=>x.id===i.id)||{}).c)}</div>
    <div class="ci-inf"><div class="ci-n">${i.n}</div><div class="ci-p">KES ${i.r.toLocaleString()} each</div></div>
    <div class="ci-q"><div class="qb" onclick="chQty(${i.id},-1)">−</div><div class="qn">${i.qty}</div><div class="qb" onclick="chQty(${i.id},1)">+</div></div>
    <div class="ci-t">KES ${(i.r*i.qty).toLocaleString()}</div>
    <div class="ci-rm" onclick="rmCart(${i.id})">×</div>
  </div>`).join('');
}
function renderCart(){
  const html=cartItemsHTML();
  const bd=document.getElementById('cart-bd');if(bd)bd.innerHTML=html;
  const dbd=document.getElementById('d-bd');if(dbd)dbd.innerHTML=html;
  const has=cart.length>0;
  ['chk-btn','d-chk'].forEach(id=>{const el=document.getElementById(id);if(el)el.disabled=!has;});
  const cnt=cart.length;
  const cc=document.getElementById('cart-count');if(cc)cc.textContent=cnt+' item'+(cnt!==1?'s':'');
  const dc=document.getElementById('d-count');if(dc)dc.textContent=cnt+' item'+(cnt!==1?'s':'');
  const fc=document.getElementById('fabCnt');if(fc)fc.textContent=cnt;
  updateTotals();
}
function chQty(id,d){const i=cart.find(x=>x.id===id);if(i){i.qty=Math.max(1,Math.min(i.qty+d,i.q));renderCart();}}
function rmCart(id){cart=cart.filter(x=>x.id!==id);renderCart();}
function clearCart(){cart=[];renderCart();closeDrawer();resetPayExtra();}
function updateTotals(){
  const sub=cart.reduce((s,i)=>s+i.r*i.qty,0);
  const tot=sub; // TOT is calculated monthly in backend reports only
  [['c-sub','d-sub'],['c-tot','d-tot']].forEach(([a,b],i)=>{
    const v=['KES '+sub.toLocaleString(),'KES '+tot.toLocaleString()][i];
    const ea=document.getElementById(a);const eb=document.getElementById(b);
    if(ea)ea.textContent=v;if(eb)eb.textContent=v;
  });
  if(typeof updatePeChange==='function')updatePeChange();
}
function selPay(m){
  payM=m;
  ['cash','mpesa','card'].forEach(k=>{
    ['pc-'+k,'dpc-'+k].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.toggle('on',k===m);});
  });
  renderPayExtra();
}
// ── CASH RECEIVED / CHANGE / M-PESA CODE ─────────────────
let payExtra={cash:'',ref:''};
function peTotal(){return cart.reduce((s,i)=>s+i.r*i.qty,0);}
function renderPayExtra(){
  let h='';
  if(payM==='cash')h='<input class="pe-in pe-cash" inputmode="decimal" placeholder="Cash received (optional)" value="'+payExtra.cash+'" oninput="peCash(this.value)"><div class="pe-chg pe-chg-t"></div>';
  else if(payM==='mpesa')h='<input class="pe-in pe-ref" maxlength="10" autocapitalize="characters" autocomplete="off" placeholder="M-Pesa code (optional)" value="'+payExtra.ref+'" oninput="peRef(this.value)">';
  ['pay-extra','d-pay-extra'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=h;});
  updatePeChange();
}
function peSync(sel,v){document.querySelectorAll(sel).forEach(i=>{if(i.value!==v)i.value=v;});}
function peCash(v){payExtra.cash=String(v).replace(/[^\d.]/g,'');peSync('.pe-cash',payExtra.cash);updatePeChange();}
function peRef(v){payExtra.ref=String(v).toUpperCase().replace(/[^A-Z0-9]/g,'');peSync('.pe-ref',payExtra.ref);}
function updatePeChange(){
  const t=peTotal(),r=parseFloat(payExtra.cash);
  let txt='',col='var(--green)';
  if(payM==='cash'&&payExtra.cash!==''&&!isNaN(r)){
    if(r<t){txt='Short by KES '+(t-r).toLocaleString();col='var(--danger)';}
    else txt='Change: KES '+(r-t).toLocaleString();
  }
  document.querySelectorAll('.pe-chg-t').forEach(el=>{el.textContent=txt;el.style.color=col;});
}
function resetPayExtra(){payExtra={cash:'',ref:''};renderPayExtra();}
function fillReceiptExtras(x){
  const set=(row,val,txt)=>{const r=document.getElementById(row),v=document.getElementById(val);if(!r||!v)return;r.style.display=txt?'flex':'none';v.textContent=txt||'';};
  const has=x&&x.paid!=null;
  set('r-paid-row','r-paid',has?'KES '+Number(x.paid).toLocaleString():'');
  set('r-chg-row','r-chg',has?'KES '+Number(x.change||0).toLocaleString():'');
  set('r-ref-row','r-ref',x&&x.ref?x.ref:'');
}
try{renderPayExtra();}catch(_){}
function openDrawer(){document.getElementById('drawer').classList.add('open');renderCart();}
function closeDrawer(){document.getElementById('drawer').classList.remove('open');}
// Cashier sales history (in-session)
const cashierSales = [];
let receiptCounter = 1;

// ── LIVE SALES STATS (built from sales recorded in the app) ─────────────
const MAC_FMT=n=>Math.round(n).toLocaleString('en-KE');
const MAC_PAYLBL={cash:'Cash',mpesa:'M-Pesa',card:'Card'};
const MAC_PAYBDG={cash:'bo',mpesa:'bg',card:'bb'};
function macPayKey(p){p=String(p||'').toLowerCase();return p.includes('pesa')?'mpesa':p.includes('card')?'card':'cash';}
function macWeekStart(d){const x=new Date(d);x.setHours(0,0,0,0);x.setDate(x.getDate()-((x.getDay()+6)%7));return x;}
function macPeriodLabel(){const n=new Date();return n.toLocaleDateString('en-KE',{month:'short',year:'numeric'})+'  |  '+n.getDate()+' '+n.toLocaleDateString('en-KE',{month:'short'});}
function macStats(){
  const now=new Date(), sod=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const sum=a=>a.reduce((t,x)=>t+x.tot,0), items=a=>a.reduce((t,x)=>t+x.items,0);
  const all=scopedSales().map(x=>Object.assign({},x,{d:new Date(x.date)}));
  const today=all.filter(x=>x.d>=sod);
  const month=all.filter(x=>x.d.getMonth()===now.getMonth()&&x.d.getFullYear()===now.getFullYear());
  const wk0=macWeekStart(now), weeks=[];
  for(let i=7;i>=0;i--){const a=new Date(wk0);a.setDate(a.getDate()-i*7);const b=new Date(a);b.setDate(b.getDate()+7);
    const f=all.filter(x=>x.d>=a&&x.d<b);weeks.push({label:a.toLocaleDateString('en-KE',{day:'numeric',month:'short'}),gross:sum(f),tx:f.length});}
  const days=[0,0,0,0,0,0,0];all.filter(x=>x.d>=wk0).forEach(x=>{days[(x.d.getDay()+6)%7]+=x.tot;});
  const pay={cash:0,mpesa:0,card:0};month.forEach(x=>{pay[macPayKey(x.pay)]+=x.tot;});
  const catMap={};month.forEach(x=>(x.lines||[]).forEach(l=>{const p=PRODS.find(q=>q.n===l.n);const c=p?p.c:'Other';catMap[c]=(catMap[c]||0)+l.t;}));
  const prodMap={};today.forEach(x=>(x.lines||[]).forEach(l=>{prodMap[l.n]=(prodMap[l.n]||0)+l.t;}));
  const cashMap={};today.forEach(x=>{const k=x.cashier||'Staff';cashMap[k]=(cashMap[k]||0)+x.tot;});
  const byVal=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]);
  return {all,today,month,weeks,days,pay,cats:byVal(catMap),top:byVal(prodMap).slice(0,5),cashiers:byVal(cashMap),
    todayTotal:sum(today),todayCount:today.length,monthTotal:sum(month),monthItems:items(month),monthCount:month.length};
}
function macReportRows(){
  const R=macStats(), tot=calcTOT(R.monthTotal), pct=k=>R.monthTotal?Math.round(R.pay[k]/R.monthTotal*100)+'%':'0%';
  const rows=[['Receipt #','Shop','Cashier','Items','Payment Method','Total (KES)','Time']];
  R.all.forEach(x=>rows.push([x.num,shopName(saleShop(x)),x.cashier||'Staff',x.items,MAC_PAYLBL[macPayKey(x.pay)],x.tot,x.time]));
  rows.push([],['MONTHLY SUMMARY — KRA TURNOVER TAX (TOT)'],
    ['Total Gross Revenue','KES '+MAC_FMT(R.monthTotal)],['Turnover Tax ('+(getTOTRate()*100)+'%)','KES '+tot.toLocaleString('en-KE',{minimumFractionDigits:2})],
    ['Net Revenue After Tax','KES '+(R.monthTotal-tot).toLocaleString('en-KE',{minimumFractionDigits:2})],['Total Transactions',R.monthCount],
    ['M-Pesa Share',pct('mpesa')],['Cash Share',pct('cash')],['Card Share',pct('card')],
    ['Shop',scopeLabel()],['Report Period',new Date().toLocaleDateString('en-KE',{month:'long',year:'numeric'})],['Generated by','Macrome Electronics POS — KRA TOT Compliant']);
  return rows;
}

// ── LIVE RENDER (dashboard, reports, charts) ────────────────────────────
const MAC_CH={};
function renderLive(){
  if(typeof updateBackupNudge==='function')updateBackupNudge();
  try{updateDashProfit();}catch(e){console.error(e);}
  const R=macStats(), el=id=>document.getElementById(id), empty=(c,t)=>`<tr><td colspan="${c}" style="text-align:center;color:var(--g400);padding:18px;font-size:12px">${t}</td></tr>`;
  const row=(x,cols)=>cols;
  if(el('dash-kpi-revenue'))el('dash-kpi-revenue').textContent='KES '+MAC_FMT(R.todayTotal);
  if(el('dash-kpi-cust'))el('dash-kpi-cust').textContent=R.todayCount;
  const rec=el('dash-recent');
  if(rec)rec.innerHTML=R.today.length?R.today.slice(0,6).map(x=>{const k=macPayKey(x.pay);return `<tr><td style="font-weight:600;font-size:12px;font-family:monospace">${x.num}</td><td>${x.cashier||'Staff'}</td><td><span class="badge bb">${x.items}</span></td><td style="font-weight:700;color:var(--text-brand)">KES ${MAC_FMT(x.tot)}</td><td><span class="badge ${MAC_PAYBDG[k]}">${MAC_PAYLBL[k]}</span></td><td style="color:var(--g400);font-size:12px">${x.time}</td></tr>`;}).join(''):empty(6,'No sales yet today');
  const top=el('dash-top');
  if(top){const mx=R.top.length?R.top[0][1]:1;top.innerHTML=R.top.length?R.top.map(([n,v],i)=>{const p=PRODS.find(q=>q.n===n);const st=i===0?'background:var(--gold-p);color:var(--text-gold)':i===1?'background:var(--pale);color:var(--text-brand)':'background:var(--g50);color:var(--g400)';
    return `<div class="tpi"><div class="tpr" style="${st}">${i+1}</div><div class="tpn"><div class="tpnm">${n}</div><div class="tpnc">${p?p.c:''}</div></div><div class="tpbw"><div class="tpb" style="width:${Math.round(v/mx*100)}%"></div></div><div class="tpa">KES ${v>=1000?(v/1000).toFixed(1)+'K':v}</div></div>`;}).join(''):'<div style="color:var(--g400);font-size:12px;padding:6px 0">Top sellers appear after the first sale</div>';}
  const al=el('dash-alerts'), low=PRODS.filter(p=>p.q<=LOW_STOCK).sort((a,b)=>a.q-b.q);
  if(al)al.innerHTML=!PRODS.length?'<div style="color:var(--g400);font-size:12px;padding:6px 0">No stock loaded yet</div>':low.length?low.slice(0,5).map(p=>`<div class="ar"><div class="a-dot" style="background:var(--${p.q===0?'danger':'warn'})"></div><div><div class="a-t">${p.n}</div><div class="a-s">${p.q} unit${p.q===1?'':'s'} — ${p.q===0?'Out of stock':'Low stock'}</div></div></div>`).join(''):'<div style="color:var(--g400);font-size:12px;padding:6px 0">All items are well stocked ✓</div>';
  const nb=el('nb-inv');if(nb){nb.textContent=low.length;nb.style.display=low.length?'':'none';}
  const cs=el('dash-cashiers');
  if(cs){const mx=R.cashiers.length?R.cashiers[0][1]:1;cs.innerHTML=R.cashiers.length?R.cashiers.map(([n,v],i)=>{const ini=n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();const st=i===0?'background:var(--pale);color:var(--text-brand)':'background:var(--gold-p);color:var(--text-gold)';
    return `<div class="cr"><div class="cav" style="${st}">${ini}</div><div class="cn">${n}</div><div class="cbw"><div class="cb" style="width:${Math.round(v/mx*100)}%"></div></div><div class="ca">KES ${MAC_FMT(v)}</div></div>`;}).join(''):'<div style="color:var(--g400);font-size:12px;padding:6px 0">Cashier totals appear after the first sale</div>';}
  const log=el('rep-log');
  if(log)log.innerHTML=R.all.length?R.all.slice(0,100).map(x=>{const k=macPayKey(x.pay);return `<tr><td style="font-family:monospace;font-size:12px">${x.num}</td><td>${x.cashier||'Staff'}</td><td>${x.items}</td><td><span class="badge ${MAC_PAYBDG[k]}">${MAC_PAYLBL[k]}</span></td><td style="font-weight:700">KES ${MAC_FMT(x.tot)}</td><td style="font-size:12px;color:var(--g400)">${x.time}</td></tr>`;}).join(''):empty(6,'No transactions yet');
  const rp=el('rep-period');if(rp)rp.textContent=new Date().toLocaleDateString('en-KE',{month:'long',year:'numeric'})+' — KRA TOT Compliant';
  ['mpesa','cash','card'].forEach(k=>{const p=R.monthTotal?Math.round(R.pay[k]/R.monthTotal*100):0;if(el('pm-'+k))el('pm-'+k).style.width=p+'%';if(el('pm-'+k+'-p'))el('pm-'+k+'-p').textContent=p+'%';});
  const wk=R.weeks;
  [['dash',wk.map(w=>w.label),wk.map(w=>w.gross)],['repBar',wk.map(w=>w.label),wk.map(w=>w.gross)],['repStack',['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],R.days]].forEach(([k,l,d])=>{const c=MAC_CH[k];if(c){c.data.labels=l;c.data.datasets[0].data=d;c.update();}});
  if(MAC_CH.repDonut){const t=R.pay.mpesa+R.pay.cash+R.pay.card;MAC_CH.repDonut.data.datasets[0].data=t?[R.pay.mpesa,R.pay.cash,R.pay.card]:[0,0,0];MAC_CH.repDonut.update();}
  if(MAC_CH.repCat){const c=R.cats.length?R.cats:[['—',0]];MAC_CH.repCat.data.labels=c.map(x=>x[0]);MAC_CH.repCat.data.datasets[0].data=c.map(x=>x[1]);MAC_CH.repCat.update();}
  if(typeof updateDashTOT==='function')updateDashTOT();
}
function renderCatPills(){
  const box=document.getElementById('pos-cats');if(!box)return;
  const cats=[...new Set(PRODS.map(p=>p.c))];
  box.innerHTML='<div class="cpill'+(posCat==='All'?' on':'')+'" onclick="setCat(\'All\',this)">All</div>'+cats.map(c=>{const p=PRODS.find(x=>x.c===c);const e=catIcon(c);return `<div class="cpill${posCat===c?' on':''}" onclick="setCat('${c.replace(/'/g,"\\'")}',this)">${e} ${c}</div>`;}).join('');
}


function checkout(){
  if(!cart.length)return;
  if(!needShop())return;
  // Re-check live stock before taking the sale
  const short=cart.filter(i=>{const p=PRODS.find(x=>x.id===i.id);return !p||p.q<i.qty;})
    .map(i=>{const p=PRODS.find(x=>x.id===i.id);return i.n+(p?' (only '+p.q+' left)':' (no longer in stock list)');});
  if(short.length){
    syncCart();
    showToast('⚠️ Not enough stock: '+short.join(', '),'error',5000);
    return;
  }
  let paid=null,change=null,ref='';
  const tot0=peTotal();
  if(payM==='cash'&&payExtra.cash!==''){
    const r=parseFloat(payExtra.cash);
    if(isNaN(r)||r<tot0){showToast('Cash received is less than the total','error');return;}
    paid=r;change=r-tot0;
  }
  if(payM==='mpesa'&&payExtra.ref!==''){
    if(!/^[A-Z0-9]{10}$/.test(payExtra.ref)){showToast('M-Pesa code must be 10 letters/numbers','error');return;}
    ref=payExtra.ref;
  }
  closeDrawer();
  const sub=cart.reduce((s,i)=>s+i.r*i.qty,0);
  const tot=sub; // No VAT — TOT is monthly aggregate at 1.5%
  const now=new Date();
  let receiptNum,cloudSeq=0;
  if(CL.on){cloudSeq=cloudNextSeq();receiptNum=SCOPE+'-'+((currentUser&&currentUser.code)||'STF')+'-'+String(cloudSeq).padStart(4,'0');}   // e.g. A-GRC-0001
  else{receiptNum='#REC-'+String(receiptCounter).padStart(4,'0');receiptCounter++;}
  document.getElementById('r-date').textContent=now.toLocaleDateString('en-KE',{year:'numeric',month:'short',day:'numeric'});
  document.getElementById('r-pay').textContent={cash:'Cash',mpesa:'M-Pesa',card:'Card'}[payM];
  document.getElementById('r-items').innerHTML=cart.map(i=>`<div class="rpi"><div><div class="rpin">${i.n}</div><div class="rpiq">× ${i.qty} @ KES ${i.r.toLocaleString()}</div></div><div class="rpit">KES ${(i.r*i.qty).toLocaleString()}</div></div>`).join('');
  document.getElementById('r-sub').textContent='KES '+sub.toLocaleString();
  document.getElementById('r-tot').textContent='KES '+tot.toLocaleString();
  fillReceiptExtras({paid,change,ref});
  // Update cashier name on receipt
  const cashierName=currentUser?currentUser.name:'Staff';
  const rCashierEl=document.querySelector('.rpmeta-i:nth-child(3) .rpmv');
  if(rCashierEl)rCashierEl.textContent=cashierName;
  // Update receipt number display
  const rvEl=document.querySelector('.rpmv');if(rvEl)rvEl.textContent=receiptNum;
  document.getElementById('overlay').classList.add('show');
  // Record in cashier history (store tot for TOT aggregation)
  cashierSales.unshift(CUR_SALE={
    key:CL.on?receiptNum:undefined,uid:CL.on&&currentUser?currentUser.id:undefined,
    num:receiptNum,
    time:now.toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'}),
    date:now,
    items:cart.reduce((s,i)=>s+i.qty,0),
    pay:{cash:'Cash',mpesa:'M-Pesa',card:'Card'}[payM],
    sub,tot,paid,change,ref,
    cashier:cashierName,
    cashierId:currentUser?currentUser.username:'',
    shop:SCOPE,
    lines:cart.map(i=>({id:i.id,n:i.n,qty:i.qty,r:i.r,w:Number(i.w)||0,t:i.r*i.qty}))
  });
  // Deduct sold quantities from stock, then save everything to the device
  cart.forEach(i=>{const p=PRODS.find(x=>x.id===i.id);if(p)p.q=Math.max(0,p.q-i.qty);});
  if(CL.on)cloudSaveSale(CUR_SALE,cloudSeq);   // one all-or-nothing write: the sale + the stock taken out (queued if offline)
  saveData();
  renderProds();renderInv();
  // Update dashboard TOT widget live
  updateDashTOT();
  if(typeof renderLive==='function')renderLive();
  autoPrintIfReady();
}
function closeRct(e){if(e.target.id==='overlay')newSale();}
function newSale(){document.getElementById('overlay').classList.remove('show');clearCart();}

// ── CASHIER HISTORY ──────────────────────────────────────
// Sales the signed-in person made today — nobody sees anyone else's, or earlier days'
function mySales(){
  const sod=new Date();sod.setHours(0,0,0,0);
  if(!currentUser)return [];
  return cashierSales.map((s,i)=>({s,i})).filter(({s})=>{
    if(new Date(s.date)<sod)return false;
    if(CL.on)return s.uid===currentUser.id;
    return s.cashierId?s.cashierId===currentUser.username:s.cashier===currentUser.name;
  });
}
function renderCashierHistory(){
  const mineRows=mySales(), mineS=mineRows.map(r=>r.s);
  const cd=document.getElementById('ch-date');
  if(cd)cd.textContent=new Date().toLocaleDateString('en-KE',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const totalRev=mineS.reduce((s,x)=>s+x.tot,0);
  const totalItems=mineS.reduce((s,x)=>s+x.items,0);
  const el_rev=document.getElementById('ch-revenue');
  const el_sales=document.getElementById('ch-sales');
  const el_items=document.getElementById('ch-items');
  const el_badge=document.getElementById('ch-badge');
  if(el_rev)el_rev.textContent='KES '+totalRev.toLocaleString();
  if(el_sales)el_sales.textContent=mineS.length;
  if(el_items)el_items.textContent=totalItems;
  if(el_badge)el_badge.textContent=mineS.length+' sale'+(mineS.length!==1?'s':'');
  const sub_rev=document.getElementById('ch-rev-sub');
  const sub_sales=document.getElementById('ch-sales-sub');
  const sub_items=document.getElementById('ch-items-sub');
  if(sub_rev)sub_rev.textContent=mineS.length?`Avg KES ${Math.round(totalRev/mineS.length).toLocaleString()} per sale`:'No sales yet';
  if(sub_sales)sub_sales.textContent=mineS.length?`Last: ${mineS[0].time}`:'Start your first sale!';
  if(sub_items)sub_items.textContent=mineS.length?`Across ${mineS.length} transaction${mineS.length!==1?'s':''}`:'—';
  const list=document.getElementById('ch-list');
  if(!list)return;
  if(!mineS.length){
    list.innerHTML=`<div style="text-align:center;padding:48px 20px;color:var(--g200)">
      <svg viewBox="0 0 24 24" fill="currentColor" style="width:44px;height:44px;opacity:.3;display:block;margin:0 auto 12px"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
      <p style="font-size:14px;font-weight:600;margin-bottom:4px">No sales yet</p>
      <p style="font-size:12px">Process your first sale in the POS screen!</p>
    </div>`;
    return;
  }
  list.innerHTML=`<table style="width:100%;border-collapse:collapse;min-width:480px">
    <thead><tr>
      <th style="text-align:left;font-size:12px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1.5px solid var(--g100)">Receipt</th>
      <th style="text-align:left;font-size:12px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1.5px solid var(--g100)">Time</th>
      <th style="text-align:left;font-size:12px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1.5px solid var(--g100)">Items</th>
      <th style="text-align:left;font-size:12px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1.5px solid var(--g100)">Payment</th>
      <th style="text-align:left;font-size:12px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1.5px solid var(--g100)">Total</th>
      <th style="text-align:left;font-size:12px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.8px;padding:10px 14px;border-bottom:1.5px solid var(--g100)">Action</th>
    </tr></thead>
    <tbody>${mineS.map((s,i)=>`<tr style="${i%2===1?'background:var(--g50)':''}">
      <td style="padding:11px 14px;border-bottom:1px solid var(--g50);font-weight:700;font-size:12px;font-family:monospace;color:var(--text-brand)">${s.num}</td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--g50);font-size:12px;color:var(--g400)">${s.time}</td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--g50)"><span class="badge bb">${s.items} item${s.items!==1?'s':''}</span></td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--g50);font-size:12px">${s.pay}</td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--g50);font-weight:800;color:var(--text-brand)">KES ${s.tot.toLocaleString()}</td>
      <td style="padding:11px 14px;border-bottom:1px solid var(--g50)">
        <button onclick="reprintSale(${s.key?`'${s.key}'`:mineRows[i].i})" style="font-size:12px;font-weight:700;padding:5px 10px;border-radius:6px;background:var(--pale);color:var(--text-brand);border:1px solid var(--mint);cursor:pointer;min-height:32px">🖨 Reprint</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function reprintSale(ref){
  const idx=typeof ref==='string'?cashierSales.findIndex(x=>x.key===ref):ref;
  const s=cashierSales[idx];if(!s)return;
  if(!isMgr()&&!mySales().some(r=>r.i===idx))return;
  CUR_SALE=s;
  const sd=new Date(s.date);
  document.getElementById('r-date').textContent=(isNaN(sd)?new Date():sd).toLocaleDateString('en-KE',{year:'numeric',month:'short',day:'numeric'});
  const rc=document.querySelector('.rpmeta-i:nth-child(3) .rpmv');if(rc)rc.textContent=s.cashier||'Staff';
  document.getElementById('r-pay').textContent=s.pay;
  document.getElementById('r-items').innerHTML=s.lines.map(l=>`<div class="rpi"><div><div class="rpin">${l.n}</div><div class="rpiq">× ${l.qty} @ KES ${l.r.toLocaleString()}</div></div><div class="rpit">KES ${l.t.toLocaleString()}</div></div>`).join('');
  document.getElementById('r-sub').textContent='KES '+s.sub.toLocaleString();
  document.getElementById('r-tot').textContent='KES '+s.tot.toLocaleString();
  fillReceiptExtras(s);
  const rvEl=document.querySelector('.rpmv');if(rvEl)rvEl.textContent=s.num;
  // Show thermal print panel directly (no need to open overlay)
  const txt=buildThermalReceipt(s);
  document.getElementById('thermal-preview').textContent=txt;
  const panel=document.getElementById('thermal-panel');
  panel.style.display='flex';
  updateBtUI();
}

function exportCashierCSV(){
  const mineS=mySales().map(r=>r.s);
  if(!mineS.length){showToast('No sales to export yet','error');return;}
  const rows=[['Receipt #','Time','Items','Payment','Amount (KES)','Total (KES)']];
  mineS.forEach(s=>rows.push([s.num,s.time,s.items,s.pay,'KES '+s.sub,'KES '+s.tot]));
  const totalGross=mineS.reduce((a,s)=>a+s.tot,0);
  const totTax=(totalGross*0.015).toFixed(2);
  rows.push([],[' TOTAL GROSS SALES','','','','','KES '+totalGross.toLocaleString()]);
  rows.push([' TURNOVER TAX (1.5%)','','','','','KES '+Number(totTax).toLocaleString()]);
  rows.push([' NET REVENUE','','','','','KES '+(totalGross-Number(totTax)).toLocaleString()]);
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  a.download='My-Sales-'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(a);a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},200);
  showToast('✅ Your sales exported','success');
}

// INVENTORY
let invFilter='all', invQuery='';
const INV_FILTERS=[['all','All stock'],['low','Low stock'],['out','Out of stock']];
function invStatus(p){return p.q===0?'out':p.q<=LOW_STOCK?'low':'ok';}
function setInvQuery(v){invQuery=v;renderInv();}
function cycleInvFilter(){const i=INV_FILTERS.findIndex(f=>f[0]===invFilter);invFilter=INV_FILTERS[(i+1)%INV_FILTERS.length][0];renderInv();}
function invVisible(){
  const q=invQuery.trim().toLowerCase();
  return PRODS.filter(p=>{
    if(invFilter!=='all'&&invStatus(p)!==invFilter)return false;
    return !q||p.n.toLowerCase().includes(q)||p.s.toLowerCase().includes(q)||p.c.toLowerCase().includes(q);
  });
}
const IC_PLUS='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const IC_EDIT='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>';
const IC_XFER='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>';
const IC_DEL='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z"/></svg>';
// In 'All shops' view show how many each shop holds
function shopSplit(p){return SCOPE==='ALL'?'<div style="font-size:12px;color:var(--g400);font-weight:500;white-space:nowrap">'+SHOP_IDS.map(i=>i+': '+p.qs[i]).join(' · ')+'</div>':'';}
function renderInv(){
  const tb=document.getElementById('inv-tbody');
  const cards=document.getElementById('inv-cards');
  const list=invVisible(), canEdit=isMgr(), canCat=canCatalog();
  const ab=document.getElementById('inv-add-btn'),ib=document.getElementById('inv-import-btn');
  if(ab)ab.style.display=canCat?'':'none';if(ib)ib.style.display=canCat?'':'none';
  const lbl=document.getElementById('inv-filter-lbl');if(lbl)lbl.textContent=INV_FILTERS.find(f=>f[0]===invFilter)[1];
  const sm=document.getElementById('inv-summary');
  if(sm){
    const low=PRODS.filter(p=>invStatus(p)==='low').length, out=PRODS.filter(p=>p.q===0).length, units=PRODS.reduce((s,p)=>s+p.q,0);
    sm.textContent=PRODS.length?`${scopeLabel()} · ${PRODS.length} product${PRODS.length===1?'':'s'} · ${units} unit${units===1?'':'s'} in stock · ${low} low · ${out} out of stock`:'';
  }
  const emptyMsg=PRODS.length?'No products match your search or filter':'No products yet — tap Add Product, or Import CSV from your stock sheet';
  if(tb){
    tb.innerHTML=list.map(p=>{
      const st=invStatus(p), sc=st==='out'?'br':st==='low'?'bw':'bg', sl=st==='out'?'Out of stock':st==='low'?'Low stock':'In stock';
      const snc=st==='out'?'color:var(--danger-text)':st==='low'?'color:var(--warn-text)':'';
      const act=canEdit?`<div style="display:flex;gap:5px"><div class="ab add" title="Receive stock" onclick="openStockModal(${p.id})">${IC_PLUS}</div>${canCat?`<div class="ab add" title="Transfer to another shop" onclick="openTransferModal(${p.id})">${IC_XFER}</div><div class="ab edit" title="Edit" onclick="openProdModal(${p.id})">${IC_EDIT}</div><div class="ab del" title="Delete" onclick="delProd(${p.id})">${IC_DEL}</div>`:''}</div>`:'';
      return`<tr><td><div style="display:flex;align-items:center;gap:10px"><div class="pt">${catIcon(p.c)}</div><div class="tn">${p.n}</div></div></td><td style="font-family:monospace;font-size:12px;color:var(--g400)">${p.s}</td><td><span class="badge bb">${p.c}</span></td><td style="font-weight:700;color:var(--text-brand)">KES ${p.r.toLocaleString()}</td><td style="color:var(--g600)">KES ${p.w.toLocaleString()}</td><td><span style="font-weight:700;${snc}">${p.q}</span>${shopSplit(p)}</td><td><span class="badge ${sc}">${sl}</span></td><td>${act}</td></tr>`;
    }).join('')||`<tr><td colspan="8" style="text-align:center;color:var(--g400);padding:28px;font-size:13px">${emptyMsg}</td></tr>`;
  }
  if(cards){
    cards.innerHTML=list.map(p=>{
      const st=invStatus(p), sc=st==='out'?'br':st==='low'?'bw':'bg', sl=st==='out'?'Out of stock':st==='low'?'Low stock':'In stock';
      const act=canEdit?`<div class="icact"><div class="icbtn ice-btn" onclick="openStockModal(${p.id})">${IC_PLUS.replace('<svg ','<svg style="width:14px;height:14px" ')}Stock</div>${canCat?`<div class="icbtn ice-btn" onclick="openTransferModal(${p.id})">${IC_XFER.replace('<svg ','<svg style="width:14px;height:14px" ')}Move</div><div class="icbtn ice-btn" onclick="openProdModal(${p.id})">${IC_EDIT.replace('<svg ','<svg style="width:14px;height:14px" ')}Edit</div><div class="icbtn icd-btn" onclick="delProd(${p.id})">${IC_DEL.replace('<svg ','<svg style="width:14px;height:14px" ')}Delete</div>`:''}</div>`:'';
      return`<div class="icard"><div class="ict"><div class="ice">${catIcon(p.c)}</div><div class="icinfo"><div class="icn">${p.n}</div><div class="ics">${p.s}</div></div><span class="badge ${sc}">${sl}</span></div><div class="icm"><div><div class="icml">Retail</div><div class="icmv" style="color:var(--text-brand)">KES ${p.r.toLocaleString()}</div></div><div><div class="icml">Cost</div><div class="icmv" style="color:var(--g600)">KES ${p.w.toLocaleString()}</div></div><div><div class="icml">Stock</div><div class="icmv" style="color:${st==='out'?'var(--danger)':st==='low'?'var(--warn)':'var(--ink)'}">${p.q}</div>${shopSplit(p)}</div></div>${act}</div>`;
    }).join('')||`<div style="text-align:center;color:var(--g400);padding:28px;font-size:13px">${emptyMsg}</div>`;
  }
}

// ── INVENTORY: add / edit / delete / receive stock ─────────────────────
function refreshStockViews(){
  if(posCat!=='All'&&!PRODS.some(p=>p.c===posCat))posCat='All';
  renderCatPills();renderProds();renderInv();renderLive();
  try{renderTransfers();renderShopCompare();renderReceipts();}catch(_){}
}
// Keep the open cart consistent with the current stock list
function syncCart(){
  cart=cart.filter(i=>{
    const p=PRODS.find(x=>x.id===i.id);
    if(!p||p.q<1)return false;
    Object.assign(i,{n:p.n,e:p.e,r:p.r,s:p.s,c:p.c,q:p.q});
    i.qty=Math.min(i.qty,p.q);
    return true;
  });
  renderCart();
}
function nextProdId(){return CL.on?CL.newId():PRODS.reduce((m,p)=>Math.max(m,p.id),0)+1;}
function defaultSku(pid,used){
  if(!CL.on)return 'MAC-'+String(pid).padStart(4,'0');
  const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for(let k=0;k<60;k++){
    let c='MAC-';for(let i=0;i<5;i++)c+=A[Math.floor(Math.random()*A.length)];
    if(!PRODS.some(x=>String(x.s).toLowerCase()===c.toLowerCase())&&!(used&&used.has(c)))return c;
  }
  return 'MAC-'+pid;
}
// Cloud mode: only all-shops managers change the product list or move stock between shops (the server rules say so too)
function canCatalog(){return !CL.on||!userShop();}
function needCatalog(){if(isMgr()&&canCatalog())return true;showToast(isMgr()?'⛔ Only an all-shops manager can change the product list':'⛔ Manager access required','error');return false;}
const cloudQty=(sh,id)=>STK[sh+'_'+id]||0;           // raw stock (can be below 0 if two tills sold the last unit offline)
const cloudFail=what=>e=>{console.error(e);showToast('⚠️ '+what+' — '+CL.friendly(e),'error',7000);};
const invClean=s=>String(s==null?'':s).replace(/[<>"`\\]/g,'').replace(/\s+/g,' ').trim();

function openProdModal(id){
  if(!needCatalog())return;
  const p=id!=null?PRODS.find(x=>x.id===id):null;
  const set=(k,v)=>{document.getElementById(k).value=v;};
  document.getElementById('pm-title').textContent=p?'Edit Product':'Add Product';
  set('pm-id',p?p.id:'');set('pm-name',p?p.n:'');set('pm-sku',p?p.s:'');set('pm-cat',p?p.c:'');
  set('pm-retail',p?p.r:'');set('pm-cost',p?p.w:'');set('pm-qty',p?p.q:'');
  const qi=document.getElementById('pm-qty'),ql=document.getElementById('pm-qty-l');
  const all=SCOPE==='ALL';
  if(ql)ql.textContent='In stock — '+shopName(SCOPE);
  if(qi)qi.closest('.ff').style.display=all?'none':'';
  const row=document.getElementById('pm-qs-row');
  if(row){row.style.display=all?'':'none';
    document.getElementById('pm-qs-in').innerHTML=SHOPS.map(x=>`<div class="ff" style="margin:0"><label style="font-size:12px">${pfEsc(x.name)}</label><input id="pm-qs-${x.id}" type="number" inputmode="numeric" min="0" step="1" value="${p?p.qs[x.id]:0}"></div>`).join('');}
  const cats=[...new Set([...Object.keys(CAT_EMOJI).filter(k=>k!=='Household'),...PRODS.map(x=>x.c)])];
  document.getElementById('pm-cats').innerHTML=cats.map(c=>`<option value="${c}">`).join('');
  document.getElementById('pm-err').textContent='';
  document.getElementById('prod-modal').classList.add('show');
  setTimeout(()=>document.getElementById('pm-name').focus(),60);
}
function closeProdModal(){document.getElementById('prod-modal').classList.remove('show');}
function saveProd(){
  if(!needCatalog())return;
  const g=k=>document.getElementById(k).value;
  const err=m=>{document.getElementById('pm-err').textContent=m;};
  const id=g('pm-id'), name=invClean(g('pm-name')), cat=invClean(g('pm-cat'))||'General';
  let sku=invClean(g('pm-sku'));
  const r=parseFloat(g('pm-retail')), w=parseFloat(g('pm-cost')), q=g('pm-qty')===''?0:Number(g('pm-qty'));
  if(!name)return err('Enter the product name.');
  if(!(r>0))return err('Enter a retail price above 0.');
  if(g('pm-cost')==='')return err('Enter the cost price (what you paid for it) — profit reports need it.');
  if(isNaN(w)||w<0)return err('Cost must be 0 or more.');
  const qsIn={};if(SCOPE==='ALL'){for(const i of SHOP_IDS){const v=document.getElementById('pm-qs-'+i).value,n=v===''?0:Number(v);if(!Number.isInteger(n)||n<0)return err('Stock for '+shopName(i)+' must be a whole number, 0 or more.');qsIn[i]=n;}}
  else if(!Number.isInteger(q)||q<0)return err('Stock must be a whole number, 0 or more.');
  const editing=id!=='', pid=editing?Number(id):nextProdId();
  if(!sku)sku=defaultSku(pid);
  if(PRODS.some(x=>x.id!==pid&&x.n.toLowerCase()===name.toLowerCase()))return err('A product with this name already exists.');
  if(PRODS.some(x=>x.id!==pid&&x.s.toLowerCase()===sku.toLowerCase()))return err('SKU "'+sku+'" is already used by another product.');
  const cur=editing?PRODS.find(x=>x.id===pid):null;
  if(editing&&!cur)return err('This product no longer exists.');
  const data={n:name,s:sku,c:cat,e:CAT_ICON[cat]||'inventory_2',r:Math.round(r*100)/100,w:Math.round(w*100)/100};
  if(CL.on){   // cloud: write to Firebase; the live listener updates every screen (on every phone) from the local copy at once
    const o={id:pid,isNew:!editing,fields:{n:name,s:sku,c:cat,r:data.r,w:data.w}};
    if(!editing)o.qs=SCOPE==='ALL'?qsIn:{[SCOPE]:q};
    else{o.delta={};if(SCOPE==='ALL')SHOP_IDS.forEach(i=>{o.delta[i]=qsIn[i]-cloudQty(i,pid);});else o.delta[SCOPE]=q-cloudQty(SCOPE,pid);}
    CL.saveProduct(o).catch(cloudFail('Product not saved'));
    closeProdModal();showToast((editing?'✅ Product updated':'✅ Product added')+(navigator.onLine?'':' (offline — will sync)'),'success');
    return;
  }
  const setStock=pr=>{if(SCOPE==='ALL')SHOP_IDS.forEach(i=>{pr.qs[i]=qsIn[i];});else pr.q=q;};
  if(cur){Object.assign(cur,data);setStock(cur);}
  else{const np=mkProd(Object.assign({id:pid},data));setStock(np);PRODS.push(np);}
  saveData();syncCart();refreshStockViews();closeProdModal();
  showToast(editing?'✅ Product updated':'✅ Product added','success');
}
function delProd(id){
  if(!needCatalog())return;
  const p=PRODS.find(x=>x.id===id);if(!p)return;
  if(!confirm('Delete "'+p.n+'" from inventory?\nThis removes it from ALL shops ('+SHOP_IDS.map(i=>shopName(i)+': '+p.qs[i]).join(', ')+').\nPast sales and receipts are kept.'))return;
  if(CL.on){CL.deleteProduct(p.id).catch(cloudFail('Product not deleted'));showToast('🗑️ Product deleted');return;}
  PRODS.splice(PRODS.indexOf(p),1);
  saveData();syncCart();refreshStockViews();
  showToast('🗑️ Product deleted');
}
let stockTarget=null;
function openStockModal(id){
  if(!needMgr())return;
  const p=PRODS.find(x=>x.id===id);if(!p)return;
  stockTarget=id;
  const ss=document.getElementById('sm-shop');
  ss.innerHTML=SHOPS.map(x=>`<option value="${x.id}"${x.id===(SCOPE==='ALL'?LAST_SHOP:SCOPE)?' selected':''}>${pfEsc(x.name)}</option>`).join('');
  ss.disabled=scopeLocked();
  stockShopChanged();
  document.getElementById('sm-qty').value='';
  document.getElementById('sm-err').textContent='';
  document.getElementById('stock-modal').classList.add('show');
  setTimeout(()=>document.getElementById('sm-qty').focus(),60);
}
function stockShopChanged(){
  const p=PRODS.find(x=>x.id===stockTarget);if(!p)return;
  const sh=document.getElementById('sm-shop').value;
  document.getElementById('sm-info').textContent=p.n+' — '+p.qs[sh]+' in stock now at '+shopName(sh);
}
function closeStockModal(){document.getElementById('stock-modal').classList.remove('show');stockTarget=null;}
function applyStock(){
  if(!needMgr())return;
  const p=PRODS.find(x=>x.id===stockTarget);if(!p)return closeStockModal();
  const q=Number(document.getElementById('sm-qty').value);
  if(!Number.isInteger(q)||q<1){document.getElementById('sm-err').textContent='Enter a whole number of units, 1 or more.';return;}
  let sh=document.getElementById('sm-shop').value;if(userShop())sh=userShop();
  if(!SHOP_IDS.includes(sh))return;
  if(CL.on){
    CL.receiveStock(sh,{id:p.id,n:p.n},q,{uid:currentUser.id,name:currentUser.name}).catch(cloudFail('Stock not saved'));
    closeStockModal();showToast('✅ +'+q+' received at '+shopName(sh)+(navigator.onLine?'':' (offline — will sync)'),'success');
    return;
  }
  p.qs[sh]+=q;
  saveData();syncCart();refreshStockViews();closeStockModal();
  showToast('✅ +'+q+' received at '+shopName(sh)+' — '+p.qs[sh]+' in stock','success');
}
// ── STOCK TRANSFER between shops ───────────────────────
let xferTarget=null;
function xferShopOpts(sel,skip){return SHOPS.filter(x=>x.id!==skip).map(x=>`<option value="${x.id}"${x.id===sel?' selected':''}>${pfEsc(x.name)}</option>`).join('');}
function openTransferModal(id){
  if(!needCatalog())return;
  const p=PRODS.find(x=>x.id===id);if(!p)return;
  xferTarget=id;
  const from=SCOPE!=='ALL'?SCOPE:(SHOP_IDS.find(i=>p.qs[i]>0)||LAST_SHOP);
  const f=document.getElementById('tf-from'),t=document.getElementById('tf-to');
  f.innerHTML=SHOPS.map(x=>`<option value="${x.id}"${x.id===from?' selected':''}>${pfEsc(x.name)}</option>`).join('');
  if(scopeLocked())f.disabled=true;else f.disabled=false;
  document.getElementById('tf-name').textContent=p.n;
  document.getElementById('tf-qty').value='';
  document.getElementById('tf-err').textContent='';
  xferFromChanged();
  document.getElementById('transfer-modal').classList.add('show');
  setTimeout(()=>document.getElementById('tf-qty').focus(),60);
}
function xferFromChanged(){
  const p=PRODS.find(x=>x.id===xferTarget);if(!p)return;
  const from=document.getElementById('tf-from').value,t=document.getElementById('tf-to'),prev=t.value;
  t.innerHTML=xferShopOpts(prev&&prev!==from?prev:null,from);
  if(scopeLocked()){/* shop managers can send from their own shop to any other */}
  document.getElementById('tf-have').textContent=SHOPS.map(x=>x.name+': '+p.qs[x.id]).join('   ·   ');
  document.getElementById('tf-qty').max=p.qs[from];
}
function closeTransferModal(){document.getElementById('transfer-modal').classList.remove('show');xferTarget=null;}
function applyTransfer(){
  if(!needCatalog())return;
  const p=PRODS.find(x=>x.id===xferTarget);if(!p)return closeTransferModal();
  const err=m=>{document.getElementById('tf-err').textContent=m;};
  const from=document.getElementById('tf-from').value,to=document.getElementById('tf-to').value,q=Number(document.getElementById('tf-qty').value);
  if(userShop()&&from!==userShop())return err('You can only send stock out of your own shop.');
  if(!SHOP_IDS.includes(from)||!SHOP_IDS.includes(to)||from===to)return err('Choose two different shops.');
  if(!Number.isInteger(q)||q<1)return err('Enter a whole number of units, 1 or more.');
  if(q>p.qs[from])return err(shopName(from)+' only has '+p.qs[from]+' of this item.');
  if(CL.on){
    CL.transferStock(from,to,{id:p.id,n:p.n},q,{uid:currentUser.id,name:currentUser.name}).catch(cloudFail('Transfer not saved'));
    closeTransferModal();showToast('✅ Moved '+q+' × '+p.n+': '+shopName(from)+' → '+shopName(to)+(navigator.onLine?'':' (offline — will sync)'),'success',4000);
    return;
  }
  p.qs[from]-=q;p.qs[to]+=q;
  TRANSFERS.unshift({id:'t'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),date:new Date().toISOString(),pid:p.id,n:p.n,from,to,qty:q,by:currentUser?currentUser.name:''});
  if(TRANSFERS.length>500)TRANSFERS.length=500;
  saveData();syncCart();refreshStockViews();renderTransfers();closeTransferModal();
  showToast('✅ Moved '+q+' × '+p.n+': '+shopName(from)+' → '+shopName(to),'success',4000);
}
function renderTransfers(){
  const box=document.getElementById('xfer-log');if(!box)return;
  const card=box.closest('.card');if(card)card.style.display=(CL.on&&userShop())?'none':'';   // cloud: only all-shops managers see transfers
  const list=TRANSFERS.filter(t=>!userShop()||t.from===userShop()||t.to===userShop()).slice(0,15);
  box.innerHTML=list.length?'<table style="min-width:440px"><thead><tr><th>When</th><th>Product</th><th>Qty</th><th>From → To</th><th>By</th></tr></thead><tbody>'+list.map(t=>`<tr><td style="white-space:nowrap">${pfEsc(new Date(t.date).toLocaleString('en-KE',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))}</td><td style="font-weight:600">${pfEsc(t.n)}</td><td>${t.qty}</td><td>${pfEsc(shopName(t.from))} → ${pfEsc(shopName(t.to))}</td><td>${pfEsc(t.by)}</td></tr>`).join('')+'</tbody></table>':'<div style="color:var(--g400);font-size:12px;padding:6px 0">No transfers yet. Use the ⇄ button on a product to move stock between shops.</div>';
}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeProdModal();closeStockModal();closeTransferModal();}
  if(e.key==='Enter'&&document.getElementById('transfer-modal').classList.contains('show')){e.preventDefault();applyTransfer();return;}
  if(e.key==='Enter'){
    if(document.getElementById('prod-modal').classList.contains('show')){e.preventDefault();saveProd();}
    else if(document.getElementById('stock-modal').classList.contains('show')){e.preventDefault();applyStock();}
  }
});

// ── CSV import / export (stock-taking sheet) ───────────────────────────
function macDownload(name,text,mime){
  const blob=new Blob([text],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},300);
}
function macYMD(){return new Date().toISOString().slice(0,10);}
function csvParse(text){
  text=text.replace(/^\ufeff/,'');
  const first=text.split(/\r?\n/)[0]||'';
  const delim=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else q=false;}else cell+=c;}
    else if(c==='"')q=true;
    else if(c===delim){row.push(cell);cell='';}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);cell='';rows.push(row);row=[];}
    else cell+=c;
  }
  if(cell!==''||row.length){row.push(cell);rows.push(row);}
  return rows.filter(r=>r.some(c=>String(c).trim()!==''));
}
function exportInvCSV(){
  if(!PRODS.length){showToast('No products to export yet','error');return;}
  const q=v=>'"'+String(v).replace(/"/g,'""')+'"';
  const all=SCOPE==='ALL';
  const rows=[['Name','SKU','Category','Retail (KES)','Cost (KES)','Stock'].concat(all?SHOPS.map(x=>x.name):[])];
  PRODS.forEach(p=>rows.push([p.n,p.s,p.c,p.r,p.w,p.q].concat(all?SHOP_IDS.map(i=>p.qs[i]):[])));
  macDownload('Macrome-inventory-'+scopeLabel().replace(/[^A-Za-z0-9]+/g,'-')+'-'+macYMD()+'.csv','\ufeff'+rows.map(r=>r.map(q).join(',')).join('\r\n'),'text/csv;charset=utf-8;');
  showToast('✅ Inventory exported','success');
}
function importInvCSV(input){
  if(!needCatalog())return;
  if(!needShop()){input.value='';return;}
  const f=input.files&&input.files[0];input.value='';
  if(!f)return;
  const rd=new FileReader();
  rd.onerror=()=>showToast('❌ Could not read that file','error');
  rd.onload=()=>{
    try{
      const rows=csvParse(String(rd.result));
      if(!rows.length){showToast('That file is empty','error');return;}
      const norm=s=>String(s).toLowerCase().replace(/[^a-z]/g,'');
      const SYN={n:['name','product','productname','item','itemname','description'],s:['sku','code','itemcode','productcode','barcode'],c:['category','cat','type','group'],r:['retail','retailkes','retailprice','price','sellingprice','selling','sp','unitprice'],w:['cost','costkes','costprice','buying','buyingprice','bp','purchaseprice'],q:['qty','quantity','stock','instock','onhand','units','count']};
      let idx={n:0,s:1,c:2,r:3,w:4,q:5}, start=0;
      const head=rows[0].map(norm), found={};
      Object.keys(SYN).forEach(k=>{const j=head.findIndex(h=>SYN[k].includes(h));if(j>=0)found[k]=j;});
      if(found.n!==undefined){idx=Object.assign({n:-1,s:-1,c:-1,r:-1,w:-1,q:-1},found);start=1;}
      const cell=(r,k)=>idx[k]>=0&&idx[k]<r.length?r[idx[k]]:'';
      const num=v=>{const x=parseFloat(String(v).replace(/[^0-9.\-]/g,''));return isNaN(x)?NaN:x;};
      const adds=[], updates=[], seen=new Set();
      let skipped=0;
      for(let i=start;i<rows.length;i++){
        const r=rows[i], name=invClean(cell(r,'n'));
        if(!name){skipped++;continue;}
        const price=num(cell(r,'r'));
        if(!(price>0)){skipped++;continue;}
        const cost=cell(r,'w')===''?0:num(cell(r,'w'));
        const qty=cell(r,'q')===''?0:Math.floor(num(cell(r,'q')));
        if(isNaN(cost)||cost<0||isNaN(qty)||qty<0){skipped++;continue;}
        const cat=invClean(cell(r,'c'))||'General', sku=invClean(cell(r,'s'));
        const key=(sku||name).toLowerCase();
        if(seen.has(key)){skipped++;continue;}
        seen.add(key);
        const rec={n:name,s:sku,c:cat,r:Math.round(price*100)/100,w:Math.round(cost*100)/100,q:qty};
        const ex=PRODS.find(p=>(sku&&p.s.toLowerCase()===sku.toLowerCase())||(!sku&&p.n.toLowerCase()===name.toLowerCase()))
                 ||PRODS.find(p=>p.n.toLowerCase()===name.toLowerCase());
        if(ex){
          const clash=sku&&PRODS.some(p=>p!==ex&&p.s.toLowerCase()===sku.toLowerCase());
          if(clash){skipped++;continue;}
          updates.push([ex,rec]);
        }else adds.push(rec);
      }
      if(!adds.length&&!updates.length){showToast('No valid rows found — need at least a name and retail price','error',5000);return;}
      if(!confirm('Import from "'+f.name+'" into '+shopName(SCOPE)+'?\n(Stock quantities go to this shop only; prices apply to every shop.)\n\n• '+adds.length+' new product'+(adds.length===1?'':'s')+'\n• '+updates.length+' existing product'+(updates.length===1?'':'s')+' updated (price and stock replaced)\n• '+skipped+' row'+(skipped===1?'':'s')+' skipped'))return;
      if(CL.on){
        const L=(v,n)=>String(v).slice(0,n), list=[], used=new Set();
        updates.forEach(([p,rec])=>list.push({id:p.id,isNew:false,fields:{n:L(rec.n,80),s:L(rec.s||p.s,30),c:L(rec.c,40),r:rec.r,w:rec.w},delta:{[SCOPE]:rec.q-cloudQty(SCOPE,p.id)}}));
        adds.forEach(rec=>{const id=nextProdId(),sku=L(rec.s||defaultSku(id,used),30);used.add(sku);list.push({id,isNew:true,fields:{n:L(rec.n,80),s:sku,c:L(rec.c,40),r:rec.r,w:rec.w},qs:{[SCOPE]:rec.q}});});
        CL.importProducts(list).then(()=>showToast('✅ Import saved to the cloud','success',3000)).catch(cloudFail('Import not saved'));
        showToast('⏳ Importing '+adds.length+' new, '+updates.length+' updated…','success',3500);
        return;
      }
      updates.forEach(([p,rec])=>{p.n=rec.n;p.c=rec.c;p.r=rec.r;p.w=rec.w;p.q=rec.q;if(rec.s)p.s=rec.s;});
      adds.forEach(rec=>{
        const id=nextProdId();
        const np=mkProd({id,n:rec.n,s:rec.s||defaultSku(id),c:rec.c,e:CAT_ICON[rec.c]||'inventory_2',r:rec.r,w:rec.w});np.q=rec.q;PRODS.push(np);
      });
      saveData();syncCart();refreshStockViews();
      showToast('✅ Imported: '+adds.length+' new, '+updates.length+' updated','success',4000);
    }catch(e){console.error(e);showToast('❌ Could not import that file','error');}
  };
  rd.readAsText(f);
}

// CHARTS
function initDash(){
  const el=document.getElementById('dashBar');if(!el)return;
  const W=macStats().weeks;
  if(MAC_CH.dash){try{MAC_CH.dash.destroy();}catch(e){}}
  MAC_CH.dash=new Chart(el,{type:'bar',data:{labels:W.map(w=>w.label),datasets:[{label:'Revenue',data:W.map(w=>w.gross),backgroundColor:'#150857',borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{font:{size:10},color:'#706B88'}},y:{beginAtZero:true,grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:{size:10},color:'#706B88',callback:v=>v>=1000?Math.round(v/1000)+'K':v}}}}});
}
function initRep(){
  const C=(id,cfg)=>{const el=document.getElementById(id);if(!el)return;if(MAC_CH[id]){try{MAC_CH[id].destroy();}catch(e){}}MAC_CH[id]=new Chart(el,cfg);};
  const R=macStats(), W=R.weeks;
  const ax={x:{grid:{display:false},ticks:{font:{size:10},color:'#706B88'}},y:{beginAtZero:true,grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:{size:10},color:'#706B88',callback:v=>v>=1000?Math.round(v/1000)+'K':v}}};
  C('repBar',{type:'bar',data:{labels:W.map(w=>w.label),datasets:[{label:'Revenue',data:W.map(w=>w.gross),backgroundColor:'#150857',borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:ax}});
  C('repDonut',{type:'doughnut',data:{labels:['M-Pesa','Cash','Card'],datasets:[{data:[R.pay.mpesa,R.pay.cash,R.pay.card],backgroundColor:['#150857','#F71D6D','#2E14B0'],borderWidth:0,hoverOffset:4}]},options:{responsive:false,cutout:'68%',plugins:{legend:{display:false}}}});
  C('repStack',{type:'bar',data:{labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],datasets:[{label:'Sales',data:R.days,backgroundColor:'#F71D6D',borderRadius:[4,4,0,0],borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:ax}});
  const cats=R.cats.length?R.cats:[['—',0]];
  C('repCat',{type:'bar',data:{labels:cats.map(x=>x[0]),datasets:[{label:'KES',data:cats.map(x=>x[1]),backgroundColor:['#0F063F','#150857','#220E89','#2E14B0','#F71D6D','#FF4F90'],borderRadius:5,borderSkipped:false}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:{size:9},color:'#706B88',callback:v=>v>=1000?Math.round(v/1000)+'K':v}},y:{grid:{display:false},ticks:{font:{size:10},color:'#38344D'}}}}});
}

// DARK MODE
function toggleDark(){
  const html=document.documentElement;
  const cur=html.getAttribute('data-theme');
  const isDark=cur==='dark'||(cur===null&&window.matchMedia('(prefers-color-scheme:dark)').matches);
  const next=isDark?'light':'dark';
  html.setAttribute('data-theme',next);
  try{localStorage.setItem('macrome-theme',next);}catch(e){}
}
// Restore saved theme on load
(function(){
  try{const saved=localStorage.getItem('macrome-theme');if(saved)document.documentElement.setAttribute('data-theme',saved);}catch(e){}
})();


// ══ TOAST ══════════════════════════════════════════════
let toastTimer=0;
function showToast(msg,type,duration,action){
  duration=duration||3000;
  const t=document.getElementById('toast');
  clearTimeout(toastTimer);
  {const s=splitLeadIcon(msg);t.textContent='';if(s.icon)t.insertAdjacentHTML('afterbegin',MI(s.icon,'mi-inline'));t.appendChild(document.createTextNode(s.text));}
  if(action){
    const b=document.createElement('button');b.type='button';b.className='toast-act';b.textContent=action.label||'Undo';
    b.onclick=()=>{clearTimeout(toastTimer);t.classList.remove('show');try{action.fn();}catch(e){console.error(e);}};
    t.appendChild(b);
  }
  t.className='toast '+(type||'')+(action?' has-act':'');
  t.setAttribute('role',type==='error'?'alert':'status');t.setAttribute('aria-live',type==='error'?'assertive':'polite');
  void t.offsetWidth;t.classList.add('show');
  toastTimer=setTimeout(()=>t.classList.remove('show'),duration);
}

// ══ PDF LOADER ═════════════════════════════════════════
function showLoader(){document.getElementById('pdfLoader').classList.add('show');}
function hideLoader(){document.getElementById('pdfLoader').classList.remove('show');}

// ══ RECEIPT — PRINT ════════════════════════════════════
// ══════════════════════════════════════════════════════════
// THERMAL PRINTING — P58E Bluetooth (58mm, 32 chars/line)
// ══════════════════════════════════════════════════════════

let CUR_SALE=null; // the sale on screen / being reprinted (set when a sale is recorded or reprinted)

const THERMAL = {
  device: null,
  characteristic: null,
  candidates: [],   // every writable Bluetooth channel found on the printer
  idx: 0,           // which one is in use
  connected: false
};

// Macrome sale -> shape used by receipt.js
function macromeToSale(s){
  const pay=String(s.pay||'').replace(/[^\x20-\x7E]/g,'').trim()||'Cash'; // drop the emoji from "Cash 💵"
  return{
    receiptNumber:String(s.num||''),
    cashierName:s.cashier||'Staff',
    date:s.date,
    items:(s.lines||[]).map(l=>({product:{name:l.n,sellingPrice:l.r},quantity:l.qty})),
    subtotal:s.sub,discount:0,total:s.tot,
    shopName:shopName(saleShop(s)),shopLoc:(SHOPS.find(x=>x.id===saleShop(s))||{}).loc||'',
    paymentMethod:pay,
    reference:s.ref||undefined,                       // M-Pesa code, if entered
    amountPaid:s.paid==null?undefined:s.paid,        // cash received, if entered (else no Paid/Change lines)
    change:s.change==null?0:s.change
  };
}

function thermalWhen(sale){
  const d=new Date(sale.date);const t=isNaN(d)?new Date():d;
  const two=n=>(n<10?'0':'')+n;
  return{date:two(t.getDate())+'/'+two(t.getMonth()+1)+'/'+t.getFullYear(),time:two(t.getHours())+':'+two(t.getMinutes())};
}

// Plain-text version of the receipt (preview, .txt download, Android bridge). Same layout as the ESC/POS bytes.
function buildThermalReceipt(sale){
  const R=NotifyReceipt,c=R.config,W=c.cols,sh=c.shop,cur=c.currency;
  const x=macromeToSale(sale),when=thermalWhen(x);
  const L=[];
  const centre=t=>R.wrap(t,W).forEach(l=>L.push(' '.repeat(Math.max(0,Math.floor((W-l.length)/2)))+l));
  const rule=ch=>L.push(new Array(W+1).join(ch||'-'));
  centre(sh.name);sh.lines.forEach(centre);centre(x.shopName+(x.shopLoc?' - '+x.shopLoc:''));rule();
  L.push(R.pad('Receipt:',x.receiptNumber,W));
  L.push(R.pad('Date:',when.date,W));
  L.push(R.pad('Time:',when.time,W));
  L.push(R.pad('Cashier:',x.cashierName,W));
  rule();
  x.items.forEach(it=>{
    R.wrap(it.product.name,W).forEach(l=>L.push(l));
    L.push(R.pad('  '+it.quantity+' x '+R.money(it.product.sellingPrice),R.money(it.product.sellingPrice*it.quantity),W));
  });
  rule();
  L.push(R.pad('Subtotal:',cur+' '+R.money(x.subtotal),W));
  L.push(R.pad('TOTAL:',cur+' '+R.money(x.total),W));
  L.push(R.pad('Payment:',x.paymentMethod.toUpperCase(),W));
  if(x.reference)L.push(R.pad('Ref:',x.reference,W));
  if(x.amountPaid!=null){L.push(R.pad('Paid:',cur+' '+R.money(x.amountPaid),W));L.push(R.pad('Change:',cur+' '+R.money(x.change),W));}
  rule();
  sh.footer.forEach(centre);
  L.push('','','');
  return L.join('\n');
}

// Styled receipt for the normal browser/OS print dialog (58mm roll). Everything is inline-styled so it
// does not depend on the app's CSS.
function receiptHTML(sale){
  const R=NotifyReceipt,c=R.config,sh=c.shop,cur=c.currency;
  const x=macromeToSale(sale),when=thermalWhen(x);
  const e=v=>String(v==null?'':v).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  const row=(a,b,st)=>'<div style="display:flex;justify-content:space-between;gap:6px;'+(st||'')+'"><span>'+e(a)+'</span><span style="white-space:nowrap">'+e(b)+'</span></div>';
  const rule='<div style="border-top:1px dashed #000;margin:4px 0"></div>';
  let h='<style>html,body{height:auto!important;overflow:visible!important}</style>';
  h+='<div style="font:11px/1.35 \'Courier New\',monospace;color:#000;width:100%">';
  h+='<div style="text-align:center;font-weight:bold;font-size:13px">'+e(sh.name)+'</div>';
  sh.lines.forEach(l=>{h+='<div style="text-align:center">'+e(l)+'</div>';});
  h+='<div style="text-align:center;font-weight:bold">'+e(x.shopName+(x.shopLoc?' - '+x.shopLoc:''))+'</div>';
  h+=rule+row('Receipt:',x.receiptNumber)+row('Date:',when.date)+row('Time:',when.time)+row('Cashier:',x.cashierName)+rule;
  x.items.forEach(it=>{
    const u=it.product.sellingPrice,q=it.quantity;
    h+='<div style="margin-top:2px;word-break:break-word">'+e(it.product.name)+'</div>'+row('  '+q+' x '+R.money(u),R.money(u*q));
  });
  h+=rule+row('Subtotal:',cur+' '+R.money(x.subtotal));
  h+=row('TOTAL:',cur+' '+R.money(x.total),'font-weight:bold;font-size:13px');
  h+=row('Payment:',x.paymentMethod.toUpperCase());
  if(x.reference)h+=row('Ref:',x.reference);
  if(x.amountPaid!=null)h+=row('Paid:',cur+' '+R.money(x.amountPaid))+row('Change:',cur+' '+R.money(x.change));
  h+=rule;
  sh.footer.forEach(l=>{h+='<div style="text-align:center">'+e(l)+'</div>';});
  return h+'</div>';
}

// Collect current receipt data from DOM / sale store
function getCurrentSaleData(){
  if(CUR_SALE)return CUR_SALE;
  const receiptEl=document.querySelector('.rpmv');
  const num=receiptEl?receiptEl.textContent.trim():'';
  const dateEl=document.getElementById('r-date');
  const payEl=document.getElementById('r-pay');
  const subEl=document.getElementById('r-sub');
  const totEl=document.getElementById('r-tot');
  const cashierEl=document.querySelector('.rpmeta-i:nth-child(3) .rpmv');
  // Parse items from DOM
  const itemEls=document.querySelectorAll('#r-items .rpi');
  const lines=[];
  itemEls.forEach(el=>{
    const name=el.querySelector('.rpin')?el.querySelector('.rpin').textContent.trim():'';
    const qtyLine=el.querySelector('.rpiq')?el.querySelector('.rpiq').textContent.trim():'';
    const totTxt=el.querySelector('.rpit')?el.querySelector('.rpit').textContent.trim():'';
    // parse "× 2 @ KES 150"
    const qm=qtyLine.match(/×\s*(\d+)\s*@\s*KES\s*([\d,]+)/);
    const tm=totTxt.match(/KES\s*([\d,]+)/);
    lines.push({
      n:name,
      qty:qm?parseInt(qm[1]):1,
      r:qm?parseInt(qm[2].replace(/,/g,'')):0,
      t:tm?parseInt(tm[1].replace(/,/g,'')):0
    });
  });
  const sub=subEl?parseInt(subEl.textContent.replace(/[^0-9]/g,'')):0;
  const tot=totEl?parseInt(totEl.textContent.replace(/[^0-9]/g,'')):0;
  return{
    num,
    date:dateEl?dateEl.textContent.trim():new Date().toLocaleDateString('en-KE'),
    pay:payEl?payEl.textContent.trim():'',
    cashier:cashierEl?cashierEl.textContent.trim():'Staff',
    sub,tot,lines
  };
}

// ── PANEL OPEN / CLOSE ────────────────────────────────────
// ── Is native Android bridge available? ───────────────────
function hasAndroidBridge(){
  return typeof window.Android !== 'undefined' && typeof window.Android.printText === 'function';
}

function openPrintPanel(){
  const rb=document.getElementById('raw-print-btn');
  if(rb){const a=NotifyReceipt.available();rb.style.display=(a.indexOf('usb')>-1||a.indexOf('serial')>-1)?'flex':'none';}
  const sale=getCurrentSaleData();
  const txt=buildThermalReceipt(sale);
  document.getElementById('thermal-preview').textContent=txt;
  const panel=document.getElementById('thermal-panel');
  panel.style.display='flex';
  setTimeout(()=>panel.style.opacity='1',10);
  updateBtUI();
}
function closePrintPanel(){
  const panel=document.getElementById('thermal-panel');
  panel.style.display='none';
  // Close receipt overlay and return to dashboard
  const overlay=document.getElementById('overlay');
  if(overlay) overlay.classList.remove('show');
  if(typeof clearCart==='function') clearCart();
  const dashNav=document.querySelector('[data-page=dashboard]');
  if(typeof go==='function' && dashNav) go('dashboard', dashNav);
}

// ── BT STATUS UI ──────────────────────────────────────────
function updateBtUI(){
  setTimeout(updateBtDiag,0);
  const dot=document.getElementById('bt-dot');
  const txt=document.getElementById('bt-status-text');
  const sub=document.getElementById('bt-status-sub');
  const btn=document.getElementById('bt-main-btn');
  const lbl=document.getElementById('bt-main-label');
  const bar=document.getElementById('bt-status-bar');
  if(!dot||!btn)return;

  // ── Native Android bridge path ──
  if(hasAndroidBridge()){
    const connected = window.Android.isPrinterConnected();
    const name      = window.Android.getPrinterName() || 'P58E';
    if(connected){
      dot.style.background='#22c55e';
      bar.style.borderColor='#bbf7d0';bar.style.background='#f0fdf4';
      txt.textContent='Connected — '+name;
      sub.textContent='Ready to print';
      btn.style.background='#16a34a';
      lbl.textContent='Print Now';
      btn.querySelector('span').innerHTML=MI('print');
    } else {
      dot.style.background='var(--g200)';
      bar.style.borderColor='var(--g100)';bar.style.background='var(--g50)';
      txt.textContent='Not connected';
      sub.textContent='Tap to select your P58E printer';
      btn.style.background='var(--green)';
      lbl.textContent='Select Printer';
      btn.querySelector('span').innerHTML=MI('bluetooth_searching');
    }
    return;
  }

  // ── Web Bluetooth path (browser fallback) ──
  if(THERMAL.connected && THERMAL.characteristic){
    dot.style.background='#22c55e';
    bar.style.borderColor='#bbf7d0';bar.style.background='#f0fdf4';
    txt.textContent='Connected — '+(THERMAL.device?THERMAL.device.name:'P58E');
    sub.textContent='Ready to print';
    btn.style.background='#16a34a';
    lbl.textContent='Print Now';
    btn.querySelector('span').innerHTML=MI('print');
  } else {
    dot.style.background='var(--g200)';
    bar.style.borderColor='var(--g100)';bar.style.background='var(--g50)';
    txt.textContent='Not connected';
    sub.textContent='Tap "Connect Printer" to pair your P58E';
    btn.style.background='var(--green)';
    lbl.textContent='Connect Printer';
    btn.querySelector('span').innerHTML=MI('bluetooth_searching');
  }
}

// ── MAIN BUTTON ACTION ────────────────────────────────────
async function thermalMainAction(){
  // ── Native Android bridge ──
  if(hasAndroidBridge()){
    if(window.Android.isPrinterConnected()){
      // Already connected — print immediately
      const sale=getCurrentSaleData();
      const txt=buildThermalReceipt(sale);
      showToast('Sending to printer…','success');
      window.Android.printText(txt);
    } else {
      // Open native printer picker
      window.Android.selectPrinter();
    }
    return;
  }
  // ── Web Bluetooth fallback ──
  if(THERMAL.connected && THERMAL.characteristic){
    await sendThermalPrint();
  } else {
    await connectP58E();
  }
}

// ── Callbacks from Android native bridge ─────────────────
window.onNativePrintDone = function(success, msg){
  if(typeof showToast==='function') showToast(msg, success?'success':'error');
  if(success && typeof closePrintPanel==='function') setTimeout(closePrintPanel,1200);
};
window.onPrinterSelected = function(name){
  if(typeof showToast==='function') showToast('Printer set: '+name,'success');
  updateBtUI();
};

// ── BLUETOOTH CONNECT ─────────────────────────────────────
// ── BLUETOOTH PRINTER CHANNELS ───────────────────────────
// Cheap BLE printers expose several services/characteristics and only ONE of them feeds the print head.
// "Sent" only means the write was accepted, so we list every writable channel, try the likeliest first,
// and let the user move to the next one (Test print / Try next channel) until paper comes out.
const BLE_PRINTER_SERVICES=[
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000af30-0000-1000-8000-00805f9b34fb',
  '00001101-0000-1000-8000-00805f9b34fb'
];
const BLE_KEY='macrome-printer-channel';
function shortUUID(u){return String(u).replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/,'$1').slice(0,8);}
async function findPrinterChannels(server){
  let svcs=[];
  try{svcs=await server.getPrimaryServices();}catch(e){}
  const out=[];
  for(const svc of svcs){
    let chars=[];try{chars=await svc.getCharacteristics();}catch(e){continue;}
    for(const c of chars){
      const p=c.properties||{};
      if(p.writeWithoutResponse)out.push({svc:svc.uuid,char:c,mode:'nr'});
      if(p.write)out.push({svc:svc.uuid,char:c,mode:'rsp'});
    }
  }
  const rank=u=>{const i=BLE_PRINTER_SERVICES.indexOf(u);return i<0?99:i;};
  out.sort((a,b)=>rank(a.svc)-rank(b.svc));
  out.forEach(c=>{
    c.label=shortUUID(c.svc)+' / '+shortUUID(c.char.uuid)+(c.mode==='nr'?' (fast)':' (acked)');
    c.key=c.svc+'/'+c.char.uuid+'/'+c.mode;
  });
  return out;
}
async function sendBytes(bytes){
  const ch=THERMAL.candidates[THERMAL.idx];
  if(!ch)throw new Error('No printer channel');
  const CHUNK=NotifyReceipt.config.bleChunk,GAP=ch.mode==='rsp'?10:25;
  for(let i=0;i<bytes.length;i+=CHUNK){
    await writeChunk(ch.char,bytes.slice(i,i+CHUNK),ch.mode);
    await delay(GAP);
  }
}
function updateBtDiag(){
  const box=document.getElementById('bt-diag');if(!box)return;
  const on=THERMAL.connected&&!hasAndroidBridge()&&THERMAL.candidates&&THERMAL.candidates.length>0;
  box.style.display=on?'block':'none';if(!on)return;
  const c=THERMAL.candidates[THERMAL.idx];
  document.getElementById('bt-diag-info').textContent='Channel '+(THERMAL.idx+1)+' of '+THERMAL.candidates.length+': '+c.label;
  document.getElementById('bt-diag-next').disabled=THERMAL.candidates.length<2;
}
async function btTest(){
  const c=THERMAL.candidates[THERMAL.idx];if(!c)return;
  const txt='\n   MACROME PRINTER TEST\nChannel '+(THERMAL.idx+1)+' of '+THERMAL.candidates.length+'\n'+c.label+'\n--------------------------------\n\n\n\n';
  const head=new Uint8Array([0x1b,0x40]),body=new TextEncoder().encode(txt);
  const bytes=new Uint8Array(head.length+body.length);bytes.set(head,0);bytes.set(body,head.length);
  try{await sendBytes(bytes);showToast('Test sent — did paper come out?','success',3500);}
  catch(e){showToast('Test failed: '+e.message,'error');}
}
function btNext(){
  if(!THERMAL.candidates.length)return;
  THERMAL.idx=(THERMAL.idx+1)%THERMAL.candidates.length;
  THERMAL.characteristic=THERMAL.candidates[THERMAL.idx].char;
  updateBtDiag();btTest();
}
function btKeep(){
  const c=THERMAL.candidates[THERMAL.idx];if(!c||!THERMAL.device)return;
  try{localStorage.setItem(BLE_KEY,JSON.stringify({dev:THERMAL.device.name,key:c.key}));}catch(_){}
  showToast('Saved — Macrome will use this channel for '+(THERMAL.device.name||'this printer'),'success',3500);
}

async function connectP58E(){
  if(!navigator.bluetooth){
    showToast('Web Bluetooth not supported on this browser. Use the .txt download option.','error');
    return;
  }
  const lbl=document.getElementById('bt-main-label');
  const btn=document.getElementById('bt-main-btn');
  try{
    lbl.textContent='Scanning…';btn.disabled=true;
    const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:BLE_PRINTER_SERVICES});
    lbl.textContent='Connecting…';
    const server=await device.gatt.connect();
    const found=await findPrinterChannels(server);
    if(!found.length)throw new Error('No writable characteristic found');
    try{ // use the channel that worked last time for this printer
      const sv=JSON.parse(localStorage.getItem(BLE_KEY)||'null');
      if(sv&&sv.dev===device.name){const i=found.findIndex(c=>c.key===sv.key);if(i>0)found.unshift(found.splice(i,1)[0]);}
    }catch(_){}
    THERMAL.device=device;
    THERMAL.candidates=found;THERMAL.idx=0;
    THERMAL.characteristic=found[0].char;
    THERMAL.connected=true;
    device.addEventListener('gattserverdisconnected',()=>{
      THERMAL.connected=false;THERMAL.characteristic=null;THERMAL.device=null;THERMAL.candidates=[];
      showToast('Printer disconnected','error');
      updateBtUI();
    });
    showToast('Printer connected: '+device.name,'success');
    updateBtUI();
  }catch(err){
    THERMAL.connected=false;
    if(err.name==='NotFoundError'||err.message.includes('cancelled')){
      showToast('Pairing cancelled','error');
    } else if(err.message.includes('No printable')||err.message.includes('No writable')){
      showToast('P58E paired but Classic BT not supported by browser. Use .txt download + PrintHand app.','error');
    } else {
      showToast('Could not connect: '+err.message,'error');
    }
    lbl.textContent='Connect Printer';btn.disabled=false;
    updateBtUI();
  }
  btn.disabled=false;
}

// ── SEND TO PRINTER ───────────────────────────────────────
// ── AUTO-PRINT ───────────────────────────────────────────
// When ON, a finished sale prints by itself if a printer is already connected (otherwise the receipt just shows as usual).
const AUTOPRINT_KEY='macrome-autoprint';
function autoPrintOn(){try{return localStorage.getItem(AUTOPRINT_KEY)!=='off';}catch(_){return true;}}
function toggleAutoPrint(el){
  const on=!el.classList.contains('on');el.classList.toggle('on',on);
  try{localStorage.setItem(AUTOPRINT_KEY,on?'on':'off');}catch(_){}
}
function autoPrintIfReady(){
  if(!autoPrintOn()||!CUR_SALE)return;
  try{
    if(hasAndroidBridge()){
      if(window.Android.isPrinterConnected())window.Android.printText(buildThermalReceipt(CUR_SALE));
    }else if(THERMAL.connected&&THERMAL.characteristic){
      sendThermalPrint(true);
    }
  }catch(e){console.error('[Macrome] auto-print failed',e);}
}
try{const t=document.getElementById('autoprint-toggle');if(t)t.classList.toggle('on',autoPrintOn());}catch(_){}

async function sendThermalPrint(auto){
  const sale=getCurrentSaleData();
  try{
    const bytes=NotifyReceipt.buildEscPos(macromeToSale(sale)); // init, text, bold total, feed + cut
    await sendBytes(bytes);
    showToast('Receipt sent to printer ✓','success');
    if(!auto)setTimeout(()=>closePrintPanel(),1200);
  }catch(err){
    showToast('Print failed: '+err.message,'error');
    THERMAL.connected=false;THERMAL.characteristic=null;
    updateBtUI();
  }
}

async function writeChunk(char,data,mode){
  if(mode==='rsp'){
    if(char.writeValueWithResponse)await char.writeValueWithResponse(data);
    else await char.writeValue(data);
  }else if(mode==='nr'||char.properties.writeWithoutResponse){
    await char.writeValueWithoutResponse(data);
  }else{
    await char.writeValue(data);
  }
}
function delay(ms){return new Promise(r=>setTimeout(r,ms));}

// ── DOWNLOAD .TXT FALLBACK ────────────────────────────────
function downloadReceiptTxt(){
  const sale=getCurrentSaleData();
  const txt=buildThermalReceipt(sale);
  const blob=new Blob([txt],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='Macrome-'+( sale.num||'receipt').replace(/[^a-zA-Z0-9-]/g,'')+'.txt';
  a.click();
  showToast('Receipt downloaded — open with PrintHand to print','success');
}

// ── BROWSER PRINT ─────────────────────────────────────────
function browserPrint(){
  const sale=getCurrentSaleData();
  if(!sale||!(sale.lines||[]).length){showToast('Nothing to print','error');return;}
  NotifyReceipt.printHTML(receiptHTML(sale));   // hidden iframe: no popup blocking, prints once laid out
  setTimeout(()=>closePrintPanel(),800);
}

// Raw ESC/POS over USB or Serial (Chrome/Edge on a PC or Android; needs https or localhost)
async function rawPrint(){
  const sale=getCurrentSaleData();
  if(!sale||!(sale.lines||[]).length){showToast('Nothing to print','error');return;}
  await NotifyReceipt.printSaleRaw(macromeToSale(sale));
}

// Legacy alias (used by reprintSale path — now opens panel)
function printReceipt(){ openPrintPanel(); }

// ══ RECEIPT — SAVE AS PDF ══════════════════════════════
async function saveReceiptPDF(){
  if(typeof jspdf==='undefined'){
    showToast('PDF library not ready, try again…','error');return;
  }
  showLoader();
  try{
    const {jsPDF}=jspdf;

    // ── Collect live receipt data from the DOM ──
    const receiptEl  = document.querySelector('.rpmv');
    const receiptNum = receiptEl ? receiptEl.textContent.trim() : 'REC-???';
    const dateEl     = document.getElementById('r-date');
    const payEl      = document.getElementById('r-pay');
    const subEl      = document.getElementById('r-sub');
    const totEl      = document.getElementById('r-tot');
    const itemsEl    = document.getElementById('r-items');
    const cashierEl  = document.querySelector('.rpmeta-i:nth-child(3) .rpmv');

    const rDate   = dateEl   ? dateEl.textContent.trim()   : new Date().toLocaleDateString('en-KE');
    const rPay    = payEl    ? payEl.textContent.trim()     : 'Cash';
    const rSub    = subEl    ? subEl.textContent.trim()     : 'KES 0';
    const rTot    = totEl    ? totEl.textContent.trim()     : 'KES 0';
    const rCash   = cashierEl? cashierEl.textContent.trim() : 'Staff';

    // Parse line items from DOM
    const lineItems = [];
    if(itemsEl){
      itemsEl.querySelectorAll('.rpi').forEach(row=>{
        const name = row.querySelector('.rpin')?.textContent.trim() || '';
        const qty  = row.querySelector('.rpiq')?.textContent.trim() || '';
        const amt  = row.querySelector('.rpit')?.textContent.trim() || '';
        if(name) lineItems.push({name, qty, amt});
      });
    }

    // ── Build 80mm-wide receipt PDF ──
    const W = 80, m = 5;
    const cGreen=[8,78,87], cGold=[247,148,29], cInk=[15,30,33], cGray=[107,131,136];

    // Calculate height dynamically
    const lineH = 6.5;
    const headerH = 32;
    const metaH   = 22;
    const itemsH  = Math.max(lineItems.length, 1) * lineH + 6;
    const totalsH = 18;
    const footerH = 28;
    const totalH  = headerH + metaH + itemsH + totalsH + footerH;

    const pdf = new jsPDF({unit:'mm', format:[W, totalH], orientation:'portrait'});

    let y = 0;

    // ── Header (green band) ──
    pdf.setFillColor(...cGreen);
    pdf.rect(0, 0, W, headerH, 'F');

    // Brand name
    pdf.setTextColor(255,255,255);
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(14);
    pdf.text('MACROME ELECTRONICS', W/2, 10, {align:'center'});

    // Gold accent line
    pdf.setFillColor(...cGold);
    pdf.rect(0, 13, W, 1, 'F');

    pdf.setFont('helvetica','normal');
    pdf.setFontSize(7);
    pdf.setTextColor(220,240,228);
    pdf.text('Furniture | Electronics | Household Goods', W/2, 18, {align:'center'});

    // Receipt title pill
    pdf.setFillColor(255,255,255);
    pdf.roundedRect(m+4, 27, W-m*2-8, 7, 2, 2, 'F');
    pdf.setTextColor(...cGreen);
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(8);
    pdf.text('SALES RECEIPT', W/2, 32, {align:'center'});

    y = headerH + 6;

    // ── Meta info ──
    pdf.setTextColor(...cGray);
    pdf.setFont('helvetica','normal');
    pdf.setFontSize(7);

    const metaRows = [
      ['Receipt #:', receiptNum],
      ['Date:',      rDate],
      ['Cashier:',   rCash],
      ['Payment:',   rPay],
    ];
    metaRows.forEach(([label, val])=>{
      pdf.setFont('helvetica','normal'); pdf.setTextColor(...cGray);
      pdf.text(label, m, y);
      pdf.setFont('helvetica','bold'); pdf.setTextColor(...cInk);
      pdf.text(val, W - m, y, {align:'right'});
      y += 5;
    });

    // Divider
    pdf.setDrawColor(200,220,210);
    pdf.setLineWidth(0.3);
    pdf.setLineDash([1,1]);
    pdf.line(m, y, W-m, y);
    pdf.setLineDash([]);
    y += 5;

    // ── Line items ──
    if(lineItems.length){
      lineItems.forEach(item=>{
        // Item name (truncate if too long)
        pdf.setFont('helvetica','bold');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...cInk);
        const maxNameW = W - m*2 - 20;
        let name = item.name;
        while(pdf.getTextWidth(name) > maxNameW && name.length > 4) name = name.slice(0,-1);
        if(name !== item.name) name += '…';
        pdf.text(name, m, y);
        pdf.setFont('helvetica','bold');
        pdf.setTextColor(...cGreen);
        pdf.text(item.amt, W-m, y, {align:'right'});
        y += 4.5;
        // Qty/unit price line
        pdf.setFont('helvetica','normal');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...cGray);
        pdf.text(item.qty, m+2, y);
        y += 5;
      });
    } else {
      pdf.setFont('helvetica','italic');
      pdf.setFontSize(7);
      pdf.setTextColor(...cGray);
      pdf.text('No items', W/2, y+3, {align:'center'});
      y += 10;
    }

    // Divider
    pdf.setDrawColor(200,220,210);
    pdf.setLineDash([1,1]);
    pdf.line(m, y, W-m, y);
    pdf.setLineDash([]);
    y += 5;

    // ── Subtotal ──
    pdf.setFont('helvetica','normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(...cGray);
    pdf.text('Subtotal', m, y);
    pdf.setTextColor(...cInk);
    pdf.text(rSub, W-m, y, {align:'right'});
    y += 5;

    // ── TOT notice ──
    pdf.setFontSize(6.5);
    pdf.setTextColor(...cGray);
    pdf.text('(Turnover Tax calculated monthly — KRA TOT)', W/2, y, {align:'center'});
    y += 6;

    // ── Grand total band ──
    pdf.setFillColor(...cGreen);
    pdf.roundedRect(m, y, W-m*2, 10, 2, 2, 'F');
    pdf.setTextColor(255,255,255);
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(9);
    pdf.text('TOTAL PAID', m+3, y+7);
    pdf.setFontSize(11);
    pdf.text(rTot, W-m-3, y+7, {align:'right'});
    y += 16;

    // ── Payment details (cash received / change / M-Pesa code) ──
    const extra=[];
    [['r-paid-row','Cash received','r-paid'],['r-chg-row','Change','r-chg'],['r-ref-row','M-Pesa code','r-ref']].forEach(([row,lbl,v])=>{
      const re=document.getElementById(row);
      if(re&&re.style.display!=='none')extra.push([lbl,document.getElementById(v).textContent.trim()]);
    });
    pdf.setFontSize(7.5);pdf.setFont('helvetica','normal');
    extra.forEach(([l,v],i)=>{pdf.setTextColor(...cGray);pdf.text(l,m,y+4+i*4.5);pdf.setTextColor(...cInk);pdf.text(v,W-m,y+4+i*4.5,{align:'right'});});
    y += 15;

    // ── Footer ──
    pdf.setFillColor(245,250,247);
    pdf.rect(0, y, W, totalH-y, 'F');
    pdf.setFillColor(...cGold);
    pdf.rect(0, y, W, 1, 'F');
    y += 6;
    pdf.setTextColor(...cGreen);
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(7.5);
    pdf.text('Thank you for shopping at Macrome Electronics!', W/2, y, {align:'center'});
    y += 5;
    pdf.setFont('helvetica','normal');
    pdf.setTextColor(...cGray);
    pdf.setFontSize(6.5);
    pdf.text('Furniture | Electronics | Household Goods', W/2, y, {align:'center'});

    // Save
    pdf.save('Macrome-'+receiptNum.replace(/[^a-zA-Z0-9-]/g,'')+'-'+new Date().toISOString().slice(0,10)+'.pdf');
    hideLoader();
    showToast('✅ Receipt saved as PDF','success');
  }catch(e){
    hideLoader();
    showToast('❌ Could not generate PDF','error');
    console.error(e);
  }
}

// ══ REPORTS — EXPORT CSV ═══════════════════════════════
function exportReportsCSV(){
  const rows=macReportRows();
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='Macrome-Sales-Report-'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(a);a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},200);
  showToast('✅ CSV exported successfully','success');
}

// ══ REPORTS — EXPORT PDF ═══════════════════════════════
async function exportReportsPDF(){
  if(typeof jspdf==='undefined'){showToast('PDF library not ready, try again…','error');return;}
  showLoader();
  try{
    const {jsPDF}=jspdf;
    const pdf=new jsPDF({unit:'mm',format:'a4',orientation:'portrait'});
    const pageW=210,pageH=297,m=14,cW=pageW-m*2;
    const cGreen=[8,78,87],cGold=[247,148,29],cInk=[15,30,33],cGray=[107,131,136],cBg=[237,243,244];

    // Header band
    pdf.setFillColor(...cGreen);pdf.rect(0,0,pageW,30,'F');
    pdf.setTextColor(255,255,255);
    pdf.setFont('helvetica','bold');pdf.setFontSize(20);
    pdf.text('MACROME ELECTRONICS',m,13);
    pdf.setFont('helvetica','normal');pdf.setFontSize(9);
    pdf.text('Sales & Revenue Report  |  Chuka Town  |  Tel 0715186441',m,20);
    pdf.text('Furniture | Electronics | Household Goods',m,26);
    // Date badge
    pdf.setFillColor(...cGold);pdf.roundedRect(pageW-m-55,8,55,14,3,3,'F');
    pdf.setTextColor(...cInk);pdf.setFont('helvetica','bold');pdf.setFontSize(9);
    pdf.text(macPeriodLabel(),pageW-m-51,17);

    let y=38;

    // KPI cards
    const RS=macStats(), fm=n=>'KES '+MAC_FMT(n);
    const kpis=[
      {l:'Total Revenue',v:fm(RS.monthTotal),s:'This month',c:cGreen},
      {l:'Sales Today',v:String(RS.todayCount),s:fm(RS.todayTotal),c:cGold},
      {l:'Items Sold',v:String(RS.monthItems),s:'This month',c:[26,86,219]},
      {l:'TOT Payable ('+(getTOTRate()*100)+'%)',v:'KES '+calcTOT(RS.monthTotal).toLocaleString('en-KE',{minimumFractionDigits:2}),s:'Monthly',c:[192,57,43]},
    ];
    const kW=(cW-9)/4;
    kpis.forEach((k,i)=>{
      const x=m+i*(kW+3);
      pdf.setFillColor(...cBg);pdf.roundedRect(x,y,kW,24,3,3,'F');
      pdf.setFillColor(...k.c);pdf.rect(x,y,kW,2.5,'F');
      pdf.setTextColor(...cInk);pdf.setFont('helvetica','bold');pdf.setFontSize(14);
      pdf.text(k.v,x+3,y+14);
      pdf.setFont('helvetica','normal');pdf.setFontSize(7);pdf.setTextColor(...cGray);
      pdf.text(k.l.toUpperCase(),x+3,y+19.5);
      pdf.setFont('helvetica','bold');pdf.setFontSize(7);pdf.setTextColor(...k.c);
      pdf.text(k.s,x+3,y+23.5);
    });
    y+=32;

    // Section helper
    function sectionTitle(title){
      pdf.setFont('helvetica','bold');pdf.setFontSize(11);pdf.setTextColor(...cGreen);
      pdf.text(title,m,y);
      pdf.setDrawColor(...cGreen);pdf.setLineWidth(0.5);
      pdf.line(m,y+1.5,m+pdf.getTextWidth(title),y+1.5);
      y+=8;
    }

    // Payment Methods
    sectionTitle('Payment Methods Breakdown');
    const pays=[
      {l:'M-Pesa',p:RS.monthTotal?Math.round(RS.pay.mpesa/RS.monthTotal*100):0,v:fm(RS.pay.mpesa),c:cGreen},
      {l:'Cash',p:RS.monthTotal?Math.round(RS.pay.cash/RS.monthTotal*100):0,v:fm(RS.pay.cash),c:cGold},
      {l:'Card',p:RS.monthTotal?Math.round(RS.pay.card/RS.monthTotal*100):0,v:fm(RS.pay.card),c:[26,86,219]},
    ];
    pays.forEach(p=>{
      pdf.setFont('helvetica','normal');pdf.setFontSize(9.5);pdf.setTextColor(...cInk);
      pdf.text(p.l,m,y+4);
      pdf.setFillColor(219,227,239);pdf.roundedRect(m+22,y,cW-62,5,2,2,'F');
      pdf.setFillColor(...p.c);pdf.roundedRect(m+22,y,(cW-62)*p.p/100,5,2,2,'F');
      pdf.setFont('helvetica','bold');pdf.setFontSize(9);
      pdf.text(p.p+'%',m+cW-36,y+4);
      pdf.setFont('helvetica','normal');pdf.setTextColor(...cGray);
      pdf.text(p.v,m+cW-20,y+4);
      y+=10;
    });
    y+=4;

    // Weekly Revenue
    sectionTitle('Weekly Revenue Trend (Last 8 Weeks)');
    const weeks=RS.weeks.map(w=>['w/c '+w.label,MAC_FMT(w.gross),String(w.tx),w.tx?MAC_FMT(w.gross/w.tx):'-']);
    const wTotG=RS.weeks.reduce((t,w)=>t+w.gross,0), wTotT=RS.weeks.reduce((t,w)=>t+w.tx,0);
    const wCols=[40,45,35,60];const wHdrs=['Period','Revenue (KES)','Transactions','Avg/Transaction'];
    pdf.setFillColor(...cGreen);pdf.rect(m,y,cW,7,'F');
    pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(8.5);
    let cx=m+3;wHdrs.forEach((h,i)=>{pdf.text(h,cx,y+4.8);cx+=wCols[i];});y+=7;
    weeks.forEach((row,ri)=>{
      if(ri%2===0){pdf.setFillColor(255,255,255);}else{pdf.setFillColor(244,246,251);}
      pdf.rect(m,y,cW,6.5,'F');
      pdf.setTextColor(...cInk);pdf.setFont('helvetica','normal');pdf.setFontSize(8.5);
      cx=m+3;row.forEach((c,i)=>{pdf.text(c,cx,y+4.5);cx+=wCols[i];});y+=6.5;
    });
    // Total
    pdf.setFillColor(...cGreen);pdf.rect(m,y,cW,7,'F');
    pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(8.5);
    cx=m+3;
    ['TOTAL',MAC_FMT(wTotG),String(wTotT),wTotT?'KES '+MAC_FMT(wTotG/wTotT):'-'].forEach((c,i)=>{pdf.text(c,cx,y+4.8);cx+=wCols[i];});
    y+=14;

    // Category Revenue
    sectionTitle('Revenue by Product Category');
    const palette=[[6,56,63],[8,78,87],[14,125,137],[20,163,176],[247,148,29],[255,176,79]];
    const catTot=RS.cats.reduce((t,c)=>t+c[1],0);
    const cats=RS.cats.length?RS.cats.map((c,i)=>({n:c[0],r:MAC_FMT(c[1]),p:catTot?Math.round(c[1]/catTot*100):0,c:palette[i%palette.length]})):[{n:'No sales recorded this month',r:'0',p:0,c:palette[1]}];
    cats.forEach(c=>{
      pdf.setFillColor(...c.c);pdf.rect(m,y,3,6.5,'F');
      pdf.setFont('helvetica','normal');pdf.setFontSize(9);pdf.setTextColor(...cInk);
      pdf.text(c.n,m+6,y+4.5);
      pdf.text('KES '+c.r,m+80,y+4.5);
      pdf.setFillColor(219,227,239);pdf.roundedRect(m+112,y+1,55,4,1.5,1.5,'F');
      pdf.setFillColor(...c.c);pdf.roundedRect(m+112,y+1,55*c.p/100,4,1.5,1.5,'F');
      pdf.setFont('helvetica','bold');pdf.setFontSize(8);
      pdf.text(c.p+'%',m+170,y+4.5);
      y+=9;
    });
    y+=6;

    // Transaction log
    if(y<pageH-60){
      sectionTitle('Recent Transactions');
      const txnHdrs=['Receipt #','Cashier','Items','Payment','Amount','Time'];
      const txnCols=[30,40,15,25,35,25];
      const txns=RS.all.slice(0,12).map(x=>[x.num,x.cashier||'Staff',String(x.items),MAC_PAYLBL[macPayKey(x.pay)],'KES '+MAC_FMT(x.tot),x.time]);
      if(!txns.length)txns.push(['-','No sales recorded yet','','','','']);
      pdf.setFillColor(...cGreen);pdf.rect(m,y,cW,7,'F');
      pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(8.5);
      cx=m+3;txnHdrs.forEach((h,i)=>{pdf.text(h,cx,y+4.8);cx+=txnCols[i];});y+=7;
      txns.forEach((row,ri)=>{
        pdf.setFillColor(ri%2===0?255:244,ri%2===0?255:246,ri%2===0?255:251);
        pdf.rect(m,y,cW,6.5,'F');
        pdf.setTextColor(...cInk);pdf.setFont('helvetica','normal');pdf.setFontSize(8.5);
        cx=m+3;row.forEach((c,i)=>{pdf.text(c,cx,y+4.5);cx+=txnCols[i];});y+=6.5;
      });
    }

    // Footer
    pdf.setFillColor(...cBg);pdf.rect(0,pageH-18,pageW,18,'F');
    pdf.setFillColor(...cGreen);pdf.rect(0,pageH-18,pageW,1,'F');
    pdf.setTextColor(...cGray);pdf.setFont('helvetica','normal');pdf.setFontSize(7.5);
    pdf.text('Macrome Electronics POS  ·  Chuka Town  ·  Tel 0715186441',m,pageH-11);
    pdf.text('Generated: '+new Date().toLocaleString('en-KE'),m,pageH-5.5);
    pdf.setFont('helvetica','bold');pdf.setTextColor(...cGreen);pdf.setFontSize(7.5);
    pdf.text('CONFIDENTIAL — For internal use only',pageW-m-60,pageH-11);
    pdf.setFont('helvetica','normal');pdf.setTextColor(...cGray);
    pdf.text('Page 1 of 1',pageW-m-14,pageH-5.5);

    pdf.save('Macrome-Sales-Report-'+new Date().toISOString().slice(0,10)+'.pdf');
    hideLoader();showToast('✅ Report exported as PDF','success');
  }catch(e){
    hideLoader();showToast('❌ Could not generate PDF','error');console.error(e);
  }
}

// ══ KRA TURNOVER TAX (TOT) ENGINE ══════════════════════
// Scalable config — update TOT_RATE here when KRA changes the rate
const TOT_CONFIG = {
  rate: 0.015,       // 1.5% — update this single value if KRA changes the rate
  enabled: true,
  label: 'Turnover Tax (TOT)',
  authority: 'Kenya Revenue Authority',
};

function getTOTRate(){ return TOT_CONFIG.rate; }
function calcTOT(grossSales){ return parseFloat((grossSales * getTOTRate()).toFixed(2)); }
function calcNetRevenue(grossSales){ return parseFloat((grossSales - calcTOT(grossSales)).toFixed(2)); }

function toggleTOT(el){
  el.classList.toggle('on');
  TOT_CONFIG.enabled = el.classList.contains('on');
  saveData();
  showToast(TOT_CONFIG.enabled ? '✅ TOT enabled' : 'TOT disabled', TOT_CONFIG.enabled ? 'success' : '');
}
function updateTOTRate(val){
  const r = parseFloat(val);
  if(isNaN(r)||r<0||r>100){ showToast('Invalid TOT rate','error'); return; }
  TOT_CONFIG.rate = r/100;
  saveData();
  showToast('✅ TOT rate updated to '+r+'%', 'success');
  renderTOTReport();
}

// Monthly sales data — in a real deployment this comes from the database
function getTOTMonthlyData(month, year){
  // Built from the sales recorded in the POS (4 buckets: days 1-7, 8-14, 15-21, 22-end)
  const weeks=[1,2,3,4].map(n=>({week:'Week '+n,gross:0,tx:0}));
  scopedSales().forEach(x=>{
    const d=new Date(x.date);
    if(d.getMonth()===month && d.getFullYear()===year){
      const w=Math.min(3,Math.floor((d.getDate()-1)/7));
      weeks[w].gross+=x.tot; weeks[w].tx+=1;
    }
  });
  return weeks;
}

function renderTOTReport(){
  const mSel = document.getElementById('tot-month');
  const ySel = document.getElementById('tot-year');
  const month = parseInt(mSel ? mSel.value : new Date().getMonth());
  const year  = parseInt(ySel ? ySel.value : new Date().getFullYear());
  const weeks = getTOTMonthlyData(month, year);

  const totalGross = weeks.reduce((s,w)=>s+w.gross, 0);
  const totalTOT   = calcTOT(totalGross);
  const totalNet   = calcNetRevenue(totalGross);
  const totalTx    = weeks.reduce((s,w)=>s+w.tx, 0);

  const fmt = n => 'KES '+n.toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});
  const el = id => document.getElementById(id);
  if(el('tot-gross-sales')) el('tot-gross-sales').textContent = fmt(totalGross);
  if(el('tot-tax-amount'))  el('tot-tax-amount').textContent  = fmt(totalTOT);
  if(el('tot-net-revenue')) el('tot-net-revenue').textContent = fmt(totalNet);
  if(el('tot-tx-count'))    el('tot-tx-count').textContent    = totalTx;

  const tbody = el('tot-tbody');
  const tfoot = el('tot-tfoot');
  if(tbody){
    tbody.innerHTML = weeks.map((w,i)=>{
      const wTOT = calcTOT(w.gross);
      const wNet = calcNetRevenue(w.gross);
      return `<tr style="${i%2===1?'background:var(--g50)':''}">
        <td style="font-weight:600">${w.week}</td>
        <td style="font-weight:700;color:var(--text-brand)">${fmt(w.gross)}</td>
        <td style="font-weight:700;color:var(--danger-text)">${fmt(wTOT)}</td>
        <td style="font-weight:700;color:var(--info-text)">${fmt(wNet)}</td>
        <td><span class="badge bb">${w.tx}</span></td>
      </tr>`;
    }).join('');
  }
  if(tfoot){
    tfoot.innerHTML = `<tr style="background:var(--forest);color:#fff">
      <td style="font-weight:800;padding:12px 14px">MONTHLY TOTAL</td>
      <td style="font-weight:800;padding:12px 14px">${fmt(totalGross)}</td>
      <td style="font-weight:800;padding:12px 14px;color:#FFB3D1">${fmt(totalTOT)}</td>
      <td style="font-weight:800;padding:12px 14px">${fmt(totalNet)}</td>
      <td style="font-weight:800;padding:12px 14px">${totalTx}</td>
    </tr>`;
  }

  const cEl = el('totTrendChart');
  if(cEl){
    if(cEl._chartInst) cEl._chartInst.destroy();
    cEl._chartInst = new Chart(cEl, {
      type:'bar',
      data:{
        labels: weeks.map(w=>w.week),
        datasets:[
          {label:'Gross Sales',data:weeks.map(w=>w.gross),backgroundColor:'#150857',borderRadius:6,borderSkipped:false},
          {label:'TOT (1.5%)',data:weeks.map(w=>calcTOT(w.gross)),backgroundColor:'#c0392b',borderRadius:6,borderSkipped:false},
          {label:'Net Revenue',data:weeks.map(w=>calcNetRevenue(w.gross)),backgroundColor:'#1a56db',borderRadius:6,borderSkipped:false},
        ]
      },
      options:{
        responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{font:{size:10},color:'#38344D',boxWidth:12}}},
        scales:{
          x:{grid:{display:false},ticks:{font:{size:10},color:'#706B88'}},
          y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{font:{size:10},color:'#706B88',callback:v=>v>=1000?Math.round(v/1000)+'K':v}}
        }
      }
    });
  }
}

// Set TOT month selector to current month on load
(function initTOTFilters(){
  const now = new Date();
  const mSel = document.getElementById('tot-month');
  const ySel = document.getElementById('tot-year');
  if(mSel) mSel.value = now.getMonth();
  if(ySel) ySel.value = now.getFullYear();
})();

function updateDashTOT(){
  const now = new Date();
  const weeks = getTOTMonthlyData(now.getMonth(), now.getFullYear());
  const totalGross = weeks.reduce((s,w)=>s+w.gross, 0);
  const totalTOT   = calcTOT(totalGross);
  const fmt = n => 'KES '+n.toLocaleString('en-KE',{minimumFractionDigits:Number.isInteger(n)?0:2,maximumFractionDigits:2});
  const el  = id => document.getElementById(id);
  if(el('dash-kpi-tot'))     el('dash-kpi-tot').textContent     = fmt(totalTOT);
  if(el('dash-kpi-monthly')) el('dash-kpi-monthly').textContent = fmt(totalGross);
  if(el('dash-kpi-tot-sub')) el('dash-kpi-tot-sub').textContent = 'Gross: '+fmt(totalGross);
}

// ══ TOT REPORT — EXPORT CSV ════════════════════════════
function exportTOTCSV(){
  const mSel = document.getElementById('tot-month');
  const ySel = document.getElementById('tot-year');
  const month = parseInt(mSel ? mSel.value : new Date().getMonth());
  const year  = parseInt(ySel ? ySel.value : new Date().getFullYear());
  const mNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const weeks = getTOTMonthlyData(month, year);
  const totalGross = weeks.reduce((s,w)=>s+w.gross, 0);
  const totalTOT   = calcTOT(totalGross);
  const totalNet   = calcNetRevenue(totalGross);
  const rows=[
    ['MACROME ELECTRONICS — KRA TURNOVER TAX REPORT'],
    ['Period: '+mNames[month]+' '+year],
    ['Generated: '+new Date().toLocaleString('en-KE')],
    [],
    ['Week','Gross Sales (KES)','Turnover Tax 1.5% (KES)','Net Revenue (KES)','Transactions'],
    ...weeks.map(w=>[w.week, w.gross.toFixed(2), calcTOT(w.gross).toFixed(2), calcNetRevenue(w.gross).toFixed(2), w.tx]),
    [],
    ['MONTHLY SUMMARY'],
    ['Total Gross Sales','KES '+totalGross.toFixed(2)],
    ['Turnover Tax (1.5%)','KES '+totalTOT.toFixed(2)],
    ['Net Revenue After TOT','KES '+totalNet.toFixed(2)],
    [],
    ['Tax Regime','KRA Turnover Tax (TOT)'],
    ['Rate','1.5% of Monthly Gross Turnover'],
    ['Filing Frequency','Monthly — Due by 20th of following month'],
  ];
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  a.download='Macrome-KRA-TOT-'+mNames[month]+'-'+year+'.csv';
  document.body.appendChild(a);a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},200);
  showToast('✅ TOT report exported as CSV','success');
}

// ══ TOT REPORT — EXPORT PDF ════════════════════════════
async function exportTOTPDF(){
  if(typeof jspdf==='undefined'){showToast('PDF library not ready, try again…','error');return;}
  showLoader();
  try{
    const {jsPDF}=jspdf;
    const mSel = document.getElementById('tot-month');
    const ySel = document.getElementById('tot-year');
    const month = parseInt(mSel ? mSel.value : new Date().getMonth());
    const year  = parseInt(ySel ? ySel.value : new Date().getFullYear());
    const mNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
    const weeks = getTOTMonthlyData(month, year);
    const totalGross = weeks.reduce((s,w)=>s+w.gross, 0);
    const totalTOT   = calcTOT(totalGross);
    const totalNet   = calcNetRevenue(totalGross);

    const pdf=new jsPDF({unit:'mm',format:'a4',orientation:'portrait'});
    const pageW=210,pageH=297,m=14,cW=pageW-m*2;
    const cGreen=[8,78,87],cGold=[247,148,29],cInk=[15,30,33],cGray=[107,131,136];
    const cRed=[192,57,43],cBlue=[26,86,219],cBg=[237,243,244];
    const fmt=(n)=>'KES '+n.toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});

    // Header
    pdf.setFillColor(...cGreen);pdf.rect(0,0,pageW,38,'F');
    pdf.setFillColor(...cGold);pdf.rect(0,35,pageW,3,'F');
    pdf.setTextColor(255,255,255);
    pdf.setFont('helvetica','bold');pdf.setFontSize(21);
    pdf.text('MACROME ELECTRONICS',m,14);
    pdf.setFont('helvetica','normal');pdf.setFontSize(8.5);
    pdf.text('Chuka Town  ·  Tel 0715186441  ·  Furniture | Electronics | Household Goods',m,22);

    // KRA badge
    pdf.setFillColor(255,255,255);pdf.roundedRect(pageW-m-52,7,52,20,3,3,'F');
    pdf.setTextColor(...cGreen);pdf.setFont('helvetica','bold');pdf.setFontSize(8);
    pdf.text('KENYA REVENUE',pageW-m-48,14);
    pdf.text('AUTHORITY',pageW-m-42,20);
    pdf.setFont('helvetica','normal');pdf.setFontSize(7);pdf.setTextColor(...cGray);
    pdf.text('TOT Compliant',pageW-m-45,26);

    let y=44;
    pdf.setTextColor(...cInk);pdf.setFont('helvetica','bold');pdf.setFontSize(14);
    pdf.text('KRA TURNOVER TAX REPORT',m,y);
    pdf.setDrawColor(...cGold);pdf.setLineWidth(1);pdf.line(m,y+2,m+90,y+2);
    pdf.setDrawColor(...cGray);pdf.setLineWidth(0.3);
    pdf.setFont('helvetica','normal');pdf.setFontSize(8.5);pdf.setTextColor(...cGray);
    pdf.text('Period: '+mNames[month]+' '+year+'   |   Rate: '+(TOT_CONFIG.rate*100).toFixed(1)+'% of Monthly Gross Turnover   |   Regime: Turnover Tax (TOT)',m,y+8);
    pdf.text('Generated: '+new Date().toLocaleString('en-KE'),m,y+14);
    y+=22;

    pdf.line(m,y,pageW-m,y);y+=8;

    // Summary cards
    const cardW=(cW-8)/3;
    [{l:'TOTAL GROSS SALES',v:fmt(totalGross),c:cGreen},{l:'TURNOVER TAX ('+((TOT_CONFIG.rate*100).toFixed(1))+'%)',v:fmt(totalTOT),c:cRed},{l:'NET REVENUE AFTER TAX',v:fmt(totalNet),c:cBlue}].forEach((sc,i)=>{
      const cx=m+i*(cardW+4);
      pdf.setFillColor(...cBg);pdf.roundedRect(cx,y,cardW,26,3,3,'F');
      pdf.setFillColor(...sc.c);pdf.rect(cx,y,cardW,3,'F');
      pdf.setTextColor(...sc.c);pdf.setFont('helvetica','bold');pdf.setFontSize(12);
      pdf.text(sc.v,cx+4,y+15);
      pdf.setFont('helvetica','normal');pdf.setFontSize(6.5);pdf.setTextColor(...cGray);
      pdf.text(sc.l,cx+4,y+22);
    });
    y+=34;

    // Table header
    pdf.setFont('helvetica','bold');pdf.setFontSize(11);pdf.setTextColor(...cGreen);
    pdf.text('Weekly Breakdown',m,y);
    pdf.setDrawColor(...cGreen);pdf.line(m,y+1.5,m+pdf.getTextWidth('Weekly Breakdown'),y+1.5);
    y+=8;

    const cols=[30,46,40,46,20];
    const hdrs=['Week','Gross Sales','TOT','Net Revenue','Tx'];
    pdf.setFillColor(...cGreen);pdf.rect(m,y,cW,7,'F');
    pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(8.5);
    let cx=m+3;hdrs.forEach((h,i)=>{pdf.text(h,cx,y+4.8);cx+=cols[i];});y+=7;
    weeks.forEach((w,ri)=>{
      pdf.setFillColor(ri%2===0?255:244,ri%2===0?255:246,ri%2===0?255:251);pdf.rect(m,y,cW,7,'F');
      const row=[w.week,fmt(w.gross),fmt(calcTOT(w.gross)),fmt(calcNetRevenue(w.gross)),String(w.tx)];
      pdf.setTextColor(...cInk);pdf.setFont('helvetica','normal');pdf.setFontSize(8.5);
      cx=m+3;row.forEach((c,i)=>{pdf.text(c,cx,y+4.8);cx+=cols[i];});y+=7;
    });
    pdf.setFillColor(...cGreen);pdf.rect(m,y,cW,8,'F');
    pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(8.5);
    cx=m+3;
    ['TOTAL',fmt(totalGross),fmt(totalTOT),fmt(totalNet),String(weeks.reduce((s,w)=>s+w.tx,0))].forEach((c,i)=>{pdf.text(c,cx,y+5.2);cx+=cols[i];});
    y+=16;

    // KRA note
    pdf.setFillColor(253,243,216);pdf.roundedRect(m,y,cW,18,3,3,'F');
    pdf.setFillColor(...cGold);pdf.rect(m,y,3,18,'F');
    pdf.setTextColor(...cInk);pdf.setFont('helvetica','bold');pdf.setFontSize(9);
    pdf.text('KRA Filing Instructions',m+6,y+7);
    pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.setTextColor(...cGray);
    pdf.text('Turnover Tax (1.5%) is due on or before the 20th of the following month.',m+6,y+12);
    pdf.text('File via iTax: itax.kra.go.ke  |  Pay via M-Pesa Paybill 572572  |  Account: your KRA PIN',m+6,y+17);
    y+=26;

    // Signature
    pdf.setDrawColor(...cGray);pdf.setLineWidth(0.3);
    pdf.line(m,y+14,m+60,y+14);pdf.line(pageW-m-60,y+14,pageW-m,y+14);
    pdf.setTextColor(...cGray);pdf.setFont('helvetica','normal');pdf.setFontSize(7.5);
    pdf.text('Authorised Signatory / Director',m,y+19);
    pdf.text('Accountant / Tax Representative',pageW-m-60,y+19);
    pdf.setFont('helvetica','bold');pdf.setTextColor(...cInk);
    pdf.text('Name: _________________________',m,y+26);
    pdf.text('Date: __________________________',m,y+32);

    // Footer
    pdf.setFillColor(...cBg);pdf.rect(0,pageH-18,pageW,18,'F');
    pdf.setFillColor(...cGreen);pdf.rect(0,pageH-18,pageW,1,'F');
    pdf.setTextColor(...cGray);pdf.setFont('helvetica','normal');pdf.setFontSize(7.5);
    pdf.text('Macrome Electronics POS  ·  Chuka Town  ·  KRA TOT Report',m,pageH-11);
    pdf.text('Generated: '+new Date().toLocaleString('en-KE'),m,pageH-5.5);
    pdf.setFont('helvetica','bold');pdf.setTextColor(...cGreen);
    pdf.text('CONFIDENTIAL — KRA TAX DOCUMENT',pageW-m-72,pageH-11);
    pdf.setFont('helvetica','normal');pdf.setTextColor(...cGray);
    pdf.text('Page 1 of 1',pageW-m-14,pageH-5.5);

    pdf.save('Macrome-KRA-TOT-'+mNames[month]+'-'+year+'.pdf');
    hideLoader();showToast('✅ KRA TOT Report exported as PDF','success');
  }catch(e){
    hideLoader();showToast('❌ Could not generate PDF','error');console.error(e);
  }
}

renderCart();

// ══ DEVICE STORAGE ═════════════════════════════════════
// Everything (stock, sales, receipt counter, TOT settings, business info)
// is saved in this browser's localStorage after every change and reloaded on start.
const MAC_STORE_KEY='macrome-pos-data-v1';
const MAC_BIZ={name:'Macrome Electronics',loc:'Chuka Town',phone:'0715186441',till:''};
let macLastSaved=null, macLastBackup=null, macStoreWarned=false;

function macStorageOK(){
  try{const k='__mac_t';localStorage.setItem(k,'1');localStorage.removeItem(k);return true;}catch(e){return false;}
}
// ── EXPENSES & PROFIT REPORTING ─────────────────────────────────────────
// Profit = sales − cost of goods sold (cost price recorded on every sale line) − expenses − turnover tax.
const EXP_CATS=['Rent','Salaries & Wages','Electricity & Water','Transport & Delivery','Marketing & Ads','Licences & Permits','Repairs & Maintenance','Airtime, Internet & Bank Charges','Other'];
function pfEsc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function pfYMD(d){const x=new Date(d);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');}
function pfParse(s){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||''));return m?new Date(+m[1],+m[2]-1,+m[3]):new Date(NaN);}
function pfM(n){n=Math.round(n||0);return (n<0?'-':'')+'KES '+Math.abs(n).toLocaleString('en-KE');}
function pfPct(a,b){return b>0?(a/b*100).toFixed(1)+'%':'—';}
function pfDay(d){return new Date(d).toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'});}

function pfRange(){
  const sel=(document.getElementById('pf-period')||{}).value||'month', now=new Date();
  const y=now.getFullYear(), m=now.getMonth(), sod=new Date(y,m,now.getDate());
  let a,b;
  if(sel==='today'){a=sod;b=new Date(sod);b.setDate(b.getDate()+1);}
  else if(sel==='week'){a=macWeekStart(now);b=new Date(a);b.setDate(b.getDate()+7);}
  else if(sel==='last'){a=new Date(y,m-1,1);b=new Date(y,m,1);}
  else if(sel==='year'){a=new Date(y,0,1);b=new Date(y+1,0,1);}
  else if(sel==='custom'){
    a=pfParse((document.getElementById('pf-from')||{}).value);b=pfParse((document.getElementById('pf-to')||{}).value);
    if(isNaN(+a))a=new Date(y,m,1);
    if(isNaN(+b))b=new Date(sod);
    if(b<a){const t=a;a=b;b=t;}
    b=new Date(b);b.setDate(b.getDate()+1);
  }else{a=new Date(y,m,1);b=new Date(y,m+1,1);}
  cloudEnsureRange(a,b);
  const last=new Date(b);last.setDate(last.getDate()-1);
  return {a,b,label:pfDay(a)+(pfYMD(a)===pfYMD(last)?'':' – '+pfDay(last))};
}

function pfData(a,b){
  const inR=d=>{const t=new Date(d);return t>=a&&t<b;};
  const S=scopedSales().filter(s=>inR(s.date));
  const E=scopedExpenses().filter(e=>{const t=pfParse(e.date);return t>=a&&t<b;});
  const byP={},byC={},bucket={},missing={};
  let revenue=0,cogs=0,units=0;
  const monthly=(b-a)/864e5>62;
  S.forEach(s=>{
    const key=monthly?pfYMD(s.date).slice(0,7):pfYMD(s.date);
    (s.lines||[]).forEach(l=>{
      const p=PRODS.find(x=>x.id===l.id)||PRODS.find(x=>x.n===l.n);
      let w=Number(l.w);
      if(!(w>0))w=p?(Number(p.w)||0):0;           // sold before cost was recorded: use current cost
      const qty=Number(l.qty)||0, rev=Number(l.t)||0, cost=w*qty, noCost=!(w>0);
      revenue+=rev;cogs+=cost;units+=qty;
      const r=byP[l.n]||(byP[l.n]={n:l.n,qty:0,rev:0,cost:0,noCost:false});r.qty+=qty;r.rev+=rev;r.cost+=cost;if(noCost)r.noCost=true;
      const cn=p?p.c:'Other', c=byC[cn]||(byC[cn]={n:cn,rev:0,cost:0});c.rev+=rev;c.cost+=cost;
      const d=bucket[key]||(bucket[key]={rev:0,cost:0});d.rev+=rev;d.cost+=cost;
      if(noCost)missing[l.n]=1;
    });
  });
  const expByCat={};let expTotal=0;
  E.forEach(e=>{const v=Number(e.amt)||0;expTotal+=v;expByCat[e.cat]=(expByCat[e.cat]||0)+v;});
  const gross=revenue-cogs, tot=TOT_CONFIG.enabled?calcTOT(revenue):0, net=gross-expTotal-tot;
  return {sales:S,expenses:E,revenue,cogs,gross,expTotal,tot,net,units,byP:Object.values(byP),byC:Object.values(byC),
    expByCat:Object.entries(expByCat).sort((x,y)=>y[1]-x[1]),bucket,monthly,missing:Object.keys(missing)};
}

// ── PROFIT BY SHOP (only when a manager views "All shops") ──
function renderProfitShops(R){
  const card=document.getElementById('pf-shops-card'),tb=document.getElementById('pf-shops');if(!card||!tb)return;
  if(SCOPE!=='ALL'||userShop()){card.style.display='none';return;}
  card.style.display='';
  const keep=SCOPE;let all,rows;
  try{SCOPE='ALL';all=pfData(R.a,R.b);rows=SHOPS.map(sh=>{SCOPE=sh.id;return {sh,D:pfData(R.a,R.b)};});}finally{SCOPE=keep;}
  const shared=Math.max(0,all.expTotal-rows.reduce((t,r)=>t+r.D.expTotal,0));
  const net=v=>'<td style="text-align:right;font-weight:800;color:'+(v<0?'var(--danger-text)':'var(--text-brand)')+'">'+pfM(v)+'</td>';
  tb.innerHTML=rows.map(r=>`<tr style="cursor:pointer" onclick="setScope('${r.sh.id}')"><td style="font-weight:700">${pfEsc(r.sh.name)}</td><td>${pfM(r.D.revenue)}</td><td class="hm">${pfM(r.D.gross)}</td><td class="hm">${pfPct(r.D.gross,r.D.revenue)}</td><td class="hm">${pfM(r.D.expTotal)}</td>${net(r.D.net)}</tr>`).join('')+
    (shared>0?`<tr><td style="font-weight:700">Shared / head office</td><td>—</td><td class="hm">—</td><td class="hm">—</td><td class="hm">${pfM(shared)}</td>${net(-shared)}</tr>`:'')+
    `<tr style="font-weight:800;background:var(--pale)"><td>All shops</td><td>${pfM(all.revenue)}</td><td class="hm">${pfM(all.gross)}</td><td class="hm">${pfPct(all.gross,all.revenue)}</td><td class="hm">${pfM(all.expTotal)}</td>${net(all.net)}</tr>`;
}

// ── BEST SELLERS BY SHOP (Reports) ──
function bsRange(){
  const sel=(document.getElementById('bs-period')||{}).value||'month',now=new Date(),y=now.getFullYear(),m=now.getMonth(),sod=new Date(y,m,now.getDate());
  if(sel==='year'||sel==='all')cloudEnsureRange(sel==='year'?new Date(y,0,1):new Date(0),new Date());
  if(sel==='today'){const b=new Date(sod);b.setDate(b.getDate()+1);return [sod,b,'Today'];}
  if(sel==='week'){const a=macWeekStart(now),b=new Date(a);b.setDate(b.getDate()+7);return [a,b,'This week'];}
  if(sel==='year')return [new Date(y,0,1),new Date(y+1,0,1),'This year'];
  if(sel==='all')return [new Date(0),new Date(8.64e15),'All time'];
  return [new Date(y,m,1),new Date(y,m+1,1),'This month'];
}
function renderBestSellers(){
  const body=document.getElementById('bs-body');if(!body)return;
  const [a,b,label]=bsRange();
  const locked=userShop(), ids=locked?[locked]:(SCOPE==='ALL'?SHOP_IDS:[SCOPE]);
  const inR=s=>{const t=new Date(s.date);return t>=a&&t<b;};
  const block=(title,sales,top,id)=>{
    const by={};let rev=0,units=0;
    sales.forEach(s=>(s.lines||[]).forEach(l=>{const q=Number(l.qty)||0,t=Number(l.t)||0;const r=by[l.n]||(by[l.n]={n:l.n,q:0,t:0});r.q+=q;r.t+=t;rev+=t;units+=q;}));
    const list=Object.values(by).sort((x,y)=>y.q-x.q||y.t-x.t).slice(0,top);
    const head=`<div class="bs-h"${id?` role="button" tabindex="0" onclick="setScope('${id}')"`:''}><div class="bs-t">${pfEsc(title)}</div><div class="bs-s">${pfM(rev)} · ${sales.length} sale${sales.length===1?'':'s'} · ${units} item${units===1?'':'s'}</div></div>`;
    const rows=list.length?list.map((p,i)=>`<div class="bs-row"><span class="bs-n">${i+1}</span><span class="bs-name">${pfEsc(p.n)}</span><span class="bs-q">${p.q} sold</span><span class="bs-r">${pfM(p.t)}</span></div>`).join(''):'<div class="bs-empty">No sales in this period</div>';
    return `<div class="bs-block">${head}${rows}</div>`;
  };
  const all=cashierSales.filter(inR);
  let html='';
  if(ids.length>1)html+=block('All shops — top 10',all,10,'');
  html+=ids.map(id=>block(shopName(id)+(ids.length>1?' — top 5':' — top 10'),all.filter(s=>saleShop(s)===id),ids.length>1?5:10,ids.length>1?id:'')).join('');
  body.innerHTML='<div class="bs-grid">'+html+'</div>';
  const sub=document.getElementById('bs-sub');if(sub)sub.textContent=label+' · by items sold';
}

function pfSeries(R,D){
  const labels=[],rev=[],gp=[];
  if(D.monthly){
    for(let d=new Date(R.a.getFullYear(),R.a.getMonth(),1);d<R.b;d=new Date(d.getFullYear(),d.getMonth()+1,1)){
      const k=pfYMD(d).slice(0,7),v=D.bucket[k]||{rev:0,cost:0};
      labels.push(d.toLocaleDateString('en-KE',{month:'short'}));rev.push(Math.round(v.rev));gp.push(Math.round(v.rev-v.cost));
    }
  }else{
    for(let d=new Date(R.a);d<R.b;d.setDate(d.getDate()+1)){
      const k=pfYMD(d),v=D.bucket[k]||{rev:0,cost:0};
      labels.push(d.getDate()+' '+d.toLocaleDateString('en-KE',{month:'short'}));rev.push(Math.round(v.rev));gp.push(Math.round(v.rev-v.cost));
    }
  }
  return {labels,rev,gp};
}

function renderProfit(){
  const el=id=>document.getElementById(id);
  if(!el('pf-period'))return;
  document.querySelectorAll('.pf-custom').forEach(x=>x.style.display=el('pf-period').value==='custom'?'':'none');
  const R=pfRange(), D=pfData(R.a,R.b);
  el('pf-range-label').textContent=R.label+'  ·  '+D.sales.length+' sale'+(D.sales.length===1?'':'s');
  el('pf-k-rev').textContent=pfM(D.revenue);el('pf-k-rev-s').textContent=D.units+' item'+(D.units===1?'':'s')+' sold';
  el('pf-k-cogs').textContent=pfM(D.cogs);el('pf-k-cogs-s').textContent=D.revenue?pfPct(D.cogs,D.revenue)+' of sales':'';
  el('pf-k-gross').textContent=pfM(D.gross);el('pf-k-gross-s').textContent='Margin '+pfPct(D.gross,D.revenue);
  el('pf-k-net').textContent=pfM(D.net);el('pf-k-net').style.color=D.net<0?'var(--danger)':'';
  el('pf-k-net-s').textContent='After expenses & tax · '+pfPct(D.net,D.revenue);
  el('pf-k-net-ac').style.background=D.net<0?'linear-gradient(90deg,var(--danger),#e74c3c)':'linear-gradient(90deg,var(--green),var(--leaf))';
  // warning: costs missing
  const noCostStock=PRODS.filter(p=>!(p.w>0));
  const w=el('pf-warn'), parts=[];
  if(D.missing.length)parts.push('<b>'+D.missing.length+' product'+(D.missing.length===1?'':'s')+' sold in this period have no cost price</b> ('+D.missing.slice(0,6).map(pfEsc).join(', ')+(D.missing.length>6?'…':'')+'), so profit on them is counted as 100% and the total is <b>overstated</b>.');
  if(noCostStock.length)parts.push(noCostStock.length+' product'+(noCostStock.length===1?'':'s')+' in stock have no cost price yet.');
  if(parts.length){w.style.display='';w.innerHTML=MI('warning','mi-inline')+' '+parts.join(' ')+' Open Inventory, edit the product and enter its cost (what you paid).';}else w.style.display='none';
  // P&L
  const row=(l,v,cls,sub)=>`<tr class="${cls||''}"><td>${l}${sub?`<div class="pf-sub">${sub}</div>`:''}</td><td style="text-align:right">${v}</td></tr>`;
  el('pf-pl').innerHTML=
    row('Sales revenue',pfM(D.revenue))+
    row('Less: cost of goods sold','- '+pfM(D.cogs).replace('-',''),'',D.units+' items at cost price')+
    row('Gross profit',pfM(D.gross),'pf-tot','Margin '+pfPct(D.gross,D.revenue))+
    row('Less: operating expenses','- '+pfM(D.expTotal),'',D.expenses.length+' expense'+(D.expenses.length===1?'':'s')+' recorded')+
    row('Less: turnover tax ('+(TOT_CONFIG.enabled?(TOT_CONFIG.rate*100).toFixed(1)+'%':'off')+')','- '+pfM(D.tot))+
    row('Net profit',pfM(D.net),'pf-tot pf-net'+(D.net<0?' neg':''),'Net margin '+pfPct(D.net,D.revenue));
  try{renderProfitShops(R);}catch(e){console.error(e);}
  // chart
  const S=pfSeries(R,D);el('pf-chart-sub').textContent=D.monthly?'By month':'By day';
  if(typeof Chart!=='undefined'&&el('pfChart')){
    if(MAC_CH.profit){try{MAC_CH.profit.destroy();}catch(e){}}
    MAC_CH.profit=new Chart(el('pfChart'),{type:'bar',data:{labels:S.labels,datasets:[
      {label:'Revenue',data:S.rev,backgroundColor:'#2E14B0',borderRadius:4},
      {label:'Gross profit',data:S.gp,backgroundColor:'#F71D6D',borderRadius:4}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:10},boxWidth:12}}},
        scales:{x:{grid:{display:false},ticks:{font:{size:10},maxRotation:0,autoSkip:true}},y:{beginAtZero:true,ticks:{font:{size:10},callback:v=>v>=1000?Math.round(v/1000)+'K':v}}}}});
  }
  // tables
  const empty=(c,t)=>`<tr><td colspan="${c}" style="text-align:center;color:var(--g400);padding:18px;font-size:12px">${t}</td></tr>`;
  const prods=D.byP.map(x=>Object.assign(x,{gp:x.rev-x.cost})).sort((x,y)=>y.gp-x.gp);
  el('pf-prod').innerHTML=prods.length?prods.map(x=>`<tr><td style="font-weight:600">${pfEsc(x.n)}${x.noCost?' <span class="badge br">no cost</span>':''}</td><td>${x.qty}</td><td>${pfM(x.rev)}</td><td>${pfM(x.cost)}</td><td style="font-weight:700;color:${x.gp<0?'var(--danger)':'var(--green)'}">${pfM(x.gp)}</td><td>${pfPct(x.gp,x.rev)}</td></tr>`).join(''):empty(6,'No sales in this period');
  const cats=D.byC.map(x=>Object.assign(x,{gp:x.rev-x.cost})).sort((x,y)=>y.gp-x.gp);
  el('pf-cat').innerHTML=cats.length?cats.map(x=>`<tr><td style="font-weight:600">${pfEsc(x.n)}</td><td>${pfM(x.rev)}</td><td style="font-weight:700;color:${x.gp<0?'var(--danger)':'var(--green)'}">${pfM(x.gp)}</td><td>${pfPct(x.gp,x.rev)}</td></tr>`).join(''):empty(4,'No sales in this period');
  el('pf-exp').innerHTML=D.expByCat.length?D.expByCat.map(x=>`<tr><td>${pfEsc(x[0])}</td><td style="font-weight:700">${pfM(x[1])}</td></tr>`).join('')+`<tr><td style="font-weight:800">Total</td><td style="font-weight:800">${pfM(D.expTotal)}</td></tr>`:empty(2,'No expenses recorded in this period');
}

function updateDashProfit(){
  const el=id=>document.getElementById(id);
  if(!el('dash-pf-today'))return;
  const now=new Date(), sod=new Date(now.getFullYear(),now.getMonth(),now.getDate()), tom=new Date(sod);tom.setDate(tom.getDate()+1);
  const m0=new Date(now.getFullYear(),now.getMonth(),1), m1=new Date(now.getFullYear(),now.getMonth()+1,1);
  const T=pfData(sod,tom), M=pfData(m0,m1);
  el('dash-pf-today').textContent=pfM(T.gross);el('dash-pf-today-s').textContent='Margin '+pfPct(T.gross,T.revenue);
  el('dash-pf-month').textContent=pfM(M.gross);el('dash-pf-month-s').textContent='Margin '+pfPct(M.gross,M.revenue);
  el('dash-pf-net').textContent=pfM(M.net);el('dash-pf-net').style.color=M.net<0?'var(--danger)':'';
  el('dash-pf-net-s').textContent='After '+pfM(M.expTotal)+' expenses & tax';
}

// ── Expenses ──
function renderExpenses(){
  const el=id=>document.getElementById(id);
  if(!el('ex-tbody'))return;
  if(!el('ex-cat').options.length)el('ex-cat').innerHTML=EXP_CATS.map(c=>`<option>${pfEsc(c)}</option>`).join('');
  if(el('ex-shop')){const keep=el('ex-shop').value;el('ex-shop').innerHTML=SHOPS.map(x=>`<option value="${x.id}">${pfEsc(x.name)}</option>`).join('')+'<option value="">Shared (all shops)</option>';
    el('ex-shop').value=SCOPE!=='ALL'?SCOPE:(keep!==''&&keep?keep:'');if(scopeLocked())el('ex-shop').disabled=true;}
  if(!el('ex-date').value)el('ex-date').value=pfYMD(new Date());
  if(!el('ex-month').value)el('ex-month').value=pfYMD(new Date()).slice(0,7);
  const now=new Date(), nm=pfYMD(now).slice(0,7), today=pfYMD(now);
  if(CL.on&&CL.ensureMonths&&isMgr())CL.ensureMonths([nm,el('ex-month').value]);
  const SE=scopedExpenses();
  const inMonth=SE.filter(e=>String(e.date).slice(0,7)===nm);
  el('ex-k-month').textContent=pfM(inMonth.reduce((t,e)=>t+e.amt,0));
  el('ex-k-today').textContent=pfM(SE.filter(e=>e.date===today).reduce((t,e)=>t+e.amt,0));
  const cm={};inMonth.forEach(e=>{cm[e.cat]=(cm[e.cat]||0)+e.amt;});
  const top=Object.entries(cm).sort((a,b)=>b[1]-a[1])[0];
  el('ex-k-top').textContent=top?top[0]+' · '+pfM(top[1]):'—';
  const sel=el('ex-month').value;
  const list=SE.filter(e=>String(e.date).slice(0,7)===sel).sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0);
  el('ex-tbody').innerHTML=list.length?list.map(e=>`<tr><td style="white-space:nowrap">${pfEsc(pfDay(pfParse(e.date)))}</td><td><span class="badge bo">${pfEsc(e.cat)}</span></td><td>${pfEsc(e.desc)||'<span style="color:var(--g400)">—</span>'}${SCOPE==='ALL'?' <span class="badge bb" style="font-size:12px">'+pfEsc(e.shop===''?'Shared':shopName(e.shop===undefined?'A':e.shop))+'</span>':''}</td><td style="font-weight:700">${pfM(e.amt)}</td><td style="text-align:right"><button class="btn btn-d" style="padding:4px 10px;min-height:32px" onclick="deleteExpense('${pfEsc(e.id)}')">Delete</button></td></tr>`).join('')+`<tr><td colspan="3" style="font-weight:800">Total for month</td><td style="font-weight:800">${pfM(list.reduce((t,e)=>t+e.amt,0))}</td><td></td></tr>`
    :`<tr><td colspan="5" style="text-align:center;color:var(--g400);padding:18px;font-size:12px">No expenses recorded for this month</td></tr>`;
}
function addExpense(){
  if(!needMgr())return;
  const el=id=>document.getElementById(id), err=m=>{el('ex-err').textContent=m;};
  const date=el('ex-date').value, cat=el('ex-cat').value, desc=invClean(el('ex-desc').value), amt=parseFloat(el('ex-amt').value);
  if(isNaN(+pfParse(date)))return err('Pick the date of the expense.');
  if(!(amt>0))return err('Enter an amount above 0.');
  err('');
  const shopSel=el('ex-shop')?el('ex-shop').value:LAST_SHOP;
  if(CL.on){
    const sh=scopeLocked()?SCOPE:(SHOP_IDS.includes(shopSel)?shopSel:'');
    const id='x'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    CL.addExpense(id,{shop:sh,date,month:date.slice(0,7),cat:EXP_CATS.includes(cat)?cat:'Other',desc:desc.slice(0,120),amt:Math.round(amt*100)/100,by:String(currentUser.name).slice(0,40),byUid:currentUser.id}).catch(cloudFail('Expense not saved'));
    el('ex-desc').value='';el('ex-amt').value='';el('ex-month').value=date.slice(0,7);
    showToast('✅ Expense added'+(navigator.onLine?'':' (offline — will sync)'),'success');
    return;
  }
  EXPENSES.push({id:'x'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),date,cat:EXP_CATS.includes(cat)?cat:'Other',desc,amt,by:currentUser?currentUser.name:'',shop:scopeLocked()?SCOPE:(SHOP_IDS.includes(shopSel)?shopSel:'')});
  el('ex-desc').value='';el('ex-amt').value='';
  el('ex-month').value=date.slice(0,7);
  saveData();renderExpenses();updateDashProfit();
  showToast('✅ Expense added','success');
}
function deleteExpense(id){
  if(!needMgr())return;
  const e=EXPENSES.find(x=>x.id===id);if(!e)return;
  const at=EXPENSES.indexOf(e);
  if(CL.on){
    CL.deleteExpense(id).catch(cloudFail('Expense not deleted'));
    showToast('Expense deleted ('+e.cat+' — '+pfM(e.amt)+')','success',7000,{label:'Undo',fn:()=>{
      CL.addExpense(e.id,{shop:e.shop,date:e.date,month:String(e.date).slice(0,7),cat:e.cat,desc:String(e.desc).slice(0,120),amt:e.amt,by:String(e.by).slice(0,40),byUid:currentUser.id}).catch(cloudFail('Expense not restored'));
      showToast('Expense restored','success');}});
    return;
  }
  EXPENSES.splice(at,1);
  saveData();renderExpenses();updateDashProfit();
  showToast('Expense deleted ('+e.cat+' — '+pfM(e.amt)+')','success',7000,{label:'Undo',fn:()=>{
    EXPENSES.splice(Math.min(at,EXPENSES.length),0,e);
    saveData();renderExpenses();updateDashProfit();showToast('Expense restored','success');
  }});
}

// ── Profit exports ──
function exportProfitCSV(){
  const R=pfRange(), D=pfData(R.a,R.b), q=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
  const rows=[[MAC_BIZ.name+' — Profit Report'],['Period',R.label],[],
    ['Sales revenue',Math.round(D.revenue)],['Cost of goods sold',Math.round(D.cogs)],['Gross profit',Math.round(D.gross)],['Gross margin',pfPct(D.gross,D.revenue)],
    ['Operating expenses',Math.round(D.expTotal)],['Turnover tax',Math.round(D.tot)],['Net profit',Math.round(D.net)],['Net margin',pfPct(D.net,D.revenue)],[],
    ['PROFIT BY PRODUCT'],['Product','Qty sold','Revenue','Cost','Profit','Margin','Cost missing']]
    .concat(D.byP.map(x=>Object.assign({},x,{gp:x.rev-x.cost})).sort((a,b)=>b.gp-a.gp).map(x=>[x.n,x.qty,Math.round(x.rev),Math.round(x.cost),Math.round(x.gp),pfPct(x.gp,x.rev),x.noCost?'YES':'']))
    .concat([[],['PROFIT BY CATEGORY'],['Category','Revenue','Profit','Margin']])
    .concat(D.byC.map(x=>[x.n,Math.round(x.rev),Math.round(x.rev-x.cost),pfPct(x.rev-x.cost,x.rev)]))
    .concat([[],['EXPENSES'],['Date','Category','Note','Amount']])
    .concat(D.expenses.slice().sort((a,b)=>a.date<b.date?-1:1).map(e=>[e.date,e.cat,e.desc,Math.round(e.amt)]));
  macDownload('Macrome-Profit-'+macYMD()+'.csv','\ufeff'+rows.map(r=>r.map(q).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  showToast('✅ Profit report exported','success');
}
async function exportProfitPDF(){
  if(typeof jspdf==='undefined'){showToast('PDF library not ready, try again…','error');return;}
  showLoader();
  try{
    const {jsPDF}=jspdf, pdf=new jsPDF({unit:'mm',format:'a4',orientation:'portrait'});
    const R=pfRange(), D=pfData(R.a,R.b), pageW=210,pageH=297,m=14,cW=pageW-m*2;
    const cG=[8,78,87],cO=[247,148,29],cI=[15,30,33],cGr=[107,131,136],cBg=[237,243,244],cRed=[192,57,43];
    const M=n=>pfM(n).replace('KES ','KES ');
    const band=()=>{pdf.setFillColor(...cG);pdf.rect(0,0,pageW,30,'F');pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(18);pdf.text((MAC_BIZ.name||'MACROME ELECTRONICS').toUpperCase(),m,13);
      pdf.setFont('helvetica','normal');pdf.setFontSize(9);pdf.text('Profit Report  |  '+R.label,m,20);pdf.text((MAC_BIZ.loc||'')+(MAC_BIZ.phone?'  |  Tel '+MAC_BIZ.phone:''),m,26);};
    band();let y=40;
    const ensure=h=>{if(y+h>pageH-16){pdf.addPage();y=16;}};
    // headline boxes
    const boxes=[['Revenue',M(D.revenue),cG],['Gross profit',M(D.gross),cG],['Expenses + tax',M(D.expTotal+D.tot),cO],['NET PROFIT',M(D.net),D.net<0?cRed:cG]], bw=(cW-9)/4;
    boxes.forEach((b,i)=>{const x=m+i*(bw+3);pdf.setFillColor(...cBg);pdf.roundedRect(x,y,bw,20,2,2,'F');pdf.setFillColor(...b[2]);pdf.rect(x,y,bw,1.6,'F');
      pdf.setTextColor(...cGr);pdf.setFont('helvetica','bold');pdf.setFontSize(7);pdf.text(b[0].toUpperCase(),x+3,8+y);pdf.setTextColor(...cI);pdf.setFontSize(10);pdf.text(b[1],x+3,16+y);});
    y+=28;
    // P&L
    pdf.setTextColor(...cG);pdf.setFont('helvetica','bold');pdf.setFontSize(11);pdf.text('Profit & Loss',m,y);y+=5;
    [['Sales revenue',M(D.revenue),0],['Less: cost of goods sold','- '+M(D.cogs).replace('-',''),0],['Gross profit  ('+pfPct(D.gross,D.revenue)+')',M(D.gross),1],['Less: operating expenses','- '+M(D.expTotal),0],['Less: turnover tax','- '+M(D.tot),0],['NET PROFIT  ('+pfPct(D.net,D.revenue)+')',M(D.net),2]].forEach(r=>{
      if(r[2]){pdf.setFillColor(...cBg);pdf.rect(m,y-4,cW,7,'F');}
      pdf.setFont('helvetica',r[2]?'bold':'normal');pdf.setFontSize(9);pdf.setTextColor(...(r[2]===2&&D.net<0?cRed:cI));pdf.text(r[0],m+2,y);pdf.text(r[1],m+cW-2,y,{align:'right'});y+=7;});
    y+=4;
    if(D.missing.length){pdf.setTextColor(...cRed);pdf.setFont('helvetica','bold');pdf.setFontSize(8);
      const t=pdf.splitTextToSize('Warning: '+D.missing.length+' product(s) sold have no cost price, so profit is overstated: '+D.missing.slice(0,8).join(', '),cW);pdf.text(t,m,y);y+=t.length*4+3;}
    // product table
    const table=(title,head,widths,rows)=>{
      ensure(20);pdf.setTextColor(...cG);pdf.setFont('helvetica','bold');pdf.setFontSize(11);pdf.text(title,m,y);y+=4;
      const hdr=()=>{pdf.setFillColor(...cG);pdf.rect(m,y,cW,7,'F');pdf.setTextColor(255,255,255);pdf.setFontSize(8);let x=m+2;head.forEach((h,i)=>{pdf.text(h,i?x+widths[i]-2:x,y+4.8,{align:i?'right':'left'});x+=widths[i];});y+=7;};
      hdr();
      rows.forEach((r,ri)=>{if(y+7>pageH-16){pdf.addPage();y=16;hdr();}
        if(ri%2){pdf.setFillColor(...cBg);pdf.rect(m,y,cW,6.5,'F');}
        pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.setTextColor(...cI);let x=m+2;
        r.forEach((c,i)=>{const s=String(c);if(i===0)pdf.text(pdf.splitTextToSize(s,widths[0]-4)[0],x,y+4.6);else pdf.text(s,x+widths[i]-2,y+4.6,{align:'right'});x+=widths[i];});y+=6.5;});
      y+=6;};
    const pr=D.byP.map(x=>Object.assign({},x,{gp:x.rev-x.cost})).sort((a,b)=>b.gp-a.gp);
    table('Profit by Product',['Product','Qty','Revenue','Cost','Profit','Margin'],[62,16,26,26,26,26],pr.map(x=>[x.n+(x.noCost?' *':''),x.qty,M(x.rev),M(x.cost),M(x.gp),pfPct(x.gp,x.rev)]));
    if(pr.some(x=>x.noCost)){pdf.setFont('helvetica','italic');pdf.setFontSize(7);pdf.setTextColor(...cGr);pdf.text('* cost price missing — profit overstated',m,y-3);y+=2;}
    table('Profit by Category',['Category','Revenue','Profit','Margin'],[70,38,38,36],D.byC.map(x=>Object.assign({},x,{gp:x.rev-x.cost})).sort((a,b)=>b.gp-a.gp).map(x=>[x.n,M(x.rev),M(x.gp),pfPct(x.gp,x.rev)]));
    if(D.expByCat.length)table('Expenses by Category',['Category','Amount'],[130,52],D.expByCat.map(x=>[x[0],M(x[1])]).concat([['Total',M(D.expTotal)]]));
    const pages=pdf.getNumberOfPages();
    for(let i=1;i<=pages;i++){pdf.setPage(i);pdf.setFont('helvetica','normal');pdf.setFontSize(7);pdf.setTextColor(...cGr);pdf.text('CONFIDENTIAL — For internal use only  ·  Generated '+new Date().toLocaleString('en-KE'),m,pageH-6);pdf.text('Page '+i+' of '+pages,pageW-m,pageH-6,{align:'right'});}
    pdf.save('Macrome-Profit-'+macYMD()+'.pdf');
    hideLoader();showToast('✅ Profit report exported as PDF','success');
  }catch(e){hideLoader();showToast('❌ Could not generate PDF','error');console.error(e);}
}

function macSnapshot(){
  return {app:'macrome-pos',v:2,savedAt:new Date().toISOString(),lastBackup:macLastBackup,
    shops:SHOPS.map(x=>({id:x.id,name:x.name,loc:x.loc})),transfers:CL.on?CLOUD_LEGACY.transfers:TRANSFERS,
    prods:CL.on?CLOUD_LEGACY.prods:PRODS.map(prodPlain),sales:CL.on?CLOUD_LEGACY.sales:cashierSales,expenses:CL.on?CLOUD_LEGACY.expenses:EXPENSES,receiptCounter,
    tot:{rate:TOT_CONFIG.rate,enabled:TOT_CONFIG.enabled},biz:MAC_BIZ};
}
function saveData(){
  try{
    const s=macSnapshot();
    localStorage.setItem(MAC_STORE_KEY,JSON.stringify(s));
    macLastSaved=s.savedAt;updateBackupUI();
    return true;
  }catch(e){
    console.error('[Macrome] save failed',e);
    if(!macStoreWarned){macStoreWarned=true;showToast('⚠️ Could not save on this device — download a backup now','error',6000);}
    updateBackupUI();
    return false;
  }
}
function macValidate(d){
  if(!d||typeof d!=='object'||!Array.isArray(d.prods)||!Array.isArray(d.sales))throw new Error('Not an Macrome Electronics backup');
}
function macApply(d){
  macValidate(d);
  // older (single-shop) backups have p.q and no shops: that stock becomes Shop A's
  const prods=d.prods.map(p=>mkProd({
    id:Math.floor(Number(p.id)),n:invClean(p.n),s:invClean(p.s),c:invClean(p.c)||'General',
    e:CAT_ICON[p.c]||'inventory_2',r:Number(p.r)||0,w:Number(p.w)||0,qs:p.qs,q:p.q
  })).filter(p=>Number.isFinite(p.id)&&p.n);
  if(Array.isArray(d.shops))d.shops.forEach(x=>{const t=x&&SHOPS.find(y=>y.id===x.id);if(t){t.name=invClean(x.name)||t.name;t.loc=invClean(x.loc||'');}});
  if(CL.on){CLOUD_LEGACY.prods=d.prods;CLOUD_LEGACY.transfers=Array.isArray(d.transfers)?d.transfers:[];}
  else{TRANSFERS.length=0;}
  if(!CL.on)(Array.isArray(d.transfers)?d.transfers:[]).forEach(t=>{const q=Math.floor(Number(t&&t.qty));if(t&&SHOP_IDS.includes(t.from)&&SHOP_IDS.includes(t.to)&&q>0)TRANSFERS.push({id:String(t.id||''),date:String(t.date||''),pid:Number(t.pid),n:invClean(t.n),from:t.from,to:t.to,qty:q,by:invClean(t.by)});});
  const sales=d.sales.map(s=>{const dt=new Date(s.date);return Object.assign({},s,{shop:SHOP_IDS.includes(s.shop)?s.shop:'A',date:isNaN(+dt)?new Date():dt,num:invClean(s.num),cashier:invClean(s.cashier),pay:invClean(s.pay),time:invClean(s.time),ref:invClean(s.ref),lines:(Array.isArray(s.lines)?s.lines:[]).map(l=>Object.assign({},l,{n:invClean(l.n)}))});});
  if(!CL.on){PRODS.length=0;prods.forEach(p=>PRODS.push(p));}
  try{renderShopCtl();renderShopSettings();}catch(_){}
  if(CL.on)CLOUD_LEGACY.sales=d.sales;else{cashierSales.length=0;sales.forEach(s=>cashierSales.push(s));}
  if(CL.on)CLOUD_LEGACY.expenses=Array.isArray(d.expenses)?d.expenses:[];
  if(!CL.on){EXPENSES.length=0;(Array.isArray(d.expenses)?d.expenses:[]).forEach(e=>{const amt=Number(e&&e.amt);if(e&&isFinite(amt)&&amt>0&&!isNaN(+pfParse(e.date)))EXPENSES.push({id:String(e.id||('x'+Math.random().toString(36).slice(2,8))),date:String(e.date),cat:EXP_CATS.includes(e.cat)?e.cat:'Other',desc:invClean(e.desc||''),amt,by:String(e.by||''),shop:SHOP_IDS.includes(e.shop)?e.shop:(e.shop===''&&d.v>=2?'':'A')});});}
  if(!CL.on)receiptCounter=Math.max(1,Math.floor(Number(d.receiptCounter))||1);
  if(d.tot){
    const r=Number(d.tot.rate);
    if(isFinite(r)&&r>=0&&r<=1)TOT_CONFIG.rate=r;
    TOT_CONFIG.enabled=d.tot.enabled!==false;
    const ri=document.getElementById('tot-rate-input');if(ri)ri.value=+(TOT_CONFIG.rate*100).toFixed(2);
    const tg=document.getElementById('tot-toggle');if(tg)tg.classList.toggle('on',TOT_CONFIG.enabled);
  }
  if(d.biz&&typeof d.biz==='object'){
    ['name','loc','phone','till'].forEach(k=>{if(typeof d.biz[k]==='string')MAC_BIZ[k]=d.biz[k];});
  }
  if(!MAC_BIZ.phone)MAC_BIZ.phone='0715186441';
  macFillBiz();
  macLastSaved=d.savedAt||null;macLastBackup=d.lastBackup||null;
}
function loadData(){
  let raw=null;
  try{raw=localStorage.getItem(MAC_STORE_KEY);}catch(e){return false;}
  if(!raw)return false;
  try{macApply(JSON.parse(raw));return true;}
  catch(e){
    console.error('[Macrome] saved data unreadable',e);
    // keep the unreadable copy so a later save can never overwrite it
    try{localStorage.setItem(MAC_STORE_KEY+'-corrupt-'+Date.now(),raw);}catch(_){}
    setTimeout(()=>showToast('⚠️ Saved data could not be read — a copy was kept. Restore from a backup.','error',7000),800);
    return false;
  }
}
function macFillBiz(){
  [['biz-name','name'],['biz-loc','loc'],['biz-phone','phone'],['biz-till','till']].forEach(([id,k])=>{
    const el=document.getElementById(id);if(el)el.value=MAC_BIZ[k]||'';
  });
}
function renderShopSettings(){
  const box=document.getElementById('shops-form');if(!box)return;
  box.innerHTML=SHOPS.map(x=>`<div class="pm-row" style="margin-bottom:6px"><div class="ff" style="margin-bottom:6px"><label>Shop ${x.id} name</label><input id="shop-n-${x.id}" value="${pfEsc(x.name)}" maxlength="30"></div><div class="ff" style="margin-bottom:6px"><label>Shop ${x.id} location (on receipts)</label><input id="shop-l-${x.id}" value="${pfEsc(x.loc)}" maxlength="40" placeholder="e.g. Chuka Town"></div></div>`).join('');
}
function saveShops(){
  if(!needMgr())return;
  if(userShop()){showToast('⛔ Only an all-shops manager can rename shops','error');return;}
  const names=SHOPS.map(x=>invClean(document.getElementById('shop-n-'+x.id).value)||('Shop '+x.id));
  if(new Set(names.map(n=>n.toLowerCase())).size<names.length){showToast('Give each shop a different name','error');return;}
  SHOPS.forEach((x,i)=>{x.name=names[i];x.loc=invClean(document.getElementById('shop-l-'+x.id).value);});
  if(CL.on)CL.saveSettings({shops:SHOPS.map(x=>({id:x.id,name:x.name,loc:x.loc}))}).catch(cloudFail('Shop names not saved to the cloud'));
  if(saveData()){renderShopCtl();renderShopSettings();renderShopCompare();try{setDate();refreshStockViews();}catch(_){}showToast('✅ Shops saved','success');}
}
function saveBiz(){
  if(!needMgr())return;
  if(CL.on&&userShop()){showToast('⛔ Only an all-shops manager can change business info','error');return;}
  const v=id=>invClean(document.getElementById(id).value);
  MAC_BIZ.name=v('biz-name')||'Macrome Electronics';MAC_BIZ.loc=v('biz-loc');MAC_BIZ.phone=v('biz-phone');MAC_BIZ.till=v('biz-till');
  macFillBiz();
  if(CL.on)CL.saveSettings({biz:{name:MAC_BIZ.name,loc:MAC_BIZ.loc,phone:MAC_BIZ.phone,till:MAC_BIZ.till}}).catch(cloudFail('Business info not saved to the cloud'));
  if(saveData())showToast('✅ Business info saved','success');
}
function updateBackupUI(){
  if(typeof updateBackupNudge==='function')updateBackupNudge();
  const fmt=t=>t?new Date(t).toLocaleString('en-KE',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):null;
  const ok=macStorageOK();
  const sv=document.getElementById('bk-saved'), bd=document.getElementById('bk-badge'), bf=document.getElementById('bk-file'), bp=document.getElementById('bk-persist');
  if(sv)sv.textContent=!ok?'This browser is blocking storage — data will be lost on refresh':macLastSaved?'Last saved '+fmt(macLastSaved):'Nothing saved yet — saves automatically after each change';
  if(bd){bd.className='badge '+(ok?'bg':'br');bd.textContent=ok?'Auto-save on':'Not saving';}
  if(bf)bf.textContent=macLastBackup?fmt(macLastBackup):'No backup file downloaded yet';
  if(bp){
    if(navigator.storage&&navigator.storage.persisted){
      navigator.storage.persisted().then(p=>{bp.textContent=p?'Protected — the browser will not clear this data automatically':'Standard — keep regular backups; clearing browser data erases everything';}).catch(()=>{});
    }else bp.textContent='Keep regular backups; clearing browser data erases everything';
  }
}
// ── BACKUP NUDGE + SHARE ─────────────────────────────────
const BACKUP_NUDGE_DAYS=3;                 // remind when the last backup is this many days old
const BACKUP_SNOOZE_KEY='macrome-backup-snooze';
function updateBackupNudge(){
  const el=document.getElementById('backup-nudge');if(!el)return;
  let show=false,title='',sub='';
  // this can run during start-up, before the login state exists: treat that as "not a manager yet"
  let mgr=false,hasData=false;
  try{mgr=isMgr();hasData=!!(PRODS.length||cashierSales.length);}catch(_){}
  if(mgr&&hasData){
    const t=macLastBackup?new Date(macLastBackup).getTime():NaN;
    if(isNaN(t)){
      show=true;title='No backup yet';
      sub='Your sales and stock are only on this device. Send a copy to WhatsApp or Drive now.';
    }else{
      const days=Math.floor((Date.now()-t)/864e5);
      if(days>=BACKUP_NUDGE_DAYS){
        show=true;title='Last backup was '+days+' days ago';
        sub='Send a fresh copy to WhatsApp or Drive so a lost or reset phone does not lose your records.';
      }
    }
    try{if(localStorage.getItem(BACKUP_SNOOZE_KEY)===macYMD())show=false;}catch(_){}
  }
  el.style.display=show?'flex':'none';
  if(show){document.getElementById('bkn-title').textContent=title;document.getElementById('bkn-sub').textContent=sub;}
}
function snoozeBackupNudge(){
  try{localStorage.setItem(BACKUP_SNOOZE_KEY,macYMD());}catch(_){}
  updateBackupNudge();
}
// One tap: opens the phone's share sheet (WhatsApp, Drive, Gmail...) with the backup file attached.
// If the browser cannot share files, the backup downloads instead.
async function shareBackup(){
  if(!needMgr())return;
  const prev=macLastBackup;
  macLastBackup=new Date().toISOString();           // so the file records when it was made
  const name='Macrome-backup-'+macYMD()+'.json';
  const text=JSON.stringify(macSnapshot(),null,2);
  let file=null;
  if(navigator.share&&navigator.canShare){
    for(const type of ['application/json','text/plain']){
      try{const f=new File([text],name,{type});if(navigator.canShare({files:[f]})){file=f;break;}}catch(_){}
    }
  }
  if(!file){
    macLastBackup=prev;backupNow();
    showToast('Sharing is not available here — backup downloaded instead','success',4500);
    return;
  }
  try{
    await navigator.share({files:[file],title:'Macrome Electronics backup',text:'Macrome Electronics backup '+macYMD()});
    saveData();
    showToast('✅ Backup shared — keep that copy safe','success',4500);
  }catch(err){
    macLastBackup=prev;                              // cancelled or failed: not counted as a backup
    if(err&&err.name!=='AbortError'){backupNow();showToast('Could not share — backup downloaded instead','error',4500);}
  }
  updateBackupUI();
}
function backupNow(){
  if(!needMgr())return;
  macLastBackup=new Date().toISOString();
  const snap=macSnapshot();
  macDownload('Macrome-backup-'+macYMD()+'.json',JSON.stringify(snap,null,2),'application/json');
  saveData();
  showToast('✅ Backup downloaded — keep a copy off this device','success',4500);
}
function restoreBackup(input){
  if(!needSuper())return;
  const f=input.files&&input.files[0];input.value='';
  if(!f)return;
  const rd=new FileReader();
  rd.onerror=()=>showToast('❌ Could not read that file','error');
  rd.onload=()=>{
    try{
      const d=JSON.parse(String(rd.result));macValidate(d);
      const when=d.savedAt?new Date(d.savedAt).toLocaleString('en-KE'):'unknown date';
      if(!confirm('Restore backup from '+when+'?'+(CL.on?'\n\nThis REPLACES the sales, expenses and settings on this device. Products and stock live in the cloud and are not changed.\n• '+d.sales.length+' sales':'\n\nThis REPLACES everything on this device (all shops) with:\n• '+d.prods.length+' products\n• '+d.sales.length+' sales')))return;
      macApply(d);cart=[];renderCart();saveData();refreshStockViews();
      showToast('✅ Backup restored','success');
    }catch(e){console.error(e);showToast('❌ That is not a valid Macrome Electronics backup file','error',4500);}
  };
  rd.readAsText(f);
}
function resetSales(){
  if(!needSuper())return;
  if(CL.on){showToast('Cloud sales are permanent records and cannot be cleared here','error',5000);return;}
  if(!cashierSales.length){showToast('There are no sales to clear');return;}
  const t=prompt('This permanently deletes ALL shops\' '+cashierSales.length+' recorded sales and restarts receipt numbers at #REC-0001.\nStock levels are NOT changed.\n\nDownload a backup first if you may need this data.\n\nType RESET to continue:');
  if(t===null)return;
  if(t.trim().toUpperCase()!=='RESET'){showToast('Cancelled — nothing was deleted');return;}
  cashierSales.length=0;receiptCounter=1;
  saveData();renderLive();
  showToast('🗑️ Sales history cleared','success');
}
// Another tab/window of the app saved — pick up its data so two tabs never overwrite each other
window.addEventListener('storage',e=>{
  if(e.key!==MAC_STORE_KEY||!e.newValue)return;
  try{macApply(JSON.parse(e.newValue));syncCart();refreshStockViews();updateBackupUI();}catch(_){}
});
// Load saved data now (DOM and TOT settings exist at this point)
loadData();
updateBackupUI();
try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().then(updateBackupUI);}catch(_){}


// ══ SIGN-IN & STAFF ACCOUNTS ═══════════════════════════
// Accounts live on this device (separate from the stock/sales data, and NOT included in
// backup files). Passwords are stored salted + hashed, never in plain text.
const MAC_USERS_KEY='macrome-users-v1', MAC_LOCK_KEY='macrome-login-lock';
const MAC_ROLE_LBL={super:'Super Admin',admin:'Manager',cashier:'Cashier'};
let MAC_USERS=[];
let CLOUD_SETUP=false;                              // cloud mode: the owner account has not been created yet
const $el=id=>document.getElementById(id);
const isMgr=()=>currentRole==='admin'||currentRole==='super';
function needMgr(){if(isMgr())return true;showToast('⛔ Manager access required','error');return false;}
function needSuper(){if(currentRole==='super')return true;showToast('⛔ Super Admin access required','error');return false;}

// SHA-256 (pure JS so it works on plain http and file:// too — no crypto.subtle needed)
function macPrimes(n){const p=[];for(let c=2;p.length<n;c++){let ok=true;for(let d=2;d*d<=c;d++)if(c%d===0){ok=false;break;}if(ok)p.push(c);}return p;}
const SHA_K=new Uint32Array(macPrimes(64).map(p=>Math.floor((Math.cbrt(p)%1)*4294967296)));
const SHA_H=macPrimes(8).map(p=>Math.floor((Math.sqrt(p)%1)*4294967296)>>>0);
function sha256b(msg){
  const l=msg.length, nb=((l+9+63)>>6)<<6, buf=new Uint8Array(nb);
  buf.set(msg);buf[l]=0x80;
  const dv=new DataView(buf.buffer);
  dv.setUint32(nb-8,Math.floor(l/536870912));dv.setUint32(nb-4,(l<<3)>>>0);
  const h=SHA_H.slice(), w=new Uint32Array(64), K=SHA_K, R=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let o=0;o<nb;o+=64){
    for(let i=0;i<16;i++)w[i]=dv.getUint32(o+i*4);
    for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(R(x,7)^R(x,18)^(x>>>3))+w[i-7]+(R(y,17)^R(y,19)^(y>>>10)))>>>0;}
    let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],k=h[7];
    for(let i=0;i<64;i++){
      const t1=(k+(R(e,6)^R(e,11)^R(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;
      const t2=((R(a,2)^R(a,13)^R(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+k)>>>0;
  }
  const out=new Uint8Array(32),ov=new DataView(out.buffer);h.forEach((x,i)=>ov.setUint32(i*4,x));return out;
}
function macCat(a,b){const r=new Uint8Array(a.length+b.length);r.set(a);r.set(b,a.length);return r;}
function macHex(u){return Array.from(u,x=>x.toString(16).padStart(2,'0')).join('');}
function hashPw(pw,salt){
  const te=new TextEncoder(), p=te.encode(pw);
  let h=sha256b(macCat(te.encode(salt),p));
  for(let i=0;i<10000;i++)h=sha256b(macCat(h,p));
  return macHex(h);
}
function rndHex(n){
  const a=new Uint8Array(n);
  if(window.crypto&&crypto.getRandomValues)crypto.getRandomValues(a);else for(let i=0;i<n;i++)a[i]=Math.floor(Math.random()*256);
  return macHex(a);
}

function loadUsers(){
  if(CL.on){MAC_USERS=[];return;}                   // cloud mode: accounts live in Firebase, not on this device
  let raw=null;
  try{raw=localStorage.getItem(MAC_USERS_KEY);}catch(e){MAC_USERS=[];return;}
  if(!raw){MAC_USERS=[];return;}
  try{
    const u=JSON.parse(raw);
    if(!Array.isArray(u))throw new Error('bad');
    MAC_USERS=u.filter(x=>x&&x.id&&x.username&&x.hash&&x.salt&&MAC_ROLE_LBL[x.role]);
  }catch(e){
    try{localStorage.setItem(MAC_USERS_KEY+'-corrupt-'+Date.now(),raw);}catch(_){}
    MAC_USERS=[];
  }
}
function saveUsers(){
  if(CL.on)return true;
  try{localStorage.setItem(MAC_USERS_KEY,JSON.stringify(MAC_USERS));return true;}
  catch(e){showToast('⚠️ Could not save accounts on this device','error',5000);return false;}
}
function refreshLoginMode(keep){
  const setup=CL.on?CLOUD_SETUP:!MAC_USERS.length;
  $el('lg-h').textContent=setup?'Set up Macrome Electronics':'Welcome back';
  $el('lg-p').textContent=setup?(CL.on?'Create the owner account. You will need the setup code from your Firebase rules.':'Create the owner account. You can add cashiers later in Settings.'):'Sign in to your business dashboard';
  $el('lg-name-w').style.display=setup?'':'none';
  $el('lp2-w').style.display=setup?'':'none';
  $el('lsc-w').style.display=(setup&&CL.on)?'':'none';
  $el('lg-btn-t').textContent=setup?'Create Owner Account':'Sign In to Dashboard';
  $el('lp').setAttribute('autocomplete',setup?'new-password':'current-password');
  if(!keep)['ln','lu','lp','lp2','lsc'].forEach(id=>{$el(id).value='';});
  $el('lg-err').textContent='';
  cloudNote();
}
// one-line status under the sign-in form (cloud mode)
function cloudNote(){
  const n=$el('lg-cloud');if(!n)return;
  let msg='',bad=false;
  if(CL.broken){msg='Cloud mode is on, but the Firebase library files are missing. Run tools/vendor.py and upload the vendor folder.';bad=true;}
  else if(CL.on&&!navigator.onLine)msg='You are offline. Only the person who last signed in on this phone can sign in.';
  n.textContent=msg;n.style.display=msg?'':'none';n.style.color=bad?'var(--danger-text)':'var(--g400)';
}
const MAC_USER_RE=/^[a-z0-9._-]{3,20}$/;
function setupOwner(){
  const err=m=>{$el('lg-err').textContent=m;};
  const name=invClean($el('ln').value), u=$el('lu').value.trim().toLowerCase(), p=$el('lp').value, p2=$el('lp2').value;
  if(!name)return err('Enter your name.');
  if(!MAC_USER_RE.test(u))return err('Username: 3–20 letters, numbers, dot, dash or underscore.');
  if(p.length<6)return err('Password must be at least 6 characters.');
  if(p!==p2)return err('The two passwords do not match.');
  const salt=rndHex(16);
  MAC_USERS=[{id:'u'+Date.now().toString(36),name,username:u,role:'super',salt,hash:hashPw(p,salt),created:new Date().toISOString()}];
  if(!saveUsers()){MAC_USERS=[];return;}
  const user=MAC_USERS[0];
  refreshLoginMode();
  enterApp(user);
}
function lockState(){try{return JSON.parse(localStorage.getItem(MAC_LOCK_KEY))||{n:0,until:0};}catch(e){return {n:0,until:0};}}
function setLockState(s){try{localStorage.setItem(MAC_LOCK_KEY,JSON.stringify(s));}catch(e){}}
function doLogin(){
  const b=$el('lg-btn'),t=$el('lg-btn-t');if(b.disabled)return;
  if(CL.on)return cloudLoginUI();
  t.textContent=MAC_USERS.length?'Signing in…':'Creating account…';b.disabled=true;b.setAttribute('aria-busy','true');
  setTimeout(()=>{try{doLoginNow();}finally{b.disabled=false;b.removeAttribute('aria-busy');t.textContent=MAC_USERS.length?'Sign In to Dashboard':'Create Owner Account';}},40);
}
function doLoginNow(){
  if(!MAC_USERS.length)return setupOwner();
  const err=m=>{$el('lg-err').textContent=m;};
  const ls=lockState(), now=Date.now();
  if(ls.until>now)return err('Too many wrong attempts. Try again in '+Math.ceil((ls.until-now)/1000)+' seconds.');
  const u=$el('lu').value.trim().toLowerCase(), p=$el('lp').value;
  if(!u||!p)return err('Enter your username and password.');
  const user=MAC_USERS.find(x=>x.username===u);
  const ok=user?hashPw(p,user.salt)===user.hash:(hashPw(p,'0'.repeat(32)),false);
  if(!ok){
    const n=(ls.n||0)+1;
    setLockState({n,until:n%5===0?now+60000:0});
    $el('lp').value='';
    return err(n%5===0?'Too many wrong attempts. Locked for 60 seconds.':'Incorrect username or password.');
  }
  setLockState({n:0,until:0});
  $el('lp').value='';$el('lg-err').textContent='';
  enterApp(user);
}

// ── Cloud mode sign-in (Firebase) ──
async function cloudLoginUI(){
  const b=$el('lg-btn'),t=$el('lg-btn-t'),setup=CLOUD_SETUP;
  t.textContent=setup?'Creating account…':'Signing in…';b.disabled=true;b.setAttribute('aria-busy','true');
  try{await (setup?cloudSetupOwner():cloudLoginNow());}
  catch(e){console.error(e);$el('lg-err').textContent=CL.friendly(e);}
  finally{b.disabled=false;b.removeAttribute('aria-busy');t.textContent=CLOUD_SETUP?'Create Owner Account':'Sign In to Dashboard';}
}
async function cloudLoginNow(){
  const err=m=>{$el('lg-err').textContent=m;};
  if(CL.broken)return err('The Firebase library files are missing. Run tools/vendor.py and upload the vendor folder.');
  const ls=lockState(), now=Date.now();
  if(ls.until>now)return err('Too many wrong attempts. Try again in '+Math.ceil((ls.until-now)/1000)+' seconds.');
  const u=$el('lu').value.trim().toLowerCase(), p=$el('lp').value;
  if(!u||!p)return err('Enter your username and password.');
  const wrong=()=>{
    const n=(ls.n||0)+1;
    setLockState({n,until:n%5===0?now+60000:0});
    $el('lp').value='';
    err(n%5===0?'Too many wrong attempts. Locked for 60 seconds.':'Incorrect username or password.');
  };
  let prof;
  try{prof=await CL.signIn(u,p);}
  catch(e){
    if(CL.isBadLogin(e))return wrong();
    if(!CL.isNetwork(e))return err(CL.friendly(e));
    try{prof=await CL.offlineSignIn(u,p);}            // no internet: same person, same phone
    catch(e2){if(e2.code==='auth/invalid-credential')return wrong();return err(CL.friendly(e2));}
  }
  setLockState({n:0,until:0});
  $el('lp').value='';$el('lg-err').textContent='';
  enterApp(prof);
}
async function cloudSetupOwner(){
  const err=m=>{$el('lg-err').textContent=m;};
  if(CL.broken)return err('The Firebase library files are missing. Run tools/vendor.py and upload the vendor folder.');
  const name=invClean($el('ln').value), u=$el('lu').value.trim().toLowerCase(), p=$el('lp').value, p2=$el('lp2').value, sc=$el('lsc').value.trim();
  if(!name)return err('Enter your name.');
  if(!MAC_USER_RE.test(u))return err('Username: 3–20 letters, numbers, dot, dash or underscore.');
  if(p.length<6)return err('Password must be at least 6 characters.');
  if(p!==p2)return err('The two passwords do not match.');
  if(!/^[A-Za-z0-9_-]{4,64}$/.test(sc))return err('Enter the setup code (letters, numbers, dash or underscore).');
  let prof;
  try{prof=await CL.setupOwner({name,username:u,password:p,code:CL.makeCode(name,[]),setupCode:sc});}
  catch(e){
    if(e.code==='permission-denied'){
      if(await CL.ownerExists()===true){CLOUD_SETUP=false;refreshLoginMode(true);return err('The owner account already exists. Sign in instead.');}
      return err('The setup code was not accepted.');
    }
    if(CL.isBadLogin(e))return err('That username is already taken.');
    throw e;
  }
  CLOUD_SETUP=false;
  $el('lp').value='';$el('lp2').value='';$el('lsc').value='';
  refreshLoginMode();
  enterApp(prof);
}
// Live link while signed in: my own record (switch-off / role or shop change) and, for managers, the staff list
function cloudSessionStart(user){
  MAC_USERS=[Object.assign({},user)];
  CL.startSession(user,{
    onProfile(p){
      if(!currentUser||currentUser.id!==user.id)return;
      if(!p||!p.active){logout();showToast('🔒 Your account has been switched off.','error',7000);return;}
      if(p.role!==currentUser.role||p.shop!==currentUser.shop){logout();showToast('Your account was changed. Please sign in again.','error',7000);return;}
      currentUser.name=p.name;currentUser.code=p.code;
    },
    onUsers(list){
      MAC_USERS=list;
      if(currentUser&&curPage()==='settings')renderStaff();
    },
    onError(e){console.warn('[Macrome cloud]',e&&e.code,e&&e.message);}
  });
  // shared catalogue + this person's stock (all shops for all-shops managers), live
  CAT={};STK={};CLOUD_READY={p:false,s:false};
  CL.startCatalog(user,{
    onProducts(m){CAT=m;CLOUD_READY.p=true;cloudRebuild();},
    onStock(m){STK=m;CLOUD_READY.s=true;cloudRebuild();},
    onCosts(m){COSTS=m;cloudRebuild();},
    onSettings(d){
      if(Array.isArray(d.shops))d.shops.forEach(x=>{const t=x&&SHOPS.find(y=>y.id===x.id);if(t){t.name=invClean(x.name)||t.name;t.loc=invClean(x.loc||'');}});
      if(d.biz&&typeof d.biz==='object')['name','loc','phone','till'].forEach(k=>{if(typeof d.biz[k]==='string')MAC_BIZ[k]=d.biz[k];});
      try{macFillBiz();renderShopCtl();if(curPage()!=='settings')renderShopSettings();}catch(_){}
      cloudRefresh();
    },
    onTransfers(list){TRANSFERS.length=0;list.forEach(t=>TRANSFERS.push(t));try{renderTransfers();}catch(_){}},
    onError(e){console.warn('[Macrome cloud]',e&&e.code,e&&e.message);}
  });
  cashierSales.length=0;cloudSalesStart();                              // sales: today's for attendants, this + last month for managers
  CL.loadSeq(user.id).then(n=>{try{const k='macrome-seq-'+user.id;localStorage.setItem(k,String(Math.max(n,parseInt(localStorage.getItem(k),10)||0)));}catch(_){}});   // carry on numbering from the last phone
}
// Rebuild the product list from the cloud copies. p.q keeps meaning "stock in the current shop view" (see mkProd).
let _cloudRefT=0;
function cloudRebuild(){
  if(!currentUser||!CLOUD_READY.p||!CLOUD_READY.s)return;          // wait until both the products and the stock have arrived
  const list=Object.keys(CAT).map(id=>{
    const d=CAT[id]||{},qs={};SHOP_IDS.forEach(sh=>{qs[sh]=STK[sh+'_'+id]||0;});
    const c=invClean(d.c)||'General';
    return mkProd({id:Number(id),n:invClean(d.n),s:invClean(d.s),c,e:CAT_ICON[c]||'inventory_2',r:Number(d.r)||0,w:(id in COSTS)?COSTS[id]:(Number(d.w)||0),qs});
  }).filter(p=>Number.isFinite(p.id)&&p.n);
  list.sort((a,b)=>a.n.localeCompare(b.n));
  PRODS.length=0;list.forEach(p=>PRODS.push(p));
  if(currentUser&&isMgr()&&!userShop()){                              // old catalogue (Phase 2): move cost prices out of the product records
    const old=Object.keys(CAT).filter(id=>CAT[id]&&CAT[id].w!==undefined&&!_scrubbed[id]);
    old.forEach(id=>{_scrubbed[id]=1;});
    if(old.length)CL.scrubCosts(old.map(id=>({id,w:(id in COSTS)?COSTS[id]:CAT[id].w}))).catch(e=>console.warn('[Macrome cloud] cost tidy',e&&e.code));
  }
  cloudRefresh();
}
function cloudRefresh(){                                           // several snapshots in a row = one redraw
  clearTimeout(_cloudRefT);
  _cloudRefT=setTimeout(()=>{if(!currentUser)return;try{syncCart();refreshStockViews();}catch(e){console.error(e);}},120);
}
function cloudSalesStart(){
  const u=currentUser;if(!u)return;
  SALE_SRC={};EXP_SRC={};RECEIPTS=[];
  SALES_DAY=CL.startSales(u,{
    onSales(name,map){SALE_SRC[name]=map;cloudSalesRebuild();},
    onExpenses(name,map){EXP_SRC[name]=map;cloudExpensesRebuild();},
    onReceipts(map){RECEIPTS=Object.keys(map).map(id=>{const d=map[id],t=d.at&&d.at.toDate?d.at.toDate():new Date();return {id,date:t,pid:d.pid,n:invClean(d.n),shop:d.shop,qty:Number(d.qty)||0,by:invClean(d.byName)};}).sort((a,b)=>b.date-a.date);try{renderReceipts();}catch(_){}},
    onError(e){console.warn('[Macrome cloud] sales',e&&e.code);}});
}
// Managers pick any period: make sure the months it covers are loaded (each month once; capped at 24 months back)
function cloudEnsureRange(a,b){
  if(!CL.on||!currentUser||!isMgr())return;
  const lo=new Date();lo.setMonth(lo.getMonth()-23,1);
  const from=new Date(Math.max(+a,+lo)),to=new Date(Math.min(+b,Date.now()+864e5));
  const out=[];
  for(let d=new Date(from.getFullYear(),from.getMonth(),1);d<=to;d=new Date(d.getFullYear(),d.getMonth()+1,1))out.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'));
  CL.ensureMonths(out);
}
function cloudExpensesRebuild(){
  if(!currentUser)return;
  const seen={};Object.keys(EXP_SRC).forEach(n=>Object.assign(seen,EXP_SRC[n]));
  const list=Object.keys(seen).map(id=>{const d=seen[id];return {id,date:String(d.date),cat:EXP_CATS.includes(d.cat)?d.cat:'Other',desc:invClean(d.desc),amt:Number(d.amt)||0,by:invClean(d.by),shop:SHOP_IDS.includes(d.shop)?d.shop:''};});
  EXPENSES.length=0;list.forEach(x=>EXPENSES.push(x));
  try{if(document.getElementById('ex-tbody'))renderExpenses();updateDashProfit();if(document.getElementById('pf-period')&&curPage()==='profit')renderProfit();}catch(_){}
}
function renderReceipts(){
  const box=document.getElementById('rcv-log');if(!box)return;
  const card=box.closest('.card');if(card)card.style.display=(CL.on&&isMgr())?'':'none';
  box.innerHTML=RECEIPTS.length?'<table style="min-width:440px"><thead><tr><th>When</th><th>Product</th><th>Qty</th><th>Shop</th><th>By</th></tr></thead><tbody>'+RECEIPTS.slice(0,20).map(t=>`<tr><td style="white-space:nowrap">${pfEsc(t.date.toLocaleString('en-KE',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))}</td><td style="font-weight:600">${pfEsc(t.n)}</td><td>+${t.qty}</td><td>${pfEsc(shopName(t.shop))}</td><td>${pfEsc(t.by)}</td></tr>`).join('')+'</tbody></table>':'<div style="color:var(--g400);font-size:12px;padding:6px 0">No stock received this month yet.</div>';
}
const cloudSaleObj=(id,d)=>{
  const dt=new Date(Number(d.ts)||Date.now());
  return {key:id,uid:d.cashierUid,num:invClean(d.num||id),time:dt.toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'}),date:dt,items:Number(d.items)||0,pay:invClean(d.pay),
    sub:Number(d.sub)||0,tot:Number(d.tot)||0,paid:d.paid==null?null:Number(d.paid),change:d.change==null?null:Number(d.change),ref:invClean(d.ref||''),
    cashier:invClean(d.cashier),cashierId:d.cashierUid,shop:SHOP_IDS.includes(d.shop)?d.shop:'A',
    lines:(Array.isArray(d.lines)?d.lines:[]).map(l=>({id:Number(l.id),n:invClean(l.n),qty:Number(l.qty)||0,r:Number(l.r)||0,w:0,t:Number(l.t)||0}))};
};
function cloudSalesRebuild(){
  if(!currentUser)return;
  const seen={};Object.keys(SALE_SRC).forEach(n=>Object.assign(seen,SALE_SRC[n]));
  const list=Object.keys(seen).map(id=>cloudSaleObj(id,seen[id])).sort((a,b)=>b.date-a.date);
  cashierSales.length=0;list.forEach(x=>cashierSales.push(x));
  cloudRefresh();
  if(curPage()==='cashier-history')try{renderCashierHistory();}catch(_){}
}
// Receipt running number for this person: never reuses one this phone or the cloud has seen
const seqKey=()=>'macrome-seq-'+(currentUser?currentUser.id:'');
function cloudNextSeq(){
  let n=0;try{n=parseInt(localStorage.getItem(seqKey()),10)||0;}catch(_){}
  cashierSales.forEach(s=>{if(s.uid===currentUser.id){const m=/-(\d{4,7})(-\d)?$/.exec(s.key||'');if(m)n=Math.max(n,parseInt(m[1],10));}});
  n++;try{localStorage.setItem(seqKey(),String(n));}catch(_){}
  return n;
}
function cloudSaveSale(sale,seq){
  const d=sale.date, p2=v=>String(v).padStart(2,'0');
  const day=d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
  const doc={shop:sale.shop,num:sale.num,ts:+d,day,month:day.slice(0,7),cashierUid:currentUser.id,cashier:String(sale.cashier).slice(0,40),items:sale.items,pay:String(sale.pay).slice(0,12),sub:sale.sub,tot:sale.tot,
    lines:sale.lines.map(l=>({id:l.id,n:String(l.n).slice(0,80),qty:l.qty,r:l.r,t:l.t}))};
  if(sale.paid!=null)doc.paid=sale.paid;if(sale.change!=null)doc.change=sale.change;if(sale.ref)doc.ref=String(sale.ref).slice(0,12);
  CL.recordSale(doc,seq).then(id=>{if(id!==sale.key)sale.key=id;}).catch(cloudFail('Sale was NOT saved to the cloud'));
}
setInterval(()=>{if(CL.on&&currentUser&&SALES_DAY&&CL.dayKey(new Date())!==SALES_DAY)cloudSalesStart();},60000);   // a new day: attendants' "today" list restarts
window.addEventListener('online',cloudNote);window.addEventListener('offline',cloudNote);

// ── Staff management (Settings) ──
function canManage(t){return currentRole==='super'||(currentRole==='admin'&&t.role==='cashier'&&(!userShop()||userShop(t)===userShop()));}
function renderStaff(){
  const box=$el('staff-list');if(!box)return;
  const note=$el('staff-cloud-note');
  if(note){note.style.display=CL.on?'':'none';if(CL.on)note.textContent='Accounts are kept in the cloud and work on any phone. Each person signs in once with internet; after that the same phone can sign in offline. Everyone changes their own password under Change My Password.';}
  const bd={super:'bb',admin:'bb',cashier:'bg'};
  box.innerHTML=MAC_USERS.map((u,i)=>{
    const me=currentUser&&u.id===currentUser.id, manage=!me&&canManage(u);
    const ini=pfEsc((u.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase());
    const st=u.role==='cashier'?'background:var(--gold-p);color:var(--text-gold)':'background:var(--pale);color:var(--text-brand)';
    const canMove=manage&&!userShop()&&u.role!=='super';
    const shopPick=canMove?`<select aria-label="Shop for ${pfEsc(u.name)}" onchange="setStaffShop('${u.id}',this.value)" style="padding:6px 10px;min-height:48px;font-size:13px;border:1.5px solid var(--g100);border-radius:var(--r-sm);background:var(--g50);flex-shrink:0">${u.role==='cashier'?'':'<option value="">All shops</option>'}${SHOPS.map(x=>`<option value="${x.id}"${userShop(u)===x.id?' selected':''}>${pfEsc(x.name)}</option>`).join('')}</select>`:'';
    const off=u.active===false;
    const btns=manage?(CL.on
      ?`<div style="display:flex;gap:14px;flex-shrink:0"><button class="btn ${off?'btn-s':'btn-d'}" style="padding:6px 14px;font-size:13px;min-height:48px" onclick="toggleStaffActive('${u.id}')">${off?'Switch on':'Switch off'}</button></div>`
      :`<div style="display:flex;gap:14px;flex-shrink:0"><button class="btn btn-s" style="padding:6px 14px;font-size:13px;min-height:48px" onclick="openPwModal('${u.id}')">Reset</button><button class="btn btn-d" style="padding:6px 14px;font-size:13px;min-height:48px" onclick="delStaff('${u.id}')">Delete</button></div>`):'';
    return `<div class="cr"${i?' style="margin-top:8px"':''}><div class="cav" style="${st}">${ini}</div><div class="cn">${pfEsc(u.name)} <span class="badge ${bd[u.role]}" style="font-size:12px">${MAC_ROLE_LBL[u.role]}</span>${me?' <span class="badge bw" style="font-size:12px">You</span>':''}${off?' <span class="badge bw" style="font-size:12px">Off</span>':''}<div style="font-size:12px;color:var(--g400);font-weight:400">@${pfEsc(u.username)} · ${u.role==='super'?'All shops':pfEsc(userShop(u)?shopName(userShop(u)):'All shops')}</div></div>${shopPick}${btns}</div>`;
  }).join('')||'<div style="color:var(--g400);font-size:12px">No accounts yet</div>';
}
function setStaffShop(id,v){
  const t=MAC_USERS.find(x=>x.id===id);
  if(!t||userShop()||currentRole!=='super'&&currentRole!=='admin'||!canManage(t)||t.role==='super')return;
  if(CL.on){
    let ns=SHOP_IDS.includes(v)?v:'';if(t.role==='cashier'&&!ns)ns='A';
    CL.updateUser(id,{shop:ns}).then(()=>showToast('✅ '+t.name+' → '+(ns?shopName(ns):'All shops'),'success')).catch(e=>{showToast('⚠️ '+CL.friendly(e),'error',5000);renderStaff();});
    return;
  }
  const old=t.shop;t.shop=SHOP_IDS.includes(v)?v:'';
  if(t.role==='cashier'&&!t.shop)t.shop='A';
  if(!saveUsers()){t.shop=old;}
  renderStaff();showToast('✅ '+t.name+' → '+(t.shop?shopName(t.shop):'All shops'),'success');
}
function openStaffModal(){
  if(!needMgr())return;
  ['st-name','st-user','st-pw','st-pw2'].forEach(id=>{$el(id).value='';});
  const roles=currentRole==='super'?['cashier','admin','super']:['cashier'];
  $el('st-role').innerHTML=roles.map(r=>`<option value="${r}">${MAC_ROLE_LBL[r]}</option>`).join('');
  const own=userShop();
  $el('st-shop').innerHTML=(own?'':'<option value="">All shops (managers only)</option>')+SHOPS.filter(x=>!own||x.id===own).map(x=>`<option value="${x.id}"${x.id===(own||LAST_SHOP)?' selected':''}>${pfEsc(x.name)}</option>`).join('');
  $el('st-err').textContent='';
  $el('staff-modal').classList.add('show');
  setTimeout(()=>$el('st-name').focus(),60);
}
function closeStaffModal(){$el('staff-modal').classList.remove('show');}
function saveStaff(){
  if(!needMgr())return;
  const err=m=>{$el('st-err').textContent=m;};
  const name=invClean($el('st-name').value), u=$el('st-user').value.trim().toLowerCase(), role=$el('st-role').value, p=$el('st-pw').value, p2=$el('st-pw2').value;
  let shop=$el('st-shop').value;
  if(userShop())shop=userShop();
  if(!name)return err('Enter their full name.');
  if(!MAC_USER_RE.test(u))return err('Username: 3–20 letters, numbers, dot, dash or underscore.');
  if(MAC_USERS.some(x=>x.username===u))return err('That username is already taken.');
  if(!MAC_ROLE_LBL[role]||(currentRole!=='super'&&role!=='cashier'))return err('You can only create Cashier accounts.');
  if(role==='cashier'&&!SHOP_IDS.includes(shop))return err('Pick which shop this cashier works in.');
  if(role==='super')shop='';
  if(p.length<6)return err('Password must be at least 6 characters.');
  if(p!==p2)return err('The two passwords do not match.');
  if(CL.on)return cloudSaveStaff({name,u,role,shop,p});
  const salt=rndHex(16);
  MAC_USERS.push({id:'u'+Date.now().toString(36)+rndHex(2),name,username:u,role,shop:SHOP_IDS.includes(shop)?shop:'',salt,hash:hashPw(p,salt),created:new Date().toISOString()});
  if(!saveUsers()){MAC_USERS.pop();return;}
  closeStaffModal();renderStaff();
  showToast('✅ Account created for '+name,'success');
}
async function cloudSaveStaff(o){
  const btn=document.querySelector('#staff-modal .btn-p');if(btn)btn.disabled=true;
  try{
    const taken=MAC_USERS.filter(x=>(x.shop||'')===(o.shop||'')).map(x=>x.code).filter(Boolean);   // codes already used in that shop
    await CL.createStaff({name:o.name,username:o.u,password:o.p,role:o.role,shop:o.shop,code:CL.makeCode(o.name,taken)});
    closeStaffModal();showToast('✅ Account created for '+o.name,'success');
  }catch(e){$el('st-err').textContent=CL.friendly(e);}
  finally{if(btn)btn.disabled=false;}
}
function toggleStaffActive(id){
  const t=MAC_USERS.find(x=>x.id===id);
  if(!t||!currentUser)return;
  if(t.id===currentUser.id)return showToast('You cannot switch off your own account','error');
  if(!isMgr()||!canManage(t))return showToast('⛔ You cannot change this account','error');
  const on=t.active===false;
  if(!on&&t.role==='super'&&MAC_USERS.filter(x=>x.role==='super'&&x.active!==false).length<2)return showToast('Keep at least one active Super Admin','error');
  if(!on&&!confirm('Switch off the account for '+t.name+' (@'+t.username+')?\nThey are signed out and cannot sign in until you switch it back on. Their past sales stay in the records.'))return;
  CL.updateUser(id,{active:on}).then(()=>showToast(on?'✅ Account switched on for '+t.name:'🔒 Account switched off for '+t.name,'success')).catch(e=>showToast('⚠️ '+CL.friendly(e),'error',5000));
}
let pwTarget=null;
function openPwModal(id){
  const t=MAC_USERS.find(x=>x.id===id);
  if(!t||!currentUser)return;
  const self=t.id===currentUser.id;
  if(CL.on&&!self)return showToast('Staff change their own password in Settings. Use Switch off if a phone is lost.','',6000);
  if(!self&&!(isMgr()&&canManage(t)))return needMgr()&&showToast('⛔ You cannot change this account','error');
  pwTarget=id;
  $el('pw-title').textContent=self?'Change My Password':'Reset Password';
  $el('pw-sub').textContent=self?'You will use the new password next time you sign in.':'Set a new password for '+t.name+' (@'+t.username+').';
  $el('pw-cur-w').style.display=self?'':'none';
  ['pw-cur','pw-new','pw-new2'].forEach(i=>{$el(i).value='';});
  $el('pw-err').textContent='';
  $el('pw-modal').classList.add('show');
  setTimeout(()=>$el(self?'pw-cur':'pw-new').focus(),60);
}
function closePwModal(){$el('pw-modal').classList.remove('show');pwTarget=null;}
function savePw(){
  const t=MAC_USERS.find(x=>x.id===pwTarget);
  const err=m=>{$el('pw-err').textContent=m;};
  if(!t||!currentUser)return closePwModal();
  const self=t.id===currentUser.id;
  if(!self&&!(isMgr()&&canManage(t)))return err('You cannot change this account.');
  const p=$el('pw-new').value, p2=$el('pw-new2').value;
  if(CL.on){
    if(!self)return err('You can only change your own password.');
    if(!$el('pw-cur').value)return err('Enter your current password.');
    if(p.length<6)return err('Password must be at least 6 characters.');
    if(p!==p2)return err('The two passwords do not match.');
    CL.changeOwnPassword($el('pw-cur').value,p)
      .then(()=>{CL.remember(currentUser,p);closePwModal();showToast('✅ Password updated','success');})
      .catch(e=>err(CL.isBadLogin(e)?'Your current password is wrong.':CL.friendly(e)));
    return;
  }
  if(self&&hashPw($el('pw-cur').value,t.salt)!==t.hash)return err('Your current password is wrong.');
  if(p.length<6)return err('Password must be at least 6 characters.');
  if(p!==p2)return err('The two passwords do not match.');
  const old={salt:t.salt,hash:t.hash};
  t.salt=rndHex(16);t.hash=hashPw(p,t.salt);
  if(!saveUsers()){t.salt=old.salt;t.hash=old.hash;return;}
  closePwModal();
  showToast('✅ Password updated','success');
}
function delStaff(id){
  const t=MAC_USERS.find(x=>x.id===id);
  if(!t||!currentUser)return;
  if(t.id===currentUser.id)return showToast('You cannot delete your own account','error');
  if(!isMgr()||!canManage(t))return showToast('⛔ You cannot delete this account','error');
  if(t.role==='super'&&MAC_USERS.filter(x=>x.role==='super').length<2)return showToast('Keep at least one Super Admin','error');
  if(!confirm('Delete the account for '+t.name+' (@'+t.username+')?\nTheir past sales stay in the records.'))return;
  const at=MAC_USERS.indexOf(t);
  MAC_USERS=MAC_USERS.filter(x=>x.id!==id);
  saveUsers();renderStaff();
  showToast('🗑️ Account deleted for '+t.name,'',8000,{label:'Undo',fn:()=>{
    if(MAC_USERS.some(x=>x.id===t.id||x.username===t.username))return;
    MAC_USERS.splice(Math.min(at,MAC_USERS.length),0,t);saveUsers();renderStaff();showToast('✅ Account restored for '+t.name,'success');
  }});
}
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  if($el('staff-modal').classList.contains('show')){e.preventDefault();saveStaff();}
  else if($el('pw-modal').classList.contains('show')){e.preventDefault();savePw();}
  else if(e.target&&e.target.closest&&e.target.closest('#login')){e.preventDefault();doLogin();}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeStaffModal();closePwModal();}});
loadUsers();
refreshLoginMode();
if(CL.on&&!CL.broken)CL.ownerExists().then(x=>{if(x===false){CLOUD_SETUP=true;refreshLoginMode(true);}});   // first launch ever: show owner setup
