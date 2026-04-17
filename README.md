# 📦 img-up-bot

Bot Telegram chạy trên Cloudflare Workers, tự động upload ảnh/video/tài liệu lên hệ thống lưu trữ [CF-imgbed](https://github.com/MarSeventh/CloudFlare-ImgBed).

---

## ✨ Tính năng

- 📷 Upload ảnh, video, audio, document, animation
- 🗂️ Quản lý thư mục upload (`/admin uploadfolder`)
- 🔒 Chế độ Public/Private cho người dùng
- 📊 Thống kê upload theo người dùng
- 🚫 Ban/unban người dùng
- ⚡ **Copy Mode** — forward file Telegram sang kênh CF-imgbed, ghi thẳng vào KV (không tải về Worker)
- 🔑 Tất cả cấu hình hỗ trợ cả lệnh admin lẫn Worker Secret env vars

---

## 🚀 Triển khai

### Yêu cầu

- Tài khoản [Cloudflare](https://cloudflare.com) (Workers + KV)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm i -g wrangler`
- Bot Telegram (tạo qua [@BotFather](https://t.me/BotFather))
- CF-imgbed đã triển khai và hoạt động

### Các bước

```bash
# 1. Clone repo
git clone https://github.com/your-username/img-up-bot.git
cd img-up-bot

# 2. Đăng nhập Cloudflare
npx wrangler login

# 3. Tạo KV namespace
npx wrangler kv namespace create STATS_STORAGE
# → Copy ID trả về, điền vào wrangler.toml

# 4. Đặt các biến bắt buộc (Worker Secrets)
npx wrangler secret put BOT_TOKEN
npx wrangler secret put IMG_BED_URL
npx wrangler secret put AUTH_CODE
npx wrangler secret put ADMIN_USER_ID

# 5. Deploy
npx wrangler deploy

# 6. Đặt webhook Telegram
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://imgupbot.<your-subdomain>.workers.dev"
```

---

## ⚙️ Biến môi trường

### Bắt buộc

| Biến | Mô tả |
|------|-------|
| `BOT_TOKEN` | Token bot Telegram (lấy từ @BotFather) |
| `IMG_BED_URL` | URL API upload CF-imgbed, VD: `https://img.example.com/upload` |
| `AUTH_CODE` | Mã xác thực CF-imgbed (nếu có) |
| `ADMIN_USER_ID` | Telegram User ID của admin bot |

### Copy Mode — Telegram Forward

| Biến | Mô tả |
|------|-------|
| `IMGBED_CF_BOT_TOKEN` | Token bot TG của CF-imgbed (xem trường `TgBotToken` trong file backup) |
| `IMGBED_TG_CHAT_ID` | Chat ID kênh TG lưu file (xem trường `TgChatId` trong backup), VD: `-1001234567890` |
| `IMGBED_CHANNEL_NAME` | Tên kênh CF-imgbed, VD: `ATP_Img` (xem trường `ChannelName` trong backup) |

### Copy Mode — KV Write (khác account CF)

| Biến | Mô tả |
|------|-------|
| `IMGBED_CF_API_TOKEN` | CF API Token có quyền **KV Storage: Edit** (account CF-imgbed) |
| `IMGBED_CF_ACCOUNT_ID` | Account ID của account CF chứa CF-imgbed |
| `IMGBED_KV_NAMESPACE_ID` | KV Namespace ID của CF-imgbed |

> **Lưu ý:** Env vars có độ ưu tiên cao hơn giá trị đặt qua lệnh `/admin`. Khuyến nghị dùng `npx wrangler secret put <TÊN>` để tránh lộ giá trị trong code.

---

## ⚡ Copy Mode (Nâng cao)

Copy Mode cho phép bot upload **không tải file về Worker**. Thay vì download về rồi re-upload, luồng hoạt động:

1. **Auto-discover kênh** — Gọi API CF-imgbed (`/api/manage/list`) dùng `cftoken` để lấy `TgChatId` và `ChannelName` (cache vào KV, các lần sau không cần gọi API lại)
2. **Forward file** — Dùng `BOT_TOKEN` của bot upload (đã là admin kênh) để `forwardMessage` vào kênh TG lưu trữ của CF-imgbed
3. **Lấy file_id mới** — Lấy `TgFileId` từ message vừa forward (file_id này hợp lệ với `BOT_TOKEN` của bot)
4. **Ghi KV trực tiếp** — Ghi metadata theo schema CF-imgbed vào KV (binding hoặc REST API)

> **Quan trọng:** Copy Mode ON = **bắt buộc thành công**. Nếu bất kỳ bước nào thất bại → báo lỗi ngay cho user, không fallback về re-upload.

**Lợi ích:**
- File không đi qua RAM Worker → tiết kiệm tài nguyên đáng kể
- Không bị giới hạn 20MB của Cloudflare Workers
- Tốc độ nhanh hơn nhiều
- `TgBotToken` trong schema = `BOT_TOKEN` của bot upload → CF-imgbed dùng nó để `getFile` khi serve — hoạt động vì bot đã có quyền admin kênh

### Thiết lập Copy Mode

#### Bước 1: Thêm bot vào kênh TG của CF-imgbed

Bot upload của bạn phải được thêm là **admin** vào kênh Telegram lưu file của CF-imgbed (kênh có `TgChatId` trong backup).

#### Bước 2: Đặt Admin Token để auto-discover kênh

```
/admin cftoken <admin_token_của_cf_imgbed>
```

Bot sẽ tự gọi `/api/manage/list` để lấy `TgChatId` và `ChannelName`. Thông tin được cache vào KV sau lần đầu.

> **Thay thế thủ công** (nếu API không khả dụng hoặc chưa có file nào):
> ```
> /admin cfchatid <TgChatId_từ_backup>
> /admin cfchannel <ChannelName_từ_backup>
> ```

#### Bước 3: Thiết lập KV Write

**Cách A — Cùng Cloudflare account** (đơn giản, nhanh nhất):

```toml
# wrangler.toml — thêm binding này (bỏ dấu #)
[[kv_namespaces]]
binding = "IMGBED_KV"
id = "ID_KV_NAMESPACE_CUA_CF_IMGBED"
```
Lấy ID: CF Dashboard (account CF-imgbed) → Storage → KV → tên namespace → ID.

**Cách B — Khác Cloudflare account**:

```
/admin cfapitoken <CF_API_Token_có_quyền_KV_Edit>
/admin cfaccid   <Account_ID_account_CF_imgbed>
/admin cfkvid    <KV_Namespace_ID_của_CF_imgbed>
```

Tạo API Token: CF Dashboard (account CF-imgbed) → My Profile → API Tokens → Create Token → quyền **KV Storage: Edit**.

#### Bước 4: Bật Copy Mode

```
/admin copy on
/admin cfstatus   ← kiểm tra toàn bộ cấu hình + cảnh báo thiếu sót
```

---

## 📋 Lệnh Admin

Tất cả lệnh admin có dạng `/admin <lệnh> [tham số]`. Chỉ `ADMIN_USER_ID` mới dùng được.

### Cơ bản

| Lệnh | Mô tả |
|------|-------|
| `/admin mode public` | Cho phép mọi người dùng bot |
| `/admin mode private` | Chỉ admin dùng được bot |
| `/admin uploadfolder <path>` | Đặt thư mục upload mặc định, VD: `/guest` |
| `/admin uploadfolder reset` | Về thư mục gốc |

### Quản lý người dùng

| Lệnh | Mô tả |
|------|-------|
| `/admin ban <user_id>` | Cấm người dùng |
| `/admin unban <user_id>` | Gỡ cấm |
| `/admin list` | Danh sách bị cấm |

### Copy Mode

| Lệnh | Mô tả |
|------|-------|
| `/admin copy on` | Bật Copy Mode |
| `/admin copy off` | Tắt Copy Mode |
| `/admin copy` | Xem trạng thái |
| `/admin cfstatus` | Kiểm tra toàn bộ cấu hình Copy Mode |
| `/admin cfbottoken <token>` | Token bot TG của CF-imgbed |
| `/admin cfbottoken clear` | Xóa token |
| `/admin cfchatid <id>` | Chat ID kênh TG của CF-imgbed |
| `/admin cfchannel <name>` | Tên kênh (metadata) |
| `/admin cfapitoken <token>` | Cloudflare API Token (khác account) |
| `/admin cfaccid <id>` | CF Account ID (khác account) |
| `/admin cfkvid <id>` | KV Namespace ID (khác account) |
| `/admin cftoken <token>` | Token quản trị CF-imgbed `/api/manage/*` |

### Thống kê

| Lệnh | Mô tả |
|------|-------|
| `/stats` | Thống kê upload của bạn |
| `/admin stats` | Thống kê toàn hệ thống |

---

## 🏗️ Cấu trúc KV (STATS_STORAGE)

Bot lưu tất cả cấu hình và thống kê vào KV `STATS_STORAGE`:

| Key | Mô tả |
|-----|-------|
| `bot_public_mode` | `"true"` / `"false"` |
| `upload_folder` | Thư mục upload mặc định |
| `copy_mode` | `"true"` / `"false"` |
| `imgbed_admin_token` | Token quản trị CF-imgbed |
| `imgbed_cf_bot_token` | Token bot TG của CF-imgbed |
| `imgbed_tg_chat_id` | Chat ID kênh TG CF-imgbed |
| `imgbed_channel_name` | Tên kênh CF-imgbed |
| `imgbed_cf_api_token` | CF API Token (khác account) |
| `imgbed_cf_account_id` | CF Account ID (khác account) |
| `imgbed_kv_namespace_id` | KV Namespace ID (khác account) |
| `stats_global` | JSON thống kê toàn hệ thống |
| `stats_<chat_id>` | JSON thống kê từng user |
| `banned_users` | JSON danh sách user bị cấm |

---

## 🔒 Bảo mật

- **`TgBotToken` của CF-imgbed** được lưu trong KV (encrypted at rest bởi Cloudflare). Không commit vào Git.
- Sử dụng `npx wrangler secret put` thay vì `[vars]` trong `wrangler.toml` cho các giá trị nhạy cảm.
- Chế độ `private` chặn hoàn toàn người dùng không phải admin.
- Cloudflare API Token chỉ cần quyền `KV Storage: Edit` — không cần quyền rộng hơn.

---

## 📝 Schema KV của CF-imgbed

Bot ghi dữ liệu theo đúng schema mà CF-imgbed sử dụng:

```json
{
  "FileName": "ten-file.jpg",
  "FileType": "image/jpeg",
  "FileSize": "0.18",
  "FileSizeBytes": 193631,
  "UploadIP": "0.0.0.0",
  "UploadAddress": "未知",
  "ListType": "None",
  "TimeStamp": 1776338340230,
  "Label": "None",
  "Directory": "guest",
  "Tags": [],
  "Channel": "TelegramNew",
  "ChannelName": "ATP_Img",
  "TgFileId": "AgACBe...",
  "TgChatId": "-1003097799202",
  "TgBotToken": "8317...DU"
}
```

KV key có dạng: `{timestamp}_{tên_file_đã_normalize}`

---

## 📜 License

[MIT](LICENSE)
