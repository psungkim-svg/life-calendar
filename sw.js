'use strict';
// Release checklist: change this version, app.js APP_VERSION and version.json together.
const VERSION = '1.3.0';
const PREFIX = 'haru-calendar-';
const CACHE = PREFIX + VERSION;
const FILES = ['./','./index.html','./style.css','./app.js','./manifest.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    try {
      const response=await fetch(new URL('./version.json',self.registration.scope),{cache:'no-store'});
      if(!response.ok || (await response.json()).version!==VERSION) throw new Error('Release files are not synchronized');
      // Fetch fresh files to prevent mixing old HTTP-cache assets with a new release.
      await cache.addAll(FILES.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'})));
    } catch(error) { await caches.delete(CACHE); throw error; }
    // Updates wait for the user's explicit approval. Initial installs activate normally.
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const name of await caches.keys()) if(name.startsWith(PREFIX)&&name!==CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='GET_VERSION') event.ports[0]?.postMessage({version:VERSION});
  if(event.data?.type==='SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin) return;
  // Version checks must never be served from the application cache.
  if(url.pathname.endsWith('/version.json')||url.pathname.endsWith('/sw.js')) return;
  const allowed=FILES.map(path=>new URL(path,self.registration.scope).pathname);
  if(event.request.mode!=='navigate'&&!allowed.includes(url.pathname)) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=event.request.mode==='navigate' ? await cache.match(new URL('./index.html',self.registration.scope)) : await cache.match(event.request,{ignoreSearch:true});
    return cached || fetch(event.request);
  })());
});
