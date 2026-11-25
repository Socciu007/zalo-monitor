# Design: zalo-monitor — fork zalouser + capture tap

- **Ngày:** 2026-11-24
- **Trạng thái:** đã duyệt
- **Repo:** `e:\projectVN\zalo-monitor` (hiện chỉ có `README.md`)
- **Môi trường đã verify:** openclaw `2026.5.28`, `@openclaw/zalouser` `2026.5.28` (đang cài ở
  `~/.openclaw/npm/projects/openclaw-zalouser-23f4f34fca/node_modules/@openclaw/zalouser`)

## 1. Mục tiêu

Giám sát **mọi** tin nhắn Zalo trong **group** (kể cả tin **không tag** bot), chuyển nguyên văn lên
backend để backend tự phân loại. Hành vi trả lời của bot **không đổi**: bot vẫn chỉ trả lời tin
nhắn tag nó.

## 2. Facts đã verify trên máy (không phải giả định)

| # | Fact | Bằng chứng |
|---|---|---|
| F1 | Channel plugin `zalouser` **drop tin group không tag bên trong chính nó**, trước khi host kịp thấy | `vendor/zalouser/dist/monitor-*.js` — `if (isGroup && mentionDecision.shouldSkip) { … return; }` (khoảng dòng 340-357) nằm **trước** `core.channel.inbound.dispatchReply({...})` (khoảng dòng 452) |
| F2 | ⇒ Hook `message_received` của host **vô dụng** cho mục tiêu này | Hook được fire trong `dispatch-from-config` (`dist/dispatch-DphqeP-y.js:1076`) — sau F1 |
| F3 | Host có hook **`before_dispatch` (claiming)**: trả `{handled:true}` (không kèm `text`) ⇒ không gọi model, không reply | `dist/dispatch-DphqeP-y.js:1193-1228` |
| F4 | `inbound_claim` có field `wasMentioned` nhưng **không có call site** cho message thường trong build này (chỉ targeted plugin-owned binding) | `dist/dispatch-DphqeP-y.js:1024` là `runInboundClaimForPluginOutcome`; `runInboundClaim` không được gọi ở đâu |
| F5 | Cả `message_received` lẫn `before_dispatch` **không** expose `wasMentioned` / native mention flag | `dist/message-hook-mappers-DBnpM4vz.js:117-213`; `dist/dispatch-DphqeP-y.js:1194-1208` |
| F6 | Native mention của Zalo là **entity riêng** (`data.mentions` = mảng `{uid}`), **không** nằm chắc chắn trong text | `vendor/zalouser/dist/zalo-js-*.js` — `extractMentionIds`, `wasExplicitlyMentioned = mentionIds.some(id => id === normalizedOwnUserId)` |
| F7 | `messages.groupChat.unmentionedInbound` (`user_request`/`room_event`) **không** áp dụng cho plugin channel | Chỉ dùng ở `dist/bot-*.js` + `dist/message-handler.preflight-*.js` (discord) |
| F8 | `ChannelPlugin.messaging` **không** có API subscribe/observe inbound | `dist/plugin-sdk/types.core-*.d.ts:498` — chỉ có `resolveInboundConversation` và mấy hàm routing |
| F9 | Runtime store của plugin là **global registry** nhưng zalouser chỉ set **channel runtime** (logger/status), **không** chứa zca client | `vendor/zalouser/dist/channel-*.js:112` (`createPluginRuntimeStore({pluginId:"zalouser"})`), `index.js` (`runtime: {specifier:"./runtime-api.js", exportName:"setZalouserRuntime"}`) |

⇒ Kết luận: **không có cách nào quan sát tin group không tag với full fidelity mà không fork channel
plugin** (trừ việc đăng nhập Zalo thứ hai — bị loại vì README yêu cầu zalouser là kết nối Zalo duy
nhất, và 2 session trên 1 tài khoản tăng rủi ro conflict/ban).

## 3. Kiến trúc đã chọn

**Fork `zalouser`, cắm capture tap trước mention gate, vendor bản đã patch vào repo.**

- Plugin id: `zalo-monitor` (như README)
- Channel id do plugin cung cấp: `zalouser` (thay bản npm)
- Bản npm `@openclaw/zalouser` phải được **tắt** (không được bật đồng thời → 2 kết nối Zalo)

### 3.1. Cây thư mục

