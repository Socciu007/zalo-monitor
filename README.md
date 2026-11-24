# zalo-monitor

Plugin OpenClaw — **fork** của channel plugin `@openclaw/zalouser` (Zalo Personal, chạy qua thư viện `zca-js` không chính thức).

Plugin capture **mọi** tin nhắn Zalo **trong group** — kể cả tin **không tag bot** — ghi vào queue bền vững trên đĩa rồi POST **nguyên văn** lên backend để backend tự phân loại.

> **Bảo đảm:** bot vẫn **chỉ trả lời** tin nhắn tag nó. Hành vi trả lời không đổi — plugin này chỉ quan sát, không trả lời, không lọc.

> ⚠️ **Rủi ro:** Zalo automation là tích hợp **không chính thức** — tài khoản có nguy cơ bị khoá/ban. Fork này không làm thay đổi mức phơi nhiễm đó; nó chỉ quan sát những tin nhắn mà channel đã nhận.

## Vì sao phải fork

Channel plugin `zalouser` upstream **tự bỏ rơi** tin nhắn group không tag bot *bên trong chính plugin*, trước khi host OpenClaw kịp nhìn thấy. Trong `vendor/zalouser/dist/monitor-*.js`, hàm `processMessage()`:

```js
if (isGroup && mentionDecision.shouldSkip) {
    ...
    return;
}
```

Lệnh `return` này nằm **trước** `core.channel.inbound.dispatchReply(...)`. Hệ quả: các hook phía host mà một plugin thông thường dùng để quan sát **không bao giờ chạy** với tin không tag:

| Hook của host | Vì sao không dùng được |
|---|---|
| `message_received` | Được fire bên trong `dispatch-from-config` của host — **sau** cái gate trên. Hook này chỉ quan sát (không chiếm quyền dispatch), và với tin không tag thì không bao giờ tới được chỗ fire. |
| `before_dispatch` | Hook claiming: trả `{handled:true}` thì chặn được lượt chạy agent (không gọi model, không reply). Nhưng nó cũng chỉ chạy **sau** gate, nên cũng không thấy tin không tag. |
| `inbound_claim` | Có field `wasMentioned`, nhưng global runner trong build OpenClaw này **không có call site** cho inbound message thường (chỉ có biến thể targeted cho plugin-owned binding), nên không dựa vào được. |

Thêm nữa: mention native của Zalo là **một entity riêng** (`data.mentions` = danh sách user id), **không** nằm trong text. Chỉ channel plugin mới nhìn thấy `wasExplicitlyMentioned` và implicit mention (quote bot). Plugin phía host chỉ có thể suy ra mention từ text — không đủ fidelity.

⇒ Không có cách nào quan sát đầy đủ tin group không tag mà **không fork** channel plugin.

### Tap được cắm thế nào

`scripts/vendor-refresh.mjs` copy package `@openclaw/zalouser` từ `node_modules` vào `vendor/zalouser/`, **tìm file chứa `async function processMessage(` theo nội dung** (tên file là build hash, đổi mỗi release), rồi chèn **một import tĩnh + một lệnh gọi**:

```js
import { captureZaloMessage } from "../capture.js";
// ...
captureZaloMessage({
    isGroup,
    chatId,
    groupName,
    senderId,
    senderName,
    rawBody: message.content,
    mentioned: mentionDecision.effectiveWasMentioned,
    messageId: resolveZalouserMessageSid({ msgId: message.msgId, cliMsgId: message.cliMsgId, fallback: String(message.timestampMs) }),
    rootConfig: config
});
```

Tap nằm **sau** group/sender access gate và **trước** mention gate ⇒ capture đúng những gì channel nhận (không vượt policy) **và** kể cả tin không tag bot.

`rawBody: message.content` là text **chưa trim** (biến `rawBody` của upstream đã `.trim()` sẵn) ⇒ text forward đi **nguyên văn**.

Script **fail loudly** (exit non-zero) nếu không tìm thấy anchor, và không bao giờ thay cây vendor đang chạy bằng cây hỏng (stage → swap).

## Luồng xử lý

