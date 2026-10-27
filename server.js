const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
let webPush = null;
try { webPush = require('web-push'); } catch { /* Installed with npm install before push is enabled. */ }

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'queue.json');
let localVapid = {};
try { localVapid = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'vapid-keys.json'), 'utf8')); } catch { /* Keys can be supplied through the environment instead. */ }
const PORT = Number(process.env.PORT || 3000);
const STAFF_PIN = process.env.STAFF_PIN || '2468';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || localVapid.publicKey || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || localVapid.privateKey || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || localVapid.subject || 'mailto:admin@example.com';
const PUSH_ENABLED = Boolean(webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8' };

if (PUSH_ENABLED) webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
function initialState() { return { queueOpen: true, nextNumber: 1, orders: [], updatedAt: new Date().toISOString() }; }
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let orders = Array.isArray(parsed.orders) ? parsed.orders : [];
    if (!orders.length && Array.isArray(parsed.guests)) orders = parsed.guests.map(g => ({
      id: g.id || crypto.randomUUID(), number: g.number, orderNumber: g.orderNumber || String(g.number), items: '',
      status: g.status === 'called' ? 'waiting' : g.status === 'seated' ? 'collected' : g.status,
      joinedAt: g.joinedAt || new Date().toISOString(), readyAt: null, subscriptions: []
    }));
    return { ...initialState(), ...parsed, orders, nextNumber: Number(parsed.nextNumber) || Math.max(1, ...orders.map(o => Number(o.number) + 1)) };
  } catch { return initialState(); }
}
let state = loadState();
let saveChain = Promise.resolve();
function save() {
  state.updatedAt = new Date().toISOString();
  saveChain = saveChain.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const temp = `${DATA_FILE}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(state, null, 2));
    await fs.promises.rename(temp, DATA_FILE);
  });
  return saveChain;
}
function activeOrders() { return state.orders.filter(o => ['waiting', 'ready'].includes(o.status)); }
function safeOrder(o) { return { id: o.id, number: o.number, orderNumber: o.orderNumber, items: o.items, status: o.status, joinedAt: o.joinedAt, readyAt: o.readyAt || null, walkIn: Boolean(o.walkIn), subscriberCount: (o.subscriptions || []).length, alertAttempts: Number.isInteger(o.alertAttempts) ? o.alertAttempts : (o.status === 'ready' ? 1 : 0), alertsSent: Number(o.alertsSent ?? o.alertCount) || 0 }; }
function publicState() {
  const active = activeOrders();
  return { queueOpen: state.queueOpen, nextNumber: state.nextNumber, activeCount: active.length, waitingCount: active.filter(o => o.status === 'waiting').length, readyCount: active.filter(o => o.status === 'ready').length, updatedAt: state.updatedAt };
}
function staffState() { return { ...publicState(), orders: activeOrders().sort((a,b) => a.number - b.number).map(safeOrder) }; }
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 24_000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function staffOnly(req, res) {
  if (req.headers['x-staff-pin'] !== STAFF_PIN) { send(res, 401, { error: 'Enter the staff PIN to continue.' }); return false; }
  return true;
}
function error(res, status, message) { send(res, status, { error: message }); }
function normalizeOrderNumber(value) {
  const orderNumber = String(value || '').trim().replace(/^#/, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(orderNumber) ? orderNumber : null;
}
function orderIsActive(orderNumber) { return activeOrders().some(o => o.orderNumber === orderNumber); }
function makeOrder(orderNumber, items, walkIn = false) {
  return { id: crypto.randomUUID(), number: state.nextNumber++, orderNumber, items, status: 'waiting', joinedAt: new Date().toISOString(), readyAt: null, subscriptions: [], alertAttempts: 0, alertsSent: 0, walkIn };
}
async function sendReadyPush(order, reminder = false) {
  if (!PUSH_ENABLED || !order.subscriptions?.length) return { sent: 0, failed: 0 };
  const payload = JSON.stringify({ title: `ANN Cafe & Bakery · #${order.orderNumber} ready`, body: reminder ? `A friendly reminder: your order is ready for pickup. ${order.items}` : `Your order is ready for pickup. ${order.items}`, orderId: order.id, url: `/order?order=${encodeURIComponent(order.id)}` });
  const results = await Promise.allSettled(order.subscriptions.map(subscription => webPush.sendNotification(subscription, payload, { TTL: 300, urgency: 'high' })));
  let changed = false, sent = 0, failed = 0;
  const stale = new Set();
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') sent++;
    else {
      failed++;
      const statusCode = result.reason?.statusCode;
      if (statusCode === 404 || statusCode === 410) stale.add(order.subscriptions[i].endpoint);
      else console.error(`Web push failed for order #${order.orderNumber}:`, result.reason?.message || result.reason);
    }
  });
  if (stale.size) { order.subscriptions = order.subscriptions.filter(s => !stale.has(s.endpoint)); changed = true; }
  if (changed) await save();
  return { sent, failed };
}
function safeSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || !value.endpoint.startsWith('https://') || typeof value.keys?.p256dh !== 'string' || typeof value.keys?.auth !== 'string') return null;
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, publicState());
  if (req.method === 'GET' && url.pathname === '/api/push/config') return send(res, 200, { enabled: PUSH_ENABLED, publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
  const idMatch = url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)$/i);
  if (req.method === 'GET' && idMatch) {
    const order = state.orders.find(o => o.id === idMatch[1]);
    if (!order) return error(res, 404, 'Order not found. Check the order number with the cashier.');
    const ahead = order.status === 'waiting' ? state.orders.filter(o => o.status === 'waiting' && o.number < order.number).length : 0;
    return send(res, 200, { order: safeOrder(order), ahead, pushEnabled: PUSH_ENABLED });
  }
  if (req.method === 'GET' && url.pathname === '/api/orders/lookup') {
    const orderNumber = normalizeOrderNumber(url.searchParams.get('number'));
    if (!orderNumber) return error(res, 400, 'Enter the order number from your receipt.');
    const order = activeOrders().find(o => o.orderNumber === orderNumber);
    if (!order) return error(res, 404, 'We could not find that active order. Check the number with the cashier.');
    const ahead = order.status === 'waiting' ? state.orders.filter(o => o.status === 'waiting' && o.number < order.number).length : 0;
    return send(res, 200, { order: safeOrder(order), ahead, pushEnabled: PUSH_ENABLED });
  }
  const subscribeMatch = url.pathname.match(/^\/api\/orders\/([a-f0-9-]+)\/subscribe$/i);
  if (req.method === 'POST' && subscribeMatch) {
    let body; try { body = await readBody(req); } catch (e) { return error(res, 400, e.message); }
    if (!PUSH_ENABLED) return error(res, 503, 'Lock-screen notifications are not configured on this server yet.');
    const order = state.orders.find(o => o.id === subscribeMatch[1] && ['waiting', 'ready'].includes(o.status));
    if (!order) return error(res, 404, 'This order is no longer waiting.');
    const subscription = safeSubscription(body.subscription);
    if (!subscription) return error(res, 400, 'This phone could not register for alerts. Please try again.');
    for (const other of state.orders) other.subscriptions = (other.subscriptions || []).filter(s => s.endpoint !== subscription.endpoint);
    order.subscriptions = [...(order.subscriptions || []).filter(s => s.endpoint !== subscription.endpoint), subscription];
    await save();
    return send(res, 201, { ok: true, order: safeOrder(order) });
  }
  if (req.method === 'GET' && url.pathname === '/api/staff/state') {
    if (!staffOnly(req, res)) return;
    return send(res, 200, staffState());
  }
  if (req.method === 'GET' && url.pathname === '/api/staff/network') {
    if (!staffOnly(req, res)) return;
    const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, items]) =>
      (items || []).filter(item => item && item.family === 'IPv4' && !item.internal).map(item => ({ name, address: item.address }))
    );
    const hotspot = addresses.find(item => /^192\.168\.137\.1$/.test(item.address))
      || addresses.find(item => /hotspot|wi-?fi direct|local area connection\*/i.test(item.name));
    const host = (hotspot || addresses[0])?.address;
    const port = Number(url.port || PORT);
    return send(res, 200, { guestUrl: host ? `http://${host}:${port}/` : `http://localhost:${port}/` });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/staff/')) {
    if (!staffOnly(req, res)) return;
    let body; try { body = await readBody(req); } catch (e) { return error(res, 400, e.message); }
    const action = url.pathname.slice('/api/staff/'.length);
    if (action === 'verify') return send(res, 200, { ok: true, pushEnabled: PUSH_ENABLED });
    if (action === 'toggle') { state.queueOpen = !state.queueOpen; await save(); return send(res, 200, staffState()); }
    if (action === 'order') {
      if (!state.queueOpen) return error(res, 409, 'Open order intake before adding an order.');
      const orderNumber = normalizeOrderNumber(body.orderNumber);
      const items = String(body.items || '').trim().slice(0, 500);
      if (!orderNumber) return error(res, 400, 'Enter an order number using letters, numbers, or hyphens.');
      if (!items) return error(res, 400, 'Add the items in this order.');
      if (orderIsActive(orderNumber)) return error(res, 409, 'That order number is already active.');
      const order = makeOrder(orderNumber, items);
      state.orders.push(order); await save();
      return send(res, 201, { order: safeOrder(order), state: staffState() });
    }
    if (action === 'ready') {
      const order = state.orders.find(o => o.id === body.id && o.status === 'waiting');
      if (!order) return error(res, 404, 'That order is not waiting.');
      order.status = 'ready'; order.readyAt = new Date().toISOString(); await save();
      const alerts = await sendReadyPush(order);
      order.alertAttempts = (Number.isInteger(order.alertAttempts) ? order.alertAttempts : 0) + 1;
      order.alertsSent = (Number(order.alertsSent ?? order.alertCount) || 0) + alerts.sent;
      await save();
      return send(res, 200, { order: safeOrder(order), state: staffState(), alerts });
    }
    if (action === 'remind') {
      const order = state.orders.find(o => o.id === body.id && o.status === 'ready');
      if (!order) return error(res, 404, 'That order is not marked ready.');
      const alerts = await sendReadyPush(order, true);
      order.alertAttempts = (Number.isInteger(order.alertAttempts) ? order.alertAttempts : (order.status === 'ready' ? 1 : 0)) + 1;
      order.alertsSent = (Number(order.alertsSent ?? order.alertCount) || 0) + alerts.sent;
      await save();
      return send(res, 200, { order: safeOrder(order), state: staffState(), alerts });
    }
    if (action === 'collected') {
      const order = state.orders.find(o => o.id === body.id && o.status === 'ready');
      if (!order) return error(res, 404, 'That order is not marked ready.');
      order.status = 'collected'; order.finishedAt = new Date().toISOString(); await save();
      return send(res, 200, staffState());
    }
    if (action === 'reset') { state = initialState(); await save(); return send(res, 200, staffState()); }
    return error(res, 404, 'Staff action not found.');
  }
  return error(res, 404, 'API route not found.');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); } catch (e) { console.error('API error:', e.message); if (!res.headersSent) error(res, 500, 'Something went wrong. Please try again.'); }
    return;
  }
  const routeFiles = { '/': 'index.html', '/staff': 'staff.html', '/order': 'order.html' };
  let requested = routeFiles[url.pathname] || decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!requested || requested.endsWith('/')) requested += 'index.html';
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) return error(res, 403, 'Forbidden.');
  fs.readFile(file, (err, data) => {
    if (err) { fs.readFile(path.join(PUBLIC, 'index.html'), (fallbackErr, html) => { if (fallbackErr) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(html); }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`ANN Cafe pager is running at http://localhost:${PORT}`));







