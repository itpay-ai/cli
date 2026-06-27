import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import QRCode from "qrcode";
import { apiTimeoutMs, cliCommand, commandExists, mergeRun, readRun, readState, safeErrorMessage, writeRun } from "./env.js";

async function renderItPayPaymentAction(intent, flags = {}) {
  const action = intent?.human_action ? { ...intent.human_action } : (intent?.payment_url ? {
    id: intent.payment_intent_id,
    title: "Scan payment QR",
    url: intent.payment_url,
    expires_at: intent.qr?.expires_at
  } : null);
  if (action) {
    if (intent?.qr_png_url || intent?.qr?.png_url) {
      action.qr_png_url = intent.qr_png_url || intent.qr.png_url;
    }
    if (intent?.mobile_wallet_url) {
      action.mobile_wallet_url = intent.mobile_wallet_url;
    }
  }
  if (action && (intent?.qr_image_url || intent?.qr?.image_url)) {
    action.qr_image_url = intent.qr_image_url || intent.qr.image_url;
    action.display_mode = intent.qr?.scan_mode || "itpay_entry_qr";
    action.description = action.description || "Scan the ItPay payment entry QR; ItPay will safely hand off to the payment provider.";
  }
  const result = await renderHumanAction(action, flags);
  if (intent && action) {
    intent.human_action = { ...(intent.human_action || {}), ...action };
    if (action.local_qr_path) intent.local_qr_path = action.local_qr_path;
    if (action.preferred_qr_url) intent.preferred_qr_url = action.preferred_qr_url;
    if (action.mobile_wallet_url) intent.mobile_wallet_url = action.mobile_wallet_url;
  }
  return result;
}

function humanActionSummaryLines(action) {
  if (!action?.url) return [];
  const lines = [
    "ITP HUMAN ACTION REQUIRED",
    `Title: ${humanActionTitle(action)}`,
    `URL: ${action.url}`
  ];
  if (action.local_qr_path) {
    lines.push(`Local QR image: ${action.local_qr_path}`);
  }
  if (action.qr_png_url) {
    lines.push(`QR PNG: ${action.qr_png_url}`);
  }
  if (action.qr_image_url) {
    lines.push(`QR image: ${action.qr_image_url}`);
  }
  if (action.mobile_wallet_url) {
    lines.push(`Mobile wallet link: ${action.mobile_wallet_url}`);
  }
  if (action.oauth_start_url) {
    lines.push(`${humanActionProviderLabel(action)} auth fallback: ${action.oauth_start_url}`);
  }
  if (action.fallback_text && !action.fallback_text.includes(action.url)) {
    lines.push(`Fallback: ${action.fallback_text}`);
  }
  if (action.expires_at) {
    lines.push(`Expires at: ${formatActionTime(action.expires_at)}`);
  }
  return lines;
}

function writeHumanActionSummary(action, suffix = "") {
  const lines = humanActionSummaryLines(action);
  if (!lines.length) return;
  process.stderr.write(`\n${lines.join("\n")}${suffix ? `\n${suffix}` : ""}\n\n`);
}

function waitHeartbeatMs(flags = {}) {
  if (flags.quiet || process.env.ITP_WAIT_HEARTBEAT_SECONDS === "0") return 0;
  return Math.max(5000, Number(flags.heartbeat || process.env.ITP_WAIT_HEARTBEAT_SECONDS || 20) * 1000);
}

function writeWaitHeartbeat({ kind, idName, idValue, status, action, lastHeartbeatAt, flags, command }) {
  const heartbeatMs = waitHeartbeatMs(flags);
  if (!heartbeatMs) return lastHeartbeatAt;
  const now = Date.now();
  if (now - lastHeartbeatAt < heartbeatMs) return lastHeartbeatAt;
  const lines = [
    `ITP waiting for ${kind}: ${idName}=${idValue} status=${status}`,
    action?.url ? `URL: ${action.url}` : null,
    action?.local_qr_path ? `Local QR image: ${action.local_qr_path}` : null,
    action?.qr_png_url ? `QR PNG: ${action.qr_png_url}` : null,
    action?.qr_image_url ? `QR image: ${action.qr_image_url}` : null,
    action?.mobile_wallet_url ? `Mobile wallet link: ${action.mobile_wallet_url}` : null,
    action?.oauth_start_url ? `${humanActionProviderLabel(action)} auth fallback: ${action.oauth_start_url}` : null,
    command ? `Resume command: ${command}` : null
  ].filter(Boolean);
  process.stderr.write(`\n${lines.join("\n")}\n\n`);
  return now;
}

