# Rent Some Orders — Firebase Ready

This build keeps the lightweight admin + quick picker setup, and adds a Firebase-ready data layer.

## What changed
- Firebase-ready admin login
- Firebase-ready live orders / inventory / settings
- Firebase-ready image upload for inventory items
- Free backup safety tools:
  - append-only order audit log
  - Download Backup JSON
  - Create Snapshot
  - Restore Backup JSON
- Local demo mode still works if Firebase is not configured

## Run locally
1. Unzip the folder
2. Double-click `launch-server.bat`
3. Open `http://localhost:8000/`

Do **not** open the HTML files directly with `file:///`.

## Demo login (when Firebase is OFF)
- Email: `admin@example.com`
- Password: `admin123!`

## Turn Firebase on
Edit:
- `assets/js/config.js`

Set:
- `firebase.enabled` to `true`
- fill in your Firebase web app config values

Example:
```js
firebase: {
  enabled: true,
  config: {
    apiKey: '...'
    authDomain: '...'
    projectId: '...'
    storageBucket: '...'
    messagingSenderId: '...'
    appId: '...'
  }
}
```

## Firebase products to enable
- Authentication → Email/Password
- Firestore Database
- Storage

## Free backup tools in admin
Inside **Settings**:
- **Download Backup JSON** → saves all current orders, inventory, settings, audit log, and snapshots to a local file
- **Create Snapshot** → saves a point-in-time order snapshot
- **Restore Backup JSON** → restores from a previously downloaded backup file

## Data collections used
- `orders`
- `inventory`
- `settings` (`app` doc)
- `orderAuditLog`
- `orderSnapshots`

## Important note
This build is Firebase-ready, but I could not test it against your actual Firebase project because your real project keys and auth users are not available inside this environment.

Local/demo mode is included so you can test the full UI before wiring your real Firebase project.


## Inventory image picker
Add your inventory images inside the `images/` folder and list them in `images/library.json`. The admin inventory form will load that file and let you pick an image from a dropdown. Use paths like `images/chairs/your-file.jpg`.


## Local image paths
The admin image picker and inventory cards now resolve image paths from the site root, so entries like `images/white-folding-chairs.png` work consistently in both `/admin/` and `/quick-picker/`.


If the server window closes immediately, use launch-server.bat in this version. It keeps the window open and prints the startup error instead of silently closing.


## Inventory images
Inventory items now use direct image upload from your computer in the admin form. Images are resized in the browser and saved with the Firestore item, so you do not need an `images` folder or `images/library.json` for inventory thumbnails.


This build uses direct local file upload for inventory images in the admin panel. The old /images library dropdown has been removed.


## Accessories
Inventory items can now have multiple optional accessories. Each accessory can have its own per-item price and optional image. In the quick picker, customers can check one or more accessories and the displayed image swaps to the most recently selected accessory image.


## Inquiry email notifications

This build supports optional inquiry email notifications using EmailJS.

Open Admin > Settings and fill in:
- Notification Email
- Notification From Name
- EmailJS Public Key
- EmailJS Service ID
- EmailJS Template ID
- Enable inquiry email notifications

Recommended EmailJS template variables to use in your template:
`to_email`, `from_name`, `business_name`, `customer_name`, `exchange_datetime`, `return_datetime`, `fulfillment_type`, `delivery_address`, `delivery_miles`, `delivery_fee`, `subtotal`, `total`, `contacts_text`, `items_text`, `delivery_text`, `message`, `inquiry_id`


## Google Maps setup

1. In Google Cloud, enable **Maps JavaScript API** and **Places API (New)** for your project.
2. Create a browser API key and restrict it to your GitHub Pages domain or custom domain.
3. Paste the key into **Admin → Settings → Google Maps API Key** and save.
4. The site will use Google for autocomplete, geocoding, and delivery distance when the key is present. If Google is unavailable, it falls back to the older free provider.
