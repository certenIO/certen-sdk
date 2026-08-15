import { AxiosInstance } from 'axios';
import type { ReadinessReport } from '../types.js';

/**
 * Is CERTEN able to serve right now?
 *
 * This answers the question that decides where someone should look when things do not work, and
 * getting it wrong sends them somewhere useless. `GET /v1/chains` — which is what `doctor` used to
 * lean on — proves only that the gateway is answering HTTP; it is a static registry read that keeps
 * succeeding while the database, the api-bridge, the proof service or Accumulate are down. So the
 * diagnosis said "gateway reachable: ok" and the user went looking at their own configuration for a
 * fault that was never theirs.
 *
 * The case that matters most is `sponsor_below_floor`. When the onboarding sponsor account runs
 * dry, identity creation still returns 202 and then never completes — the single worst failure mode
 * in onboarding, because every visible signal says it worked. The probe reports it; nothing on the
 * client side could see it.
 *
 * Public: no API key. That is deliberate on the gateway's side, and useful here — it means a
 * caller whose credential is rejected can still find out whether the platform is the problem.
 */
export class HealthResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Whether the gateway can serve, and what is wrong when it cannot.
   *
   * **Does not throw on 503.** A not-ready answer is the answer — it carries the reasons, and
   * turning it into an exception would discard exactly the information worth having. Only a genuine
   * transport failure throws, which is itself the distinct and useful signal that nothing is
   * answering at all.
   */
  async ready(): Promise<ReadinessReport> {
    const { data, status } = await this.http.get('/v1/health/ready', {
      // 503 is a documented outcome of this endpoint, not an error in it.
      validateStatus: (s) => s === 200 || s === 503,
    });
    return {
      ...data,
      ready: status === 200 && data?.status === 'ready',
    };
  }
}