```
e:\projectVN\zalo-monitor\
├─ package.json                  # plugin zalo-monitor
├─ openclaw.plugin.json          # id: zalo-monitor, channels: ["zalouser"], contracts.tools: ["zalouser"]
├─ tsconfig.json
├─ src\
│  ├─ index.ts                   # entry channel: nối vendor entry + capture config
│  ├─ capture.ts                 # tap: nhận message → queue (non-blocking)
│  ├─ queue.ts                   # pending/ bền vững, checkpoint, status.json, replay
│  ├─ eb-client.ts               # POST backend + retry/backoff
│  ├─ normalize.ts               # chuẩn hoá payload 6 field
│  └─ state.ts                   # state dir, atomic write, đường dẫn
├─ vendor\zalouser\              # @openclaw/zalouser đã patch (bản cài 2026.5.28)
│  ├─ dist\*.js                  #   (monitor-*.js có tap call)
│  ├─ openclaw.plugin.json
│  └─ package.json
└─ scripts\vendor-refresh.mjs    # copy bản @openclaw/zalouser mới + apply patch
```

### 3.2. Vị trí tap

Trong `processMessage(message, account, config, core, runtime, historyState, statusSink)` của
`vendor/zalouser/dist/monitor-*.js`:

| Thứ tự | Mốc trong code | Hành vi |
|---|---|---|
| 1 | `if (!rawBody) return` / thiếu `senderId` | rác → bỏ, **không** capture |
| 2 | group route access (`routeAccess.allowed`) / sender access (`accessDecision.senderAccess`) | group/sender ngoài policy → bỏ, **không** capture |
| 3 | **TAP** | **capture** |
| 4 | `if (isGroup && requireMention && !canDetectMention …) return` | bỏ + log lỗi (vẫn đã capture ở bước 3) |
| 5 | `if (isGroup && mentionDecision.shouldSkip) { … return; }` | tin không tag → **bỏ**, bot không thấy |

Đặt tap **sau** access gate và **trước** mention gate ⇒ capture đúng "những gì channel nhận" (không
tự lọc group, không vượt policy) **và** "kể cả tin không tag bot".

Tap được gọi cho **mọi** tin đã đi qua access gate (kể cả DM), nhưng `captureZaloMessage` chỉ ghi
queue khi `isGroup === true` **hoặc** khi bật `captureDm: true` (xem §6). ⇒ **mặc định chỉ capture
tin group**; tin DM chỉ được capture khi operator chủ động bật `captureDm`.

### 3.3. Dữ liệu tap thu được

| Field | Nguồn | Gửi backend? |
|---|---|---|
| `content` | `message.content` — **chưa trim**. Upstream `monitor-*.js:151` đã làm `const rawBody = message.content?.trim()` nên `rawBody` **đã mất** khoảng trắng đầu/cuối; bản nguyên văn là `message.content` (từ zca-js `normalizeMessageContent(data.content)`, không trim) | ✅ |
| `groupId` | `chatId` | ✅ |
| `groupName` | `groupName` (đã resolve, có thể gọi API lấy tên group) | ✅ |
| `userId` | `senderId` | ✅ |
| `senderName` | `senderName` | ✅ |
| `platform` | hằng số `"zalo"` | ✅ |
| `messageId` | `resolveZalouserMessageSid({msgId, cliMsgId, fallback: timestampMs})` | ❌ (nội bộ) |
| `mentioned` | `mentionDecision.effectiveWasMentioned` | ❌ (nội bộ) |
| `receivedAt` | ISO timestamp lúc capture | ❌ (nội bộ) |

`mentioned` là thông tin **nội bộ**: README yêu cầu body đúng 6 field, không thêm field.

### 3.4. Tính chất của tap

- **Fire-and-forget**: ghi queue bằng I/O bất đồng bộ, **không** await network. Tap không được
  làm chậm/nghẽn luồng chat của channel.
- **Fail-safe**: lỗi capture (ghi file hỏng, …) → log, **không** throw ra channel.
- **Chống gửi trùng**: `messageId` đã có trong `checkpoint.json` → bỏ qua (checkpoint theo group).

### 3.4.1. Cơ chế nối tap vào bản vendor

- Bản vendor giữ nguyên cấu trúc ESM của `@openclaw/zalouser`; patch = thêm **1 import tĩnh** và
  **1 lệnh gọi** vào `vendor/zalouser/dist/monitor-*.js`:

  ```js
  import { captureZaloMessage } from "<đường dẫn tương đối tới dist/capture.js của repo>";
  // …
  captureZaloMessage({ message, isGroup, chatId, groupName, senderId, senderName, rawBody: message.content, mentioned, config, log });
  ```

  Đường dẫn tương đối được tính lúc implement (từ `vendor/zalouser/dist/` tới `<repo>/dist/capture.js`)
  và **phải** được `vendor-refresh.mjs` chèn tự động — không hardcode tay trong file vendor.