1. **Capture** — tap chạy non-blocking, fail-safe: lỗi capture chỉ được log, **không** ném exception ra channel, không chặn luồng chat.
2. **Ghi queue** — mỗi tin thành 1 file JSON trong `pending/`, ghi **trước** mọi lần gọi mạng.
3. **Giao** — worker flush đọc `pending/` (đơn giản single-flight) và POST lên backend.
4. **Xác nhận** — chỉ khi backend trả `2xx` mới xoá file pending và ghi checkpoint.

## Cấu trúc thư mục

```
e:\projectVN\zalo-monitor\
├─ package.json              # plugin "zalo-monitor"; scripts: build, test, typecheck, vendor:refresh
├─ openclaw.plugin.json      # manifest: id zalo-monitor, channels ["zalouser"], preferOver ["zalouser"]
├─ tsconfig.json
├─ .gitignore
├─ src\
│  ├─ index.ts               # plugin entry (defineBundledChannelEntry) — đăng ký channel + tool zalouser
│  ├─ setup-entry.ts         # setup entry (màn hình QR login)
│  ├─ runtime.ts             # flush timer + replay-on-start
│  ├─ capture.ts             # TAP: captureZaloMessage() — non-blocking, fail-safe
│  ├─ flush.ts               # delivery worker trên pending queue (single-flight)
│  ├─ eb-client.ts           # POST backend + retry/backoff
│  ├─ queue.ts               # pending/ queue, checkpoint.json, status.json
│  ├─ normalize.ts           # payload 6 field gửi backend
│  ├─ config.ts              # settings từ plugins.entries["zalo-monitor"].config
│  ├─ state.ts               # state paths + atomic JSON writes
│  └─ *.test.ts              # 34 test, node:test
├─ scripts\
│  ├─ vendor-refresh.mjs     # vendor + patch upstream zalouser channel
│  ├─ copy-vendor.mjs        # build step: vendor/zalouser/dist → dist/zalouser
│  └─ clean-dist.mjs         # build step: xoá dist/ trước khi tsc
├─ vendor\zalouser\          # vendored, đã patch @openclaw/zalouser 2026.5.28 (23 file tracked)
└─ docs\superpowers\         # design spec + implementation plan
```

## Hợp đồng backend

`POST` tới `backendUrl`, body **đúng sáu field**:

```json
{
  "platform": "zalo",
  "content": "<text nguyên văn>",
  "groupId": "<chatId>",
  "groupName": "<tên group>",
  "userId": "<senderId>",
  "senderName": "<tên người gửi>"
}
```

| Kết quả | Hành động |
|---|---|
| `2xx` | **delivered** — xoá record khỏi queue, ghi checkpoint. |
| `4xx` | **rejected** — **không retry**; record chuyển vào `pending/rejected/` để soi. |
| `5xx` / lỗi mạng / timeout | **retry** với backoff `1s → 4s → 16s`, tối đa **4 request**; hết lượt thì giữ record trong queue để giao lại sau. |

Plugin **không** phân loại, **không** lọc, **không** bỏ tin nào — forward nguyên text. Việc phân loại thuộc về backend.

## Bền vững

- Tin nhắn được ghi vào đĩa **trước** bất kỳ lần gọi mạng nào, và chỉ bị xoá **sau** khi backend trả `2xx`.
- `checkpoint.json` ghi lại message id đã giao theo từng group ⇒ khi reconnect, tin đã giao không bị giao lại.
- Backend chết lâu ⇒ `pending/` tích tụ, tin không mất; lần khởi động sau sẽ replay (`capture_replayed_on_start`).

## State trên đĩa

Nằm dưới state dir của OpenClaw (`~/.openclaw` mặc định):

```
<state-dir>/plugin-state/zalo-monitor/
├─ checkpoint.json     # { "<groupId>": { "<messageId>": { "at": "<iso>" } } }
├─ pending/            # mỗi tin 1 file JSON: đã capture, chưa giao được
│  └─ rejected/        # tin backend từ chối bằng 4xx
└─ status.json         # { pending, rejected, lastPostAt, lastPostStatus, lastError, updatedAt }
```

```json
{
  "pending": 0,
  "rejected": 0,
  "lastPostAt": "2026-11-24T09:12:33.120Z",
  "lastPostStatus": 201,
  "lastError": null,
  "updatedAt": "2026-11-24T09:12:33.121Z"
}
```

Log (`openclaw channels logs --channel zalouser`): `message_forwarded`, `post_rejected_4xx`, `post_failed_after_retries`, `capture_replayed_on_start`.

