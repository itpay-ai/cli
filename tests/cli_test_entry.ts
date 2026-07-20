export {};

const transportValue = process.env.ITPAY_CLI_TEST_TRANSPORT_URL;
if (!transportValue) throw new Error("ITPAY_CLI_TEST_TRANSPORT_URL is required by the CLI test entry");

const transport = new URL(transportValue);
const isLoopback = transport.hostname === "127.0.0.1" || transport.hostname === "localhost" || transport.hostname === "[::1]";
if (
  transport.protocol !== "http:" ||
  !isLoopback ||
  transport.username ||
  transport.password ||
  transport.pathname !== "/" ||
  transport.search ||
  transport.hash
) {
  throw new Error("ITPAY_CLI_TEST_TRANSPORT_URL only accepts an HTTP loopback origin");
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const source = new URL(input instanceof Request ? input.url : String(input));
  if (source.origin !== "https://app.itpay.ai") {
    throw new Error(`CLI attempted a non-production Backend: ${source.origin}`);
  }
  const routed = new URL(source.pathname + source.search, transport);
  return nativeFetch(routed, init);
};

await import("../src/main.js");