- `dist/capture.js` của repo phải được **build trước** khi restart gateway (`npm run build`), nếu
  không import sẽ fail → channel zalouser không load được. `vendor-refresh.mjs` phải kiểm tra file
  build tồn tại và báo lỗi rõ ràng nếu thiếu.
- Cấu hình backend đọc **tại thời điểm tap** từ root config đã có sẵn trong scope của
  `processMessage`: `config.plugins?.entries?.["zalo-monitor"]?.config` (root `OpenClawConfig` — đã
  xác nhận qua `config.channels?.zalouser` trong chính file monitor). Không phụ thuộc thứ tự
  `register(api)`.
- Ngoài đường tap, **runtime** nạp config của chính plugin lúc khởi động (`api.pluginConfig` →
  `startCaptureRuntime(pluginConfig)`) để replay backlog và timer flush dùng **đúng** `backendUrl`
  / `flushIntervalMs` do operator cấu hình — không chờ tin đầu tiên mới biết (xem §5, §6).
- `captureZaloMessage` **không** được ném exception ra ngoài: bọc trong try/catch, log lỗi, nuốt lỗi.

## 4. Gửi backend

- URL: `backendUrl`, mặc định `http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData` (khớp README).
- Method `POST`, body **đúng 6 field**: `platform`, `content`, `groupId`, `groupName`, `userId`, `senderName`.
- Timeout mặc định `10000` ms.

| Kết quả | Hành động | Event log |
|---|---|---|
| `2xx` | ghi `checkpoint.json` **trước**, rồi xoá file pending, cập nhật `status.json` | `message_forwarded` |
| `5xx` / lỗi mạng / timeout | retry lùi `1s → 4s → 16s`, **tối đa 4 request**; hết lượt → giữ file pending (replay lần sau). Nhãn lỗi `post_failed_5xx:<status>` / `post_failed_network:<msg>` | `post_failed_after_retries` |
| `408` / `429` | **ngoại lệ**: là lỗi **tạm thời** (server timeout / giới hạn tần suất) ⇒ **retry** y hệt 5xx; hết lượt → **giữ** file pending, không đẩy vào `rejected/`. Nhãn lỗi `post_failed_retryable_4xx:<status>` | `post_failed_after_retries` |
| `4xx` khác (400, 401, 403, 404, 422…) | **từ chối vĩnh viễn**: chuyển file sang `pending/rejected/`, **không** retry, **không** bao giờ tự gửi lại ⇒ operator phải **re-queue tay** (đưa file về `pending/`) | `post_rejected_4xx` |

> Vì sao `408`/`429` phải retry: chúng là lỗi **tạm thời**; đẩy vào `rejected/` sẽ **vĩnh viễn**
> vứt bỏ tin nhắn. Còn lại (payload sai, token hết hạn, endpoint sai…) sẽ bị từ chối y hệt mọi lần
> thử ⇒ retry vô nghĩa, chỉ tốn thêm thời gian.

## 5. State & bền vững

`<state-dir>/plugin-state/zalo-monitor/` (`state-dir` = `~/.openclaw` mặc định):

```
<state-dir>/plugin-state/zalo-monitor/
├─ checkpoint.json     # { "<groupId>": { "<messageId>": { "at": "<iso>" } } }
├─ pending/            # queue bền vững: ghi trước khi POST, xoá sau khi 2xx
│  └─ rejected/        # tin bị 4xx (không phải 408/429) — chờ soi, không tự gửi lại
└─ status.json         # { pending, rejected, lastPostAt, lastPostStatus, lastError, updatedAt }
```

- Mỗi tin = 1 file JSON trong `pending/`, tên file là **id tất định**:
  `buildRecordId(groupId, messageId)` = **32 ký tự hex** của SHA-1 trên `groupId\0messageId` —
  **không có timestamp**. ⇒ capture lại cùng một tin (reconnect zca-js, tap chạy lại) **ghi đè**
  đúng file pending cũ thay vì tạo file thứ hai ⇒ reconnect **không** giao trùng lên backend.
- Ghi file **atomic**: ghi file tạm → rename. Không để lại file nửa vời.
- `checkpoint.json` chống gửi trùng khi zca-js re-deliver sau reconnect. **Giới hạn 2000 message id
  mỗi group** — vượt ngưỡng thì bỏ entry **cũ nhất** trước ⇒ file không phình vô hạn theo một group
  (số group thì không bị giới hạn).
