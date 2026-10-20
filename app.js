'use strict';
const APP_VERSION = '1.2.0';
const APP_NAME = 'SK-달력';
const DB_VERSION = 2;
const $ = id => document.getElementById(id);
let db, selected = dateKey(new Date()), shown = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let editingOriginal=null;
let suppressDateClickUntil = 0;
let monthAnimating = false, dragX = 0;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let monthEvents = [], editingId = null, registration = null, remoteVersion = null, applyingUpdate = false;
function dateKey(d) { return `${String(d.getFullYear()).padStart(4,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDate(s) { const [y,m,d] = s.split('-').map(Number); const date = new Date(0); date.setFullYear(y,m-1,d); date.setHours(12,0,0,0); return date; }
function notify(text) { $('messageText').textContent = text; if (!$('messageDialog').open) $('messageDialog').showModal(); }
function openDatabase() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open('haru-personal-calendar', DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings',{keyPath:'id'});
      if (!database.objectStoreNames.contains('events')) {
        const events = database.createObjectStore('events',{keyPath:'id'});
        events.createIndex('date','date');
      }
      // Future records may use YYYY, YYYY-MM or YYYY-MM-DD dates. Do not coerce them.
      if (!database.objectStoreNames.contains('records')) {
        const records = database.createObjectStore('records',{keyPath:'id'});
        records.createIndex('date','date');
        records.createIndex('nextDueDate','nextDueDate');
      }
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); notify('다른 창에서 저장소가 변경되었습니다. 이 창을 닫고 다시 열어 주세요.'); }; resolve(req.result); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => notify('앱이 열린 다른 탭을 닫은 뒤 다시 실행해 주세요.');
  });
}
// Reserved record factory: all planned fields are present; no sample data is saved.
function createRecord(values = {}) {
  const now = new Date().toISOString();
  return {id:crypto.randomUUID(),date:'',endDate:null,title:'',category:'',subject:'',cost:null,currency:'USD',place:'',memo:'',nextDueDate:null,recurrence:null,createdAt:now,updatedAt:now,...values};
}
function readEvents(range) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction('events','readonly');
    const req = tx.objectStore('events').index('date').getAll(range);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
function saveEvent(value, remove = false) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction('events','readwrite');
    const store = tx.objectStore('events');
    if (remove) store.delete(value); else store.put(value);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function render() {
  $('monthTitle').textContent = `${shown.getFullYear()}년 ${shown.getMonth()+1}월`;
  const start = new Date(shown); start.setDate(1-start.getDay());
  const end = new Date(start); end.setDate(end.getDate()+41);
  const requestMonth = shown.getTime();
  try { const [results, records] = await Promise.all([readEvents(IDBKeyRange.bound(dateKey(start),dateKey(end))),getAll('records')]); if (requestMonth !== shown.getTime()) return; allRecords=records; monthEvents = [...results,...records.filter(r=>r.nextDueDate && r.nextDueDate>=dateKey(start) && r.nextDueDate<=dateKey(end)).map(dueEvent)]; refreshUpcoming(); }
  catch { notify('일정을 읽지 못했습니다. 앱을 다시 열어 주세요.'); return; }
  const counts = new Set(monthEvents.map(e => e.date));
  $('days').replaceChildren();
  for(let i=0;i<42;i++) {
    const day = new Date(start); day.setDate(start.getDate()+i); const key = dateKey(day);
    const b = document.createElement('button'); b.className = 'day';
    if(day.getDay()===0) b.classList.add('sun'); if(day.getDay()===6) b.classList.add('sat');
    if(day.getMonth()!==shown.getMonth()) b.classList.add('outside');
    if(key===dateKey(new Date())) { b.classList.add('today'); b.setAttribute('aria-current','date'); }
    if(key===selected) b.classList.add('selected');
    b.setAttribute('aria-pressed',String(key===selected));
    b.setAttribute('aria-label',`${day.getFullYear()}년 ${day.getMonth()+1}월 ${day.getDate()}일${counts.has(key)?', 일정 있음':''}`);
    const num = document.createElement('span'); num.textContent = day.getDate();
    const dot = document.createElement('span'); dot.className = `dot${counts.has(key)?'':' empty'}`; dot.setAttribute('aria-hidden','true');
    b.append(num,dot); b.onclick = async () => { if(monthAnimating || Date.now()<suppressDateClickUntil) return; selected=key; if(day.getMonth()!==shown.getMonth() || day.getFullYear()!==shown.getFullYear()) shown=new Date(day.getFullYear(),day.getMonth(),1); await render(); openEditor(); };
    $('days').append(b);
  }
  renderList();
}
function renderList() {
  const d = parseDate(selected);
  $('selectedTitle').textContent = `${d.getMonth()+1}월 ${d.getDate()}일 ${['일','월','화','수','목','금','토'][d.getDay()]}요일`;
  const events = monthEvents.filter(e=>e.date===selected).sort((a,b)=>(a.time||'99').localeCompare(b.time||'99') || a.createdAt.localeCompare(b.createdAt));
  $('eventCount').textContent = `${events.length}개 일정`; $('eventList').replaceChildren();
  if(!events.length) { const empty = document.createElement('div'); empty.className='empty-state'; const title=document.createElement('strong'); title.textContent='여유로운 하루입니다'; const text=document.createElement('p'); text.textContent='새 일정을 추가해 보세요.'; empty.append(title,text); $('eventList').append(empty); }
  for(const event of events) {
    const b=document.createElement('button'); b.className='event-item';
    b.setAttribute('aria-label',`${event.time||'시간 없음'} ${event.title}, 수정`);
    const time=document.createElement('span'); time.className='event-time'; time.textContent=event.time||'종일';
    const copy=document.createElement('span'); copy.className='event-copy'; const title=document.createElement('span'); title.className='event-name'; title.textContent=event.title; copy.append(title);
    if(event.memo) { const memo=document.createElement('span'); memo.className='event-memo'; memo.textContent=event.memo; copy.append(memo); }
    const hint=document.createElement('span'); hint.className='edit-hint'; hint.textContent='›'; b.append(time,copy,hint); b.onclick=()=>event.sourceRecordId?openRecordEditor(allRecords.find(r=>r.id===event.sourceRecordId)):openEditor(event); $('eventList').append(b);
  }
}
async function moveMonth(offset) {
  if(monthAnimating) return;
  const next=new Date(shown.getFullYear(),shown.getMonth()+offset,1);
  if(next.getFullYear()<1 || next.getFullYear()>9998) { resetDrag(); return; }
  monthAnimating=true;
  $('prev').disabled=true; $('next').disabled=true; $('today').disabled=true;
  const grid=$('days'), direction=offset>0?-1:1, width=grid.clientWidth;
  try {
    if(!reducedMotion() && grid.animate) {
      await grid.animate([
        {transform:`translateX(${dragX}px)`,opacity:1},
        {transform:`translateX(${direction*width}px)`,opacity:0.25}
      ],{duration:140,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'}).finished;
    }
    shown=next; selected=dateKey(shown); await render();
    grid.getAnimations().forEach(animation=>animation.cancel()); grid.style.transform=''; dragX=0;
    if(!reducedMotion() && grid.animate) {
      await grid.animate([
        {transform:`translateX(${-direction*width}px)`,opacity:0.4},
        {transform:'translateX(0)',opacity:1}
      ],{duration:210,easing:'cubic-bezier(0,0,.2,1)'}).finished;
    }
  } catch { /* Canceled animations must not disable calendar navigation. */ }
  finally {
    grid.getAnimations().forEach(animation=>animation.cancel()); grid.style.transform=''; dragX=0;
    monthAnimating=false; suppressDateClickUntil=Date.now()+180;
    $('prev').disabled=false; $('next').disabled=false; $('today').disabled=false;
  }
}
function resetDrag() {
  const grid=$('days'), from=dragX; dragX=0; grid.style.transform='';
  if(from && !reducedMotion() && grid.animate) grid.animate([
    {transform:`translateX(${from}px)`},{transform:'translateX(0)'}
  ],{duration:160,easing:'ease-out'});
}
function openEditor(event) {
  editingOriginal=event||null; editingId=event?.id||null; $('eventForm').reset(); $('formError').textContent=''; $('formTitle').textContent=event?'일정 수정':'일정 추가';
  $('eventDate').value=event?.date||selected; $('eventTime').value=event?.time||''; $('eventTitle').value=event?.title||''; $('eventMemo').value=event?.memo||''; $('deleteEvent').hidden=!event; $('eventDialog').showModal();
}
async function storageStatus(request = false) {
  let persisted=false;
  try { if(navigator.storage?.persisted) persisted=await navigator.storage.persisted(); if(request && !persisted && navigator.storage?.persist) persisted=await navigator.storage.persist();
    $('storageStatus').textContent=persisted?'영구 저장: 허용됨 (데이터 삭제까지 막지는 못합니다)':'영구 저장: 미허용 또는 지원 안 됨. 브라우저가 공간 부족 시 데이터를 지울 수 있습니다.';
  } catch { $('storageStatus').textContent='영구 저장 상태를 확인하지 못했습니다.'; }
}
async function getWorkerVersion(worker) {
  if(!worker) return null;
  return new Promise(resolve=>{ const channel=new MessageChannel(); const timer=setTimeout(()=>resolve(null),3000); channel.port1.onmessage=e=>{clearTimeout(timer); resolve(e.data?.version);}; worker.postMessage({type:'GET_VERSION'},[channel.port2]); });
}
async function checkUpdate(manual=false) {
  if(!navigator.onLine){$('updateStatus').textContent='오프라인입니다. 일정·기록은 사용할 수 있으며 업데이트는 인터넷 연결 후 확인해 주세요.';if(manual)notify('업데이트 확인에는 인터넷 연결이 필요합니다.');return;}
  $('updateStatus').textContent='새 버전 확인 중…';
  try {
    const response=await fetch(`./version.json?check=${Date.now()}`,{cache:'no-store'}); if(!response.ok) throw new Error('network');
    const data=await response.json();
    if(!/^\d+\.\d+\.\d+$/.test(data.version) || !Array.isArray(data.notes)) throw new Error('format');
    const newer=data.version.split('.').map(Number).reduce((state,n,i)=>state || Math.sign(n-Number(APP_VERSION.split('.')[i])),0)>0;
    if(newer) {
      remoteVersion=data; $('updateTitle').textContent=`새 버전 v${data.version}가 있습니다`; $('updateNotes').replaceChildren();
      for(const note of data.notes) { const li=document.createElement('li'); li.textContent=String(note); $('updateNotes').append(li); }
      $('updateStatus').textContent=`새 버전 v${data.version}가 있습니다.`;
      if(!$('updateDialog').open) $('updateDialog').showModal();
      if(registration) await registration.update();
    } else { $('updateStatus').textContent=`현재 최신 버전 v${APP_VERSION}입니다.`; if(manual) notify('현재 최신 버전입니다.'); }
  } catch { $('updateStatus').textContent='새 버전을 확인할 수 없습니다. 인터넷 연결 후 다시 눌러 주세요.'; if(manual) notify('업데이트 확인에 실패했습니다. 인터넷 연결을 확인해 주세요.'); }
}
async function applyUpdate() {
  if(!registration || !remoteVersion) { $('updateError').textContent='업데이트 기능이 준비되지 않았습니다. 인터넷 연결 후 앱을 다시 열어 주세요.'; return; }
  $('applyUpdate').disabled=true; $('applyUpdate').textContent='준비 중…'; $('updateError').textContent='';
  try {
    if($('eventDialog').open || $('recordDialog').open) throw new Error('입력 중인 일정을 저장하거나 닫은 뒤 업데이트해 주세요.');
    await registration.update();
    if(registration.installing) await new Promise((resolve,reject)=>{const worker=registration.installing; const timer=setTimeout(()=>reject(new Error('업데이트 준비가 오래 걸립니다. 잠시 후 다시 시도해 주세요.')),20000); const check=()=>{if(worker.state==='installed'){clearTimeout(timer);resolve();} if(worker.state==='redundant'){clearTimeout(timer);reject(new Error('새 파일을 받지 못했습니다. 다시 시도해 주세요.'));}}; worker.addEventListener('statechange',check); check();});
    const worker=registration.waiting;
    if(!worker || await getWorkerVersion(worker)!==remoteVersion.version) throw new Error('새 파일이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    applyingUpdate=true; worker.postMessage({type:'SKIP_WAITING'});
  } catch(error) { $('updateError').textContent=error.message; $('applyUpdate').disabled=false; $('applyUpdate').textContent='지금 업데이트'; }
}
function bindUI() {
  document.querySelectorAll('[data-version]').forEach(el=>el.textContent=el.classList.contains('settings-version')?`v${APP_VERSION}`:`버전 v${APP_VERSION}`);
  // The settings heading uses a nested span with the word '버전' outside it.
  document.querySelector('.settings-version [data-version]').textContent=`v${APP_VERSION}`;
  $('appSignature').textContent=`${APP_NAME}-v${APP_VERSION}`;
  $('prev').onclick=()=>moveMonth(-1); $('next').onclick=()=>moveMonth(1);
  $('today').onclick=()=>{selected=dateKey(new Date()); shown=new Date(new Date().getFullYear(),new Date().getMonth(),1); render();};
  $('addEvent').onclick=()=>openEditor(); $('closeEvent').onclick=()=>$('eventDialog').close();
  $('eventForm').onsubmit=async event=>{
    event.preventDefault(); if(eventSaving)return; const title=$('eventTitle').value.trim(); if(!title){$('formError').textContent='제목을 입력해 주세요.';return;}
    eventSaving=true; const submit=$('eventForm').querySelector('[type=submit]');submit.disabled=true;
    const old=editingOriginal||monthEvents.find(e=>e.id===editingId); const now=new Date().toISOString();
    const value={id:editingId||crypto.randomUUID(),date:$('eventDate').value,time:$('eventTime').value,title,memo:$('eventMemo').value.trim(),createdAt:old?.createdAt||now,updatedAt:now};
    try { await saveEvent(value); selected=value.date; const d=parseDate(selected); shown=new Date(d.getFullYear(),d.getMonth(),1); $('eventDialog').close(); await refreshData(); }
    catch { $('formError').textContent='저장하지 못했습니다. 저장 공간 또는 브라우저 설정을 확인해 주세요.'; } finally {eventSaving=false;submit.disabled=false;}
  };
  $('deleteEvent').onclick=()=>$('deleteDialog').showModal(); $('cancelDelete').onclick=()=>$('deleteDialog').close();
  $('confirmDelete').onclick=async()=>{try{await saveEvent(editingId,true);$('deleteDialog').close();$('eventDialog').close();await refreshData();}catch{notify('삭제하지 못했습니다. 다시 시도해 주세요.');}};
  $('closeMessage').onclick=()=>$('messageDialog').close();
  for(const name of ['calendar','records','search','settings']) $(name+'Tab').onclick=()=>showTab(name);
  $('persistButton').onclick=()=>storageStatus(true);$('checkUpdate').onclick=()=>checkUpdate(true);$('laterUpdate').onclick=()=>$('updateDialog').close();$('applyUpdate').onclick=applyUpdate;
  let touch=null; const calendar=document.querySelector('.calendar');
  calendar.addEventListener('touchstart',e=>{
    if(monthAnimating || e.touches.length!==1) { touch=null; return; }
    touch={x:e.touches[0].clientX,y:e.touches[0].clientY,horizontal:false};
  },{passive:true});
  calendar.addEventListener('touchmove',e=>{
    if(!touch || monthAnimating) return;
    if(e.touches.length!==1) { touch=null; resetDrag(); return; }
    const dx=e.touches[0].clientX-touch.x,dy=e.touches[0].clientY-touch.y;
    if(!touch.horizontal && Math.abs(dy)>12 && Math.abs(dy)>Math.abs(dx)) {touch=null;resetDrag();return;}
    if(Math.abs(dx)>12 && Math.abs(dx)>Math.abs(dy)*1.3) touch.horizontal=true;
    if(touch.horizontal) {
      if(e.cancelable)e.preventDefault();
      suppressDateClickUntil=Date.now()+500;
      dragX=reducedMotion()?0:Math.max(-$('days').clientWidth,Math.min($('days').clientWidth,dx));
      $('days').style.transform=`translateX(${dragX}px)`;
    }
  },{passive:false});
  calendar.addEventListener('touchend',e=>{
    if(!touch)return;
    const dx=e.changedTouches[0].clientX-touch.x,dy=e.changedTouches[0].clientY-touch.y;
    const horizontal=touch.horizontal; touch=null;
    if(Math.abs(dx)>65 && Math.abs(dx)>Math.abs(dy)*1.5) {
      suppressDateClickUntil=Date.now()+600; moveMonth(dx<0?1:-1);
    } else { if(horizontal)suppressDateClickUntil=Date.now()+300; resetDrag(); }
  },{passive:true});
  calendar.addEventListener('touchcancel',()=>{touch=null;resetDrag();});
  function connection(){const el=$('connection');el.textContent=navigator.onLine?'':'현재 오프라인입니다. 일정은 계속 사용할 수 있습니다.';el.hidden=navigator.onLine;}
  connection();window.addEventListener('online',connection);window.addEventListener('offline',connection);
}
async function init() {
  bindUI(); bindExtras(); storageStatus(true);
  try { db=await openDatabase(); await render(); await initializeExtras(); }
  catch { $('addEvent').disabled=true; notify('기기 저장소를 열지 못했습니다. 일반 모드의 Chrome으로 다시 열어 주세요.'); }
  if('serviceWorker' in navigator && location.protocol!=='file:') {
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(applyingUpdate)location.reload();});
    try { registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}); }
    catch { $('updateStatus').textContent='오프라인 준비에 실패했습니다. 인터넷 연결 후 다시 열어 주세요.'; }
  }
  await checkUpdate();
}
const CATEGORIES = ['차량','집 설비','여행','서울 임대','병원','보험·세금 갱신','지출','인생 기록'];
const RELEASE_NOTES = [
  '기록장: 8개 분류, 금액·통화·메모·갱신일 입력과 수정·삭제를 지원합니다.',
  '연도별 지출을 USD와 KRW로 나누어 합산합니다.',
  '갱신·검진일을 달력에 자동 표시하고 30일 이내 D-day 배너를 추가했습니다.',
  '질문 탭에서 모든 일정·기록을 키워드로 검색합니다. AI와 사진 기능은 없습니다.',
  'JSON 백업·복원, CSV 일괄 가져오기와 샘플 내려받기를 추가했습니다.',
  'Google Drive 연결·백업·복원, Client ID 입력과 설정 안내를 추가했습니다. 미연결 시 JSON 파일을 사용하세요.',
  '기존 일정·기록을 보존하는 DB 버전 2를 적용하고 앱 버전을 v1.2.0으로 올렸습니다.'
];
let allRecords=[], recordEditingId=null, eventSaving=false, recordSaving=false, pendingImport=null, importing=false;
let driveToken=null, driveExpiry=0, driveClientId='', driveBusy=false, gisPromise=null;
const MAX_FILE_SIZE=10*1024*1024;
function getAll(store) { return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly');const req=tx.objectStore(store).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}); }
function putValue(store,value,remove=false) {return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');if(remove)tx.objectStore(store).delete(value);else tx.objectStore(store).put(value);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function node(tag,text,cls) {const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function addOption(select,value,label=value){const el=node('option',label);el.value=value;select.append(el);}
function validDate(value,partial=false,empty=false) {
  if(!value)return empty;
  if(typeof value!=='string'||!(partial?/^\d{4}(-\d{2})?(-\d{2})?$/:/^\d{4}-\d{2}-\d{2}$/).test(value))return false;
  const parts=value.split('-').map(Number),[y,m=1,d=1]=parts;
  if(y<1||y>9999||m<1||m>12||d<1||d>31)return false;
  const date=parseDate(`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  return date.getFullYear()===y&&date.getMonth()===m-1&&date.getDate()===d;
}
function validateCost(value) {
  if(value===null||value===undefined||value==='')return null;
  const raw=String(value).trim();
  if(!/^\d+(\.\d{1,2})?$/.test(raw)||Number(raw)>1e12)throw new Error('금액은 0 이상 숫자로 입력해 주세요. 소수점은 두 자리까지 가능합니다.');
  return Number(raw);
}
function dueEvent(record){return {id:'due:'+record.id,sourceRecordId:record.id,date:record.nextDueDate,time:'',title:'[갱신·검진] '+record.title,memo:record.category+(record.memo?' · '+record.memo:''),createdAt:record.createdAt||''};}
function upcomingItems(){const today=dateKey(new Date());const end=parseDate(today);end.setDate(end.getDate()+30);return allRecords.filter(r=>validDate(r.nextDueDate)&&r.nextDueDate>=today&&r.nextDueDate<=dateKey(end)).sort((a,b)=>a.nextDueDate.localeCompare(b.nextDueDate)||a.title.localeCompare(b.title));}
function dayLabel(date){const a=parseDate(dateKey(new Date())),b=parseDate(date);const days=Math.round((Date.UTC(b.getFullYear(),b.getMonth(),b.getDate())-Date.UTC(a.getFullYear(),a.getMonth(),a.getDate()))/86400000);return days===0?'D-day':`D-${days}`;}
function refreshUpcoming(){const items=upcomingItems();$('upcomingBanner').hidden=!items.length;if(items.length)$('upcomingBanner').textContent=`${dayLabel(items[0].nextDueDate)} · ${items[0].title}${items.length>1?' 외 '+(items.length-1)+'건':''} ›`;
  $('upcomingList').replaceChildren();for(const r of items){const b=node('button',`${dayLabel(r.nextDueDate)} · ${r.nextDueDate}\n${r.title}`,'result-card');b.onclick=()=>{$('upcomingDialog').close();openRecordEditor(r);};$('upcomingList').append(b);}if(!items.length)$('upcomingList').append(node('p','30일 이내 다가오는 일이 없습니다.'));
}
async function showTab(name){for(const n of ['calendar','records','search','settings']){const active=n===name;$(n+'View').hidden=!active;$(n+'Tab').classList.toggle('active',active);if(active)$(n+'Tab').setAttribute('aria-current','page');else $(n+'Tab').removeAttribute('aria-current');}
  try{if(name==='records'){allRecords=await getAll('records');renderRecords();}if(name==='search'&&$('searchInput').value.trim())await runSearch();if(name==='settings')await storageStatus();if(name==='calendar')await render();}catch{notify('자료를 읽지 못했습니다. 다시 열어 주세요.');}}
