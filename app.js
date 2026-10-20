'use strict';
const APP_VERSION = '1.3.0';
const APP_NAME = 'SK-달력';
const DB_VERSION = 3;
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
      if (!database.objectStoreNames.contains('googleEvents')) {const g=database.createObjectStore('googleEvents',{keyPath:'id'});g.createIndex('accountId','accountId');}
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
  try { const [results, records, googleRows] = await Promise.all([readEvents(IDBKeyRange.bound(dateKey(start),dateKey(end))),getAll('records'),getAll('googleEvents')]); if (requestMonth !== shown.getTime()) return; allRecords=records; monthEvents = [...results,...googleRows.flatMap(r=>expandGoogleEvent(r,dateKey(start),dateKey(end))),...records.filter(r=>r.nextDueDate && r.nextDueDate>=dateKey(start) && r.nextDueDate<=dateKey(end)).map(dueEvent)]; refreshUpcoming(); refreshGoogleBar(googleRows); }
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
    b.setAttribute('aria-label',`${event.time||'시간 없음'} ${event.title}, ${event.sourceGoogleId?'Google 보기':'수정'}`);
    const time=document.createElement('span'); time.className='event-time'; time.textContent=event.time||'종일';
    const copy=document.createElement('span'); copy.className='event-copy'; const title=document.createElement('span'); title.className='event-name'; title.textContent=event.title; copy.append(title);
    if(event.memo) { const memo=document.createElement('span'); memo.className='event-memo'; memo.textContent=event.memo; copy.append(memo); }
    const hint=document.createElement('span'); hint.className='edit-hint'; hint.textContent='›'; b.append(time,copy,hint); b.onclick=()=>event.sourceGoogleId?showGoogleEvent(event):event.sourceRecordId?openRecordEditor(allRecords.find(r=>r.id===event.sourceRecordId)):openEditor(event); $('eventList').append(b);
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
    if($('eventDialog').open || $('recordDialog').open || $('passwordDialog').open) throw new Error('입력 중인 일정을 저장하거나 닫은 뒤 업데이트해 주세요.');
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
  bindUI(); bindExtras(); bindSecureGoogle(); storageStatus(true);
  try { db=await openDatabase(); await render(); await initializeExtras(); await initializeCalendars(); }
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
  "Google 캘린더를 읽기 전용으로 연결하고 여러 캘린더와 여러 계정을 선택해 가져옵니다. 원본 쓰기·삭제 API는 사용하지 않습니다.",
  "Google 일정 보관본을 앱에서 조회·검색하고 내 일정으로 복사할 수 있습니다. 새로 가져오면 변경·취소된 일정도 앱에 반영합니다.",
  "캘린더와 Drive 권한을 별도로 요청하며 Gmail·연락처 권한은 요청하지 않습니다. 이메일만으로 접근하지 않습니다.",
  "Drive 및 기기 백업을 AES-256-GCM으로 암호화합니다. 백업 비밀번호는 저장하지 않으며 복원 시 필요합니다.",
  "복원 화면을 쉽게 정리하고 이전 버전 백업도 지원합니다. Google 일정 보관본도 암호화 백업에 포함합니다.",
  "전화기 바의 테마를 짙은 파랑(#102a43)으로 요청합니다. 실제 적용은 Android·Chrome에 따라 다릅니다.",
  "기존 일정·기록을 보존하고 DB 버전을 3, 앱 버전을 v1.3.0으로 올렸습니다."
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
async function runSearch(){const query=$('searchInput').value.trim().toLocaleLowerCase('ko-KR');$('searchResults').replaceChildren();if(!query){$('searchCount').textContent='찾을 말을 입력해 주세요.';return;}const terms=query.split(/\s+/);const [localEvents,records,googleRows]=await Promise.all([getAll('events'),getAll('records'),getAll('googleEvents')]);const events=[...localEvents,...googleRows.map(googleSearchEvent)];
  const result=[...events.map(item=>({item,type:'일정'})),...records.map(item=>({item,type:'기록'}))].filter(({item})=>{const hay=[item.date,item.title,item.memo,item.category,item.subject,item.place,item.nextDueDate,item.cost,item.currency].filter(v=>v!==undefined&&v!==null).join(' ').toLocaleLowerCase('ko-KR');return terms.every(term=>hay.includes(term));}).sort((a,b)=>{if(!a.item.date)return b.item.date?1:0;if(!b.item.date)return -1;return a.item.date.localeCompare(b.item.date)||(a.item.time||'').localeCompare(b.item.time||'');});
  $('searchCount').textContent=result.length?`${result.length}개 결과 · 날짜순 (날짜 없는 기록은 맨 아래)`:'찾는 기록이 없습니다';
  for(const {item,type}of result){const b=node('button',undefined,'result-card');b.append(node('span',`${type} · ${item.date||'날짜 없음'}`,'result-meta'),node('strong',item.title));if(item.memo)b.append(node('span',item.memo,'record-excerpt'));b.onclick=()=>type==='기록'?openRecordEditor(item):item.sourceGoogleId?showGoogleEvent(item):openEditor(item);$('searchResults').append(b);}}
