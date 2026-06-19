# tool_bcr_v2

## 1. Luồng Screenshot

- Chọn luồng bằng env `TRIGGER`:
  `TRIGGER=class` -> dùng `serviceScreenshot/classIndex.js`
  `TRIGGER=api` -> dùng `serviceScreenshot/manualIndex.js`
- Nếu cần, vẫn có thể override trực tiếp bằng `SCREENSHOT_BOT_ENTRY`
- Nếu `AUTO_LOGIN=true`:
  Browser Playwright sẽ tự login bằng `AUTO_USERNAME_ACCOUNT` và `AUTO_PASSWORD_ACCOUNT`
  Sau đó vào đúng table và bắt đầu watcher screenshot.
- Nếu `AUTO_LOGIN=false`:
  Browser mở lên để login tay, sau đó watcher mới tiếp tục.
- Watcher chỉ poll DOM class trong game:
  `#gameWinnerPlayer .resulf_left`
  `#gameWinnerBanker .resulf_right`
  Khi thấy `result_win_blue`, `result_win_red`, hoặc `result_tie_green` thì chụp `#gameInfoCard` và gửi ảnh về Telegram.
- `TRIGGER=class` không phụ thuộc MongoDB khi bootstrap hoặc trigger screenshot.
- `TRIGGER=api` mới dùng MongoDB để theo dõi `latestKey`/`latestRound`, chống gửi trùng, và điều khiển vòng capture theo trạng thái game.

## 2. Luồng Bot

- `npm start` chạy `scripts/startPipeline.js`
- Pipeline sẽ start:
  `server.js`
  `telegramBot/index.js`
- Nếu `TRIGGER=api`:
  pipeline sẽ nạp thêm `session.js` -> `session5.js` trước khi start server/bot.
- Nếu `TRIGGER=class`:
  pipeline bỏ qua toàn bộ bước nạp session.
- Cấu hình khởi tạo có thể set bằng env:
  `BOT_INIT_TABLE_NAME`
  `BOT_INIT_TOTAL_AMOUNT`
  `BOT_INIT_BET_INIT_AMOUNT`
- Sau khi bot chạy, cấu hình vẫn có thể sửa từ panel bot, gồm table, tổng lãi và tiền cược.
- Khi user gõ `/start`, Telegram bot sẽ spawn screenshot process riêng cho table đã cấu hình.
