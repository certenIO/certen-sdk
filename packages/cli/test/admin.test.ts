import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Round-2 #44: integration tests for `certen admin api-keys rotate|revoke`.
 *
 * We mock the @certen.io/sdk client surface to assert the CLI wires the
 * argument through to the correct SDK method and prints the response
 * payload. We don't spin up a real gateway here — that's owned by the
 * gateway's own integration tests; this layer only validates the CLI
 * binding.
 */
const rotateMock = vi.fn().mockResolvedValue({ id: 'new-key-id', api_key: 'ck_live_NEW' });
const revokeMock = vi.fn().mockResolvedValue({ success: true, message: 'revoked' });
const listMock = vi.fn().mockResolvedValue({ apiKeys: [] });

vi.mock('@certen.io/sdk', () => ({
  CertenClient: class {
    admin = {
      rotateApiKey: rotateMock,
      revokeApiKey: revokeMock,
      listApiKeys: listMock,
      createApiKey: vi.fn(),
      getAuditLog: vi.fn(),
      getUsage: vi.fn(),
    };
  },
}));

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn().mockResolvedValue('ck_test'),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:8090'),
  getOutputFormat: vi.fn().mockReturnValue('json'),
}));

const printSpy = vi.fn();
vi.mock('../src/output.js', () => ({
  printOutput: (...args: unknown[]) => printSpy(...args),
}));

import { Command } from 'commander';
import { registerAdminCommands } from '../src/commands/admin.js';

beforeEach(() => {
  rotateMock.mockClear();
  revokeMock.mockClear();
  printSpy.mockClear();
});

describe('certen admin api-keys rotate', () => {
  it('calls SDK admin.rotateApiKey with the supplied --id and prints the result', async () => {
    const program = new Command();
    program.exitOverride();
    registerAdminCommands(program);
    await program.parseAsync(['node', 'certen', 'admin', 'api-keys', 'rotate', '--id', 'abc-123']);
    expect(rotateMock).toHaveBeenCalledWith('abc-123');
    expect(printSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-key-id', api_key: 'ck_live_NEW' }),
    );
  });
});

describe('certen admin api-keys revoke', () => {
  it('calls SDK admin.revokeApiKey with the supplied --id and prints the result', async () => {
    const program = new Command();
    program.exitOverride();
    registerAdminCommands(program);
    await program.parseAsync(['node', 'certen', 'admin', 'api-keys', 'revoke', '--id', 'def-456']);
    expect(revokeMock).toHaveBeenCalledWith('def-456');
    expect(printSpy).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'revoked' }),
    );
  });
});
