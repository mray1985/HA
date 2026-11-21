const cacheKey='ha-synthetic-review-v1:'+self.registration.scope
const shell=['index.html','manifest.webmanifest','icon192.png','icon512.png'].map(path=>new URL(path,self.registration.scope).href)
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheKey).then(cache=>cache.addAll(shell))))
self.addEventListener('fetch',event=>{
  const url=event.request.url
  if(event.request.method==='GET' && (shell.includes(url)||url===self.registration.scope)){
    event.respondWith(fetch(event.request).catch(()=>caches.open(cacheKey).then(cache=>cache.match(url===self.registration.scope?shell[0]:url))))
  }
})
