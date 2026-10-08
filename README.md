# YanServer

Live public status dashboard for **https://server.ethanyanxu.com**, deployed on Windows `finprint-host` behind the existing shared Caddy service. Node.js 22+; no third-party runtime dependencies.

## What it measures

- Whole-host CPU and memory every 5 seconds.
- Windows disk, physical network adapter, NVIDIA GPU, process, service, and scheduled task readings every 30 seconds.
- Public hostnames automatically discovered from Caddy's active HTTPS routes every 60 seconds.
- TLS-verified GET requests to each site's root, routed directly to the server with its actual hostname. Redirects count as responding; authentication responses are labeled restricted; other 4xx and 5xx are flagged. These are shallow origin checks, not external end-to-end application tests.
- Up to 24 hours of resource samples and observed availability; unobserved intervals remain gray. Status changes remain for seven days. History is saved each minute and survives deployments/restarts.

The monitor lives on the machine it monitors. A host, power, or internet outage can make the dashboard unavailable. It cannot independently prove public DNS, external reachability, or the health of every application dependency.

## Public and owner views

Public responses are constructed with an explicit allowlist: resource percentages, total traffic rates, uptime, public website names and health, TLS expiry, and website state changes. Private responses additionally include hardware identity, memory and disk sizes, processes, scheduled tasks and deployment hashes, Windows services, internal listener addresses, and website routing paths.

Owner access uses a randomly generated 192-bit code, an scrypt hash, and a signed HttpOnly, Secure, SameSite=Strict cookie lasting 30 days. Login is rate limited and requires the configured Origin. Public and private responses use `Cache-Control: no-store` and `Vary: Cookie`. There are no remote execution, restart, or process control endpoints.

The code is generated on the server in the protected file `C:\ProgramData\YanServer\data\owner-access.txt`. It is never bundled into source or frontend assets. Keep any downloaded copy private. To revoke all remembered browsers, stop the YanServer task, set `YANSERVER_DATA` to the existing data directory, run `node scripts/rotate-access.mjs` from the active release, and restart the task.

## Development and verification

```powershell
npm.cmd start
npm.cmd run check
npm.cmd test
```

The listener binds only to `127.0.0.1:3800`. Local development creates ignored `.runtime` data and uses `http://localhost:3800` as the allowed origin. `PORT`, `PUBLIC_ORIGIN`, `YANSERVER_DATA`, and `CADDY_API` can be overridden. `NO_COLLECTOR=1` disables Windows collection for isolated API tests.

## Deployment

Commit the release first. `npm.cmd run deploy` uploads a Git archive, verifies SHA-256 on the server, launches a SYSTEM startup task on alternating loopback ports 3800/3801, and waits for both resource collection and website checks before switching Caddy. The previous task remains available until activation succeeds. Only the active release writes shared history.

On first installation, run `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/deploy.ps1 -PrepareDns`. This creates only `server.ethanyanxu.com CNAME finprint.ethanyanxu.com` using the existing host-protected DNS credential. It refuses to overwrite an unrelated record. Verify public DNS propagation, then run the normal deployment command. Other hostnames and services are preserved.

Runtime layout:

- `C:\ProgramData\YanServer\releases\<commit>-<time>` — immutable code
- `data\` — private credentials and durable history
- `active.json` / `previous.json` — activation metadata
- `Caddyfile` — managed import in the shared Finprint Caddyfile
- `logs\` — bounded application and HTTP logs

Application processes are supervised and restarted after failure. The scheduled task starts at boot. A failed readiness check leaves the old deployment active; an invalid Caddy update restores its previous config. Full rollback after a successful release has not been automated: retain the previous release/task and switch its validated upstream through the shared Caddy configuration if needed.

Reference: [Caddy administration API](https://caddyserver.com/docs/api) provides the live route inventory. No Caddy configuration or credentials are returned in the public API.
