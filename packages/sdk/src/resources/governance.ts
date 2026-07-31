import { AxiosInstance } from 'axios';
import { omitUndefined } from '../internal.js';
import type {
  GovernanceParams,
  CreateGovernanceResponse,
  GovernanceResponse,
  SubmitGovernanceSignatureParams,
  SubmitGovernanceSignatureResponse,
} from '../types.js';

export class GovernanceResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Submit one or more governance operations.
   *
   * This previously sent `{ identity_id, operation_type, payload }` and omitted BOTH fields the API
   * requires (`identity` — the ADI, not a uuid — and `operations`, an array), so every call 400'd.
   */
  async create(params: GovernanceParams): Promise<CreateGovernanceResponse> {
    const { data } = await this.http.post('/v1/governance', omitUndefined({
      identity: params.identity,
      operations: params.operations,
      key_page_url: params.keyPageUrl,
      signer_key_page: params.signerKeyPage,
      signer_public_key: params.signerPublicKey,
    }));
    return data;
  }

  async submitSignature(id: string, params: SubmitGovernanceSignatureParams): Promise<SubmitGovernanceSignatureResponse> {
    const { data } = await this.http.post(`/v1/governance/${id}/signature`, {
      signature: params.signature,
      public_key: params.publicKey,
    });
    return data;
  }

  async get(id: string): Promise<GovernanceResponse> {
    const { data } = await this.http.get(`/v1/governance/${id}`);
    return data;
  }
}
