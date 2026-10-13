import importlib.util
import base64
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
        (self.root / 'deploy/.env.development.example').write_text(
            'APP_ENVIRONMENT=development\nCSRF_SECRET_KEY=replace-with-example\nAUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nENCRYPTION_KEY=replace-with-example\nCORS_ORIGINS=http://localhost:3003\nLLM_PROVIDER=deepseek\nLLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=\n')
        (self.root / 'deploy/.env.production.example').write_text(
            'APP_ENVIRONMENT=production\nCSRF_SECRET_KEY=replace-with-example\nAUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nENCRYPTION_KEY=replace-with-example\nCORS_ORIGINS=http://localhost:3003\nLLM_PROVIDER=deepseek\nLLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=\n')
        self.calls = []
        self.call_kwargs = []
        self.fail_stage = None
        self.corrupt_config_key = False
        self.runtime_environment = 'development'
        self.runtime_auth_enabled = 'false'
        self.runtime_deployment_mode = 'single_user'
        self.cwd = Path.cwd()
        self.config = {
            'networks': {'default': {'name': 'lumate-customized-network'}},
            'services': {s: {'container_name': 'lumate-customized-' + s} for s in ('api', 'web', 'redis')},
            'volumes': {'lumate_customized_' + s: {'name': 'lumate-customized_' + s} for s in ('data', 'uploads', 'redis')},
        }
        self.config['services']['api']['environment'] = {
            'ENVIRONMENT': 'development', 'AUTH_ENABLED': 'false', 'DEPLOYMENT_MODE': 'single_user'}

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_mock(self, args, **kwargs):
        self.calls.append(args)
        self.call_kwargs.append(kwargs)
        if self.fail_stage and self.fail_stage in args:
            raise subprocess.CalledProcessError(1, args)
        if '--format' in args:
            profile = Path(args[args.index('--env-file') + 1])
            values = deploy.read_env(profile.read_text())
            actual = self.config['services']['api']['environment']
            actual['LLM_PROVIDER'] = values['LLM_PROVIDER']
            actual['LLM_MODEL'] = values['LLM_MODEL']
            key_name = deploy.KEYS[values['LLM_PROVIDER']]
            actual[key_name] = 'wrong-key' if self.corrupt_config_key else values[key_name]
            return subprocess.CompletedProcess(args, 0, json.dumps(self.config), '')
        if 'inspect' in args:
            states = [{'State': {'Health': {'Status': 'healthy'}}, 'Config': {'Env': [
                'ENVIRONMENT=' + self.runtime_environment,
                'AUTH_ENABLED=' + self.runtime_auth_enabled,
                'DEPLOYMENT_MODE=' + self.runtime_deployment_mode]}}] * 3
            return subprocess.CompletedProcess(args, 0, json.dumps(states), '')
        return subprocess.CompletedProcess(args, 0, '', '')

    def execute(self, env_file=None, *, existing=None, volume_exists=False):
        argv = ['deploy'] + (['--env-file', str(env_file)] if env_file else [])
        with patch.object(deploy, 'ROOT', self.root), patch.object(deploy, 'DEFAULT_ENV', self.root / 'deploy/.env.development'), \
             patch.object(deploy, 'inspect_api', return_value=existing), patch.object(deploy, 'data_volume_exists', return_value=volume_exists), \
             patch.object(deploy, 'run', side_effect=self.run_mock), \
             patch('builtins.input', return_value='https://learn.example.com'), patch.object(deploy.getpass, 'getpass', return_value='test-key'), \
             patch.object(deploy.sys, 'argv', argv), patch.object(deploy.sys.stdin, 'isatty', return_value=True), patch.dict(os.environ):
            deploy.main()

    def test_container_lookup_does_not_match_same_named_image(self):
        result = subprocess.CompletedProcess([], 1, '', 'No such container')
        with patch.object(deploy.subprocess, 'run', return_value=result) as run:
            self.assertIsNone(deploy.inspect_api())
        self.assertEqual(run.call_args.args[0],
                         ['docker', 'container', 'inspect', 'lumate-customized-api'])

    def test_deleted_container_recovers_keys_from_previous_profile(self):
        encryption_key = base64.urlsafe_b64encode(b'a' * 32).decode()
        (self.root / 'deploy/.env.production').write_text(
            'APP_ENVIRONMENT=production\nCSRF_SECRET_KEY=' + 'c' * 64 +
            '\nENCRYPTION_KEY=' + encryption_key +
            '\nCORS_ORIGINS=https://learn.example.com\nLLM_PROVIDER=deepseek\n'
            'LLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=existing-key\n')
        self.execute(volume_exists=True)
        profile = deploy.read_env((self.root / 'deploy/.env.development').read_text())
        self.assertEqual(profile['ENCRYPTION_KEY'], encryption_key)
        self.assertEqual(profile['CSRF_SECRET_KEY'], 'c' * 64)
        self.assertEqual(profile['DEEPSEEK_API_KEY'], 'existing-key')
        self.assertEqual(profile['CORS_ORIGINS'], 'https://learn.example.com')
        self.assertTrue(any('up' in call for call in self.calls))

    def test_deleted_container_with_data_but_no_key_stops_safely(self):
        with self.assertRaisesRegex(ValueError, 'data volume exists but no ENCRYPTION_KEY'):
            self.execute(volume_exists=True)
        self.assertFalse(any('build' in call for call in self.calls))

    def test_existing_stopped_container_updates_in_place(self):
        encryption_key = base64.urlsafe_b64encode(b'b' * 32).decode()
        existing = {
            'Config': {'Env': [
                'CSRF_SECRET_KEY=' + 'd' * 64,
                'ENCRYPTION_KEY=' + encryption_key,
                'CORS_ORIGINS=https://learn.example.com',
                'DEEPSEEK_API_KEY=existing-key',
            ]},
            'State': {'Running': False},
        }
        self.execute(existing=existing, volume_exists=True)
        profile = deploy.read_env((self.root / 'deploy/.env.development').read_text())
        self.assertEqual(profile['ENCRYPTION_KEY'], encryption_key)
        self.assertEqual(profile['CSRF_SECRET_KEY'], 'd' * 64)
        self.assertTrue(any('up' in call for call in self.calls))

    def test_fresh_deployment_and_repeat_preserves_secrets(self):
        self.execute()
        profile = self.root / 'deploy/.env.development'
        first = deploy.read_env(profile.read_text())
        self.assertEqual(profile.stat().st_mode & 0o777, 0o600)
        self.execute()
        second = deploy.read_env(profile.read_text())
        for key in ('CSRF_SECRET_KEY', 'ENCRYPTION_KEY', 'DEEPSEEK_API_KEY'):
            self.assertEqual(first[key], second[key])
        self.assertEqual(first['AUTH_ENABLED'], 'false')
        self.assertEqual(first['DEPLOYMENT_MODE'], 'single_user')
        self.assertEqual(first['APP_ENVIRONMENT'], 'development')
        stages = [s for call in self.calls[:8] for s in call if s in ('build', 'run', 'up')]
        self.assertEqual(stages, ['build', 'run', 'up'])
        preflight = [(call, kwargs) for call, kwargs in zip(self.calls, self.call_kwargs) if 'run' in call]
        self.assertEqual(len(preflight), 2)
        for call, kwargs in preflight:
            self.assertEqual(call[-4:], ['python', '-m', 'services.llm.deployment_preflight',
                                         '--require-development-single-user'])
            self.assertNotIn('data', kwargs)

    def test_legacy_empty_keys_and_duplicate_entries(self):
        (self.root / 'deploy/.env.development.example').write_text('APP_ENVIRONMENT=development\nAUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nJWT_SECRET_KEY=' + 'a'*40 + '\nENCRYPTION_KEY=\nENCRYPTION_KEY=""\nCORS_ORIGINS=https://learn.example.com\nLLM_PROVIDER=deepseek\nLLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=test-key\n')
        self.execute()
        text = (self.root / 'deploy/.env.development').read_text()
        self.assertEqual(text.count('ENCRYPTION_KEY='), 1)
        self.assertEqual(deploy.read_env(text)['CSRF_SECRET_KEY'], 'a'*40)

    def test_short_legacy_jwt_is_replaced_by_persistent_csrf_key(self):
        (self.root / 'deploy/.env.development.example').write_text('APP_ENVIRONMENT=development\nAUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nJWT_SECRET_KEY=short\nCORS_ORIGINS=https://learn.example.com\n')
        self.execute()
        profile = self.root / 'deploy/.env.development'
        first = deploy.read_env(profile.read_text())['CSRF_SECRET_KEY']
        self.assertEqual(len(first), 64)
        self.execute()
        self.assertEqual(deploy.read_env(profile.read_text())['CSRF_SECRET_KEY'], first)
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

    def test_explicit_production_profile_remains_available(self):
        self.execute(env_file='deploy/.env.production')
        profile = deploy.read_env((self.root / 'deploy/.env.production').read_text())
        self.assertEqual(profile['APP_ENVIRONMENT'], 'production')
        self.assertFalse((self.root / 'deploy/.env.development').exists())

    def test_development_profile_normalizes_auth_and_environment_drift(self):
        (self.root / 'deploy/.env.development').write_text(
            'APP_ENVIRONMENT=production\nAUTH_ENABLED=true\nDEPLOYMENT_MODE=multi_user\n'
            'CORS_ORIGINS=https://learn.example.com\n')
        self.execute()
        profile = deploy.read_env((self.root / 'deploy/.env.development').read_text())
        self.assertEqual(profile['APP_ENVIRONMENT'], 'development')
        self.assertEqual(profile['AUTH_ENABLED'], 'false')
        self.assertEqual(profile['DEPLOYMENT_MODE'], 'single_user')
        backups = list((self.root / 'deploy').glob('.env.development.backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertIn('APP_ENVIRONMENT=production', backups[0].read_text())
        self.assertTrue(any('up' in call for call in self.calls))

    def test_wrong_composed_environment_stops_before_build(self):
        self.config['services']['api']['environment']['ENVIRONMENT'] = 'production'
        with self.assertRaisesRegex(ValueError, 'ENVIRONMENT=development'):
            self.execute()
        self.assertFalse(any('build' in call for call in self.calls))

    def test_wrong_composed_api_key_stops_before_build(self):
        self.corrupt_config_key = True
        with self.assertRaisesRegex(ValueError, 'LLM settings differ'):
            self.execute()
        self.assertFalse(any('build' in call for call in self.calls))

    def test_running_container_must_confirm_development_environment(self):
        self.runtime_environment = 'production'
        with self.assertRaisesRegex(ValueError, 'Running API container does not have ENVIRONMENT=development'):
            self.execute()

    def test_running_container_must_confirm_single_user_auth(self):
        self.runtime_auth_enabled = 'true'
        with self.assertRaisesRegex(ValueError, 'Running API container does not have AUTH_ENABLED=false'):
            self.execute()

    def test_running_container_must_confirm_single_user_mode(self):
        self.runtime_deployment_mode = 'multi_user'
        with self.assertRaisesRegex(ValueError, 'Running API container does not have DEPLOYMENT_MODE=single_user'):
            self.execute()

    def test_default_profile_does_not_inherit_local_env(self):
        (self.root / '.env').write_text(
            'APP_ENVIRONMENT=production\nAUTH_ENABLED=true\nDEPLOYMENT_MODE=multi_user\n')
        self.execute()
        profile = deploy.read_env((self.root / 'deploy/.env.development').read_text())
        self.assertEqual(profile['APP_ENVIRONMENT'], 'development')
        self.assertEqual(profile['AUTH_ENABLED'], 'false')

    def test_missing_custom_profile_must_be_created_first(self):
        with self.assertRaisesRegex(ValueError, 'does not exist'):
            self.execute(env_file='deploy/.env.staging')
        self.assertFalse(any('build' in c for c in self.calls))

    def test_jwt_profile_requires_its_own_key(self):
        profile = self.root / 'deploy/.env.staging'
        profile.write_text('AUTH_ENABLED=true\nDEPLOYMENT_MODE=multi_user\nCORS_ORIGINS=https://learn.example.com\n')
        with self.assertRaisesRegex(ValueError, 'JWT_SECRET_KEY'):
            self.execute(env_file='deploy/.env.staging')
        self.assertFalse(any('build' in c for c in self.calls))

    def test_invalid_environment_name_stops_before_build(self):
        profile = self.root / 'deploy/.env.staging'
        profile.write_text('APP_ENVIRONMENT=prodution\nCORS_ORIGINS=https://learn.example.com\n')
        with self.assertRaisesRegex(ValueError, 'APP_ENVIRONMENT'):
            self.execute(env_file='deploy/.env.staging')
        self.assertFalse(any('build' in c for c in self.calls))

    def test_invalid_existing_encryption_key_still_stops_before_build(self):
        (self.root / 'deploy/.env.development.example').write_text('APP_ENVIRONMENT=development\nAUTH_ENABLED=false\nDEPLOYMENT_MODE=single_user\nJWT_SECRET_KEY=short\nENCRYPTION_KEY=invalid\nCORS_ORIGINS=https://learn.example.com\n')
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
        with self.assertRaisesRegex(ValueError, 'API preflight container failed after image build'):
            self.execute()
        self.assertFalse(any('up' in c for c in self.calls))

    def test_llm_probe_reports_only_sanitized_diagnostic(self):
        original = self.run_mock

        def failed_probe(args, **kwargs):
            if 'run' in args:
                raise subprocess.CalledProcessError(
                    1, args, stderr='LLM test failed: ConnectError; check key, quota, model and outbound network.\nsecret-key-value')
            return original(args, **kwargs)

        with patch.object(self, 'run_mock', side_effect=failed_probe):
            with self.assertRaisesRegex(ValueError, 'LLM test failed: ConnectError') as caught:
                self.execute()
        self.assertNotIn('secret-key-value', str(caught.exception))
        self.assertFalse(any('up' in c for c in self.calls))

    def test_foreign_volume_stops_before_build(self):
        self.config['volumes']['lumate_customized_data']['name'] = 'opentutor-data'
        with self.assertRaises(ValueError):
            self.execute()
        self.assertFalse(any('build' in c for c in self.calls))


if __name__ == '__main__':
    unittest.main()