- **Bảo đảm: at-least-once** — *không* phải exactly-once. `markDelivered` ghi **checkpoint trước**,
  rồi mới xoá file pending ⇒ **không có cửa sổ mất tin**. Đổi lại: nếu tiến trình chết sau khi backend
  trả `2xx` nhưng trước khi ghi checkpoint, record vẫn nằm trong `pending/` và **có thể được giao
  lại** ⇒ **backend phải chịu được duplicate**.
- Lượt flush bỏ qua (và dọn) record đã có trong `checkpoint.json` ⇒ file pending sót lại sau crash
  không bị gửi lại lần nữa.
- **Replay khi khởi động**: đọc lại `pending/` → gửi lại → event `capture_replayed_on_start`. Replay
  dùng **đúng** `backendUrl` do operator cấu hình (runtime nạp `api.pluginConfig` lúc khởi động),
  không dùng default.
- Backend chết lâu → `pending/` tích tụ; tin không mất. Tin bị **4xx** (không phải 408/429) bị đẩy
  vào `pending/rejected/` và **không bao giờ** tự gửi lại — operator phải re-queue tay.
- `status.json` là chỗ **theo dõi**: `pending` (đang chờ giao), `rejected` (bị 4xx từ chối vĩnh viễn),
  `lastPostAt`, `lastPostStatus`, `lastError`.
- Số liệu `pending`/`rejected` được đo **một lần cho cả lượt flush** (không quét lại thư mục sau mỗi
  record) ⇒ chi phí flush **tuyến tính** theo số record, không bậc hai.

## 6. Cấu hình

`plugins.entries["zalo-monitor"].config` (đọc từ root config tại `config.plugins.entries["zalo-monitor"].config`):

```json5
{
  backendUrl: "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
  timeoutMs: 10000,
  maxAttempts: 4,          // tối đa 4 request
  retryDelaysMs: [1000, 4000, 16000],
  captureDm: false,        // mặc định chỉ capture group — bật true thì DM cũng được capture
  flushIntervalMs: 60000   // chu kỳ timer flush
}
```

`captureDm` là **công tắc duy nhất** quyết định DM có được capture hay không (xem §3.2): mặc định
`false` ⇒ chỉ capture tin **group**; đặt `true` ⇒ tin DM cũng được ghi queue và POST lên backend.

`backendUrl` được áp dụng **ngay từ lúc khởi động**: runtime nạp config của chính plugin
(`plugins.entries["zalo-monitor"].config`, qua `api.pluginConfig`) **trước** khi replay backlog và
trước khi hẹn timer ⇒ backlog không bị POST nhầm sang backend default.

`channels.zalouser.groups.*.requireMention` **giữ nguyên `true`** → hành vi bot không đổi.

## 7. Cài đặt & vận hành

1. `npm install` trong repo (peer `openclaw`, dep `zca-js` khớp version bản vendor).
2. **`npm run link:host-sdk`** — trỏ `node_modules/openclaw` của repo về **bản cài openclaw của host**
   (symlink/junction). Bắt buộc: `openclaw` là devDependency nên `npm install` đặt một **bản thật**
   vào repo, Node sẽ resolve `openclaw/plugin-sdk/*` từ đó ⇒ plugin chạy trên **SDK thứ hai**,
   không phải SDK của host ⇒ sau khi gateway nâng cấp, plugin vẫn chạy trên SDK cũ.
   `npm install` **luôn** khôi phục bản thật ⇒ phải chạy lại `link:host-sdk` **sau mỗi** `npm install`.
3. `npm run build` — build `dist/` (không phụ thuộc bước 2).
4. `openclaw plugins install --link e:\projectVN\zalo-monitor`
5. **Tắt bản npm** để không có 2 kết nối Zalo:
   - khuyến nghị (đảo ngược được): `plugins.entries.zalouser.enabled = false` trong `~/.openclaw/openclaw.json`
   - hoặc dứt điểm: `openclaw plugins uninstall zalouser`
6. `openclaw gateway restart`
7. Kiểm tra:
   - `openclaw plugins doctor` → **không** có diagnostic `channel already registered`
   - `openclaw channels status` → `zalouser` có **đúng một** owner
   - `openclaw channels logs --channel all` → thấy `message_forwarded` (log của plugin mang
     subsystem `zalo-monitor`, không bị lọc bởi `--channel zalouser`)
   - `status.json` → `pending` về 0

> ⚠️ Không bật đồng thời bản npm và bản fork: hai zca-js client trên một tài khoản Zalo.

> ⚠️ OpenClaw đăng ký **một** plugin cho mỗi channel id; plugin đăng ký sau bị bỏ qua với diagnostic
> `channel already registered` ⇒ **tap không bao giờ chạy** (no-op im lặng). `preferOver` **không**
> ảnh hưởng tới đường này (nó chỉ quyết định auto-enable) ⇒ phải tắt bản npm và kiểm tra
> `openclaw plugins doctor` sau mỗi lần restart.

