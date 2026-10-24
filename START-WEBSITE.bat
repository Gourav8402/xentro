@echo off
cd /d "%~dp0"
echo Starting Xentro Storefront. Open the URL printed below (PORT in .env, or 3000 by default).
echo Keep this window open while using order tracking, checkout, or the admin panel.
node server.js
pause
