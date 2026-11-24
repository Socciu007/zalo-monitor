import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPTURE_SETTINGS, resolveCaptureSettings } from "./config.js";

test("resolveCaptureSettings trả default khi không có config", () => {
  assert.deepEqual(resolveCaptureSettings(undefined), DEFAULT_CAPTURE_SETTINGS);
  assert.deepEqual(resolveCaptureSettings({}), DEFAULT_CAPTURE_SETTINGS);
});

test("resolveCaptureSettings đọc plugins.entries['zalo-monitor'].config", () => {
  const settings = resolveCaptureSettings({
    plugins: { entries: { "zalo-monitor": { config: { backendUrl: "http://example.test/x", timeoutMs: 250, maxAttempts: 2, retryDelaysMs: [5, 10], captureDm: true, flushIntervalMs: 30_000 } } } },
  });
  assert.equal(settings.backendUrl, "http://example.test/x");
  assert.equal(settings.timeoutMs, 250);
  assert.equal(settings.maxAttempts, 2);
  assert.deepEqual(settings.retryDelaysMs, [5, 10]);
  assert.equal(settings.captureDm, true);
  assert.equal(settings.flushIntervalMs, 30_000);
});

test("resolveCaptureSettings bỏ qua giá trị sai kiểu, giữ default", () => {
  const settings = resolveCaptureSettings({
    plugins: {
      entries: {
        "zalo-monitor": {
          config: {
            backendUrl: 123,
            timeoutMs: 250.5,
            maxAttempts: -1,
            retryDelaysMs: "nope",
            flushIntervalMs: 0,
            captureDm: "true",
          },
        },
      },
    },
  });
  assert.deepEqual(settings, DEFAULT_CAPTURE_SETTINGS);
  // Số thực không phải số nguyên → phải rơi về default, không được nhận 250.5.
  assert.equal(settings.timeoutMs, DEFAULT_CAPTURE_SETTINGS.timeoutMs);
  // flushIntervalMs = 0 (không phải số nguyên > 0) → phải giữ default.
  assert.equal(settings.flushIntervalMs, DEFAULT_CAPTURE_SETTINGS.flushIntervalMs);
  // captureDm chỉ nhận boolean thật, chuỗi "true" không được coi là bật.
  assert.equal(settings.captureDm, false);
});

test("resolveCaptureSettings trả mảng retryDelaysMs riêng, không dùng chung mảng default", () => {
  const settings = resolveCaptureSettings(undefined);
  assert.notEqual(settings.retryDelaysMs, DEFAULT_CAPTURE_SETTINGS.retryDelaysMs);
  settings.retryDelaysMs.push(999_999);
  assert.deepEqual(DEFAULT_CAPTURE_SETTINGS.retryDelaysMs, [1_000, 4_000, 16_000]);
});