function money(amount,currency){return new Intl.NumberFormat('ko-KR',{style:'currency',currency,maximumFractionDigits:2}).format(amount);}
function renderRecords(){const previous=$('expenseYear').value,years=new Set([String(new Date().getFullYear())]);allRecords.forEach(r=>{if(r.date)years.add(r.date.slice(0,4));});$('expenseYear').replaceChildren();[...years].sort().reverse().forEach(y=>addOption($('expenseYear'),y));if(years.has(previous))$('expenseYear').value=previous;renderTotals();
  const category=$('categoryFilter').value;const records=allRecords.filter(r=>!category||r.category===category).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||a.title.localeCompare(b.title));$('recordList').replaceChildren();if(!records.length)$('recordList').append(node('p','아직 기록이 없습니다. ＋ 기록 추가를 눌러 주세요.','empty-state'));
  for(const r of records){const b=node('button',undefined,'result-card');b.setAttribute('aria-label',`${r.title}, 기록 수정`);b.append(node('span',`${r.date||'날짜 없음'} · ${r.category}`,'result-meta'),node('strong',r.title));if(r.cost!==null&&r.cost!==undefined)b.append(node('span',money(r.cost,r.currency||'USD')));if(r.nextDueDate)b.append(node('span',`다음 갱신·검진 ${r.nextDueDate}`));if(r.memo)b.append(node('span',r.memo,'record-excerpt'));b.onclick=()=>openRecordEditor(r);$('recordList').append(b);}}
