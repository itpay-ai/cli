// Test-only identity injection. Never packaged; real authorization is covered
// separately by the backend device/OAuth suites.
import { DeviceAuthority } from '../src/state/device_authority.js';
DeviceAuthority.prototype.authorizationHeaders = async () => ({'X-ItPay-Test-Actor': process.env.ITPAY_SELL_TEST_ACTOR ?? 'seller'});
await import('./cli_test_entry.js');
