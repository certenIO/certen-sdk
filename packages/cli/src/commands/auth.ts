import { Command } from 'commander';
import { readConfig, writeConfig, setApiKey, clearApiKey, DEFAULT_API_URL } from '../config.js';
import { printOutput, human } from '../output.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication management');

  auth
    .command('login')
    .description('Save API key (OS keyring by default; --no-keyring stores in ~/.certen/config.json with 0600 perms)')
    .requiredOption('--api-key <key>', 'API key to save')
    .option('--api-url <url>', 'API base URL')
    .option('--no-keyring', 'Store in ~/.certen/config.json instead of the OS keyring')
    .action(async (opts: { apiKey: string; apiUrl?: string; keyring: boolean }) => {
      const useKeyring = opts.keyring !== false;
      try {
        await setApiKey(opts.apiKey, useKeyring);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to save API key: ${msg}`);
        process.exit(1);
      }
      if (opts.apiUrl) {
        const cfg = readConfig();
        cfg.api_url = opts.apiUrl;
        writeConfig(cfg);
      }
      human(useKeyring ? 'API key saved to OS keyring' : 'API key saved to ~/.certen/config.json (mode 0600)');
    });

  auth
    .command('logout')
    .description('Remove the saved API key from keyring or config file')
    .action(async () => {
      await clearApiKey();
      human('API key cleared');
    });

  auth
    .command('status')
    .description('Show current authentication config (prefix-only — never reveals the full key)')
    .action(() => {
      const cfg = readConfig();
      // Round-2 #43: when storage=keyring the prefix is persisted at login
      // time, so we can still display "which key is selected" without
      // round-tripping through the OS keyring. The prefix has zero
      // exfiltration risk — it's used as the public lookup field.
      let apiKey: string;
      if (process.env.CERTEN_API_KEY) {
        apiKey = `${process.env.CERTEN_API_KEY.substring(0, 12)}... (from CERTEN_API_KEY env)`;
      } else if (cfg.api_key) {
        apiKey = `${cfg.api_key.substring(0, 12)}...`;
      } else if (cfg.storage === 'keyring' && cfg.key_prefix) {
        apiKey = `${cfg.key_prefix}... (in OS keyring)`;
      } else if (cfg.storage === 'keyring') {
        apiKey = '(in OS keyring; prefix unknown — re-run `certen auth login` to record it)';
      } else {
        apiKey = '(not set)';
      }
      printOutput({
        storage: cfg.storage ?? 'file (default)',
        api_key: apiKey,
        api_url: cfg.api_url ?? `${DEFAULT_API_URL} (default)`,
        output: cfg.output ?? 'table (default)',
      });
    });
}