function renderTotals(){const year=$('expenseYear').value;const cents={USD:0,KRW:0};allRecords.filter(r=>r.date?.startsWith(year)&&Number.isFinite(r.cost)).forEach(r=>{if(r.currency in cents)cents[r.currency]+=Math.round(r.cost*100);});$('expenseTotal').textContent=`${year}년 지출 합계\nUSD ${money(cents.USD/100,'USD')}\nKRW ${money(cents.KRW/100,'KRW')}`;}
function openRecordEditor(record){recordEditingId=record?.id||null;$('recordForm').reset();$('recordError').textContent='';$('recordFormTitle').textContent=record?'기록 수정':'기록 추가';$('recordDate').value=record?.date||'';$('recordTitle').value=record?.title||'';$('recordCategory').value=record?.category||CATEGORIES[0];$('recordCost').value=record?.cost??'';$('recordCurrency').value=record?.currency||'USD';$('recordMemo').value=record?.memo||'';$('recordDue').value=record?.nextDueDate||'';$('deleteRecord').hidden=!record;if(!$('recordDialog').open)$('recordDialog').showModal();}
async function refreshData(){await render();renderRecords();if(!$('searchView').hidden&&$('searchInput').value.trim())await runSearch();}
async function saveRecordForm(event){event.preventDefault();if(recordSaving)return;try{const date=$('recordDate').value.trim(),title=$('recordTitle').value.trim(),due=$('recordDue').value;
  if(!title)throw new Error('제목을 입력해 주세요.');if(!validDate(date,true,true))throw new Error('날짜를 2024, 2024-05 또는 2024-05-20 형식으로 입력해 주세요.');if(due&&!validDate(due))throw new Error('갱신·검진 날짜를 확인해 주세요.');const cost=validateCost($('recordCost').value);
  recordSaving=true;$('saveRecord').disabled=true;const old=allRecords.find(r=>r.id===recordEditingId);const record=createRecord({...old,id:recordEditingId||crypto.randomUUID(),date,title,category:$('recordCategory').value,cost,currency:$('recordCurrency').value,memo:$('recordMemo').value.trim(),nextDueDate:due||null,updatedAt:new Date().toISOString()});await putValue('records',record);$('recordDialog').close();await refreshData();
  }catch(error){$('recordError').textContent=error.message||'저장하지 못했습니다.';}finally{recordSaving=false;$('saveRecord').disabled=false;}}
