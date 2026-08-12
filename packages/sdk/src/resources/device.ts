import { AxiosInstance } from 'axios';
import type { DeviceAuthorization, DeviceAuthorizationStatus } from '../types.js';

/**
 * The device authorization grant (RFC 8628), so a terminal can obtain its own API key.
 *
 * Without it, the first credential could only be minted in a browser and carried to a terminal by
 * hand — several steps in another application, and a long-lived secret through a clipboard and
 * usually into shell history.
 *
 * **`start` and `poll` take no API key**, by design: the caller has none yet, which is the entire
 * point. Neither grants anything on its own. A started request belongs to no organization until a
 * signed-in owner or admin approves it in the portal, and the key is minted only when the device
 * collects it — once — using the 256-bit device code, which the gateway stores only as an HMAC.
 *
 * Approval and denial are **not** exposed here. They require a Firebase portal session, which a
 * machine key deliberately cannot substitute for: the gateway answers 401 to an approval attempt
 * carrying `X-API-Key`, so a leaked machine key cannot escalate itself into minting more keys.
 * Putting those calls on this SDK would imply otherwise.
 */
export class DeviceResource {
  constructor(private http: AxiosInstance) {}

  /**
   * Ask for a device code and the short user code a human types into the portal.
   *
   * `deviceName` is shown on the approval screen and becomes the minted key's name, so make it
   * something the approver will recognise as the machine in front of them.
   */
  async start(params: { deviceName?: string } = {}): Promise<DeviceAuthorization> {
    const { data } = await this.http.post('/v1/portal/device', {
      device_name: params.deviceName,
    });
    return data;
  }

  /**
   * Ask whether it has been approved yet, and collect the key when it has.
   *
   * **The key is returned exactly once**, in the first response after approval; later calls report
   * `claimed` and carry nothing. Store it before doing anything else with the result.
   *
   * Poll no faster than the `interval` seconds `start` returned. A `claimed` status on a code this
   * process never collected means someone else did — worth surfacing loudly rather than retrying.
   */
  async poll(deviceCode: string): Promise<DeviceAuthorizationStatus> {
    const { data } = await this.http.get(`/v1/portal/device/${encodeURIComponent(deviceCode)}`);
    return data;
  }
}
