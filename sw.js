const CACHE='cardiolink-v4.0.9.1-hc-search-ux';
const SHELL=['./','./index.html?v=40091','./styles.css?v=40091','./app.js?v=40091','./manifest.webmanifest?v=40091','./icons/icon-192.png?v=40091','./icons/icon-512.png?v=40091'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin)return;e.respondWith(fetch(r,{cache:'no-store'}).then(resp=>{const copy=resp.clone();caches.open(CACHE).then(c=>c.put(r,copy));return resp}).catch(()=>caches.match(r).then(x=>x||caches.match('./index.html?v=40091')||caches.match('./index.html'))));});
self.addEventListener('message',e=>{if(e.data&&e.data.type==='SKIP_WAITING')self.skipWaiting()});