## Cấu hình

Đọc từ entry riêng của plugin trong `~/.openclaw/openclaw.json`:

```json5
"plugins": {
  "entries": {
    "zalo-monitor": {
      "enabled": true,
      "config": {
        "backendUrl": "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
        "timeoutMs": 10000,
        "maxAttempts": 4,
        "retryDelaysMs": [1000, 4000, 16000],
        "captureDm": false,
        "flushIntervalMs": 60000
      }
    }
  }
}
```

Mọi field đều **optional**; giá trị sai kiểu rơi về default chứ không làm sập channel. `captureDm: false` ⇒ chỉ capture tin nhắn **group**.

## Cài đặt

Thứ tự **bắt buộc** — làm đúng theo thứ tự dưới đây:

```bash
cd e:/projectVN/zalo-monitor
npm install --legacy-peer-deps
npm run build
openclaw plugins install --link e:/projectVN/zalo-monitor
```

`--link` ghi đường dẫn repo vào `plugins.load.paths` trong `~/.openclaw/openclaw.json` (không copy), nên sửa code ở repo này rồi restart gateway là xong, không cần cài lại.

Sau đó sửa **`~/.openclaw/openclaw.json`**:

1. **BẮT BUỘC — tắt bản npm gốc** để chỉ có **một** kết nối Zalo: set `plugins.entries.zalouser.enabled` thành `false`. Bật cả hai sẽ chạy **hai** client `zca-js` trên cùng một tài khoản Zalo.
2. Thêm entry `zalo-monitor` như ở mục [Cấu hình](#cấu-hình).

```json5
{
  "plugins": {
    "entries": {
      // (1) BẮT BUỘC — tắt bản npm của zalouser
      "zalouser": {
        "enabled": false
      },
      // (2) Entry của zalo-monitor
      "zalo-monitor": {
        "enabled": true,
        "config": {
          "backendUrl": "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
          "timeoutMs": 10000,
          "maxAttempts": 4,
          "retryDelaysMs": [1000, 4000, 16000],
          "captureDm": false,
          "flushIntervalMs": 60000
        }
      }
    }
  }
}
```

Rồi restart gateway:

```bash
openclaw gateway restart
```

## Kiểm tra sau cài

```bash
openclaw plugins list          # zalo-monitor enabled, zalouser (npm) disabled
openclaw channels status       # channel zalouser có đúng MỘT owner
openclaw channels logs --channel zalouser
```

- `openclaw plugins list` → `zalo-monitor` enabled, `zalouser` (bản npm) disabled.
- `openclaw channels status` → channel `zalouser` có **đúng một** owner. Nếu có hai ⇒ bản npm chưa được tắt.
- `openclaw channels logs --channel zalouser` → thấy event `message_forwarded` sau khi có tin nhắn group.
- `<state-dir>/plugin-state/zalo-monitor/status.json` → `pending` về `0`.

## Nâng cấp `@openclaw/zalouser`

```bash
# 1. bump version @openclaw/zalouser trong package.json
npm install --legacy-peer-deps
npm run vendor:refresh
npm run build
openclaw gateway restart
```

Nếu cấu trúc file upstream thay đổi, `vendor:refresh` **fail loudly** và cây vendor cũ được giữ nguyên — không bao giờ thay bằng cây hỏng.

## Development

```bash
npm run build       # tsc + copy vendor → dist/
npm test            # 34 test, node:test (chạy trên JS đã build)
npm run typecheck   # tsc --noEmit
```

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Zalo automation không chính thức ⇒ khoá/ban tài khoản | Cảnh báo ở đầu README; fork không thay đổi mức phơi nhiễm, chỉ quan sát tin channel đã nhận. |
| Quên tắt bản npm ⇒ hai kết nối Zalo | Bước 1 ở mục *Cài đặt* là bắt buộc; kiểm tra bằng `openclaw channels status`. |
| Backend chết lâu ⇒ `pending/` phình | `status.json` + `pending/rejected/` để soi; tin không mất. |
| Fork lệch khi upstream nâng cấp | `vendor-refresh` fail-safe; version pin trong `package.json`. |
| Tap làm chậm luồng chat | Tap non-blocking, không await network, fail-safe. |
