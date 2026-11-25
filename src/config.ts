/** Cấu hình runtime của capture tap, đã resolve + kiểm tra kiểu. */
export interface CaptureSettings {
  backendUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelaysMs: number[];
  captureDm: boolean;
  flushIntervalMs: number;
}

/** Giá trị dùng khi config vắng mặt hoặc sai kiểu — không bao giờ throw. */
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  backendUrl: "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
  timeoutMs: 10_000,
  maxAttempts: 4,
  retryDelaysMs: [1_000, 4_000, 16_000],
  captureDm: false,
  flushIntervalMs: 60_000,
};

/** Móc config của riêng plugin: rootConfig.plugins.entries["zalo-monitor"].config. */
function readPluginConfig(rootConfig: unknown): Record<string, unknown> | undefined {
  if (!rootConfig || typeof rootConfig !== "object") return undefined;
  const plugins = (rootConfig as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== "object") return undefined;
  const entries = (plugins as Record<string, unknown>).entries;
  if (!entries || typeof entries !== "object") return undefined;
  const entry = (entries as Record<string, unknown>)["zalo-monitor"];
  if (!entry || typeof entry !== "object") return undefined;
  const config = (entry as Record<string, unknown>).config;
  if (!config || typeof config !== "object") return undefined;
  return config as Record<string, unknown>;
}

/** Chỉ nhận số nguyên > 0 — float, 0, số âm và non-number đều bị loại. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Áp dụng config của plugin lên settings.
 * `pluginConfig` là đúng giá trị `plugins.entries["zalo-monitor"].config`
 * (hoặc `api.pluginConfig` của plugin API).
 * Mọi giá trị sai kiểu đều rơi về default thay vì ném lỗi — config hỏng
 * không được làm sập kênh message.
 */
export function captureSettingsFromPluginConfig(pluginConfig: unknown): CaptureSettings {
  const settings: CaptureSettings = { ...DEFAULT_CAPTURE_SETTINGS, retryDelaysMs: [...DEFAULT_CAPTURE_SETTINGS.retryDelaysMs] };
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) return settings;
  const raw = pluginConfig as Record<string, unknown>;
  if (typeof raw.backendUrl === "string" && raw.backendUrl.trim()) settings.backendUrl = raw.backendUrl.trim();
  const timeoutMs = positiveInt(raw.timeoutMs);
  if (timeoutMs !== undefined) settings.timeoutMs = timeoutMs;
  const maxAttempts = positiveInt(raw.maxAttempts);
  if (maxAttempts !== undefined) settings.maxAttempts = maxAttempts;
  const flushIntervalMs = positiveInt(raw.flushIntervalMs);
  if (flushIntervalMs !== undefined) settings.flushIntervalMs = flushIntervalMs;
  if (Array.isArray(raw.retryDelaysMs)) {
    const delays = raw.retryDelaysMs.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    if (delays.length > 0) settings.retryDelaysMs = delays;
  }
  if (typeof raw.captureDm === "boolean") settings.captureDm = raw.captureDm;
  return settings;
}

/**
 * Đọc settings từ root OpenClaw config.
 * Mọi giá trị sai kiểu đều rơi về default thay vì ném lỗi — config hỏng
 * không được làm sập kênh message.
 */
export function resolveCaptureSettings(rootConfig: unknown): CaptureSettings {
  return captureSettingsFromPluginConfig(readPluginConfig(rootConfig));
}
