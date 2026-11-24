import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { getLastCaptureSettings } from "./capture.js";
import { flushPending } from "./flush.js";
import { listPendingRecords } from "./queue.js";
import { resolvePluginStateDir } from "./state.js";

const logger = createSubsystemLogger("zalo-monitor");

let timer: NodeJS.Timeout | null = null;

/**
 * Timer flush + replay khi khởi động.
 * Settings lấy từ `getLastCaptureSettings()` — tức là settings resolve gần nhất
 * từ root config (qua tap). Trước khi có tin nào, dùng default.
 */
export function startCaptureRuntime(): void {
  if (timer) return;
  const stateDir = resolvePluginStateDir();
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
  timer = setInterval(() => {
    void flushPending(stateDir, getLastCaptureSettings()).catch((err) => {
      logger.error("capture_flush_failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, getLastCaptureSettings().flushIntervalMs);
  timer.unref?.();
}