async function renderHumanAction(action, flags = {}) {
  if (!action?.url) return null;
  const qrImageURL = preferredHumanActionQRURL(action);
  const mode = String(flags.display || process.env.ITP_DISPLAY || "").toLowerCase() || "auto";
  annotateHumanActionPresentation(action, qrImageURL);
  if (flags.json || mode === "none" || mode === "json") {
    if (qrImageURL && shouldPrepareLocalQRForJSON(mode, flags, action)) {
      const localPath = await prepareLocalQRFile(action, qrImageURL, flags, mode !== "file" && !flags.qr_file && !process.env.ITP_QR_FILE);
      if (localPath) {
        attachAgentQRImage(action, qrImageURL, localPath);
        persistHumanAction(action, flags);
        return { rendered: false, mode: "json-local-qr", outputs: [localPath] };
      }
    }
    if (!qrImageURL && shouldGenerateLocalQRFromActionURL(action, mode, flags)) {
      const localPath = await prepareLocalQRFromActionURL(action, flags, mode !== "file" && !flags.qr_file && !process.env.ITP_QR_FILE);
      if (localPath) {
        attachAgentLocalQR(action, localPath);
        annotateHumanActionPresentation(action, "");
        persistHumanAction(action, flags);
        return { rendered: false, mode: "json-local-url-qr", outputs: [localPath] };
      }
    }
    return { rendered: false, mode: flags.json ? "json" : mode };
  }
  const host = String(process.env.ITP_HOST || flags.host || "").toLowerCase();
  if (["discord", "telegram", "whatsapp"].includes(host)) {
    return { rendered: false, mode: "chat-json", host };
  }
  if (shouldUseAgentTextQR(flags)) {
    if (qrImageURL) {
      const localPath = await prepareLocalQRFile(action, qrImageURL, flags, true);
      attachAgentQRImage(action, qrImageURL, localPath);
      persistHumanAction(action, flags);
      return { rendered: false, mode: localPath ? "agent-local-image-qr" : "agent-image-qr", host, outputs: [localPath || "preferred_qr_url"] };
    }
    if (shouldGenerateLocalQRFromActionURL(action, mode, flags)) {
      const localPath = await prepareLocalQRFromActionURL(action, flags, true);
      if (localPath) {
        attachAgentLocalQR(action, localPath);
        annotateHumanActionPresentation(action, "");
        persistHumanAction(action, flags);
        return { rendered: false, mode: "agent-local-url-qr", host, outputs: [localPath] };
      }
    }
    process.stderr.write(`No QR image available. Open action URL: ${action.url}\n`);
    persistHumanAction(action, flags);
    return { rendered: false, mode: "agent-url-fallback", host, outputs: ["action_url"] };
  }

  const renderResult = { rendered: false, mode, outputs: [] };
  const terminalQRAllowed = shouldRenderTerminalQR(host, mode);
  const providerLabel = humanActionProviderLabel(action);
  const actionTitle = humanActionTitle(action);
  writeHumanActionSummary(action);

  if ((mode === "auto" || mode === "terminal") && terminalQRAllowed) {
    const qr = await QRCode.toString(action.url, {
      type: terminalQRType(flags, host),
      small: true,
      errorCorrectionLevel: "M"
    });
    process.stderr.write(`\n${actionTitle}\n`);
    if (action.description) process.stderr.write(`${action.description}\n`);
    process.stderr.write(`${qr}\n`);
    process.stderr.write(`${providerLabel} action URL: ${action.url}\n`);
    if (action.expires_at) process.stderr.write(`Expires at: ${formatActionTime(action.expires_at)}\n`);
    renderResult.rendered = true;
    renderResult.outputs.push("terminal");
    return renderResult;
  }

  if ((mode === "auto" || mode === "browser") && shouldOpenBrowser(flags)) {
    if (openBrowser(qrImageURL || action.mobile_wallet_url || action.url)) {
      renderResult.rendered = true;
      renderResult.outputs.push("browser");
    }
    if (mode === "browser") return renderResult;
  }

  if (mode === "file" || flags.qr_file || process.env.ITP_QR_FILE) {
    const file = flags.qr_file || process.env.ITP_QR_FILE || defaultQRFilePath(action, qrImageURL);
    if (qrImageURL) {
      await downloadQRImage(qrImageURL, file, flags);
      action.local_qr_path = file;
      action.local_qr_mime = qrMimeType(qrImageURL, action);
      process.stderr.write(`${providerLabel} QR image: ${file}\n`);
      renderResult.rendered = true;
      renderResult.outputs.push(file);
      if (mode === "file") return renderResult;
    } else {
      const localPath = shouldGenerateLocalQRFromActionURL(action, mode, flags)
        ? await prepareLocalQRFromActionURL(action, flags, false)
        : "";
      if (localPath) {
        attachAgentLocalQR(action, localPath);
        annotateHumanActionPresentation(action, "");
        process.stderr.write(`${providerLabel} action QR image: ${localPath}\n`);
        renderResult.rendered = true;
        renderResult.outputs.push(localPath);
        if (mode === "file") return renderResult;
      } else {
        process.stderr.write(`No branded QR image available. Open action URL: ${action.url}\n`);
      }
    }
  }

  if (qrImageURL) {
    process.stderr.write(`${providerLabel} QR image URL: ${qrImageURL}\n`);
    if (action.mobile_wallet_url) process.stderr.write(`Mobile wallet link: ${action.mobile_wallet_url}\n`);
    renderResult.outputs.push("preferred_qr_url");
    return renderResult;
  }

  process.stderr.write(`${action.fallback_text || `Open ${providerLabel} URL: ${action.url}`}\n`);
  renderResult.outputs.push("url");
  return renderResult;
}

