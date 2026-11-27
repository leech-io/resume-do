#!/usr/bin/env python3
"""Conservative service selection from Git trees, including changes since the last good release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

SERVICES = ('api', 'worker', 'web')


def requires_deployment(path):
    """Classify this event independently of accumulated, not-yet-released changes."""
    # The shared edge has its own workflow and must not release application images.
    # Keep affected()/fingerprints conservative for deployed-baseline compatibility.
    if path.startswith('deploy/public/') or path in (
        'scripts/deploy-public-entry.sh', '.github/workflows/public-entry.yml',
    ):
        return False
    if path.startswith(('docs/', '.idea/', '.qoder/', '.run/', 'scripts/tests/')):
        return False
    if path.lower() in ('readme.md', 'agents.md', '.gitignore'):
        return False
    # These files change CI planning/checks, not the running application.
    if path in ('scripts/plan-release.py', '.github/workflows/ci-cd.yml'):
        return False
    if path.startswith('apps/api/src/test/'):
        return False
    if path.startswith(('apps/', 'packages/')):
        parts = Path(path).parts
        if any(part in ('test', 'tests', '__tests__') for part in parts[:-1]):
            return False
        if re.search(r'\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$', parts[-1]):
            return False
    # Runtime code, dependencies, deployment inputs and unknown paths stay conservative.
    return True


def affected(path):
    # Also used for persisted production fingerprints. Keep its existing semantics:
    # excluding tests here would invalidate older deployed baseline fingerprints.
    if path.startswith('packages/schema/'):
        return set(SERVICES)
    if path in ('apps/web/package.json', 'apps/pdf-worker/package.json'):
        return {'worker', 'web'}
    if path.startswith('apps/api/'):
        return {'api'}
    if path.startswith('apps/web/'):
        return {'web'}
    if path.startswith('apps/pdf-worker/'):
        return {'worker'}
    if path.startswith('packages/'):
        return {'worker', 'web'}
    if path in ('deploy/api.Dockerfile', 'deploy/maven-settings.xml'):
        return {'api'}
    if path in ('deploy/worker.Dockerfile', 'deploy/worker-health.mjs', 'scripts/dev-worker.mjs'):
        return {'worker'}
    if path in ('deploy/web.Dockerfile', 'deploy/nginx.conf', 'scripts/copy-pdf-assets.mjs'):
        return {'web'}
    if path.startswith(('docs/', '.idea/', '.qoder/', '.run/')) or path in ('README.md', 'AGENTS.md', '.gitignore'):
        return set()
    # Lockfiles, workspace manifests, deployment/test helpers and unknown inputs are shared.
    return set(SERVICES)


def tree(ref):
    raw = subprocess.check_output(['git', 'ls-tree', '-r', '-z', ref])
    return {name.decode(): meta.split()[2].decode()
            for entry in raw.split(b'\0') if entry
            for meta, name in [entry.split(b'\t', 1)]}


def fingerprints(files):
    hashes = {s: hashlib.sha256() for s in (*SERVICES, 'migrations')}
    for name, oid in sorted(files.items()):
        targets = affected(name)
        if name.startswith('apps/api/src/main/resources/db/migration/'):
            targets = targets | {'migrations'}
        for service in targets:
            hashes[service].update(f'{name}\0{oid}\n'.encode())
    return {s: h.hexdigest() for s, h in hashes.items()}


def plan(base, head, full=False, event_base=None):
    old, new = (tree(base) if base else {}), tree(head)
    changed = {p for p in old.keys() | new.keys() if old.get(p) != new.get(p)}
    migrations = any(p.startswith('apps/api/src/main/resources/db/migration/') for p in changed)
    selected = set(SERVICES) if full or not base or migrations else set().union(*(affected(p) for p in changed))
    # A docs/test-only push must not retry a previous failed production release.
    # Missing event history fails closed; full=True remains an explicit manual override.
    event_base = base if event_base is None else event_base
    event_old = (old if event_base == base else tree(event_base)) if event_base else {}
    event_changed = {p for p in event_old.keys() | new.keys() if event_old.get(p) != new.get(p)}
    deployment_required = full or bool(event_base) and any(requires_deployment(p) for p in event_changed)
    return {'services': [s for s in SERVICES if s in selected], 'migrations': migrations or not base,
            'deployment_required': deployment_required,
            'docker_validation': full or not base or bool(changed & {
                'deploy/web.Dockerfile', 'deploy/worker.Dockerfile', 'scripts/docker-dependencies.mjs',
                'scripts/package-release.py', '.dockerignore',
            }),
            'fingerprints': fingerprints(new), 'commit': subprocess.check_output(['git', 'rev-parse', head], text=True).strip()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--event-base', default=None,
                        help='Push before SHA or PR merge-base; empty means check-only unless --full')
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = plan(args.base, args.head, args.full, args.event_base)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
            for service in SERVICES:
                print(f'{service}={str(service in result["services"]).lower()}', file=out)
            print('services=' + json.dumps(result['services']), file=out)
            print(f'any={str(bool(result["services"])).lower()}', file=out)
            print(f'deployment_required={str(result["deployment_required"]).lower()}', file=out)
            print(f'integration={str(bool(set(result["services"]) & {"api", "worker"})).lower()}', file=out)
            print(f'docker_validation={str(result["docker_validation"]).lower()}', file=out)
    print(json.dumps(result, indent=2))