async function runSearch(){const query=$('searchInput').value.trim().toLocaleLowerCase('ko-KR');$('searchResults').replaceChildren();if(!query){$('searchCount').textContent='찾을 말을 입력해 주세요.';return;}const terms=query.split(/\s+/);const [events,records]=await Promise.all([getAll('events'),getAll('records')]);
  const result=[...events.map(item=>({item,type:'일정'})),...records.map(item=>({item,type:'기록'}))].filter(({item})=>{const hay=[item.date,item.title,item.memo,item.category,item.subject,item.place,item.nextDueDate,item.cost,item.currency].filter(v=>v!==undefined&&v!==null).join(' ').toLocaleLowerCase('ko-KR');return terms.every(term=>hay.includes(term));}).sort((a,b)=>{if(!a.item.date)return b.item.date?1:0;if(!b.item.date)return -1;return a.item.date.localeCompare(b.item.date)||(a.item.time||'').localeCompare(b.item.time||'');});
  $('searchCount').textContent=result.length?`${result.length}개 결과 · 날짜순 (날짜 없는 기록은 맨 아래)`:'찾는 기록이 없습니다';
  for(const {item,type}of result){const b=node('button',undefined,'result-card');b.append(node('span',`${type} · ${item.date||'날짜 없음'}`,'result-meta'),node('strong',item.title));if(item.memo)b.append(node('span',item.memo,'record-excerpt'));b.onclick=()=>type==='기록'?openRecordEditor(item):openEditor(item);$('searchResults').append(b);}}
