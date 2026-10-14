// Test-only transport and identity seam. Command parsing, Backend requests,
// authorization ownership, SubmitAction, review checks and PG persistence are real.
import {pathToFileURL} from 'node:url';
const root=process.env.ITPAY_CLI_PACKAGE_ROOT;const target=new URL(process.env.ITPAY_CLI_TEST_TRANSPORT_URL);
if(target.protocol!=='http:'||target.hostname!=='127.0.0.1')throw Error('isolated loopback only');
const {DeviceAuthority}=await import(pathToFileURL(root+'/dist/src/state/device_authority.js'));
DeviceAuthority.prototype.authorizationHeaders=async()=>({'X-Local-Fixture-Owner':'owner'});
const native=fetch;globalThis.fetch=(input,init)=>{const source=new URL(input instanceof Request?input.url:String(input));if(!['https://app.itpay.ai','https://sandbox.itpay.ai'].includes(source.origin))throw Error('unlisted network');return native(new URL(source.pathname+source.search,target),init)};
await import(pathToFileURL(root+'/dist/src/main.js'));
