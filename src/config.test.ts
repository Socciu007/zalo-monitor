import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPTURE_SETTINGS, resolveCaptureSettings } from "./config.js";

test("resolveCaptureSettings trả default khi không có config", () => {
  assert.deepEqual(resolveCaptureSettings(undefined), DEFAULT_CAPTURE_SETTINGS);
  assert.deepEqual(resolveCaptureSettings({}), DEFAULT_CAPTURE_SETTINGS);
});

test("resolveCaptureSettings đọc plugins.entries['zalo-monitor'].config", () => {
  const settings = resolveCaptureSettings({
    plugins: { entries: { "zalo-monitor": { config: { backendUrl: "http://example.test/x", timeoutMs: 250, maxAttempts: 2, retryDelaysMs: [5, 10], captureDm: true } } } },
  });
  assert.equal(settings.backendUrl, "http://example.test/x");
  assert.equal(settings.timeoutMs, 250);
  assert.equal(settings.maxAttempts, 2);
  assert.deepEqual(settings.retryDelaysMs, [5, 10]);
  assert.equal(settings.captureDm, true);
});

test("resolveCaptureSettings bỏ qua giá trị sai kiểu, giữ default", () => {
  const settings = resolveCaptureSettings({
    plugins: { entries: { "zalo-monitor": { config: { backendUrl: 123, timeoutMs: -1, maxAttempts: 0, retryDelaysMs: "nope" } } } },
  });
  assert.deepEqual(settings, DEFAULT_CAPTURE_SETTINGS);
});

test("resolveCaptureSettings trả mảng retryDelaysMs riêng, không dùng chung mảng default", () => {
  const settings = resolveCaptureSettings(undefined);
  assert.notEqual(settings.retryDelaysMs, DEFAULT_CAPTURE_SETTINGS.retryDelaysMs);
  settings.retryDelaysMs.push(999_999);
  assert.deepEqual(DEFAULT_CAPTURE_SETTINGS.retryDelaysMs, [1_000, 4_000, 16_000]);
});