async function makeBackup(){return new Promise((resolve,reject)=>{const tx=db.transaction(['events','records'],'readonly'),events=tx.objectStore('events').getAll(),records=tx.objectStore('records').getAll();tx.oncomplete=()=>resolve({format:'SK-calendar-backup',formatVersion:1,appVersion:APP_VERSION,exportedAt:new Date().toISOString(),events:events.result,records:records.result});tx.onerror=()=>reject(tx.error);});}
function downloadFile(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function exportJson(){try{const data=await makeBackup();downloadFile(`SK-calendar-${dateKey(new Date())}-${Date.now()}.json`,JSON.stringify(data,null,2),'application/json');$('backupStatus').textContent=`JSON 백업 파일을 만들었습니다. 일정 ${data.events.length}개, 기록 ${data.records.length}개. 다운로드 폴더를 확인해 주세요.`;}catch{notify('백업 파일을 만들지 못했습니다.');}}
function requiredText(value,name,max=10000){if(typeof value!=='string'||value.length>max)throw new Error(`${name} 형식 또는 길이를 확인해 주세요.`);return value;}
function normalizeItem(raw,type){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('자료 형식이 올바르지 않습니다.');const now=new Date().toISOString();const id=requiredText(raw.id,'ID',200);if(!id.trim())throw new Error('ID가 없습니다.');const title=requiredText(raw.title,'제목',120).trim();if(!title)throw new Error('제목이 없습니다.');const date=requiredText(raw.date??'','날짜',10);if(!validDate(date,type==='record',type==='record'))throw new Error('올바르지 않은 날짜가 있습니다.');
  const memo=requiredText(raw.memo??'','메모');const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():now;const base={id,date,title,memo,createdAt:stamp(raw.createdAt),updatedAt:stamp(raw.updatedAt)};
  if(type==='event'){const time=raw.time??'';if(typeof time!=='string'||(time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)))throw new Error('시간을 확인해 주세요.');return {...base,time};}
  const category=raw.category||'인생 기록';if(!CATEGORIES.includes(category))throw new Error('분류를 확인해 주세요.');const currency=raw.currency||'USD';if(!['USD','KRW'].includes(currency))throw new Error('통화는 USD 또는 KRW만 가능합니다.');const nextDueDate=raw.nextDueDate||null;if(nextDueDate&&!validDate(nextDueDate))throw new Error('갱신·검진 날짜를 확인해 주세요.');
  const extra={};for(const field of ['endDate','subject','place','recurrence']){if(raw[field]!==null&&raw[field]!==undefined)extra[field]=requiredText(raw[field],field,10000);}
  return createRecord({...extra,...base,category,currency,cost:validateCost(raw.cost),nextDueDate});}