function downloadFile(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
function requiredText(value,name,max=10000){if(typeof value!=='string'||value.length>max)throw new Error(`${name} 형식 또는 길이를 확인해 주세요.`);return value;}
function normalizeItem(raw,type){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('자료 형식이 올바르지 않습니다.');const now=new Date().toISOString();const id=requiredText(raw.id,'ID',200);if(!id.trim())throw new Error('ID가 없습니다.');const title=requiredText(raw.title,'제목',120).trim();if(!title)throw new Error('제목이 없습니다.');const date=requiredText(raw.date??'','날짜',10);if(!validDate(date,type==='record',type==='record'))throw new Error('올바르지 않은 날짜가 있습니다.');
  const memo=requiredText(raw.memo??'','메모');const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():now;const base={id,date,title,memo,createdAt:stamp(raw.createdAt),updatedAt:stamp(raw.updatedAt)};
  if(type==='event'){const time=raw.time??'';if(typeof time!=='string'||(time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)))throw new Error('시간을 확인해 주세요.');return {...base,time};}
  const category=raw.category||'인생 기록';if(!CATEGORIES.includes(category))throw new Error('분류를 확인해 주세요.');const currency=raw.currency||'USD';if(!['USD','KRW'].includes(currency))throw new Error('통화는 USD 또는 KRW만 가능합니다.');const nextDueDate=raw.nextDueDate||null;if(nextDueDate&&!validDate(nextDueDate))throw new Error('갱신·검진 날짜를 확인해 주세요.');
  const extra={};for(const field of ['endDate','subject','place','recurrence']){if(raw[field]!==null&&raw[field]!==undefined)extra[field]=requiredText(raw[field],field,10000);}
  return createRecord({...extra,...base,category,currency,cost:validateCost(raw.cost),nextDueDate});}
