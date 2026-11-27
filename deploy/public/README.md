# Shared gateway private extensions

The shared Caddyfile imports `/etc/caddy/extra/*.caddy`. Production mounts `/home/ubuntu/xiachen-public/extra` read-only; this directory persists independently of release archives. Empty directories are valid. The production Caddy process runs as root without DAC override capabilities. Private site owners install root-owned files with mode 600 in a root-owned directory with mode 700; the release script never chmods that existing private directory; never commit credentials or password hashes.

The deployment script validates the new release together with the current private extensions before switching the gateway. Keep extension directory mounts during rollbacks to older gateway releases; an older release without the mount/import can remove these routes.

The Nacos site and its operator instructions belong to the xiachen-yishe project (`deploy/nacos/caddy/`). The gateway only provides the extension mechanism. Existing application deployment workflows remain unchanged.
