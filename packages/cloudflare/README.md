# @deeprush/cloudflare

Small Cloudflare DNS helper for DeepRush infrastructure scripts.

It intentionally covers the stable operations we use most often instead of wrapping the entire Cloudflare API.

## Install

```sh
npm install @deeprush/cloudflare
```

## Authentication

Use an API token:

```js
import { createCloudflare } from '@deeprush/cloudflare'

const cf = createCloudflare({
  zone: 'example.com',
  apiToken: process.env.CF_API_TOKEN,
})
```

Or use a global API key:

```js
const cf = createCloudflare({
  zone: 'example.com',
  email: process.env.CF_EMAIL,
  apiKey: process.env.CF_API_KEY,
})
```

If credentials are omitted, the client reads:

- `CF_API_TOKEN` or `CLOUDFLARE_API_TOKEN`
- `CF_EMAIL` or `CLOUDFLARE_EMAIL`
- `CF_API_KEY` or `CLOUDFLARE_API_KEY`

## DNS

```js
await cf.setA('edge-1', '203.0.113.10')

await cf.setMany([
  'edge-1 203.0.113.10',
  'edge-3 203.0.113.10',
  { name: 'edge-5', content: '203.0.113.10' },
])
```

Defaults:

- `ttl: 60`
- `proxied: false`

`setA()` and `setAAAA()` create missing records and update existing single records. If multiple records already exist for the same name and type, the client throws instead of guessing which duplicate should be authoritative.

