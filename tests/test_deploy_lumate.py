import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', str(Path(__file__).resolve().parents[1] / 'scripts/deploy_lumate.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'deploy').mkdir()
        (self.root / 'deploy/.env.production.example').write_text(
            'CSRF_SECRET_KEY=replace-with-example\nAUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nENCRYPTION_KEY=replace-with-example\nCORS_ORIGINS=http://localhost:3003\nLLM_PROVIDER=deepseek\nLLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=\n')
        self.calls = []
        self.fail_stage = None
        self.cwd = Path.cwd()
        self.config = {
            'networks': {'default': {'name': 'lumate-customized-network'}},
            'services': {s: {'container_name': 'lumate-customized-' + s} for s in ('api', 'web', 'redis')},
            'volumes': {'lumate_customized_' + s: {'name': 'lumate-customized_' + s} for s in ('data', 'uploads', 'redis')},
        }

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_mock(self, args, **kwargs):
        self.calls.append(args)
        if self.fail_stage and self.fail_stage in args:
            raise subprocess.CalledProcessError(1, args)
        if '--format' in args:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.config), '')
        if 'inspect' in args:
            states = [{'State': {'Health': {'Status': 'healthy'}}}] * 3
            return subprocess.CompletedProcess(args, 0, json.dumps(states), '')
        return subprocess.CompletedProcess(args, 0, '', '')

    def execute(self, env_file=None):
        argv = ['deploy'] + (['--env-file', str(env_file)] if env_file else [])
        with patch.object(deploy, 'ROOT', self.root), patch.object(deploy, 'PROD', self.root / 'deploy/.env.production'), \
             patch.object(deploy, 'inspect_api', return_value=None), patch.object(deploy, 'run', side_effect=self.run_mock), \
             patch('builtins.input', return_value='https://learn.example.com'), patch.object(deploy.getpass, 'getpass', return_value='test-key'), \
             patch.object(deploy.sys, 'argv', argv), patch.object(deploy.sys.stdin, 'isatty', return_value=True), patch.dict(os.environ):
            deploy.main()

    def test_fresh_deployment_and_repeat_preserves_secrets(self):
        self.execute()
        prod = self.root / 'deploy/.env.production'
        first = deploy.read_env(prod.read_text())
        self.assertEqual(prod.stat().st_mode & 0o777, 0o600)
        self.execute()
        second = deploy.read_env(prod.read_text())
        for key in ('CSRF_SECRET_KEY', 'ENCRYPTION_KEY', 'DEEPSEEK_API_KEY'):
            self.assertEqual(first[key], second[key])
        self.assertEqual(first['AUTH_ENABLED'], 'false')
        stages = [s for call in self.calls[:8] for s in call if s in ('build', 'run', 'up')]
        self.assertEqual(stages, ['build', 'run', 'up'])

    def test_legacy_empty_keys_and_duplicate_entries(self):
        (self.root / '.env').write_text('JWT_SECRET_KEY=' + 'a'*40 + '\nENCRYPTION_KEY=\nENCRYPTION_KEY=""\nCORS_ORIGINS=https://learn.example.com\nLLM_PROVIDER=deepseek\nLLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=test-key\n')
        self.execute()
        text = (self.root / 'deploy/.env.production').read_text()
        self.assertEqual(text.count('ENCRYPTION_KEY='), 1)
        self.assertEqual(deploy.read_env(text)['CSRF_SECRET_KEY'], 'a'*40)

    def test_short_legacy_jwt_is_replaced_by_persistent_csrf_key(self):
        (self.root / '.env').write_text('JWT_SECRET_KEY=short\nCORS_ORIGINS=https://learn.example.com\n')
        self.execute()
        prod = self.root / 'deploy/.env.production'
        first = deploy.read_env(prod.read_text())['CSRF_SECRET_KEY']
        self.assertEqual(len(first), 64)
        self.execute()
        self.assertEqual(deploy.read_env(prod.read_text())['CSRF_SECRET_KEY'], first)
        self.assertTrue(any('up' in c for c in self.calls))

    def test_existing_signing_key_recovery(self):
        valid = 'a' * 64
        self.assertEqual(deploy.choose_csrf('short', valid), valid)
        self.assertEqual(deploy.choose_csrf(valid, 'short'), valid)
        self.assertEqual(len(deploy.choose_csrf('short', 'also-short')), 64)
        with self.assertRaises(ValueError):
            deploy.choose_csrf(valid, 'b' * 64)

    def test_explicit_env_file_is_used_for_profile(self):
        profile = self.root / 'deploy/.env.staging'
        profile.write_text('AUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nCORS_ORIGINS=https://stage.example.com\n')
        self.execute(env_file='deploy/.env.staging')
        self.assertTrue(profile.exists())
        self.assertFalse((self.root / 'deploy/.env.production').exists())
        self.assertEqual(deploy.read_env(profile.read_text())['AUTH_ENABLED'], 'false')
        self.assertTrue(any('deploy/.env.staging' in str(arg) for call in self.calls for arg in call))

    def test_jwt_profile_requires_its_own_key(self):
        (self.root / '.env').write_text('AUTH_ENABLED=true\nDEPLOYMENT_MODE=multi_user\nCORS_ORIGINS=https://learn.example.com\n')
        with self.assertRaisesRegex(ValueError, 'JWT_SECRET_KEY'):
            self.execute()
        self.assertFalse(any('build' in c for c in self.calls))

    def test_invalid_environment_name_stops_before_build(self):
        (self.root / '.env').write_text('APP_ENVIRONMENT=prodution\nCORS_ORIGINS=https://learn.example.com\n')
        with self.assertRaisesRegex(ValueError, 'APP_ENVIRONMENT'):
            self.execute()
        self.assertFalse(any('build' in c for c in self.calls))

    def test_invalid_existing_encryption_key_still_stops_before_build(self):
        (self.root / '.env').write_text('JWT_SECRET_KEY=short\nENCRYPTION_KEY=invalid\nCORS_ORIGINS=https://learn.example.com\n')
        with self.assertRaises(ValueError):
            self.execute()
        self.assertFalse(any('build' in c for c in self.calls))

    def test_build_failure_does_not_start_services(self):
        self.fail_stage = 'build'
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute()
        self.assertFalse(any('up' in c for c in self.calls))

    def test_llm_failure_does_not_start_services(self):
        self.fail_stage = 'run'
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute()
        self.assertFalse(any('up' in c for c in self.calls))

    def test_foreign_volume_stops_before_build(self):
        self.config['volumes']['lumate_customized_data']['name'] = 'opentutor-data'
        with self.assertRaises(ValueError):
            self.execute()
        self.assertFalse(any('build' in c for c in self.calls))


if __name__ == '__main__':
    unittest.main()
