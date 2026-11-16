# Barktown production on Dokploy

Dokploy builds the private GitHub repository on the same ARM64 Pi that runs the containers. Use **Docker Compose**, not Docker Stack or a remote build server. The one local image runs as three services. No registry or GitHub webhook is required for manual deployment.

## 1. Prepare a new Pi (skip on the existing `masmopi`)

- Install 64-bit Raspberry Pi OS. Mount the data SSD as ext4 at `/srv/verbatim` using its filesystem UUID in `/etc/fstab`; confirm with `findmnt --mountpoint /srv/verbatim`. This procedure does not format storage. An fstab `nofail` entry lets the OS boot without the SSD.
- Clone this repository with a GitHub read credential. With Docker still **uninstalled**, run `sudo bash deploy/prepare-host.sh`. This mounts fresh Docker, containerd and Dokploy directories on the SSD and makes the services require their mounts. It refuses to migrate existing runtime data. When rebuilding from backup, start with fresh runtime directories and restore Barktown data separately.
- Install Docker Engine and the Compose plugin using the [Docker Debian APT instructions](https://docs.docker.com/engine/install/debian/), following Docker's ARM64 Raspberry Pi OS guidance. Install and sign in to [Tailscale](https://tailscale.com/kb/1174/install-debian-bookworm), then confirm SSH still works before changing a tagged node's policy.
- Use the [versioned Dokploy installer](https://docs.dokploy.com/docs/core/installation) with an explicit known-good release. On the current Pi that release is `v0.31.2`. Ports 80, 443 and 3000 must be free on the host. For a fresh single-node Swarm, use the Pi's stable Tailscale IP as `ADVERTISE_ADDR`. Open the dashboard over private HTTPS; the existing setup uses the tagged named Service `svc:dokploy` with virtual endpoint `tcp:443` and backend `http://127.0.0.1:3000`. See [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) for host approval and access grants. Scope the GitHub App installation to the `enchartme/barktown-server` repository if this host will only deploy Barktown.
- Bring up a reachable, private MinIO/S3 endpoint. On `masmopi` this is the existing host MinIO on port 9000. The containers use `host.docker.internal` to reach the host; MinIO must listen on the Docker-reachable address. For an existing deployment keep the existing bucket and public upload route. On a replacement host, restore the bucket from backup or point to the existing storage server. A new empty deployment needs an empty bucket. Keep MinIO administration and the Dokploy dashboard off public routes.

## 2. Prepare the production database

Run these on the Pi from a checkout at the revision you will select in Dokploy. Keep old Barktown services stopped during migration or restore; only one ingest worker should process the production bucket.

```bash
sudo docker build -t barktown-server:production .
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" \
  /srv/verbatim/barktown /srv/verbatim/barktown/data /srv/verbatim/barktown/backups
```

Choose exactly one setup path:

| Starting point | Procedure |
|---|---|
| **Empty** | `bash deploy/database.sh init /srv/verbatim/barktown/data/barktown.db`. Use a separate empty bucket; an empty DB cannot recover metadata from the old bucket by itself. |
| **Standalone SQLite backup** | `bash deploy/database.sh restore /path/to/backup/barktown.db /srv/verbatim/barktown/data/barktown.db`. The input is a verified binary backup, not a copy taken while SQLite was writing. Restore the matching MinIO objects before starting ingest. |
| **Existing systemd install** | Stop `barktown-ingest`, `barktown-api-private`, and `barktown-api` and confirm they are inactive. Find `DB_PATH` in the old service environment without printing credentials; a relative value is relative to its working directory. If unset, use `/home/pi/git/enchartme/barktown-server/data/barktown.db`. Use the two commands below and keep the original directory and services for rollback. |

For the systemd move (replace the source if `DB_PATH` is set):

```bash
legacy=/home/pi/git/enchartme/barktown-server/data/barktown.db
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/srv/verbatim/barktown/backups/barktown-before-dokploy-$stamp.db"
bash deploy/database.sh snapshot "$legacy" "$backup"
bash deploy/database.sh restore "$backup" /srv/verbatim/barktown/data/barktown.db
```

The tool runs from the production image as your host user, with no network. It verifies integrity and Barktown tables and refuses to overwrite a database or its SQLite sidecars. Keep a copy of the snapshot off the Pi before deployment. SQLite and MinIO are two separate stores: for a coordinated recovery point, pause ingest and other writers while capturing the database and bucket backup. The SQLite file is metadata only and does not include recordings.

## 3. Deploy in Dokploy

1. Create a **Barktown → Production → Docker Compose** service. Use the `enchartme` GitHub provider, repository `barktown-server`, your reviewed branch, and `compose.yaml`. Keep automatic deployment off for the initial cutover. Do not create public Dokploy domains for these containers; keep the host loopback bindings.
2. Paste [the production environment template](../.env.dokploy.production.example) into the Compose **Environment** editor. Set `BARKTOWN_UID` and `BARKTOWN_GID` from `id -u` and `id -g` for the host data owner, and set the actual MinIO bucket and credentials. Use bucket-scoped writer credentials for private API/ingest and read-only credentials for the public API. [Policy examples](minio/) assume the bucket is named `barktown`. Do not paste root MinIO credentials. Preserve any relevant production overrides from the old .env, including recording context and ingest settings, without committing secrets.
3. **Deploy**. All three services share the one SSD directory. Compose refuses to create it implicitly; the services also fail if the database file is missing. The private API checks/migrates the schema before public API and ingest start. Do not scale the ingest service beyond one replica.
4. On the Pi run `bash deploy/check.sh` (defaults to ports 8091 and 8090). In Dokploy check ingest logs for the expected bucket and a successful MinIO connection. Verify one existing public API read, one authenticated-by-tailnet private UI operation, and one normal upload/ingest cycle before calling the cutover done.

### Routing

| Consumer | Target |
|---|---|
| Public API | Cloudflare Tunnel → `http://127.0.0.1:8091`. Preserve the existing public hostname and any Cloudflare route to MinIO. |
| Private API | Named Tailscale Service `svc:barktown-private`, virtual TCP 443 with HTTPS → `http://127.0.0.1:8090`. Approve only the correct service host and grant access only to intended clients; the API has no app-level login. |
| Ingest | No inbound route. It polls the configured MinIO bucket. |

The recommended private base URL is the named Service, currently `https://barktown-private.tail523149.ts.net`. Browser callers that still use the old Pi hostname and Traefik's cross-port redirect can fail CORS; check their configured URL before relying on them. Keep that old redirect separate from the production deployment.

**Re-analyze:** this base image does not bundle Goblin's Python runtime or models. If you need re-analysis in production, provision a container-compatible Goblin runtime plus its models, configure the three `REANALYZE_*` paths in the private API, and run a real re-analysis before retiring the old setup. A host Python virtualenv should not be assumed to work inside the image.

## Redeploy, backup and rollback

- For routine updates: keep the same Dokploy service, data path, bucket and credentials. Snapshot SQLite before deploying schema changes. Select the reviewed branch/revision and click **Deploy**, then repeat the health and ingest checks. A redeploy does not copy or reset the database.
- Make a normal file backup with `bash deploy/database.sh snapshot /srv/verbatim/barktown/data/barktown.db /srv/verbatim/barktown/backups/barktown-YYYYMMDD-HHMMSS.db`, using a new destination name. Copy it off the Pi along with separately backed-up MinIO objects and the deployment secrets/settings stored securely. Test restore into a fresh directory. For identical application/storage state, use a coordinated SQLite and MinIO recovery point.
- To restore on the same host, stop all three containers, restore into a **new** directory, update `BARKTOWN_DATA_DIR`, and deploy. Never replace an active database or copy only the main file from a live SQLite directory.
- If the first cutover fails before accepting any new writes, stop the Dokploy app and restart the old systemd services using their unchanged database. Once the new stack has accepted writes, preserve those writes and coordinate the database and bucket before rolling back. Rolling back only the image is suitable only if the older code is compatible with the current schema.
