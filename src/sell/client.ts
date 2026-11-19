import { HttpClient } from '../client/http.js';
import { BackendClient } from '../client/backend.js';
import { DeviceAuthority } from '../state/device_authority.js';
import { CLI_VERSION, type CLIConfig } from '../state/config.js';
import { sellerSessionToken } from './auth.js';
export class SellerClient extends BackendClient {
 constructor(private readonly sellerHTTP:HttpClient){super(sellerHTTP);}
  // Called only through the fixed Sell operation contract, never arbitrary Agent URLs.
  sellRequest(request: {path:string; method:"GET"|"POST"|"PUT"|"DELETE"; body?:unknown}): Promise<unknown> {
    if (!request.path.startsWith("/v1/seller/organizations") && !request.path.startsWith("/v1/library/")) throw new Error("Invalid Sell route");
    return this.sellerHTTP.request(request.path,{method:request.method,...(request.body!==undefined?{body:request.body}:{})});
  }

}
export function newSellerClient(config:CLIConfig):SellerClient {
  const authority = new DeviceAuthority({
    baseURL: config.baseURL,
    ...(config.agentType ? { requestedAgentType: config.agentType } : {}),
    compatibilityHeaders: {
      "X-ItPay-CLI-Version": CLI_VERSION,
    },
  });
  const http = new HttpClient({
    baseURL: config.baseURL,
    defaultHeaders: {
      "X-ItPay-CLI-Version": CLI_VERSION,
    },
    requestAuthorizer: (input) => {
      if (/^\/v1\/(seller\/organizations(?:\/|\?|$)|library\/)/.test(input.path)) {
        const token=config.bearerToken ?? sellerSessionToken(config.baseURL);
        if(!token)throw new Error("Seller login required; run itpay sell auth login");
        return Promise.resolve({Authorization:`Bearer ${token}`});
      }
      return authority.authorizationHeaders(input);
    },
    recoverAuthorization: options => authority.recoverAuthorization(options),
  });
  return new SellerClient(http);
}
