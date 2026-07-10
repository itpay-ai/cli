// IDE image-attach contract.
//
// The V3 backend serves a brand QR PNG that must end up visible inside
// the IDE chat window (Trae `Read` tool, Codex, Claude Code) because
// the human can only scan it from there. This module is the single
// source of truth for the download → local file → plan.attach flow:
//
//   1. download the brand image from the backend
//   2. write it to one canonical directory + an `/tmp`-style alias
//      when the filesystem permits (covers macOS sandbox which exposes
//      a private $TMPDIR under /var/folders/... but IDE tooling often
//      still probes /tmp first)
//   3. mirror the file under a stable filename per (kind, id) so
//      re-runs from the same checkout land on the same path
//   4. atomic write (write-temp + rename) for crash safety
//   5. format fallback via magic-byte sniffing so SVG / WebP / no-suffix
//      CDN URLs still produce a readable local file
//   6. errors never get swallowed: the plan still gets an attach with
//      `status: "failed"` and a populated `error` field, so JSON
//      callers and renderers can surface the failure instead of
//      silently dropping the image
//   7. the whole feature can be disabled via ITPAY_IDE_IMAGE_ATTACH=0
//      for read-only sandbox runners; in that case `status: "disabled"`
//
// Every renderer + the JSON output consume the same `ideImageAttach`
// field on the plan, so the IDE contract is consistent regardless of
// the host.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { IdeImageAttach, RenderPlan } from "./plan.js";

export type IdeImageStatus = "downloaded" | "failed" | "disabled" | "fallback";

const IDE_ATTACH_REASON =
  "Human cannot scan a remote URL: the IDE chat window is the only " +
  "surface they can pay from. The agent MUST render this PNG into the " +
  "IDE chat (Trae `Read` tool with the localPath or one of the mirrors) " +
  "and wait for the human to confirm they see + scan it. If the image is " +
  "not visible in chat, the checkout is considered failed — re-render " +
  "and ask again, do not mark the order complete.";

export interface DownloadQRResult {
  ok: boolean;
  attach?: IdeImageAttach;
  reason?: string;
}

export interface DownloadQROptions {
  fetchImpl?: typeof fetch;
  baseURL?: string;
  caption?: string;
}

export interface AttachOptions {
  fetchImpl?: typeof fetch;
  baseURL?: string;
  // when false, skip the download and stamp plan with status=disabled
  enabled?: boolean;
}

// Resolve the canonical IDE QR directory. Override via
// ITPAY_IDE_IMAGE_DIR_OVERRIDE; default to `tmpdir()/itpay-v3-qr`.
function canonicalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ITPAY_IDE_IMAGE_DIR_OVERRIDE;
  if (override && override.length > 0) return override;
  return join(tmpdir(), "itpay-v3-qr");
}

// Compute alias directories the file is also mirrored to. Today the
// only alias we care about is `/tmp/itpay-v3-qr` — IDE tooling paths
// are written against that well-known temp dir. We only mirror when
// /tmp is actually a different location from `tmpdir()` and is writable
// or creatable; otherwise we skip silently.
export function resolveIdeImageDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const canonical = canonicalDir(env);
  const dirs: string[] = [canonical];
  if (process.platform === "win32") return dirs;
  const tmps = "/tmp/itpay-v3-qr";
  if (tmps === canonical) return dirs;
  // Best-effort: probe or create the alias dir. If the filesystem
  // refuses, we silently skip (the canonical location is still
  // authoritative).
  try {
    mkdirSync(tmps, { recursive: true });
    dirs.push(tmps);
  } catch {
    /* ignore */
  }
  return dirs;
}

// Stable filename per (kind, id) so re-runs of the same checkout land
// on the same path. The short hash suffix disambiguates IDs that
// happen to share a checkout prefix (e.g. checkout + payment-intent
// for the same id).
function stableNameFor(kind: "checkout" | "payment", id: string): string {
  const safeID = id.replace(/[^a-zA-Z0-9_-]/g, "_") || randomUUID();
  const hash = createHash("sha1").update(`${kind}:${id}`).digest("hex").slice(0, 6);
  return `itpay-v3-${kind}-${safeID}-${hash}`;
}

