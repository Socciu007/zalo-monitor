import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { DEFAULT_CAPTURE_SETTINGS, resolveCaptureSettings, type CaptureSettings } from "./config.js";
import { flushPending } from "./flush.js";
import { normalizeCapture } from "./normalize.js";
import { buildRecordId, enqueueCapture, isCaptured, type PendingRecord } from "./queue.js";
import { resolvePluginStateDir } from "./state.js";

const logger = createSubsystemLogger("zalo-monitor");

export interface CaptureTapInput {
  isGroup: boolean;
  chatId: string;
  groupName: string;
  senderId: string;
  senderName: string;
  rawBody: string;
  mentioned: boolean;
  messageId: string;
  rootConfig: unknown;
}

let stateDirOverride: string | null = null;
let lastSettings: CaptureSettings = DEFAULT_CAPTURE_SETTINGS;

/** Chỉ dùng cho test; runtime dùng state dir của openclaw. */
export function setCaptureStateDir(dir: string | null): void {
  stateDirOverride = dir;
}

export function resolveCaptureStateDir(): string {
  return stateDirOverride ?? resolvePluginStateDir();
}

/** Settings resolve gần nhất từ root config — timer flush dùng lại. */
export function getLastCaptureSettings(): CaptureSettings {
  return lastSettings;
}

/** Nạp settings từ config của plugin — runtime dùng lúc khởi động, trước khi có tin nào. */
export function setLastCaptureSettings(settings: CaptureSettings): void {
  lastSettings = settings;
}

/** Tap: KHÔNG được ném exception ra channel, KHÔNG được chặn luồng chat. */
export function captureZaloMessage(input: CaptureTapInput): void {
  try {
    const settings = resolveCaptureSettings(input.rootConfig);
    lastSettings = settings;
    if (!input.isGroup && !settings.captureDm) return;
    void handleCapture(resolveCaptureStateDir(), settings, input);
  } catch (err) {
    logger.error("capture_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleCapture(stateDir: string, settings: CaptureSettings, input: CaptureTapInput): Promise<void> {
  try {
    if (await isCaptured(stateDir, input.chatId, input.messageId)) return;
    const receivedAt = new Date().toISOString();
    const payload = normalizeCapture({
      rawBody: input.rawBody,
      chatId: input.chatId,
      groupName: input.groupName,
      senderId: input.senderId,
      senderName: input.senderName,
    });
    const record: PendingRecord = {
      id: buildRecordId(input.messageId, receivedAt),
      messageId: input.messageId,
      ...payload,
      mentioned: input.mentioned,
      receivedAt,
    };
    await enqueueCapture(stateDir, record);
    await flushPending(stateDir, settings);
  } catch (err) {
    logger.error("capture_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