function stageImport(data,label){pendingImport=data;$('importPreview').textContent=`${label}: 일정 ${data.events.length}개, 기록 ${data.records.length}개${data.googleEvents?.length?`, Google 보관본 ${data.googleEvents.length}개`:""}를 확인했습니다. 가져올까요?`;if(!$('importDialog').open)$('importDialog').showModal();}
async function confirmImport(){if(importing||!pendingImport)return;importing=true;$('confirmImport').disabled=true;try{const result=await mergeImport(pendingImport);pendingImport=null;$('importDialog').close();await refreshData();$('backupStatus').textContent=`가져오기 완료: 추가 ${result.added}개, 갱신 ${result.updated}개, 중복·이전 자료 건너뜀 ${result.skipped}개.`;notify($('backupStatus').textContent);}catch{notify('가져오지 못했습니다. 기존 자료는 보존됩니다.');}finally{importing=false;$('confirmImport').disabled=false;}}
const CSV_HEADER=['type','id','date','time','title','category','cost','currency','memo','nextDueDate'];
const CSV_SAMPLE='\uFEFF'+CSV_HEADER.join(',')+'\r\nrecord,sample-record-2024,2024-05-20,,가짜 차량 정비,차량,125.50,USD,"시험용 메모, 실제 자료로 바꾸세요",\r\nevent,sample-event-2024,2024-06-01,10:30,가짜 일정,,,,시험용 일정,\r\n';
function parseCsv(text){text=text.replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false,closed=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}else if(c==='"'){if(field||closed)throw new Error('CSV 따옴표 위치를 확인해 주세요.');quoted=true;}else if(c===','){row.push(field);field='';closed=false;}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';closed=false;}else{if(closed)throw new Error('CSV 따옴표 뒤의 문자를 확인해 주세요.');field+=c;}}if(quoted)throw new Error('닫히지 않은 CSV 따옴표가 있습니다.');row.push(field);if(row.some(v=>v.trim()))rows.push(row);return rows;}
async function csvToData(text){const rows=parseCsv(text);if(!rows.length)throw new Error('CSV가 비어 있습니다.');const headers=rows.shift().map(v=>v.trim());if(headers.length!==CSV_HEADER.length||CSV_HEADER.some(h=>!headers.includes(h)))throw new Error('샘플 CSV의 열 이름을 그대로 사용해 주세요.');if(rows.length>20000)throw new Error('한 번에 최대 20,000행까지 가능합니다.');const result={events:[],records:[]};for(let i=0;i<rows.length;i++){try{if(rows[i].length!==headers.length)throw new Error('열 개수가 다릅니다.');const r=Object.fromEntries(headers.map((h,j)=>[h,rows[i][j]]));const type=['record','기록'].includes(r.type.trim())?'record':['event','일정'].includes(r.type.trim())?'event':null;if(!type)throw new Error('type은 record 또는 event로 적어 주세요.');if(!r.id.trim()){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(r)));r.id='csv-'+[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}r.createdAt='2000-01-01T00:00:00.000Z';r.updatedAt='2000-01-01T00:00:00.000Z';result[type==='record'?'records':'events'].push(normalizeItem(r,type));}catch(error){throw new Error(`CSV ${i+2}행: ${error.message}`);}}return result;}
function loadGis(){if(window.google?.accounts?.oauth2)return Promise.resolve();if(gisPromise)return gisPromise;gisPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;const timer=setTimeout(()=>{script.remove();gisPromise=null;reject(new Error('Google 연결을 준비하지 못했습니다. 기기 파일 백업을 사용해 주세요.'));},15000);script.onload=()=>{clearTimeout(timer);if(window.google?.accounts?.oauth2)resolve();else{gisPromise=null;reject(new Error('Google 로그인 기능을 열지 못했습니다.'));}};script.onerror=()=>{clearTimeout(timer);gisPromise=null;script.remove();reject(new Error('인터넷 연결 또는 Google 차단 설정을 확인해 주세요. 기기 파일 백업도 가능합니다.'));};document.head.append(script);});return gisPromise;}
async function connectDrive(){const clientId=$('googleClientId').value.trim();if(!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))throw new Error('Google Cloud에서 발급한 Client ID를 먼저 입력하고 저장해 주세요. 기기 파일 백업은 지금 사용 가능합니다.');if(clientId!==driveClientId){driveToken=null;driveExpiry=0;calendarTokens.clear();}driveClientId=clientId;
  if(!window.google?.accounts?.oauth2){await putValue('settings',{id:'googleClientId',value:clientId});await loadGis();$('driveStatus').textContent='Google 연결 준비가 되었습니다. Google 연결 버튼을 한 번 더 눌러 계정을 승인해 주세요.';return;}
  putValue('settings',{id:'googleClientId',value:clientId}).catch(()=>{});
  // Open the authorization popup synchronously within this second user gesture.
  return new Promise((resolve,reject)=>{const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/drive.appdata',include_granted_scopes:false,callback:response=>{if(response.error||!response.access_token||response.scope!=='https://www.googleapis.com/auth/drive.appdata'){reject(new Error('Drive 앱 전용 공간 권한만 승인해 주세요. 캘린더·메일 권한과는 별개입니다.'));return;}driveToken=response.access_token;driveExpiry=Date.now()+Number(response.expires_in||3600)*1000-60000;$('driveStatus').textContent='Google 연결됨. 토큰은 메모리에만 보관하며 앱을 닫으면 사라집니다.';resolve();},error_callback:()=>reject(new Error('로그인 창이 닫혔거나 차단되었습니다. Google 연결 버튼을 다시 누르세요.'))});client.requestAccessToken({prompt:'consent'});});}
async function driveRequest(url,options={}){if(!driveToken||Date.now()>=driveExpiry)throw new Error('먼저 Google 연결을 눌러 승인해 주세요. 연결하지 않아도 기기 파일 백업은 가능합니다.');const response=await fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+driveToken}});if(!response.ok){if(response.status===401){driveToken=null;driveExpiry=0;}throw new Error(`Drive 요청 실패 (${response.status}). 연결·API 설정을 확인하거나 기기 파일 백업을 사용해 주세요.`);}return response;}
async function driveBackup(){assertDriveConnected();const raw=await makeBackup();const data=await passwordOperation('encrypt',p=>encryptBackup(raw,p));if(!data)return;const boundary='sk_calendar_'+crypto.randomUUID();const metadata={name:`SK-calendar-${new Date().toISOString().replace(/[:.]/g,'-')}.skbackup`,parents:['appDataFolder'],mimeType:'application/json'};const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});$('driveStatus').textContent=`Drive 백업 완료: 암호화한 일정 ${raw.events.length}개, 기록 ${raw.records.length}개. 비밀번호는 Drive로 보내지 않았습니다.`;}
async function listDriveBackups(){const params=new URLSearchParams({spaces:'appDataFolder',q:"trashed = false and name contains 'SK-calendar-'",fields:'files(id,name,modifiedTime,size)',orderBy:'modifiedTime desc',pageSize:'100'});const response=await driveRequest('https://www.googleapis.com/drive/v3/files?'+params);const data=await response.json();$('driveFiles').replaceChildren();for(const file of data.files||[])addOption($('driveFiles'),file.id,`${new Date(file.modifiedTime).toLocaleString('ko-KR')} · ${file.name.endsWith('.skbackup')?'암호화 백업':'이전 형식 백업'}`);if(!$('driveFiles').options.length)throw new Error('Drive 앱 전용 공간에 백업이 없습니다. 먼저 백업하거나 백업 파일을 가져오세요.');$('driveDialog').showModal();}
async function chooseDriveRestore(){const id=$('driveFiles').value;if(!id)return;const response=await driveRequest('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media');const text=await response.text();if(text.length>MAX_FILE_SIZE*1.5+4096)throw new Error('Drive 백업이 너무 큽니다.');const data=await decodeBackupText(text);if(!data)return;$('driveDialog').close();stageImport(data,'Drive 안전한 백업');}
async function driveAction(action){if(driveBusy)return;driveBusy=true;for(const id of ['connectGoogle','driveBackup','driveRestore','chooseDriveRestore'])$(id).disabled=true;try{await action();}catch(error){$('driveStatus').textContent=error.message||'Google 연결에 실패했습니다. 기기 파일 백업을 사용해 주세요.';notify($('driveStatus').textContent);}finally{driveBusy=false;for(const id of ['connectGoogle','driveBackup','driveRestore','chooseDriveRestore'])$(id).disabled=false;}}
function bindExtras(){for(const category of CATEGORIES){addOption($('recordCategory'),category);addOption($('categoryFilter'),category);}for(const note of RELEASE_NOTES)$('releaseNotes').append(node('li',note));$('googleOrigin').textContent=`현재 원본 주소: ${location.origin} (경로 /my-life-calendar/ 등은 제외)`;
  $('addRecord').onclick=()=>openRecordEditor();$('closeRecord').onclick=()=>$('recordDialog').close();$('recordForm').onsubmit=saveRecordForm;$('categoryFilter').onchange=renderRecords;$('expenseYear').onchange=renderTotals;
  $('deleteRecord').onclick=()=>$('recordDeleteDialog').showModal();$('cancelRecordDelete').onclick=()=>$('recordDeleteDialog').close();$('confirmRecordDelete').onclick=async()=>{try{await putValue('records',recordEditingId,true);$('recordDeleteDialog').close();$('recordDialog').close();await refreshData();}catch{notify('기록을 삭제하지 못했습니다.');}};
  $('searchForm').onsubmit=async event=>{event.preventDefault();try{await runSearch();}catch{notify('검색하지 못했습니다.');}};
  $('upcomingBanner').onclick=()=>{refreshUpcoming();$('upcomingDialog').showModal();};$('closeUpcoming').onclick=()=>$('upcomingDialog').close();
  $('exportJson').onclick=exportJson;$('importJson').onchange=()=>readImportFile($('importJson'),'json');$('importCsv').onchange=()=>readImportFile($('importCsv'),'csv');$('downloadCsv').onclick=()=>downloadFile('SK-calendar-sample.csv',CSV_SAMPLE,'text/csv;charset=utf-8');$('confirmImport').onclick=confirmImport;$('cancelImport').onclick=()=>{pendingImport=null;$('importDialog').close();};$('importDialog').addEventListener('cancel',()=>{pendingImport=null;});
  $('saveGoogleClient').onclick=async()=>{try{const value=$('googleClientId').value.trim();if(value&&!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value))throw new Error('Client ID 형식을 확인해 주세요.');await putValue('settings',{id:'googleClientId',value});if(value!==driveClientId){driveToken=null;driveExpiry=0;calendarTokens.clear();}driveClientId=value;$('driveStatus').textContent='Client ID를 이 기기에 저장했습니다. Google 연결을 눌러 주세요.';}catch(error){notify(error.message);}};
  $('connectGoogle').onclick=()=>driveAction(connectDrive);$('driveBackup').onclick=()=>driveAction(driveBackup);$('driveRestore').onclick=()=>driveAction(listDriveBackups);$('chooseDriveRestore').onclick=()=>driveAction(chooseDriveRestore);$('cancelDriveRestore').onclick=()=>$('driveDialog').close();$('disconnectGoogle').onclick=()=>{if(driveBusy)return;driveToken=null;driveExpiry=0;$('driveStatus').textContent='이 앱의 Drive 연결을 끊었습니다. 백업 파일과 캘린더 연결은 그대로입니다. Google 계정의 권한 자체를 해제하려면 Google 계정 보안 설정을 사용해 주세요.';};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&db&&!monthAnimating)refreshData().catch(()=>{});});window.addEventListener('pageshow',()=>{if(db)render().catch(()=>{});});
}
async function initializeExtras(){renderRecords();const settings=await getAll('settings');driveClientId=settings.find(s=>s.id==='googleClientId')?.value||'';$('googleClientId').value=driveClientId;}

