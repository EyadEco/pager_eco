# digital customer pager

A Bajri-inspired customer paging product prototype. Staff register an order, then the customer links their phone by scanning its unique QR code. If a camera/QR scanner is unavailable, the customer can open the order page and enter only the order number. When staff marks it ready, the app sends a web-push alert to the customer’s phone. No customer account, name, or phone number is collected.

The home page presents the product. The cashier demo is at `/staff`; a customer order page is at `/order`.

## Run locally

1. Install Node.js 18 or newer.
2. In this folder, run `npm install` and `npm start`.
3. Open `http://localhost:3000` for the product page, `http://localhost:3000/staff` for the cashier desk, and `http://localhost:3000/order` for the customer order page. Set `PORT` if port 3000 is occupied. The default staff PIN is `2468`; change it by setting `STAFF_PIN` before starting.

In the cashier desk, enter the receipt order number and items, then select **Create order & show QR**. Each order gets its own QR linking directly to that order. The customer scans it or uses the order number fallback. Select **Mark ready** to send the alert. If the customer misses it, select **Re-alert** on that ready order to send another notification. The ready-order row shows linked phones, alert attempts, and notifications accepted by the push service. A small interactive product preview also appears on the home page.

## Enable lock-screen notifications

Web push requires the customer website to run over HTTPS, a push-capable browser, and the customer’s permission. HTTP on the local Wi-Fi network cannot provide web push. `localhost` is treated as secure for local development, but a real customer phone needs the deployed HTTPS domain.

Generate VAPID keys with `npm run keys`. Set the generated public and private values in the server environment before starting it:

```powershell
$env:VAPID_PUBLIC_KEY = 'your-public-key'
$env:VAPID_PRIVATE_KEY = 'your-private-key'
$env:VAPID_SUBJECT = 'mailto:you@example.com'
$env:STAFF_PIN = 'choose-a-pin'
npm start
```

Keep the private key secret and reuse the same pair between restarts. For production, deploy behind an HTTPS host or reverse proxy. The cashier and customer phones must use the same HTTPS site so the QR codes link to it.

On Android, the customer opens the QR/order page in a browser that supports web push, selects **Enable lock-screen alert**, and allows notifications. On iPhone/iPad, web push requires adding the site to the Home Screen and opening it from its icon; Apple introduced this for Home Screen web apps in iOS/iPadOS 16.4. It does not require an App Store download. The browser/OS controls notification sound; the app can request an audible notification but cannot override silent mode, Focus, permissions, or device settings.

## Current scope

- The cashier dashboard supports manual order entry and status changes.
- The QR library loads from a CDN and requires internet access on the cashier device.
- POS names shown in the marketing preview are examples of possible integration targets. This project does not yet connect to Foodics, Rewaa, Odoo, or another live POS API; that requires a provider-specific integration.
- Orders and push subscriptions are stored in `data/queue.json` on the server.