function humanActionTitle(action = {}) {
  if (action.title) return action.title;
  if (action.kind === "auth_qr") return `${humanActionProviderLabel(action)} authentication`;
  return "Scan payment QR";
}

function humanActionProviderLabel(action = {}) {
  const raw = String(action.provider || action.channel || action.display_mode || "").toLowerCase();
  if (raw.includes("alipay")) return "Alipay";
  if (raw.includes("wechat")) return "WeChat Pay";
  if (raw.includes("fake") || raw.includes("local")) return "ItPay local";
  return "Alipay or WeChat Pay";
}

function preferredHumanActionQRURL(action) {
  return action?.qr_png_url ||
    humanActionPresentationURL(action, "qr_png_url") ||
    action?.qr_image_url ||
    action?.qr?.png_url ||
    action?.qr?.image_url ||
    humanActionPresentationURL(action, "qr_svg_url") ||
    "";
}

function humanActionPresentationURL(action, type) {
  const display = action?.presentation?.display;
  if (!Array.isArray(display)) return "";
  const found = display.find((item) => item?.type === type && item?.url);
  return found?.url || "";
}

function annotateHumanActionPresentation(action, qrImageURL) {
  if (!action) return action;
  if (qrImageURL) {
    action.preferred_qr_url = qrImageURL;
    action.preferred_qr_mime = qrMimeType(qrImageURL, action);
  }
  const mobileURL = action.mobile_wallet_url || humanActionPresentationURL(action, "mobile_wallet_url");
  if (mobileURL) action.mobile_wallet_url = mobileURL;
  action.agent_display_hint = {
    primary: action.local_qr_path ? "local_qr_path" : (action.qr_png_url ? "qr_png_url" : "preferred_qr_url"),
    desktop: action.kind === "auth_qr"
      ? "Show local_qr_path when present; otherwise show the ItPay first-purchase entry URL. This QR starts login/registration/profile authorization and should continue to payment for the same checkout after approval; it is not payment proof."
      : "Show local_qr_path when present; otherwise show qr_png_url/preferred_qr_url directly. This is an ItPay-hosted human QR image and may render the native provider payment code; do not render your own QR from payment_entry_url.",
    mobile: "Show mobile_wallet_url as a clickable human-only fallback when present.",
    proof: "Only payment_intent.verified proves payment. QR display or page open is not payment proof."
  };
  return action;
}