// Calendar read-only tokens are separate from the Drive app-data token.
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.events.readonly'];
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/';
const calendarTokens = new Map();
let calendarAccounts=[], calendarBusy=false, passwordTask=null, viewedGoogleEvent=null;
const BACKUP_ITERATIONS=310000, BACKUP_AAD=new TextEncoder().encode('SK-calendar-encrypted:1');
function assertDriveConnected(){if(!driveToken||Date.now()>=driveExpiry)throw new Error('먼저 ‘백업용 Google Drive 연결’을 눌러 주세요. 기기에 안전한 파일로 저장하는 방법도 있습니다.');}
function toBase64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
function fromBase64(text,max){if(typeof text!=='string'||text.length>Math.ceil(max*4/3)+8||!text.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw new Error('백업 파일 형식을 확인해 주세요.');let raw;try{raw=atob(text);}catch{throw new Error('백업 파일이 손상되었습니다.');}if(raw.length>max)throw new Error('백업 파일이 너무 큽니다.');return Uint8Array.from(raw,c=>c.charCodeAt(0));}
async function backupKey(password,salt,usage){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:BACKUP_ITERATIONS},material,{name:'AES-GCM',length:256},false,[usage]);}
async function encryptBackup(data,password){if(typeof password!=='string'||password.trim().length<10||password.length>128)throw new Error('백업 비밀번호는 10자 이상으로 정해 주세요.');const plain=new TextEncoder().encode(JSON.stringify(data));if(plain.length>MAX_FILE_SIZE)throw new Error('백업 원본이 10MB를 넘습니다. 자료를 줄이거나 나누어 주세요.');const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));const key=await backupKey(password,salt,'encrypt');const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:BACKUP_AAD,tagLength:128},key,plain);return {format:'SK-calendar-encrypted',version:1,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:BACKUP_ITERATIONS,salt:toBase64(salt),iv:toBase64(iv),payload:toBase64(new Uint8Array(cipher))};}
function checkEncrypted(data){if(!data||data.format!=='SK-calendar-encrypted'||data.version!==1||data.cipher!=='AES-256-GCM'||data.kdf!=='PBKDF2-SHA256'||data.iterations!==BACKUP_ITERATIONS)throw new Error('지원하지 않는 암호화 백업입니다.');const salt=fromBase64(data.salt,16),iv=fromBase64(data.iv,12),payload=fromBase64(data.payload,MAX_FILE_SIZE+16);if(salt.length!==16||iv.length!==12||payload.length<16)throw new Error('암호화 백업이 손상되었습니다.');return {salt,iv,payload};}
async function decryptBackup(data,password){const parts=checkEncrypted(data);let plain;try{const key=await backupKey(password,parts.salt,'decrypt');plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:parts.iv,additionalData:BACKUP_AAD,tagLength:128},key,parts.payload);}catch{throw new Error('비밀번호가 다르거나 백업 파일이 손상되었습니다. 다시 입력해 주세요.');}try{return validateBackup(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)));}catch{throw new Error('백업 안의 자료 형식을 확인하지 못했습니다.');}}
function passwordOperation(mode,operation){if(passwordTask)throw new Error('현재 비밀번호 작업을 마친 뒤 다시 눌러 주세요.');$('passwordForm').reset();$('passwordError').textContent='';$('passwordTitle').textContent=mode==='encrypt'?'백업 비밀번호 정하기':'백업 비밀번호 입력';$('passwordHelp').textContent=mode==='encrypt'?'10자 이상으로 정해 주세요. 이 비밀번호로 내용을 잠근 뒤 저장합니다. 기억하기 쉬운 긴 문장을 권장합니다.':'백업할 때 정한 비밀번호를 입력해 주세요. 틀리면 다시 입력할 수 있습니다.';$('passwordConfirmLabel').hidden=mode!=='encrypt';$('backupPasswordConfirm').required=mode==='encrypt';$('submitPassword').disabled=false;return new Promise(resolve=>{passwordTask={mode,operation,resolve,busy:false};$('passwordDialog').showModal();});}
function cancelPassword(){if(!passwordTask||passwordTask.busy)return;const task=passwordTask;passwordTask=null;$('passwordForm').reset();$('passwordDialog').close();task.resolve(null);}
async function submitPassword(event){event.preventDefault();const task=passwordTask;if(!task||task.busy)return;let password=$('backupPassword').value;if(task.mode==='encrypt'&&(password.trim().length<10||password!==$('backupPasswordConfirm').value)){$('passwordError').textContent=password.trim().length<10?'비밀번호를 10자 이상으로 정해 주세요.':'두 번 입력한 비밀번호가 다릅니다.';return;}task.busy=true;$('submitPassword').disabled=true;$('cancelPassword').disabled=true;try{const result=await task.operation(password);passwordTask=null;$('passwordForm').reset();$('passwordDialog').close();task.resolve(result);}catch(error){$('passwordError').textContent=error.message||'백업 작업을 마치지 못했습니다.';$('backupPassword').value='';$('backupPasswordConfirm').value='';$('backupPassword').focus();}finally{password='';task.busy=false;$('submitPassword').disabled=false;$('cancelPassword').disabled=false;}}
async function makeBackup(){return new Promise((resolve,reject)=>{const tx=db.transaction(['events','records','googleEvents'],'readonly'),events=tx.objectStore('events').getAll(),records=tx.objectStore('records').getAll(),googleEvents=tx.objectStore('googleEvents').getAll();tx.oncomplete=()=>resolve({format:'SK-calendar-backup',formatVersion:2,appVersion:APP_VERSION,exportedAt:new Date().toISOString(),events:events.result,records:records.result,googleEvents:googleEvents.result});tx.onerror=()=>reject(tx.error);});}
async function exportJson(){try{const raw=await makeBackup();const encrypted=await passwordOperation('encrypt',p=>encryptBackup(raw,p));if(!encrypted)return;downloadFile(`SK-calendar-${dateKey(new Date())}-${Date.now()}.skbackup`,JSON.stringify(encrypted),'application/json');$('backupStatus').textContent='암호화 백업을 다운로드 폴더에 저장했습니다. 비밀번호는 파일이나 앱에 저장하지 않았습니다.';}catch(error){notify(error.message||'백업을 만들지 못했습니다.');}}
function normalizeGoogleRow(raw){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Google 일정 보관본 형식이 잘못되었습니다.');const row={};for(const [name,max]of [['id',3000],['accountId',400],['calendarId',1000],['googleEventId',1000],['calendarName',500],['title',120],['memo',10000],['date',10],['endDate',10],['time',5],['lastFetched',40]])row[name]=requiredText(raw[name]??'',name,max);if(!row.id||!row.accountId||!row.calendarId||!row.googleEventId||!validDate(row.date)||!validDate(row.endDate)||row.endDate<row.date||(row.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)))throw new Error('Google 일정의 날짜 또는 ID가 올바르지 않습니다.');row.createdAt=typeof raw.createdAt==='string'?raw.createdAt:row.lastFetched;row.updatedAt=typeof raw.updatedAt==='string'?raw.updatedAt:row.lastFetched;return row;}
function validateBackup(data){if(!data||data.format!=='SK-calendar-backup'||![1,2].includes(data.formatVersion)||!Array.isArray(data.events)||!Array.isArray(data.records)||(data.googleEvents!==undefined&&!Array.isArray(data.googleEvents)))throw new Error('SK-달력 백업 파일이 아닙니다.');if(data.events.length+data.records.length+(data.googleEvents?.length||0)>20000)throw new Error('최대 20,000개까지 가져올 수 있습니다.');return {events:data.events.map(r=>normalizeItem(r,'event')),records:data.records.map(r=>normalizeItem(r,'record')),googleEvents:(data.googleEvents||[]).map(normalizeGoogleRow)};}
async function decodeBackupText(text){if(new TextEncoder().encode(text).length>MAX_FILE_SIZE*1.5+4096)throw new Error('백업 파일이 너무 큽니다.');const parsed=JSON.parse(text.replace(/^\uFEFF/,''));if(parsed?.format==='SK-calendar-encrypted'){checkEncrypted(parsed);return passwordOperation('decrypt',p=>decryptBackup(parsed,p));}const result=validateBackup(parsed);$('backupStatus').textContent='이전 버전의 암호화 안 된 백업입니다. 복원 후 새 안전한 백업으로 다시 저장해 주세요.';return result;}
async function mergeImport(data){return new Promise((resolve,reject)=>{const tx=db.transaction(['events','records','googleEvents'],'readwrite');let added=0,updated=0,skipped=0;for(const storeName of ['events','records','googleEvents']){const store=tx.objectStore(storeName);const rows=data[storeName]||[],unique=new Map();for(const row of rows){const previous=unique.get(row.id);if(!previous||Date.parse(row.updatedAt)>Date.parse(previous.updatedAt))unique.set(row.id,row);}skipped+=rows.length-unique.size;for(const value of unique.values()){const request=store.get(value.id);request.onsuccess=()=>{const old=request.result;if(!old){store.put(value);added++;}else if(Date.parse(value.updatedAt)>(Number.isFinite(Date.parse(old.updatedAt))?Date.parse(old.updatedAt):0)){store.put(value);updated++;}else skipped++;};}}tx.oncomplete=()=>resolve({added,updated,skipped});tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
async function readImportFile(input,type){const file=input.files[0];if(!file)return;try{if(file.size>(type==='json'?MAX_FILE_SIZE*1.5+4096:MAX_FILE_SIZE))throw new Error('파일이 너무 큽니다.');const text=await file.text();const data=type==='json'?await decodeBackupText(text):await csvToData(text);if(data)stageImport(data,type==='json'?'백업 복원':'표 파일');}catch(error){notify('가져오기 중단: '+(error.message||'파일 형식을 확인해 주세요.'));}finally{input.value='';}}
function googleSearchEvent(row){return {id:row.id,sourceGoogleId:row.id,date:row.date,endDate:row.endDate,time:row.time,title:'[Google] '+row.title,memo:row.calendarName+(row.memo?' · '+row.memo:''),createdAt:row.createdAt||'',original:row};}
function expandGoogleEvent(row,from,to){if(row.endDate<from||row.date>to)return [];const result=[],date=parseDate(row.date<from?from:row.date),last=row.endDate>to?to:row.endDate;while(dateKey(date)<=last){const key=dateKey(date);result.push({...googleSearchEvent(row),date:key,time:key===row.date?row.time:'',original:row});date.setDate(date.getDate()+1);}return result;}
function refreshGoogleBar(rows){const bar=$('googleCalendarBar');bar.hidden=!rows.length;if(!rows.length)return;const last=rows.reduce((a,r)=>r.lastFetched>a?r.lastFetched:a,'');bar.textContent=`Google 일정 보관본 · ${last?new Date(last).toLocaleDateString('ko-KR'):''} · 새로 가져오기 ›`;}
function showGoogleEvent(event){viewedGoogleEvent=event;$('googleEventTitle').textContent=event.title;$('googleEventSource').textContent=`캘린더: ${event.original?.calendarName||''} · 보기 전용`;$('googleEventWhen').textContent=`${event.original?.date||event.date}${event.original?.endDate!==event.original?.date?' ~ '+event.original?.endDate:''} ${event.time||'종일'}`;$('googleEventMemo').textContent=event.original?.memo||'';if(!$('googleEventDialog').open)$('googleEventDialog').showModal();}
async function copyGoogleEvent(){const event=viewedGoogleEvent;if(!event)return;const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(event.id+'|'+event.date));const id='google-local-copy-'+toBase64(new Uint8Array(digest));const events=await getAll('events');if(events.some(e=>e.id===id)){notify('이미 내 일정으로 복사했습니다. 아래 목록에서 복사본을 수정해 주세요.');return;}const now=new Date().toISOString();await saveEvent({id,date:event.date,time:event.time||'',title:(event.original?.title||event.title).slice(0,120),memo:('Google에서 복사한 내 일정입니다. 원본과 별도로 수정됩니다.\n'+(event.original?.memo||'')).slice(0,10000),createdAt:now,updatedAt:now});$('googleEventDialog').close();await refreshData();notify('내 일정으로 복사했습니다. Google 원본에는 영향을 주지 않습니다.');}
async function calendarRequest(token,path,params={}){if(typeof path!=='string'||path.startsWith('/')||path.includes('..')||!['users/me/calendarList'].includes(path)&&!/^calendars\/[^/]+\/events$/.test(path))throw new Error('허용되지 않은 캘린더 요청입니다.');const url=CALENDAR_API+path+'?'+new URLSearchParams(params);const response=await fetch(url,{method:'GET',headers:{Authorization:'Bearer '+token}});if(!response.ok)throw new Error(`Google 캘린더 읽기에 실패했습니다 (${response.status}). API·권한·연결 상태를 확인해 주세요. 기존 보관본은 유지합니다.`);return response.json();}
async function allCalendarPages(token,path,params={}){const result=[];let next='',pages=0;do{const data=await calendarRequest(token,path,{...params,...(next?{pageToken:next}:{})});if(!Array.isArray(data.items))throw new Error('Google 캘린더 응답을 확인하지 못했습니다.');result.push(...data.items);next=data.nextPageToken||'';pages++;if(result.length>10000||pages>50)throw new Error('가져올 자료가 너무 많습니다. 캘린더 선택을 줄여 주세요. 기존 보관본은 유지합니다.');}while(next);return result;}
function checkCalendarClient(){const id=$('googleClientId').value.trim();if(!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id))throw new Error('아래 Google 연결 설정에 Client ID를 먼저 저장해 주세요. 이메일만으로는 연결할 수 없습니다.');return id;}
async function connectCalendar(){const clientId=checkCalendarClient();const hint=$('calendarEmail').value.trim();if(hint&&!$('calendarEmail').checkValidity())throw new Error('Google 이메일 형식을 확인해 주세요.');if(!window.google?.accounts?.oauth2){await loadGis();$('calendarStatus').textContent='연결 준비가 되었습니다. Google 캘린더 연결 버튼을 한 번 더 눌러 승인해 주세요.';return;}
  // No await before requestAccessToken: retain the explicit user gesture.
  return new Promise((resolve,reject)=>{const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:CALENDAR_SCOPES.join(' '),include_granted_scopes:false,...(hint?{login_hint:hint}:{}),callback:async response=>{try{if(response.error||!response.access_token)throw new Error('Google 캘린더 승인을 마치지 못했습니다.');const granted=new Set((response.scope||'').split(/\s+/));if(!CALENDAR_SCOPES.every(scope=>granted.has(scope)))throw new Error('캘린더 목록·일정 읽기 권한 두 가지를 모두 승인해 주세요.');if([...granted].some(scope=>scope&&!CALENDAR_SCOPES.includes(scope)))throw new Error('요청하지 않은 권한이 포함되었습니다. 읽기 전용 캘린더 권한만으로 다시 승인해 주세요.');const broad=['https://www.googleapis.com/auth/calendar','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.calendarlist'];if(broad.some(scope=>granted.has(scope)))throw new Error('읽기 전용 이외의 캘린더 권한이 포함되었습니다. Google 계정에서 이전 앱 권한을 해제하고 읽기 전용으로 다시 연결해 주세요.');const list=await allCalendarPages(response.access_token,'users/me/calendarList',{maxResults:'250',showHidden:'false'});const primary=list.find(c=>c.primary);if(!primary?.id)throw new Error('로그인한 계정의 기본 캘린더를 확인하지 못했습니다. 다른 계정인지 확인해 주세요.');const accountId=primary.id;const previous=calendarAccounts.find(a=>a.id===accountId);const oldChoices=new Map((previous?.calendars||[]).map(c=>[c.id,c.selected]));const account={id:accountId,label:accountId,lastSync:previous?.lastSync||'',calendars:list.filter(c=>c.id&&c.accessRole!=='freeBusyReader').map(c=>({id:String(c.id),summary:String(c.summary||'이름 없는 캘린더'),selected:!!oldChoices.get(c.id)}))};const accounts=calendarAccounts.filter(a=>a.id!==accountId);accounts.push(account);await putValue('settings',{id:'calendarAccounts',value:accounts});calendarAccounts=accounts;calendarTokens.set(accountId,{token:response.access_token,expires:Date.now()+Number(response.expires_in||3600)*1000-60000});$('calendarEmail').value='';renderCalendarAccounts();$('calendarStatus').textContent='연결했습니다. 가져올 캘린더 2~3개를 체크하고 ‘선택한 캘린더 새로 가져오기’를 누르세요. 공유받은 캘린더도 선택할 수 있습니다.';resolve();}catch(error){reject(error);}},error_callback:()=>reject(new Error('Google 로그인 창이 닫혔거나 차단되었습니다. 연결 버튼을 다시 눌러 주세요.'))});client.requestAccessToken({prompt:'select_account consent',include_granted_scopes:false});});}
