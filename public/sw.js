self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Your order is ready', {
    body: data.body || 'Head to the counter to collect your order.',
    icon: '/ann-logo.jpg', badge: '/ann-badge.svg', image: '/ann-notification.svg',
    tag: `ann-order-${data.orderId || 'ready'}`,
    requireInteraction: true, renotify: true, silent: false, vibrate: [250, 120, 250],
    data: { url: data.url || '/' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (client.url.startsWith(self.location.origin)) {
        if ('navigate' in client) client.navigate(url);
        return client.focus();
      }
    }
    return clients.openWindow(url);
  }));
});