function shouldPrepareLocalQRForJSON(mode, flags = {}, action = {}) {
  if (mode === "file" || flags.qr_file || process.env.ITP_QR_FILE) return true;
  if (action?.qr_png_url || action?.preferred_qr_url || action?.qr_image_url) return true;
  return false;
}

function shouldGenerateLocalQRFromActionURL(action = {}, mode = "", flags = {}) {
  if (!action?.url) return false;
  if (action.kind === "auth_qr") return true;
  return mode === "file" || Boolean(flags.qr_file || process.env.ITP_QR_FILE);
}

async function prepareLocalQRFile(action, qrImageURL, flags = {}, optional = false) {
  if (!qrImageURL) return "";
  const file = flags.qr_file || process.env.ITP_QR_FILE || defaultQRFilePath(action, qrImageURL);
  try {
    await downloadQRImage(qrImageURL, file, flags);
  } catch (error) {
    if (!optional) throw error;
    action.local_qr_error = safeErrorMessage(error);
    return "";
  }
  action.local_qr_path = file;
  action.local_qr_mime = qrMimeType(qrImageURL, action);
  return file;
}

async function prepareLocalQRFromActionURL(action, flags = {}, optional = false) {
  if (!action?.url) return "";
  const file = flags.qr_file || process.env.ITP_QR_FILE || defaultGeneratedQRFilePath(action);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await QRCode.toFile(file, action.url, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512
    });
  } catch (error) {
    if (!optional) throw error;
    action.local_qr_error = safeErrorMessage(error);
    return "";
  }
  action.local_qr_path = file;
  action.local_qr_mime = "image/png";
  return file;
}

function defaultQRFilePath(action, qrImageURL) {
  const id = sanitizeFilename(action?.payment_intent_id || action?.id || "qr");
  return path.join(os.tmpdir(), `itp-${id}.${qrFileExtension(qrImageURL, action)}`);
}

function defaultGeneratedQRFilePath(action) {
  const id = sanitizeFilename(action?.payment_intent_id || action?.id || "qr");
  return path.join(os.tmpdir(), `itp-${id}.png`);
}

function qrFileExtension(qrImageURL, action = {}) {
  const mime = qrMimeType(qrImageURL, action);
  if (mime === "image/png") return "png";
  if (mime === "image/svg+xml") return "svg";
  return "img";
}

function qrMimeType(qrImageURL, action = {}) {
  if (qrImageURL && action?.qr_png_url && qrImageURL === action.qr_png_url) return "image/png";
  if (String(qrImageURL || "").toLowerCase().includes(".png")) return "image/png";
  if (String(qrImageURL || "").toLowerCase().includes(".svg")) return "image/svg+xml";
  return action?.preferred_qr_mime || "image/png";
}

function sanitizeFilename(value) {
  return String(value || "qr").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "qr";
}

function formatActionTime(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" || /^[0-9]+$/.test(String(value))) {
    const numeric = Number(value);
    const millis = numeric > 100000000000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(String(value));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return String(value);
}

function shouldUseAgentTextQR(flags = {}) {
  const mode = String(flags.display || process.env.ITP_DISPLAY || "").toLowerCase() || "auto";
  const host = String(process.env.ITP_HOST || flags.host || "").toLowerCase();
  return mode === "chat" || mode === "agent" || (["gemini", "gemini-cli"].includes(host) && mode === "auto");
}

function shouldReturnAfterAgentTextQR(flags = {}) {
  if (flags.wait || flags.wait_human) return false;
  return shouldUseAgentTextQR(flags);
}

function attachAgentQRImage(action, qrImageURL, localPath = "") {
  if (!action || !qrImageURL) return action;
  action.preferred_qr_url = qrImageURL;
  if (qrMimeType(qrImageURL, action) === "image/png") {
    action.qr_png_url = action.qr_png_url || qrImageURL;
  } else {
    action.qr_image_url = action.qr_image_url || qrImageURL;
  }
  if (!Array.isArray(action.display)) {
    action.display = [];
  }
  if (!action.display.some((item) => item?.type === "image")) {
    action.display.push({
      type: "image",
      format: qrFileExtension(qrImageURL, action),
      url: qrImageURL,
      local_path: localPath || undefined,
      instructions: "Render local_path when present; otherwise render this ItPay-hosted QR image for the human to scan. ItPay may render a native provider payment code inside the image, but the agent must not request, decode, or expose provider payloads. Do not encode payment_entry_url or mobile_wallet_url into your own QR."
    });
  }
  return action;
}