function normalizeGoogleApiEvent(item,account,calendar,lastFetched){if(item.status==='cancelled'||!item.id||!item.start)return null;let date,endDate,time='';if(item.start.date){date=item.start.date;const end=parseDate(item.end?.date||date);if(item.end?.date)end.setDate(end.getDate()-1);endDate=dateKey(end);}else if(item.start.dateTime){const start=new Date(item.start.dateTime),end=new Date(item.end?.dateTime||item.start.dateTime);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))return null;date=dateKey(start);time=`${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}`;if(end>start&&end.getHours()===0&&end.getMinutes()===0&&end.getSeconds()===0)end.setDate(end.getDate()-1);endDate=dateKey(end);}else return null;if(endDate<date)endDate=date;return normalizeGoogleRow({id:JSON.stringify([account.id,calendar.id,item.id]),accountId:account.id,calendarId:calendar.id,googleEventId:String(item.id),calendarName:calendar.summary,title:String(item.summary||'(제목 없음)').slice(0,120),memo:[item.location,item.description].filter(Boolean).join('\n').slice(0,10000),date,endDate,time,lastFetched,createdAt:item.created||lastFetched,updatedAt:item.updated||lastFetched});}
function selectedCalendarIds(){const selected=new Map();document.querySelectorAll('#calendarAccounts input[type=checkbox]').forEach(input=>{if(input.checked){const account=input.dataset.account;const set=selected.get(account)||new Set();set.add(input.value);selected.set(account,set);}});return selected;}
async function syncCalendars(){if(!navigator.onLine)throw new Error('인터넷 연결 후 새로 가져와 주세요. 기존 보관본은 오프라인에서도 볼 수 있습니다.');const selected=selectedCalendarIds();if(!selected.size)throw new Error('가져올 캘린더를 하나 이상 체크해 주세요.');const wanted=calendarAccounts.map(a=>({...a,calendars:a.calendars.map(c=>({...c,selected:!!selected.get(a.id)?.has(c.id)}))}));const rangeStart=$('calendarFrom').value,rangeEnd=$('calendarTo').value;if(!validDate(rangeStart)||!validDate(rangeEnd)||rangeStart>rangeEnd||rangeStart<'1900-01-01'||rangeEnd>'2100-12-31')throw new Error('가져올 시작·마지막 날짜를 확인해 주세요.');const from=parseDate(rangeStart),to=parseDate(rangeEnd);from.setHours(0,0,0,0);to.setHours(0,0,0,0);to.setDate(to.getDate()+1);const fetched=new Date().toISOString();const rows=[];const selectedPairs=new Set();
  for(const account of wanted){const chosen=account.calendars.filter(c=>c.selected);if(!chosen.length)continue;const session=calendarTokens.get(account.id);if(!session||session.expires<=Date.now())throw new Error(`${account.label} 계정을 Google 캘린더 연결 버튼으로 다시 승인해 주세요. 앱을 다시 열면 연결 승인이 필요합니다. 기존 보관본은 유지합니다.`);for(const calendar of chosen){const items=await allCalendarPages(session.token,'calendars/'+encodeURIComponent(calendar.id)+'/events',{timeMin:from.toISOString(),timeMax:to.toISOString(),singleEvents:'true',showDeleted:'false',maxResults:'2500',orderBy:'startTime',fields:'items(id,status,summary,description,location,start,end,created,updated),nextPageToken'});selectedPairs.add(JSON.stringify([account.id,calendar.id]));for(const item of items){const row=normalizeGoogleApiEvent(item,account,calendar,fetched);if(row)rows.push(row);}if(rows.length>20000)throw new Error('20,000개가 넘습니다. 선택한 캘린더를 줄여 주세요. 기존 보관본은 유지합니다.');}account.lastSync=fetched;account.rangeLabel=rangeStart+' ~ '+rangeEnd;}
  // Commit only after all selected calendars and all pages succeeded.
  await new Promise((resolve,reject)=>{const tx=db.transaction(['googleEvents','settings'],'readwrite'),store=tx.objectStore('googleEvents'),request=store.openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor){for(const row of rows)store.put(row);tx.objectStore('settings').put({id:'calendarAccounts',value:wanted});tx.objectStore('settings').put({id:'calendarRange',value:{start:rangeStart,end:rangeEnd}});return;}const row=cursor.value;if(wanted.some(a=>a.id===row.accountId))cursor.delete();cursor.continue();};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});calendarAccounts=wanted;await refreshData();renderCalendarAccounts();$('calendarStatus').textContent=`Google 일정 ${rows.length}개를 앱에 가져왔습니다. ${new Date(fetched).toLocaleString('ko-KR')} 기준입니다. 원본에는 아무것도 쓰지 않았습니다.`;}
