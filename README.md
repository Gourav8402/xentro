# Xentro storefront

A JavaScript/Node storefront with a product catalogue, persistent cart, UPI QR checkout, WhatsApp payment screenshot follow-up, order tracking, and an order-status dashboard.

## Start locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` and replace the administrator ID and password with unique values.
3. Double-click `START-WEBSITE.bat`, or run `node server.js` (or `npm start` if npm is available).
4. Open the URL printed by the server. It defaults to `http://localhost:3000`; if `PORT` is set in `.env`, use that port instead.

UPI QR checkout and order tracking work through the Node server. Orders are stored in `orders.json`, which is created automatically. The payment QR image is `assets/payment.jpeg`. After placing an order, buyers can open WhatsApp and attach their payment screenshot manually; the site cannot attach a file automatically. Do **not** open `index.html` directly: that only displays the page and cannot run checkout, order tracking, or the admin panel.

## WhatsApp help

A floating "WhatsApp Help" button sits in the bottom-right corner of the storefront and product pages, linking to `+91 88821 48546`. The same number is used for payment screenshot messages. If it changes, update the `wa.me` links in `index.html`, `product.html`, and `blog.html`, plus `paymentWhatsApp` in `cart.js`.

## Admin panel

Open `/admin.html` and sign in using `ADMIN_ID` and `ADMIN_PASSWORD` from `.env`. The dashboard manages the catalogue, inventory, product categories/offers/featured items, homepage hero content, and orders. Product and content changes are saved to `products.json` and `site-content.json` and appear on the storefront immediately. Each product supports up to 10 images; add several files at once, replace individual images, reorder them, or remove extras in the product editor. The first image is used as the main storefront image, and product detail pages provide clickable thumbnails for the full gallery. Uploaded product and banner images are stored in `uploads/` (PNG, JPEG, or WebP up to 5 MB each).

The initial catalogue is seeded from `data.js`; existing stock is intentionally left untracked until you enter real quantities in the admin panel. New products start at zero stock. Orders reserve tracked inventory, prevent overselling, and restore inventory when cancelled. Configure persistent storage for the JSON data files and `uploads/` on your hosting provider. Production startup requires explicit admin credentials; change the example values in `.env.example` before deployment.

The admin session uses an HttpOnly, SameSite cookie, expires after inactivity, and limits repeated failed login attempts. Restart the server after updating application code so it loads the changes; catalogue edits made in the admin panel do not require a restart. For a public deployment, serve the site over HTTPS and set unique, long admin credentials.

## Product pages

Clicking any product on the storefront opens `product.html?id=<id>`, a dedicated page with its managed description, specifications, features, and reviews. The home page and product page both load the editable catalogue from the server; cart, checkout, and tracking logic lives in `cart.js`.

## Customer reviews

The `/reviews/` page lists every product, including products marked unavailable for sale in the admin panel, and lets customers submit a 1–5 star rating and written review. Reviews are stored separately in `reviews.json` and remain pending until an administrator approves them in the Reviews tab. Approved reviews appear on the product page and reviews directory; rejected reviews remain unpublished. Products marked unavailable for sale appear as Coming soon and cannot be purchased, but can receive customer feedback. Reviews are not verified against order records.

## Blog

Open `/blog/` for school-bag guides and practical care articles. Manage posts in the admin dashboard's **Blog & SEO** tab: write content with `##`/`###` headings and `-` bullet lists, upload article and social images, set image alt text and category, preview search snippets, and save drafts, publish immediately, or schedule a future publication. Published posts are server-rendered with per-post SEO titles, descriptions, focus keywords, canonical URLs, social metadata, and `BlogPosting` structured data. Drafts stay private; scheduled posts become public automatically when due. Changing a post slug redirects its previous published URL to the new one. `/sitemap.xml` is generated from the current published catalogue and posts; submit it in Google Search Console to monitor indexing. Add the Search Console HTML-tag verification code and edit home, blog-index, and reviews-page SEO and social images in the same admin tab. Product-page SEO title, description, focus keyword, canonical URL, image alt text, and sharing image are in the product editor. Google controls crawl and indexing timing; the site cannot guarantee inclusion or provide Search Console indexing reports without Google account/API credentials.

## UPI QR payments

The UPI payment QR image is `assets/payment.jpeg`. Buyers enter delivery details, place the order, scan the QR, then open WhatsApp to send the order details and manually attach their payment screenshot to `+91 88821 48546`. New orders remain marked **Payment pending** until you verify the screenshot and update the order status in the admin dashboard. Admins can set customer-visible shipment stages such as **Order placed**, **Ready to ship**, and **Shipped**, then save the carrier tracking ID. Customers can find orders using the checkout phone number; the order ID is optional. Do not mark an order paid based only on the buyer's message.

## Production note

Set unique `ADMIN_ID` and `ADMIN_PASSWORD` values in `.env` to protect the admin dashboard. Deploy the app to a Node-compatible host with durable writable storage for orders, catalogue/content JSON, and uploaded images. Configure HTTPS and persistent backups; this lightweight JSON-file implementation is best suited to a single server instance.

## SEO and responsive design

The storefront serves page-specific titles, descriptions, canonical URLs, Open Graph/Twitter previews, Product/Organization and BlogPosting structured data using the current catalogue and articles. Product details and blog articles are included in the initial HTML response as well as loaded where needed by the storefront. `robots.txt` excludes admin/API routes, and `sitemap.xml` lists the homepage, every active product URL, the blog index, and each article. Canonical and sitemap URLs use the request host, so use a stable custom domain for indexing; temporary tunnel addresses can change. After launch on your permanent domain, verify the site in Google Search Console and submit `https://your-domain/sitemap.xml`.