interface DetectedImage {
  ext: ".png" | ".svg" | ".webp" | ".jpg";
  body: Buffer;
}

async function detectImageFormat(url: string, fetchFn: typeof fetch): Promise<DetectedImage> {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`http=${r.status}`);
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length >= 2 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { ext: ".png", body: buf };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { ext: ".jpg", body: buf };
  }
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF") {
    return { ext: ".webp", body: buf };
  }
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "<svg") {
    return { ext: ".svg", body: buf };
  }
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "<?xml") {
    return { ext: ".svg", body: buf };
  }
  const ct = (r.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("svg+xml") || ct.includes("svg")) return { ext: ".svg", body: buf };
  if (ct.includes("webp")) return { ext: ".webp", body: buf };
  if (ct.includes("jpeg") || ct.includes("jpg")) return { ext: ".jpg", body: buf };
  if (ct.includes("png")) return { ext: ".png", body: buf };
  // last resort — treat as PNG to keep the IDE image viewer happy
  return { ext: ".png", body: buf };
}

function atomicWrite(filePath: string, body: Buffer): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  writeFileSync(tmp, body);
  renameSync(tmp, filePath);
}

function mirrorToDirs(fileName: string, body: Buffer, dirs: string[]): string[] {
  const written: string[] = [];
  for (const dir of dirs.slice(1)) {
    try {
      mkdirSync(dir, { recursive: true });
      const target = join(dir, fileName);
      atomicWrite(target, body);
      written.push(target);
    } catch {
      /* ignore best-effort mirror */
    }
  }
  return written;
}

function mimeFor(ext: DetectedImage["ext"]): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
  }
}

// Resolve the absolute URL the fetcher will hit. Behaviour:
//   - absolute URL → return as-is (or rewrite host if baseURL matches)
//   - scheme-relative URL (`//host/...`) → apply baseURL host
//   - path-only (`/v1/...`) → prefix with baseURL origin
// We can't blindly `new URL(url)` because the input might use a
// scheme that the runtime considers invalid.
function resolveFetchURL(url: string, baseURL: string | undefined): string {
  if (!baseURL) return url;
  if (/^https?:\/\//.test(url)) {
    return url.replace(/^https?:\/\/[^/]+/, baseURL);
  }
  if (url.startsWith("//")) {
    return new URL(url, baseURL).toString();
  }
  if (url.startsWith("/")) {
    try {
      return new URL(url, baseURL).toString();
    } catch {
      return url;
    }
  }
  return url;
}

export async function downloadBrandQRToTmp(
  url: string,
  kind: "checkout" | "payment",
  id: string | undefined,
  options: DownloadQROptions = {},
): Promise<DownloadQRResult> {
  if (!url) {
    return { ok: false, reason: "no qr_png_url on plan" };
  }
  const stem = stableNameFor(kind, id ?? randomUUID());
  const dirs = resolveIdeImageDirs();
  const canonical = dirs[0];
  if (!canonical) {
    return { ok: false, reason: "no IDE image directory resolved" };
  }
  try {
    mkdirSync(canonical, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `mkdir ${canonical} failed: ${(error as Error).message}` };
  }
  const fetchURL = resolveFetchURL(url, options.baseURL);
  try {
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    const detected = await detectImageFormat(fetchURL, fetchFn);
    const fileName = `${stem}${detected.ext}`;
    const filePath = join(canonical, fileName);
    atomicWrite(filePath, detected.body);
    const mirrors = mirrorToDirs(fileName, detected.body, dirs);
    return {
      ok: true,
      attach: {
        localPath: filePath,
        mirrors,
        mimeType: mimeFor(detected.ext),
        source: url,
        status: "downloaded",
        ...(options.caption ? { caption: options.caption } : {}),
        mustRenderReason: IDE_ATTACH_REASON,
      },
    };
  } catch (error) {
    return { ok: false, reason: `brand image fetch failed: ${(error as Error).message}` };
  }
}

export interface ApplyOutcome {
  status: IdeImageStatus;
  paths: string[];
  reason?: string;
}

