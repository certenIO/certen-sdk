import { AxiosInstance } from 'axios';
import type {
  SignRequestParams,
  SignResponse,
  SubmitSignSignatureResponse,
  SubmitSignSignatureParams,
} from '../types.js';

export class SignResource {
  constructor(private http: AxiosInstance) {}

  async create(params: SignRequestParams): Promise<SignResponse> {
    const { data } = await this.http.post('/v1/sign', {
      type: params.type,
      target_id: params.targetId,
      identity: params.identity,
      signer_url: params.signerUrl,
      vote: params.vote,
      signature: params.signature,
      public_key: params.publicKey,
    });
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