## 8. Nâng cấp zalouser

`scripts/vendor-refresh.mjs`:
1. copy `dist/`, `openclaw.plugin.json`, `package.json` từ bản `@openclaw/zalouser` mới (theo version
   pin trong `package.json` của repo) vào `vendor/zalouser/`
2. apply patch tap vào `dist/monitor-*.js`
3. patch fail → script exit non-zero, **không** để lại bản hỏng (copy vào thư mục tạm, chỉ swap khi patch ok)

Bản vendor hiện tại: `2026.5.28`.

## 9. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Zalo automation không chính thức → khoá/ban tài khoản | Cảnh báo trong README; không làm gì khác ngoài phạm vi đã cảnh báo |
| Fork bị lệch khi zalouser nâng cấp | `vendor-refresh.mjs` fail-safe; version pin trong repo |
| 2 kết nối Zalo nếu quên tắt bản npm | Bước 5 trong §7 là bắt buộc; verify bằng `openclaw channels status` |
| Bản npm đăng ký channel trước → `zalo-monitor` thua channel, **tap không chạy** (no-op im lặng) | `preferOver` không cứu được; tắt bản npm và kiểm tra `openclaw plugins doctor` sau mỗi lần restart |
| **SDK trong repo che (shadow) SDK của host** → plugin chạy trên SDK cũ sau khi gateway nâng cấp | Bắt buộc `npm run link:host-sdk` **sau mỗi** `npm install` (xem §7 bước 2) |
| Backend chết lâu → pending phình | `status.json` + `rejected/` để soi; không mất tin |
| `4xx` (không phải 408/429) → tin bị từ chối **vĩnh viễn** | Record nằm trong `pending/rejected/`, không tự gửi lại — operator re-queue tay; theo dõi `status.json` |
| Backend nhận trùng tin (duplicate) | Hệ quả **có chủ ý** của bảo đảm at-least-once; backend phải chịu được duplicate |
| Tap làm chậm chat | Fire-and-forget, không await network |

## 10. Kiểm thử

Bộ test dùng **test runner có sẵn của Node** (`node --test`), test file đặt cạnh module trong
`src/` (`src/*.test.ts`), chạy trên **JS đã build** (`npm run build && npm test`) — không thêm
dependency test framework.

**Unit**:
- `normalize`: map đúng 6 field, giữ nguyên text (kể cả newline/emoji), không thêm field ngoài
- `queue`: ghi atomic, **id tất định** (32 hex của SHA-1 trên `groupId\0messageId`), capture lại cùng
  tin chỉ tạo **một** file pending, **checkpoint ghi trước rồi mới xoá file pending** (crash giữa
  chừng không mất tin), 4xx → `rejected/`, checkpoint giới hạn 2000 id mỗi group
- `eb-client`: 2xx / **408, 429 retry** (đủ `maxAttempts`, nhãn `post_failed_retryable_4xx`) / 4xx khác
  (không retry, đúng 1 request) / 5xx (retry đúng lịch 1s→4s→16s, tối đa 4 request) / lỗi mạng
- `flush`: số liệu `status.json` lấy từ **số đo một lần** (không quét lại thư mục theo bậc hai);
  thời gian flush **tuyến tính** theo số record
- `runtime`: replay backlog lúc khởi động dùng **đúng** `backendUrl` trong config của plugin
- `capture`: lỗi capture không throw ra channel; tap **thực sự gửi** tin lên backend (không chỉ
  assert queue rỗng)
- `sdk-link`: script trỏ `node_modules/openclaw` về bản cài của host

**Tap (integration với channel fork)**:
- tin group **có** tag → capture đúng 1 lần, bot vẫn trả lời
- tin group **không** tag → capture đúng 1 lần, bot **không** trả lời
- tin DM → không capture (mặc định `captureDm: false`)
- group ngoài allowlist → không capture

**E2E (thủ công — không tự động hoá được vì cần boot gateway và gửi tin thật trong Zalo)**:
bật gateway rồi chạy checklist 4 kịch bản trong README (mục *Checklist nghiệm thu end-to-end*):
tin group có tag (capture đúng 1 lần **và** bot vẫn trả lời), tin group không tag (capture đúng 1 lần
**và** bot im lặng), tin DM (không capture), group ngoài allowlist (không capture). Mỗi kịch bản verify
bằng log `message_forwarded`, `status.json` và `checkpoint.json`; backend nhận đúng 6 field.
