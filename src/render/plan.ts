// V3 render plan: the contract between `buy` / `checkout` and the
// per-host renderers. The CLI builds a `RenderPlan` from the canonical
// V3 checkout response, then `selectPlatform` picks the host-specific
// `RenderPlatform` payload. Each renderer is pure: it takes a plan and
// a sink and writes to stdout/stderr. No HTTP, no state mutation.
//
// Mirrors V1's `lib/render-human.js` shape: `kind` is the high-level
// action the buyer needs to take (`auth_qr` or `payment_qr`); `host`
// is the consumer; `links` and `presentation` carry the brand assets.

import type { ClientHost } from "../state/client_context.js";

export type ActionKind = "auth_qr" | "payment_qr" | "checkout_qr";

export interface RenderLink {
  label: string;
  url: string;
}

export interface RenderButton {
  label: string;
  // url buttons vs callback buttons:
  // - url       : simple link the human taps
  // - callback  : in-chat intent the bot can answer in-place
  kind: "url" | "callback";
  // for url:
  url?: string;
  // for callback (translated by the host to its native scheme):
  intent?: string;
  // stable id used by the host to dispatch the callback:
  ref?: string;
}

export interface RenderMedia {
  url: string;
  label?: string;
  alt?: string;
  mimeType?: string;
  localPath?: string;
}

export interface RenderInputField {
  id: string;
  label: string;
  inputType: "text" | "email" | "phone" | "number" | "textarea";
  placeholder?: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface RenderSelectorOption {
  id: string;
  label: string;
  value: string;
  description?: string;
}

export interface RenderInputRequest {
  kind: "input";
  id: string;
  title: string;
  prompt: string;
  fields: RenderInputField[];
  media?: RenderMedia[];
  submitLabel?: string;
}

export interface RenderSelectorRequest {
  kind: "selector";
  id: string;
  title: string;
  prompt: string;
  options: RenderSelectorOption[];
  selectionMode?: "single" | "multiple";
  media?: RenderMedia[];
  submitLabel?: string;
}

export type RenderInteractionRequest = RenderInputRequest | RenderSelectorRequest;

export interface RenderPlatform {
  // free-form text the human sees
  text: string;
  // optional media (photo, image)
  media?: RenderMedia[];
  // ordered list of links the human can tap
  links: RenderLink[];
  // inline buttons (Telegram / Feishu / Lark)
  buttons: RenderButton[];
  // structured blocks the host renders as a native card
  blocks: Array<Record<string, unknown>>;
  // input prompts / selectors that a host adapter may render natively
  interactions?: RenderInteractionRequest[];
  // optional host-native extension (e.g. `openclaw_message` for Telegram)
  extension?: Record<string, unknown>;
}

export interface IdeImageAttach {
  // absolute local path the agent must hand to the IDE image viewer
  localPath: string;
  // additional mirrors under the canonical filename (e.g. `/tmp/...`
  // when the canonical location is `$TMPDIR/...`). Agents may pick
  // whichever path the IDE tooling recognises.
  mirrors: string[];
  mimeType: string;
  // the original URL we downloaded from, for traceability
  source: string;
  // human-readable caption (e.g. "ItPay 品牌支付 QR")
  caption?: string;
  // why this image must be rendered into the IDE chat window
  mustRenderReason: string;
  // download/apply outcome — agents can show failures clearly
  // instead of silently missing the image
  status: "downloaded" | "failed" | "disabled" | "fallback";
  // human-readable reason when status is "failed"
  error?: string;
}

export interface RenderPlan {
  kind: ActionKind;
  host: ClientHost;
  summary: string;
  url: string;
  preferredQRSources: string[];
  mobileWalletURL?: string;
  platform: RenderPlatform;
  paymentIntentID?: string;
  checkoutID?: string;
  // order summary for agent rendering
  orderItems?: { title: string; quantity: number; amountMinor: number; currency: string }[];
  orderCurrency?: string;
  // agent next-step instructions
  afterActionCommand?: string;
  afterActionLabel?: string;
  // payment info
  paymentMethod?: string;
  paymentStatus?: string;
  // brand QR downloaded to a local path the agent can pass to the IDE
  // image viewer (Read tool in Trae) so the human sees it in-chat and
  // can scan it from the IDE window. This is the IDE attachment
  // contract; the URL stays in preferredQRSources for non-IDE hosts.
  ideImageAttach?: IdeImageAttach;
}

// Pick the platform key for a given host. Discord / WhatsApp and
// unrecognised hosts fall back to plain-chat, matching V1.
export function platformKeyForHost(host: ClientHost): "terminal" | "markdown" | "telegram" | "feishu" | "lark" | "plain_chat" {
  switch (host) {
    case "terminal":
      return "terminal";
    case "codex":
    case "claude-code":
      return "markdown";
    case "telegram":
      return "telegram";
    case "feishu":
      return "feishu";
    case "lark":
      return "lark";
    case "discord":
    case "whatsapp":
    case "plain-chat":
    default:
      return "plain_chat";
  }
}
