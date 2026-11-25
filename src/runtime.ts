import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { getLastCaptureSettings, resolveCaptureStateDir, setLastCaptureSettings } from "./capture.js";
import { captureSettingsFromPluginConfig } from "./config.js";
import { flushPending } from "./flush.js";
import { listPendingRecords } from "./queue.js";

const logger = createSubsystemLogger("zalo-monitor");

let started = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Timer flush + replay khi khởi động.
 * Settings lấy từ `getLastCaptureSettings()` — tức là settings resolve gần nhất
 * từ root config (qua tap). Trước khi có tin nào, dùng default.
 *
 * Lúc khởi động, settings được nạp thẳng từ config của plugin (`api.pluginConfig`)
 * để replay backlog và timer dùng đúng `backendUrl`/`flushIntervalMs` do user
 * cấu hình — không chờ tin đầu tiên mới biết.
 *
 * Timer tự hẹn lại sau mỗi lần chạy (thay vì setInterval cố định) để
 * `flushIntervalMs` do user cấu hình có hiệu lực ngay khi có tin đầu tiên —
 * lúc đó `lastSettings` mới được cập nhật.
 */
export function startCaptureRuntime(pluginConfig?: unknown): void {
  if (started) return;
  started = true;
  setLastCaptureSettings(captureSettingsFromPluginConfig(pluginConfig));
  const stateDir = resolveCaptureStateDir();
  void (async () => {
    try {
      const pending = await listPendingRecords(stateDir);
      if (pending.length > 0) {
        logger.info("capture_replayed_on_start", { pending: pending.length });
        await flushPending(stateDir, getLastCaptureSettings());
      }
    } catch (err) {
      logger.error("capture_replay_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  })();
  const scheduleNext = () => {
    timer = setTimeout(() => {
      void flushPending(stateDir, getLastCaptureSettings())
        .catch((err) => {
          logger.error("capture_flush_failed", { error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          scheduleNext();
        });
    }, getLastCaptureSettings().flushIntervalMs);
    timer.unref?.();
  };
  scheduleNext();
}
