import { AxiosInstance } from 'axios';
import { omitUndefined } from '../internal.js';
import type {
  SignRequestParams,
  SignResponse,
  SubmitSignSignatureResponse,
  SubmitSignSignatureParams,
} from '../types.js';

export class SignResource {
  constructor(private http: AxiosInstance) {}

  async create(params: SignRequestParams): Promise<SignResponse> {
    // Read the per-variant fields through one widened view. Each is optional on at least one
    // member of the union, so reading them off the union directly does not typecheck — and the
    // wire shape is the same for every variant, so there is nothing to branch on.
    const p = params as Extract<SignRequestParams, { type: 'pending_action' }>;
    const { data } = await this.http.post('/v1/sign', omitUndefined({
      type: params.type,
      target_id: params.targetId,
      identity: p.identity,
      signer_url: p.signerUrl,
      vote: p.vote,
      signature: p.signature,
      public_key: p.publicKey,
    }));
    return data;
  }

  async submitSignature(id: string, params: SubmitSignSignatureParams): Promise<SubmitSignSignatureResponse> {
    const { data } = await this.http.post(`/v1/sign/${id}/signature`, {
      signature: params.signature,
      public_key: params.publicKey,
    });
    return data;
  }
}
