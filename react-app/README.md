# Inventory List React App

This is the future Coolify-deployed version of the inventory app. The repository root remains the current static GitHub Pages app.

## Local Development

```bash
npm install
npm run dev
```

## Coolify

Deploy this folder as the app root:

```text
Base directory: react-app
Install command: npm ci
Build command: npm run build
Publish directory: dist
```

Use `876en.org` tenant subdomains for the deployed app, such as:

```text
https://1st.876en.org
https://ms.876en.org
```

Set these environment variables in Coolify if you need to override defaults:

```text
VITE_BASE_DOMAIN=876en.org
VITE_API_BASE_URL=/api
VITE_LEGACY_BUCKET_BASE_URL=https://ms-inventories.s3.us-east-1.amazonaws.com
```
