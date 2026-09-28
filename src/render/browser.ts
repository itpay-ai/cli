// Local browser dispatch for `--present browser`. Opens the URL via the OS
// opener with an argv array — never a model-generated shell string. Dispatch
// proves only that the request was accepted by the OS; it never means the
// page became visible (that would be `page_loaded`, which needs evidence).
import { spawn } from "node:child_process";
import { platform } from "node:os";

export type BrowserDispatch =
  | { status: "dispatch_accepted"; argv: string[] }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

// Official HTTPS origins (or the loopback dev origin behind ITPAY_CLI_DEV).
// No userinfo, no non-http(s) schemes, no redirect chains — the opener gets
// exactly this URL once.
export function isPresentableURL(raw: string, baseURL: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (env.ITPAY_CLI_DEV === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.origin)) return true;
  if (url.protocol !== "https:") return false;
  const allowedOrigins = new Set(["https://app.itpay.ai", "https://sandbox.itpay.ai", "https://dev.itpay.ai"]);
  if (baseURL) {
    try {
      allowedOrigins.add(new URL(baseURL).origin);
    } catch {
      /* ignore malformed base URL */
    }
  }
  return allowedOrigins.has(url.origin);
}

export function openInSystemBrowser(raw: string, baseURL: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<BrowserDispatch> {
  if (!isPresentableURL(raw, baseURL, env)) {
    return Promise.resolve({ status: "failed", reason: "url_rejected" });
  }
  const [command, args] = openerArgv(raw);
  if (!command) {
    return Promise.resolve({ status: "unavailable", reason: "no system opener on this platform" });
  }
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", (error) => resolvePromise({ status: "failed", reason: error.message }));
    child.once("spawn", () => {
      child.unref();
      resolvePromise({ status: "dispatch_accepted", argv: [command, ...args] });
    });
  });
}

function openerArgv(url: string): [string | undefined, string[]] {
  switch (platform()) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      return ["cmd.exe", ["/c", "start", "", url]];
    case "linux":
    case "freebsd":
    case "openbsd":
      return ["xdg-open", [url]];
    default:
      return [undefined, []];
  }
}