function validateBackup(data){if(!data||data.format!=='SK-calendar-backup'||data.formatVersion!==1||!Array.isArray(data.events)||!Array.isArray(data.records))throw new Error('SK-달력 JSON 백업 파일이 아닙니다.');if(data.events.length+data.records.length>20000)throw new Error('한 번에 최대 20,000개까지 가져올 수 있습니다.');return {events:data.events.map(r=>normalizeItem(r,'event')),records:data.records.map(r=>normalizeItem(r,'record'))};}
function stageImport(data,label){pendingImport=data;$('importPreview').textContent=`${label}: 일정 ${data.events.length}개, 기록 ${data.records.length}개를 확인했습니다. 가져올까요?`;if(!$('importDialog').open)$('importDialog').showModal();}
async function mergeImport(data){return new Promise((resolve,reject)=>{const tx=db.transaction(['events','records'],'readwrite');let added=0,updated=0,skipped=0;
  for(const storeName of ['events','records']){const store=tx.objectStore(storeName);const unique=new Map(data[storeName].map(item=>[item.id,item]));skipped+=data[storeName].length-unique.size;for(const value of unique.values()){const request=store.get(value.id);request.onsuccess=()=>{const old=request.result;if(!old){store.put(value);added++;}else if(Date.parse(value.updatedAt)>Date.parse(old.updatedAt||0)){store.put(value);updated++;}else skipped++;};}}
  tx.oncomplete=()=>resolve({added,updated,skipped});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
});}
async function confirmImport(){if(importing||!pendingImport)return;importing=true;$('confirmImport').disabled=true;try{const result=await mergeImport(pendingImport);pendingImport=null;$('importDialog').close();await refreshData();$('backupStatus').textContent=`가져오기 완료: 추가 ${result.added}개, 갱신 ${result.updated}개, 중복·이전 자료 건너뜀 ${result.skipped}개.`;notify($('backupStatus').textContent);}catch{notify('가져오지 못했습니다. 기존 자료는 보존됩니다.');}finally{importing=false;$('confirmImport').disabled=false;}}
async function readImportFile(input,type){const file=input.files[0];if(!file)return;try{if(file.size>MAX_FILE_SIZE)throw new Error('파일은 10MB 이하로 나누어 주세요.');const text=await file.text();const data=type==='json'?validateBackup(JSON.parse(text.replace(/^\uFEFF/,''))):await csvToData(text);stageImport(data,type.toUpperCase());}catch(error){notify('가져오기 중단: '+(error.message||'파일 형식을 확인해 주세요.'));}finally{input.value='';}}
const CSV_HEADER=['type','id','date','time','title','category','cost','currency','memo','nextDueDate'];
const CSV_SAMPLE='\uFEFF'+CSV_HEADER.join(',')+'\r\nrecord,sample-record-2024,2024-05-20,,가짜 차량 정비,차량,125.50,USD,"시험용 메모, 실제 자료로 바꾸세요",\r\nevent,sample-event-2024,2024-06-01,10:30,가짜 일정,,,,시험용 일정,\r\n';
function parseCsv(text){text=text.replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false,closed=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}else if(c==='"'){if(field||closed)throw new Error('CSV 따옴표 위치를 확인해 주세요.');quoted=true;}else if(c===','){row.push(field);field='';closed=false;}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';closed=false;}else{if(closed)throw new Error('CSV 따옴표 뒤의 문자를 확인해 주세요.');field+=c;}}if(quoted)throw new Error('닫히지 않은 CSV 따옴표가 있습니다.');row.push(field);if(row.some(v=>v.trim()))rows.push(row);return rows;}
async function csvToData(text){const rows=parseCsv(text);if(!rows.length)throw new Error('CSV가 비어 있습니다.');const headers=rows.shift().map(v=>v.trim());if(headers.length!==CSV_HEADER.length||CSV_HEADER.some(h=>!headers.includes(h)))throw new Error('샘플 CSV의 열 이름을 그대로 사용해 주세요.');if(rows.length>20000)throw new Error('한 번에 최대 20,000행까지 가능합니다.');const result={events:[],records:[]};for(let i=0;i<rows.length;i++){try{if(rows[i].length!==headers.length)throw new Error('열 개수가 다릅니다.');const r=Object.fromEntries(headers.map((h,j)=>[h,rows[i][j]]));const type=['record','기록'].includes(r.type.trim())?'record':['event','일정'].includes(r.type.trim())?'event':null;if(!type)throw new Error('type은 record 또는 event로 적어 주세요.');if(!r.id.trim()){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(r)));r.id='csv-'+[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}r.createdAt='2000-01-01T00:00:00.000Z';r.updatedAt='2000-01-01T00:00:00.000Z';result[type==='record'?'records':'events'].push(normalizeItem(r,type));}catch(error){throw new Error(`CSV ${i+2}행: ${error.message}`);}}return result;}
function loadGis(){if(window.google?.accounts?.oauth2)return Promise.resolve();if(gisPromise)return gisPromise;gisPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;const timer=setTimeout(()=>{script.remove();gisPromise=null;reject(new Error('Google 연결을 준비하지 못했습니다. JSON 백업을 사용해 주세요.'));},15000);script.onload=()=>{clearTimeout(timer);if(window.google?.accounts?.oauth2)resolve();else{gisPromise=null;reject(new Error('Google 로그인 기능을 열지 못했습니다.'));}};script.onerror=()=>{clearTimeout(timer);gisPromise=null;script.remove();reject(new Error('인터넷 연결 또는 Google 차단 설정을 확인해 주세요. JSON 백업도 가능합니다.'));};document.head.append(script);});return gisPromise;}
async function connectDrive(){const clientId=$('googleClientId').value.trim();if(!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))throw new Error('Google Cloud에서 발급한 Client ID를 먼저 입력하고 저장해 주세요. JSON 백업은 지금 사용 가능합니다.');if(clientId!==driveClientId){driveToken=null;driveExpiry=0;}driveClientId=clientId;
  if(!window.google?.accounts?.oauth2){await putValue('settings',{id:'googleClientId',value:clientId});await loadGis();$('driveStatus').textContent='Google 연결 준비가 되었습니다. Google 연결 버튼을 한 번 더 눌러 계정을 승인해 주세요.';return;}
  putValue('settings',{id:'googleClientId',value:clientId}).catch(()=>{});
  // Open the authorization popup synchronously within this second user gesture.
  return new Promise((resolve,reject)=>{const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/drive.appdata',callback:response=>{if(response.error){reject(new Error('Google 승인이 완료되지 않았습니다. JSON 백업을 사용하실 수 있습니다.'));return;}driveToken=response.access_token;driveExpiry=Date.now()+Number(response.expires_in||3600)*1000-60000;$('driveStatus').textContent='Google 연결됨. 토큰은 메모리에만 보관하며 앱을 닫으면 사라집니다.';resolve();},error_callback:()=>reject(new Error('로그인 창이 닫혔거나 차단되었습니다. Google 연결 버튼을 다시 누르세요.'))});client.requestAccessToken({prompt:'consent'});});}
async function driveRequest(url,options={}){if(!driveToken||Date.now()>=driveExpiry)throw new Error('먼저 Google 연결을 눌러 승인해 주세요. 연결하지 않아도 JSON 백업은 가능합니다.');const response=await fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+driveToken}});if(!response.ok){if(response.status===401){driveToken=null;driveExpiry=0;}throw new Error(`Drive 요청 실패 (${response.status}). 연결·API 설정을 확인하거나 JSON 백업을 사용해 주세요.`);}return response;}
async function driveBackup(){const data=await makeBackup();const boundary='sk_calendar_'+crypto.randomUUID();const metadata={name:`SK-calendar-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,parents:['appDataFolder'],mimeType:'application/json'};const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});$('driveStatus').textContent=`Drive 백업 완료: 일정 ${data.events.length}개, 기록 ${data.records.length}개. 앱 전용 공간에 새 백업으로 저장했습니다.`;}
async function listDriveBackups(){const params=new URLSearchParams({spaces:'appDataFolder',q:"trashed = false and name contains 'SK-calendar-'",fields:'files(id,name,modifiedTime,size)',orderBy:'modifiedTime desc',pageSize:'100'});const response=await driveRequest('https://www.googleapis.com/drive/v3/files?'+params);const data=await response.json();$('driveFiles').replaceChildren();for(const file of data.files||[])addOption($('driveFiles'),file.id,`${new Date(file.modifiedTime).toLocaleString('ko-KR')} · ${file.name}`);if(!$('driveFiles').options.length)throw new Error('Drive 앱 전용 공간에 백업이 없습니다. 먼저 백업하거나 JSON 파일을 가져오세요.');$('driveDialog').showModal();}
async function chooseDriveRestore(){const id=$('driveFiles').value;if(!id)return;const response=await driveRequest('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media');const text=await response.text();if(text.length>MAX_FILE_SIZE)throw new Error('Drive 백업이 너무 큽니다.');const data=validateBackup(JSON.parse(text));$('driveDialog').close();stageImport(data,'Drive 백업');}
async function driveAction(action){if(driveBusy)return;driveBusy=true;for(const id of ['connectGoogle','driveBackup','driveRestore','chooseDriveRestore'])$(id).disabled=true;try{await action();}catch(error){$('driveStatus').textContent=error.message||'Google 연결에 실패했습니다. JSON 백업을 사용해 주세요.';notify($('driveStatus').textContent);}finally{driveBusy=false;for(const id of ['connectGoogle','driveBackup','driveRestore','chooseDriveRestore'])$(id).disabled=false;}}
function bindExtras(){for(const category of CATEGORIES){addOption($('recordCategory'),category);addOption($('categoryFilter'),category);}for(const note of RELEASE_NOTES)$('releaseNotes').append(node('li',note));$('googleOrigin').textContent=`현재 원본 주소: ${location.origin} (경로 /my-life-calendar/ 등은 제외)`;
  $('addRecord').onclick=()=>openRecordEditor();$('closeRecord').onclick=()=>$('recordDialog').close();$('recordForm').onsubmit=saveRecordForm;$('categoryFilter').onchange=renderRecords;$('expenseYear').onchange=renderTotals;
  $('deleteRecord').onclick=()=>$('recordDeleteDialog').showModal();$('cancelRecordDelete').onclick=()=>$('recordDeleteDialog').close();$('confirmRecordDelete').onclick=async()=>{try{await putValue('records',recordEditingId,true);$('recordDeleteDialog').close();$('recordDialog').close();await refreshData();}catch{notify('기록을 삭제하지 못했습니다.');}};
  $('searchForm').onsubmit=async event=>{event.preventDefault();try{await runSearch();}catch{notify('검색하지 못했습니다.');}};
  $('upcomingBanner').onclick=()=>{refreshUpcoming();$('upcomingDialog').showModal();};$('closeUpcoming').onclick=()=>$('upcomingDialog').close();
  $('exportJson').onclick=exportJson;$('importJson').onchange=()=>readImportFile($('importJson'),'json');$('importCsv').onchange=()=>readImportFile($('importCsv'),'csv');$('downloadCsv').onclick=()=>downloadFile('SK-calendar-sample.csv',CSV_SAMPLE,'text/csv;charset=utf-8');$('confirmImport').onclick=confirmImport;$('cancelImport').onclick=()=>{pendingImport=null;$('importDialog').close();};$('importDialog').addEventListener('cancel',()=>{pendingImport=null;});
  $('saveGoogleClient').onclick=async()=>{try{const value=$('googleClientId').value.trim();if(value&&!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value))throw new Error('Client ID 형식을 확인해 주세요.');await putValue('settings',{id:'googleClientId',value});if(value!==driveClientId){driveToken=null;driveExpiry=0;}driveClientId=value;$('driveStatus').textContent='Client ID를 이 기기에 저장했습니다. Google 연결을 눌러 주세요.';}catch(error){notify(error.message);}};
  $('connectGoogle').onclick=()=>driveAction(connectDrive);$('driveBackup').onclick=()=>driveAction(driveBackup);$('driveRestore').onclick=()=>driveAction(listDriveBackups);$('chooseDriveRestore').onclick=()=>driveAction(chooseDriveRestore);$('cancelDriveRestore').onclick=()=>$('driveDialog').close();$('disconnectGoogle').onclick=()=>{if(driveBusy)return;const token=driveToken;driveToken=null;driveExpiry=0;if(token&&window.google?.accounts?.oauth2)google.accounts.oauth2.revoke(token,()=>{});$('driveStatus').textContent='연결을 해제했습니다. Drive 백업 파일은 지워지지 않습니다.';};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&db&&!monthAnimating)refreshData().catch(()=>{});});window.addEventListener('pageshow',()=>{if(db)render().catch(()=>{});});
}
async function initializeExtras(){renderRecords();const settings=await getAll('settings');driveClientId=settings.find(s=>s.id==='googleClientId')?.value||'';$('googleClientId').value=driveClientId;}

init();