function attachAgentLocalQR(action, localPath = "") {
  if (!action || !localPath) return action;
  if (!Array.isArray(action.display)) {
    action.display = [];
  }
  if (!action.display.some((item) => item?.type === "image" && item?.local_path === localPath)) {
    action.display.push({
      type: "image",
      format: "png",
      local_path: localPath,
      instructions: "Render this local QR image for the human to scan. It encodes the ItPay human action URL, not a provider raw QR payload."
    });
  }
  return action;
}

async function downloadQRImage(qrImageURL, file, flags = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs(flags));
  let response;
  try {
    response = await fetch(qrImageURL, { method: "GET", signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`QR image download timed out: ${qrImageURL}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`QR image download failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function persistHumanAction(action, flags = {}) {
  const runId = flags.run_id || readState().current_run_id;
  if (!runId || !action?.id) return;
  const run = readRun(runId);
  if (!run?.human_action?.id || run.human_action.id !== action.id) return;
  writeRun(mergeRun(run, { human_action: action }));
}

function shouldRenderTerminalQR(host, mode = "auto") {
  if (["terminal", "tty"].includes(mode)) return true;
  if (mode && !["auto", ""].includes(mode)) return false;
  if (process.stderr.isTTY) return true;
  return terminalQRHostAliases().has(String(host || "").toLowerCase());
}

function terminalQRHostAliases() {
  return new Set(["terminal", "tty", "bash", "zsh", "sh", "shell", "iterm", "iterm2"]);
}

function terminalQRType(flags = {}, host = "") {
  const requested = String(flags.qr_format || process.env.ITP_QR_FORMAT || "").toLowerCase();
  if (requested === "unicode" || requested === "utf8") return "utf8";
  if (requested === "ansi" || requested === "terminal") return "terminal";
  if (terminalQRHostAliases().has(String(host || "").toLowerCase())) return "utf8";
  return "terminal";
}

function shouldOpenBrowser(flags = {}) {
  if (flags.no_open_browser || process.env.ITP_OPEN_BROWSER === "false" || process.env.ITP_OPEN_BROWSER === "0") return false;
  if (flags.open_browser || process.env.ITP_OPEN_BROWSER === "true" || process.env.ITP_OPEN_BROWSER === "1") return true;
  if (process.env.SSH_CONNECTION || process.env.CI) return false;
  return Boolean(process.stderr.isTTY && (process.platform === "darwin" || process.platform === "win32" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.WSL_DISTRO_NAME));
}

function openBrowser(targetURL) {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [targetURL], { stdio: "ignore", timeout: 2000 });
      return true;
    }
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", targetURL], { stdio: "ignore", timeout: 2000 });
      return true;
    }
    if (process.env.WSL_DISTRO_NAME && commandExists("cmd.exe")) {
      execFileSync("cmd.exe", ["/c", "start", "", targetURL], { stdio: "ignore", timeout: 2000 });
      return true;
    }
    if (commandExists("xdg-open")) {
      execFileSync("xdg-open", [targetURL], { stdio: "ignore", timeout: 2000 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export { renderItPayPaymentAction, humanActionSummaryLines, writeHumanActionSummary, waitHeartbeatMs, writeWaitHeartbeat, renderHumanAction, preferredHumanActionQRURL, humanActionPresentationURL, annotateHumanActionPresentation, shouldPrepareLocalQRForJSON, shouldGenerateLocalQRFromActionURL, prepareLocalQRFile, prepareLocalQRFromActionURL, defaultQRFilePath, defaultGeneratedQRFilePath, qrFileExtension, qrMimeType, sanitizeFilename, formatActionTime, shouldUseAgentTextQR, shouldReturnAfterAgentTextQR, attachAgentQRImage, attachAgentLocalQR, downloadQRImage, persistHumanAction, shouldRenderTerminalQR, terminalQRType, shouldOpenBrowser, openBrowser };