function renderCalendarAccounts(){const target=$('calendarAccounts');target.replaceChildren();for(const account of calendarAccounts){const box=node('section',undefined,'calendar-account');box.append(node('h3',account.label));const session=calendarTokens.get(account.id);box.append(node('p',session&&session.expires>Date.now()?'현재 읽기 연결됨':'보관된 선택입니다. 새로 가져올 때 이 계정으로 다시 연결해 주세요.','help'));for(const calendar of account.calendars){const label=node('label',undefined,'calendar-choice'),input=document.createElement('input');input.type='checkbox';input.value=calendar.id;input.dataset.account=account.id;input.checked=calendar.selected;label.append(input,node('span',calendar.summary));box.append(label);}if(account.lastSync)box.append(node('p','마지막 가져오기: '+new Date(account.lastSync).toLocaleString('ko-KR')+(account.rangeLabel?' · '+account.rangeLabel:''),'help'));const remove=node('button','이 계정 연결·보관본 지우기');remove.onclick=async()=>{if(calendarBusy)return;if(!confirm('이 계정의 연결 정보와 Google 일정 보관본을 이 앱에서만 지울까요? Google 원본과 내 일정 복사본은 지우지 않습니다.'))return;try{const accounts=calendarAccounts.filter(a=>a.id!==account.id);await new Promise((resolve,reject)=>{const tx=db.transaction(['googleEvents','settings'],'readwrite'),cursor=tx.objectStore('googleEvents').index('accountId').openCursor(IDBKeyRange.only(account.id));cursor.onsuccess=()=>{const c=cursor.result;if(c){c.delete();c.continue();}};tx.objectStore('settings').put({id:'calendarAccounts',value:accounts});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});calendarTokens.delete(account.id);calendarAccounts=accounts;renderCalendarAccounts();await refreshData();}catch{notify('이 앱의 보관본을 지우지 못했습니다.');}};box.append(remove);target.append(box);}}
async function calendarAction(action){if(calendarBusy)return;calendarBusy=true;$('connectCalendar').disabled=true;$('syncCalendars').disabled=true;try{await action();}catch(error){$('calendarStatus').textContent=error.message||'Google 캘린더 연결을 마치지 못했습니다.';notify($('calendarStatus').textContent);}finally{calendarBusy=false;$('connectCalendar').disabled=false;$('syncCalendars').disabled=false;}}
async function initializeCalendars(){const settings=await getAll('settings');calendarAccounts=settings.find(r=>r.id==='calendarAccounts')?.value||[];const range=settings.find(r=>r.id==='calendarRange')?.value;$('calendarFrom').value=range?.start||`${new Date().getFullYear()-1}-01-01`;$('calendarTo').value=range?.end||`${new Date().getFullYear()+2}-12-31`;renderCalendarAccounts();}
function bindSecureGoogle(){$('chooseBackupFile').onclick=()=>$('importJson').click();$('chooseCsvFile').onclick=()=>$('importCsv').click();$('passwordForm').onsubmit=submitPassword;$('cancelPassword').onclick=cancelPassword;$('passwordDialog').addEventListener('cancel',event=>{event.preventDefault();cancelPassword();});$('closeGoogleEvent').onclick=()=>$('googleEventDialog').close();$('copyGoogleEvent').onclick=()=>copyGoogleEvent().catch(()=>notify('복사하지 못했습니다.'));$('connectCalendar').onclick=()=>calendarAction(connectCalendar);$('syncCalendars').onclick=()=>calendarAction(syncCalendars);$('googleCalendarBar').onclick=()=>{showTab('settings');$('calendarAccounts').scrollIntoView({block:'start'});};}

init();
