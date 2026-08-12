import { AxiosInstance } from 'axios';
import type { ChainsListResponse, ChainDetailResponse } from '../types.js';

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
    const { data } = await this.http.get(`/v1/chains/${idOrChainId}`);
    return data;
  }
}
