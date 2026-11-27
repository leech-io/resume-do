#!/usr/bin/env bash
# Deploy the independent HTTPS edge; never recreate either application's containers.
set -Eeuo pipefail
umask 077
version=${1:?commit SHA required}
[[ "$version" =~ ^[a-f0-9]{40}$ ]] || exit 1
root=/home/ubuntu/xiachen-public
mkdir -p "$root/releases" "$root/incoming" "$root/xiachen-admin"
# Private extension files stay outside immutable release archives.
if [[ ! -d "$root/extra" ]]; then mkdir -m 755 "$root/extra"; fi
exec 9>"$root/deploy.lock"
flock -w 60 9 || { echo 'Public gateway deployment is busy' >&2; exit 1; }
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then DOCKER=(sudo -n docker); fi
release="$root/releases/$version"
python3 - "$root/incoming/$version.tar.gz" "$release" <<'PY'
import pathlib, sys, tarfile
source, target = sys.argv[1:]
allowed = {'Caddyfile', 'compose.yaml', 'site/index.html', 'site/cost.html'}
with tarfile.open(source, 'r:gz') as archive:
    members = archive.getmembers()
    if len(members) != len(allowed) or {m.name for m in members} != allowed:
        raise SystemExit('Unexpected gateway archive')
    if any(not m.isfile() or m.size > 1024*1024 for m in members):
        raise SystemExit('Unsafe gateway archive')
    base = pathlib.Path(target)
    if base.exists():
        if base.is_symlink() or any(
            not (base / m.name).is_file() or (base / m.name).is_symlink()
            or (base / m.name).read_bytes() != archive.extractfile(m).read()
            for m in members
        ):
            raise SystemExit('Existing gateway release differs; use a fresh commit')
        sys.exit(0)
    base.mkdir(mode=0o755)
    base.chmod(0o755)
    for member in members:
        output = base / member.name
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        output.parent.chmod(0o755)
        output.write_bytes(archive.extractfile(member).read())
        output.chmod(0o644)
PY
# Parent site is read-only; create the nested bind mountpoint before Docker starts.
install -d -m 755 "$release/site/xiachen-admin"
compose() { "${DOCKER[@]}" compose -p xiachen-public -f "$release/compose.yaml" "$@" </dev/null; }
compose config --quiet
curl -fsS --max-time 5 http://127.0.0.1:8080/health >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:8081/api/health >/dev/null
if ! "${DOCKER[@]}" ps --format '{{.Names}}' | grep -qx 'xiachen-public-gateway-1'; then
  # Refuse to steal a port from any existing edge service.
  if sudo -n ss -ltnH | awk '{print $4}' | grep -Eq ':(80|443|2019)$'; then
    echo 'A public gateway port is already in use; inspect before proceeding.' >&2
    exit 1
  fi
fi
compose pull gateway
image=$(compose config --images)
"${DOCKER[@]}" run --rm --network none --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --tmpfs /tmp --tmpfs /data --tmpfs /config \
  -v "$release/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$root/extra:/etc/caddy/extra:ro" "$image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
old=$(readlink -f "$root/current" || true)
rollback() {
  result=$?
  trap - EXIT
  if [[ "$result" != 0 ]]; then
    compose logs --tail 50 gateway >&2 || true
    if [[ -n "$old" && -f "$old/compose.yaml" ]]; then
      "${DOCKER[@]}" compose -p xiachen-public -f "$old/compose.yaml" up -d --no-deps gateway || true
    else
      compose stop gateway || true
    fi
    echo 'Gateway validation failed; application containers and databases were not changed.' >&2
  fi
  exit "$result"
}
trap rollback EXIT
compose up -d --no-deps gateway
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if curl --resolve resume.xiachen.xyz:443:127.0.0.1 -fsS --max-time 3 https://resume.xiachen.xyz/api/health >/dev/null 2>&1 \
    && curl --resolve api.xiachen.xyz:443:127.0.0.1 -fsS --max-time 3 https://api.xiachen.xyz/health >/dev/null 2>&1 \
    && curl --resolve cost.xiachen.xyz:443:127.0.0.1 -fsS --max-time 3 https://cost.xiachen.xyz/health >/dev/null 2>&1 \
    && curl --resolve xiachen.xyz:443:127.0.0.1 -fsS --max-time 3 https://xiachen.xyz/ >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
[[ "$ready" == 1 ]] || { echo 'Public certificates or upstreams are not ready' >&2; exit 1; }
python3 - "$root" "$release" <<'PYLINK'
import os, sys
root, release = sys.argv[1:]
temporary = root + '/current.next'
if os.path.lexists(temporary): os.unlink(temporary)
os.symlink(release, temporary)
os.replace(temporary, root + '/current')
PYLINK
touch "$release/SUCCESS"
trap - EXIT
echo "Public HTTPS gateway deployed: $version"
for host in xiachen.xyz api.xiachen.xyz cost.xiachen.xyz resume.xiachen.xyz; do
  curl --resolve "$host:443:127.0.0.1" -fsS -o /dev/null -w "$host HTTPS %{http_code}\n" "https://$host/"
done
