'use strict';
const APP_VERSION = '1.1.0';
const APP_NAME = 'SK-달력';
const DB_VERSION = 1;
const $ = id => document.getElementById(id);
let db, selected = dateKey(new Date()), shown = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let suppressDateClickUntil = 0;
let monthEvents = [], editingId = null, registration = null, remoteVersion = null, applyingUpdate = false;
function dateKey(d) { return `${String(d.getFullYear()).padStart(4,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDate(s) { const [y,m,d] = s.split('-').map(Number); const date = new Date(0); date.setFullYear(y,m-1,d); date.setHours(12,0,0,0); return date; }
function notify(text) { $('messageText').textContent = text; if (!$('messageDialog').open) $('messageDialog').showModal(); }
function openDatabase() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open('haru-personal-calendar', DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
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
  try { const results = await readEvents(IDBKeyRange.bound(dateKey(start),dateKey(end))); if (requestMonth !== shown.getTime()) return; monthEvents = results; }
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
    b.append(num,dot); b.onclick = async () => { if(Date.now()<suppressDateClickUntil) return; selected=key; if(day.getMonth()!==shown.getMonth() || day.getFullYear()!==shown.getFullYear()) shown=new Date(day.getFullYear(),day.getMonth(),1); await render(); openEditor(); };
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
    const hint=document.createElement('span'); hint.className='edit-hint'; hint.textContent='›'; b.append(time,copy,hint); b.onclick=()=>openEditor(event); $('eventList').append(b);
  }
}
function moveMonth(offset) { const next=new Date(shown.getFullYear(),shown.getMonth()+offset,1); if(next.getFullYear()<1 || next.getFullYear()>9998) return; shown=next; selected=dateKey(shown); render(); }
function openEditor(event) {
  editingId=event?.id||null; $('eventForm').reset(); $('formError').textContent=''; $('formTitle').textContent=event?'일정 수정':'일정 추가';
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
    if($('eventDialog').open) throw new Error('입력 중인 일정을 저장하거나 닫은 뒤 업데이트해 주세요.');
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
    event.preventDefault(); const title=$('eventTitle').value.trim(); if(!title){$('formError').textContent='제목을 입력해 주세요.';return;}
    const old=monthEvents.find(e=>e.id===editingId); const now=new Date().toISOString();
    const value={id:editingId||crypto.randomUUID(),date:$('eventDate').value,time:$('eventTime').value,title,memo:$('eventMemo').value.trim(),createdAt:old?.createdAt||now,updatedAt:now};
    try { await saveEvent(value); selected=value.date; const d=parseDate(selected); shown=new Date(d.getFullYear(),d.getMonth(),1); $('eventDialog').close(); await render(); }
    catch { $('formError').textContent='저장하지 못했습니다. 저장 공간 또는 브라우저 설정을 확인해 주세요.'; }
  };
  $('deleteEvent').onclick=()=>$('deleteDialog').showModal(); $('cancelDelete').onclick=()=>$('deleteDialog').close();
  $('confirmDelete').onclick=async()=>{try{await saveEvent(editingId,true);$('deleteDialog').close();$('eventDialog').close();await render();}catch{notify('삭제하지 못했습니다. 다시 시도해 주세요.');}};
  $('closeMessage').onclick=()=>$('messageDialog').close();
  function tab(settings){$('calendarView').hidden=settings;$('settingsView').hidden=!settings; for(const [id,active] of [['calendarTab',!settings],['settingsTab',settings]]){$(id).classList.toggle('active',active);if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}}
  $('calendarTab').onclick=()=>tab(false);$('settingsTab').onclick=()=>{tab(true);storageStatus();};
  $('persistButton').onclick=()=>storageStatus(true);$('checkUpdate').onclick=()=>checkUpdate(true);$('laterUpdate').onclick=()=>$('updateDialog').close();$('applyUpdate').onclick=applyUpdate;
  let touch=null; const calendar=document.querySelector('.calendar');
  calendar.addEventListener('touchstart',e=>{if(e.touches.length===1)touch={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:true});
  calendar.addEventListener('touchend',e=>{if(!touch)return;const dx=e.changedTouches[0].clientX-touch.x,dy=e.changedTouches[0].clientY-touch.y;touch=null;if(Math.abs(dx)>65&&Math.abs(dx)>Math.abs(dy)*1.5){suppressDateClickUntil=Date.now()+450;moveMonth(dx<0?1:-1);}},{passive:true});
  calendar.addEventListener('touchcancel',()=>{touch=null;});
  function connection(){$('connection').textContent=navigator.onLine?'':'· 오프라인';} connection();window.addEventListener('online',connection);window.addEventListener('offline',connection);
}
async function init() {
  bindUI(); storageStatus(true);
  try { db=await openDatabase(); await render(); }
  catch { $('addEvent').disabled=true; notify('기기 저장소를 열지 못했습니다. 일반 모드의 Chrome으로 다시 열어 주세요.'); }
  if('serviceWorker' in navigator && location.protocol!=='file:') {
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(applyingUpdate)location.reload();});
    try { registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}); }
    catch { $('updateStatus').textContent='오프라인 준비에 실패했습니다. 인터넷 연결 후 다시 열어 주세요.'; }
  }
  await checkUpdate();
}
init();
