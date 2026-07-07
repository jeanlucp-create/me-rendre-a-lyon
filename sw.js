const CACHE = 'lyon-mouvement-v2';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Sources externes (API, cartes, polices...) : toujours réseau, jamais de cache
  if (url.hostname.includes('workers.dev') || url.hostname.includes('grandlyon') || url.hostname.includes('openstreetmap') || url.hostname.includes('unpkg') || url.hostname.includes('fonts') || url.hostname.includes('data.gouv')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Page HTML (navigation) : réseau en priorité, cache en secours si hors-ligne.
  // C'est ce qui permet de récupérer automatiquement la dernière version à chaque
  // ouverture/rechargement de l'app, sans que l'utilisateur ait à vider son cache.
  const isNavigation = e.request.mode === 'navigate' || (e.request.destination === 'document');
  if (isNavigation) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const respClone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, respClone));
          return resp;
        })
        .catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Autres assets statiques (manifest, icônes...) : cache d'abord, réseau en secours
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
