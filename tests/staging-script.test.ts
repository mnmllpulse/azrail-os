import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/check-staging.mjs');
const source = readFileSync(script, 'utf8').replace(/^import .*;\n/gm, '')
  .replaceAll('export function ', 'function ')
  .replaceAll('import.meta.url', JSON.stringify(new URL('../scripts/check-staging.mjs', import.meta.url).href));
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function selectedConfig() {
  const directory = mkdtempSync(join(tmpdir(), 'azrail-staging-guard-'));
  temporary.push(directory);
  const selected = join(directory, 'selected-staging.toml');
  const config = readFileSync(join(root, 'wrangler.staging.toml'), 'utf8')
    .replaceAll('REPLACE_STAGING_D1_ID', '11111111-1111-4111-8111-111111111111')
    .replaceAll('REPLACE_STAGING_KV_ID', '11111111111111111111111111111111')
    .replaceAll('REPLACE_STAGING_ORIGIN', 'https://azrail-pulse-staging.example.workers.dev')
    .replaceAll('REPLACE_STAGING_OIDC_ISSUER', 'https://identity.example.test/staging')
    .replaceAll('REPLACE_STAGING_OIDC_CLIENT_ID', 'staging-client');
  writeFileSync(selected, config);
  return { selected, config };
}

function run(args: string[]) {
  const messages: string[] = [];
  try {
    runInNewContext(source, { existsSync, readFileSync, resolve, fileURLToPath, URL,
      process: { argv: ['node', script, ...args] }, console: { log(message: string) { messages.push(message); } } });
    return { status: 0, stdout: messages.join('\n'), stderr: '' };
  } catch (error) {
    return { status: 1, stdout: messages.join('\n'), stderr: String(error) };
  }
}

describe('staging guard command selects the deployment config explicitly', () => {
  it('checks the selected config without modifying the committed placeholder template', () => {
    const { selected } = selectedConfig();
    const result = run(['--config', selected]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Config: ${selected}.`);
    const template = run([]);
    expect(template.status).not.toBe(0);
    expect(template.stderr).toContain('replace all REPLACE_');
  });

  it('rejects production resources inside the selected config', () => {
    const { selected, config } = selectedConfig();
    writeFileSync(selected, config.replace('azrail-artifacts-staging', 'azrail-artifacts'));
    const result = run(['--config', selected]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('names must end in -staging');
  });

  it.each([['--config'], ['--env', 'staging'], ['--config', '--remote'], ['--config', 'one.toml', '--config', 'two.toml']])('rejects unsupported or ambiguous arguments %j', (...args) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage:');
  });
});
