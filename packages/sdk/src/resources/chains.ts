import { AxiosInstance } from 'axios';
import type { ChainsListResponse, ChainDetailResponse, AddressBalanceResponse } from '../types.js';
import { resolveEnabledChains, defaultEnabledChains, type ChainCatalogueEntry } from '../chains.js';
import { apiPath } from '../internal.js';
import { evmAddressProblem } from '../address.js';
import { CertenError } from '../errors.js';

/**
 * The contract registry: which chains CERTEN is deployed on, and at what addresses.
 *
 * **These two endpoints are public.** They take no API key, by deliberate design on the gateway
 * side — someone deciding whether to build on CERTEN needs to see the on-chain footprint before
 * they have a credential, and an address already published on eight block explorers is not a
 * secret worth gating. Calls made through this resource still carry the client's key header;
 * the gateway simply does not require it.
 *
 * That property is what lets a CLI validate a chain name, or check that the gateway is alive,
 * before the user has logged in to anything.
 */
export class ChainsResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Every network in the registry, with contract addresses and explorer links.
   *
   * `verifiedOnly` filters to networks whose contracts were all confirmed to carry bytecode via
   * `eth_getCode`. Non-EVM entries are transcribed from validator configuration and are never
   * independently verified, so they do not survive that filter — which is the honest behaviour,
   * not an omission.
   */
  async list(params: { family?: string; verifiedOnly?: boolean } = {}): Promise<ChainsListResponse> {
    const { data } = await this.http.get('/v1/chains', {
      params: {
        family: params.family,
        verified_only: params.verifiedOnly,
      },
    });
    return data;
  }

  /**
   * One network, by registry id (`base-sepolia`) or numeric EVM chain id (`84532`).
   *
   * Both spellings are accepted because integrators have whichever one their wallet or RPC config
   * handed them, and making them translate is a step that buys nothing.
   */
  async get(idOrChainId: string | number): Promise<ChainDetailResponse> {
    const { data } = await this.http.get(apiPath`/v1/chains/${idOrChainId}`);
    return data;
  }

  /**
   * The native balance of ANY EVM address on a chain the gateway serves, read through the gateway's own node.
   *
   * **Unlike `list()` and `get()`, this needs an API key.** The gateway reads through its node, so an open version would be an open RPC
   * proxy. The scope is the existing balance-read scope.
   *
   * `balance` is whole units of the native token as a decimal string (`0.25`). `0` is a successful read of an empty account; a node that
   * did not answer is a `BALANCE_UNREADABLE` error, never a zero. A mistyped address is refused here, before any request, with the same
   * `INVALID_ADDRESS` the gateway would give (a mixed-case address whose EIP-55 checksum does not hold names the correct capitalisation).
   * Chains this gateway does not serve answer `UNKNOWN_CHAIN`. Reading through the gateway trusts the gateway's node: for a check that does
   * not, use `readEvmBalance` with a node you chose.
   */
  async balance(idOrChainId: string | number, address: string): Promise<AddressBalanceResponse> {
    const problem = evmAddressProblem(address);
    if (problem) throw new CertenError(`certen: balance: ${problem}`, 0, 'INVALID_ADDRESS');
    const { data } = await this.http.get(apiPath`/v1/chains/${idOrChainId}/addresses/${address}/balance`);
    return data;
  }

  /**
   * The chains to offer: the configured set (default: the catalogue's live chains) narrowed to
   * those the gateway serves right now.
   *
   * This is the runtime authority. The catalogue alone answers offline questions (what a numeric
   * id means, which token is gas), but whether a chain may be USED is decided against the
   * gateway: a chain it does not list, or lists with `enabled: false`, is never returned.
   */
  async enabled(configured: readonly string[] = defaultEnabledChains()): Promise<ChainCatalogueEntry[]> {
    const { chains } = await this.list();
    return resolveEnabledChains(configured, chains);
  }
}
