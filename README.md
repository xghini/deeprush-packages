# deeprush-packages

Source of the public `@deeprush/*` npm packages.

| Package | Folder |
|---|---|
| [`@deeprush/bctl`](https://www.npmjs.com/package/@deeprush/bctl) | [packages/bctl](packages/bctl) |
| [`@deeprush/cloudflare`](https://www.npmjs.com/package/@deeprush/cloudflare) | [packages/cloudflare](packages/cloudflare) |

## Release

```bash
npm run release -- bctl
```

Bumps the package to the calendar version (`YY.MDD.HHMMSS`), runs its checks locally, commits, tags
`<package>@<version>` and pushes. The tag runs [publish.yml](.github/workflows/publish.yml), which publishes
to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) — no npm token is stored.
Each package on npmjs.com has this repository and `publish.yml` set as its trusted publisher.
