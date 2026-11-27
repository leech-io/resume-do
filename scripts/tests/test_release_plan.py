"""Exercise actual Git histories: additions, deletions and accumulated failed releases."""
import importlib.util
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('planner', Path(__file__).resolve().parents[1] / 'plan-release.py')
planner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(planner)


class ReleasePlanTests(unittest.TestCase):
    def test_gateway_only_push_does_not_release_application_services(self):
        with self.history() as (git, commit):
            base = commit('apps/api/src/main/App.java', 'production')
            for path in ('deploy/public/Caddyfile', 'deploy/public/compose.yaml',
                         'scripts/deploy-public-entry.sh', '.github/workflows/public-entry.yml'):
                head = commit(path, 'independent gateway change')
            result = planner.plan(base, head, event_base=base)
            self.assertFalse(result['deployment_required'])
            self.assertFalse(result['migrations'])

    def test_gateway_push_does_not_retry_unpublished_application_code(self):
        with self.history() as (git, commit):
            deployed = commit('apps/web/src/App.tsx', 'deployed')
            unpublished = commit('apps/web/src/App.tsx', 'previous failed release')
            head = commit('deploy/public/Caddyfile', 'independent gateway change')
            result = planner.plan(deployed, head, event_base=unpublished)
            self.assertIn('web', result['services'])
            self.assertFalse(result['deployment_required'])
            runtime = commit('apps/api/src/main/App.java', 'business code')
            self.assertTrue(planner.plan(deployed, runtime, event_base=head)['deployment_required'])

    def test_deploy_condition_allows_intentionally_skipped_ancestors(self):
        # GitHub otherwise injects success(), which propagates the skipped integration
        # ancestor even though the always() aggregate check itself succeeds.
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/ci-cd.yml').read_text()
        condition = workflow.split('  deploy:', 1)[1].split('    runs-on:', 1)[0]
        self.assertIn('!cancelled()', condition)
        self.assertIn("needs.checks.result == 'success'", condition)
        self.assertIn("needs.plan.outputs.any == 'true'", condition)
        self.assertIn("needs.plan.outputs.deployment_required == 'true'", condition)

    def test_check_only_paths_keep_checks_but_do_not_require_deployment(self):
        for path, checks in {
            'apps/api/src/test/java/com/resumedo/importing/ImportMapperTest.java': {'api'},
            'apps/api/src/test/resources/sample.json': {'api'},
            'apps/web/tests/fixtures/original.pdf': {'web'},
            'apps/pdf-worker/src/renderer.test.ts': {'worker'},
            'packages/templates/src/index.test.ts': {'worker', 'web'},
            'packages/schema/src/index.test.ts': set(planner.SERVICES),
            'packages/schema/__tests__/schema.spec.ts': set(planner.SERVICES),
            'docs/ops/redaction.md': set(),
            'README.MD': set(planner.SERVICES),
            'scripts/tests/test_release_plan.py': set(planner.SERVICES),
            'scripts/plan-release.py': set(planner.SERVICES),
            '.github/workflows/ci-cd.yml': set(planner.SERVICES),
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.affected(path), checks)
                self.assertFalse(planner.requires_deployment(path))
        for path in (
            'apps/api/src/main/App.java', 'packages/templates/src/blocks.ts',
            'apps/web/src/fixtures/products.json', 'deploy/compose.cloud.yaml',
            'package-lock.json', 'scripts/deploy-cloud.sh', 'unknown-input.txt',
        ):
            with self.subTest(path=path):
                self.assertTrue(planner.requires_deployment(path))

    @contextmanager
    def history(self):
        with tempfile.TemporaryDirectory() as scratch, patch.dict(os.environ, {
            'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
            'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid',
        }):
            cwd = os.getcwd()
            os.chdir(scratch)
            try:
                def git(*args):
                    return subprocess.check_output(['git', *args], text=True).strip()
                def commit(path, value):
                    target = Path(path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(value)
                    git('add', '.')
                    git('commit', '-qm', 'test')
                    return git('rev-parse', 'HEAD')
                git('init', '-q')
                yield git, commit
            finally:
                os.chdir(cwd)

    def test_test_data_and_docs_run_checks_without_deployment(self):
        with self.history() as (git, commit):
            base = commit('apps/api/src/main/App.java', 'production')
            commit('apps/api/src/test/java/ImportMapperTest.java', 'synthetic contact')
            commit('packages/templates/src/index.test.ts', 'synthetic contact')
            head = commit('docs/ops/redaction.md', 'redacted')
            result = planner.plan(base, head, event_base=base)
            self.assertEqual(result['services'], list(planner.SERVICES))
            self.assertFalse(result['deployment_required'])
            self.assertFalse(result['migrations'])
            # Keep the production-baseline fingerprint format backwards compatible.
            self.assertNotEqual(planner.fingerprints(planner.tree(base)), result['fingerprints'])

    def test_docs_push_does_not_release_accumulated_unpublished_code(self):
        with self.history() as (git, commit):
            deployed = commit('apps/web/src/App.tsx', 'deployed')
            unpublished = commit('apps/web/src/App.tsx', 'previous failed release')
            head = commit('docs/ops/redaction.md', 'documentation only push')
            result = planner.plan(deployed, head, event_base=unpublished)
            self.assertEqual(result['services'], ['web'])
            self.assertFalse(result['deployment_required'])
            next_head = commit('apps/api/src/main/App.java', 'new production change')
            result = planner.plan(deployed, next_head, event_base=head)
            self.assertEqual(result['services'], ['api', 'web'])
            self.assertTrue(result['deployment_required'])

    def test_no_deployed_baseline_still_does_not_publish_a_test_only_push(self):
        with self.history() as (git, commit):
            before = commit('apps/api/src/main/App.java', 'production')
            head = commit('apps/api/src/test/java/AppTest.java', 'new assertion')
            result = planner.plan('', head, event_base=before)
            self.assertEqual(result['services'], list(planner.SERVICES))
            self.assertFalse(result['deployment_required'])

    def test_missing_event_base_is_check_only_unless_full_is_explicit(self):
        with self.history() as (git, commit):
            head = commit('apps/api/src/main/App.java', 'production')
            self.assertFalse(planner.plan('', head, event_base='')['deployment_required'])
            self.assertTrue(planner.plan('', head, full=True, event_base='')['deployment_required'])

    def test_deleted_fixture_and_readme_only_do_not_deploy(self):
        with self.history() as (git, commit):
            base = commit('apps/web/tests/fixtures/sample.json', 'synthetic')
            git('rm', 'apps/web/tests/fixtures/sample.json')
            head = commit('README.MD', 'documentation')
            result = planner.plan(base, head, event_base=base)
            self.assertFalse(result['deployment_required'])

    def test_runtime_changes_mixed_with_tests_and_migrations_still_deploy(self):
        with self.history() as (git, commit):
            base = commit('packages/templates/src/blocks.ts', 'original')
            commit('packages/templates/src/index.test.ts', 'test')
            head = commit('packages/templates/src/blocks.ts', 'production fix')
            result = planner.plan(base, head, event_base=base)
            self.assertEqual(result['services'], ['worker', 'web'])
            self.assertTrue(result['deployment_required'])
            before_migration = head
            head = commit('apps/api/src/main/resources/db/migration/V9.sql', 'ALTER TABLE x ADD y INT;')
            result = planner.plan(base, head, event_base=before_migration)
            self.assertTrue(result['migrations'])
            self.assertTrue(result['deployment_required'])
            self.assertEqual(result['services'], list(planner.SERVICES))

    def test_service_boundaries(self):
        for path, services in {
            'apps/web/src/App.tsx': {'web'},
            'apps/api/src/main/App.java': {'api'},
            'apps/pdf-worker/src/db.ts': {'worker'},
            'packages/templates/src/index.ts': {'web', 'worker'},
            'packages/schema/src/index.ts': set(planner.SERVICES),
            'package-lock.json': set(planner.SERVICES),
            'deploy/compose.cloud.yaml': set(planner.SERVICES),
            'README.md': set(),
            'AGENTS.md': set(),
        }.items():
            self.assertEqual(planner.affected(path), services, path)

    def test_accumulated_changes_deletion_and_migrations(self):
        with tempfile.TemporaryDirectory() as scratch, patch.dict(os.environ, {
            'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
            'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid',
        }):
            cwd = os.getcwd()
            os.chdir(scratch)
            try:
                def git(*args):
                    return subprocess.check_output(['git', *args], text=True).strip()
                git('init', '-q')
                def commit(path, value):
                    target = Path(path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(value)
                    git('add', '.')
                    git('commit', '-qm', 'test')
                    return git('rev-parse', 'HEAD')
                first = commit('apps/api/App.java', 'first')
                second = commit('apps/web/App.tsx', 'web')
                third = commit('apps/pdf-worker/db.ts', 'worker')
                self.assertEqual(planner.plan(first, third)['services'], ['worker', 'web'])
                self.assertFalse(planner.plan(first, third)['docker_validation'])
                self.assertEqual(planner.plan(second, third)['services'], ['worker'])
                git('rm', 'apps/web/App.tsx')
                git('commit', '-qm', 'delete')
                self.assertEqual(planner.plan(third, 'HEAD')['services'], ['web'])
                before = git('rev-parse', 'HEAD')
                commit('apps/api/src/main/resources/db/migration/V9.sql', 'ALTER TABLE x ADD y INT;')
                self.assertEqual(set(planner.plan(before, 'HEAD')['services']), set(planner.SERVICES))
                self.assertTrue(planner.plan(before, 'HEAD')['migrations'])
                self.assertEqual(set(planner.plan(before, 'HEAD', full=True)['services']), set(planner.SERVICES))
                before_docker = git('rev-parse', 'HEAD')
                commit('deploy/worker.Dockerfile', 'FROM node:22-bookworm-slim')
                self.assertTrue(planner.plan(before_docker, 'HEAD')['docker_validation'])
            finally:
                os.chdir(cwd)