// Single source of truth for IDE attach bootstrap. Idempotent: if the
// plan already has a non-empty `ideImageAttach`, this is a no-op. When
// `options.enabled === false`, stamp the plan with `status:"disabled"`
// so JSON callers can see the opt-out. When the download fails, the
// plan gets `status:"failed"` plus the error reason — never a silent
// no-op.
export async function ensureIdeImageAttach(
  plan: RenderPlan,
  options: AttachOptions = {},
): Promise<void> {
  if (plan.ideImageAttach) {
    // Honor a previous successful attach: only bail when status is final.
    if (plan.ideImageAttach.status === "downloaded" || plan.ideImageAttach.status === "disabled") {
      return;
    }
  }
  if (options.enabled === false) {
    plan.ideImageAttach = {
      localPath: "",
      mirrors: [],
      mimeType: "image/png",
      source: "",
      status: "disabled",
      mustRenderReason: IDE_ATTACH_REASON,
    };
    return;
  }
  const pngURL = plan.preferredQRSources.find((src) => src.length > 0);
  if (!pngURL) {
    plan.ideImageAttach = {
      localPath: "",
      mirrors: [],
      mimeType: "image/png",
      source: "",
      status: "failed",
      mustRenderReason: IDE_ATTACH_REASON,
    };
    return;
  }
  const kind: "checkout" | "payment" = plan.kind === "payment_qr" ? "payment" : "checkout";
  const id = plan.paymentIntentID ?? plan.checkoutID;
  const caption = plan.kind === "payment_qr" ? "ItPay brand payment QR" : "ItPay checkout QR";
  const result = await downloadBrandQRToTmp(pngURL, kind, id, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    caption,
  });
  if (result.ok && result.attach) {
    plan.ideImageAttach = result.attach;
    return;
  }
  plan.ideImageAttach = {
    localPath: "",
    mirrors: [],
    mimeType: "image/png",
    source: pngURL,
    status: "failed",
    mustRenderReason: IDE_ATTACH_REASON,
    ...(result.reason ? { error: result.reason } : {}),
  };
}

// The mandatory trailing block every renderer must append when an
// ideImageAttach is present. Renderers should call this and emit the
// returned lines verbatim — wording is part of the contract. The image stays
// at the owner-only local path so the host adapter can attach it without
// pushing a large base64 payload through command stdout.
export function ideImageAttachBlock(attach: IdeImageAttach): string[] {
  const lines: string[] = [];
  // Public-path note (some IDEs read this with their file panel).
  if (attach.status === "downloaded" && attach.localPath) {
    lines.push("");
    lines.push("> [ATTACH] IDE image (must render)");
    lines.push(`> canonical: \`${attach.localPath}\``);
    if (attach.mirrors.length > 0) {
      lines.push(`> mirrors:`);
      for (const mirror of attach.mirrors) {
        lines.push(`>   - \`${mirror}\``);
      }
    }
  } else if (attach.status === "failed") {
    lines.push("");
    lines.push("> [ATTACH] IDE image MISSING — render is required but the brand image could not be downloaded");
    if (attach.error) lines.push(`> error: ${attach.error}`);
  } else if (attach.status === "disabled") {
    lines.push("");
    lines.push("> [ATTACH] IDE image attach disabled (ITPAY_IDE_IMAGE_ATTACH=0)");
  } else {
    lines.push("");
    lines.push("> [ATTACH] IDE image (must render)");
  }
  lines.push(`> source: ${attach.source}`);
  lines.push(`> mime:   ${attach.mimeType}`);
  if (attach.caption) lines.push(`> caption: ${attach.caption}`);
  lines.push(`> status: ${attach.status}`);
  lines.push(`> rule:   ${attach.mustRenderReason}`);
  lines.push(
    "> action: agent must read the canonical local path (or any mirror) " +
      "into the IDE chat window and wait for the human to confirm the image is visible. " +
      "If the image does not appear in chat, the checkout is considered failed.",
  );
  return lines;
}

export function readFileAsDataURL(filePath: string, mimeType: string): string | undefined {
  try {
    const buf = readFileSync(filePath);
    return `data:${mimeType};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}
