const axios = require("axios");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const { getCurrentTime } = require("./helper");

const telegramBotCache = new Map();

function getTelegramBot(token) {
  if (!token) {
    return null;
  }

  if (!telegramBotCache.has(token)) {
    telegramBotCache.set(token, new TelegramBot(token, { polling: false }));
  }

  return telegramBotCache.get(token);
}

async function requestData(sessionId) {
  const url = process.env.URI_REQUEST_DATA + sessionId;

  const headers = {
    "accept-language": "vi-VN,vi;q=0.9",
    accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  };

  const payload = new URLSearchParams();
  payload.append("gameGroupId", 2);

  try {
    const response = await axios.post(url, payload, { headers });
    return response.data;
  } catch (error) {
    console.error("Error calling API:", error.message);
    return {};
  }
}

async function CollectingResponseSession(response, isCollecting) {
  if (!isCollecting) return;

  const url = response.url();
  const status = response.status();
  const request = response.request();
  const resourceType = request.resourceType();
  try {
    // Debug log để kiểm tra
    console.log(`[DEBUG] Response: ${resourceType} - ${url}`);
    console.log(await response.text());
    if (
      (resourceType === "xhr" || resourceType === "fetch") &&
      url.includes("https://bfscg.awamat.com")
    ) {
      let responseBody = "NONE";
      let sessionId = undefined;
      responseBody = await response.text();

      const match = url.match(/jsessionid=([^?]+)/);
      sessionId = match ? match[1] : undefined;

      console.log(`[SESSION] Found sessionId: ${sessionId} from URL: ${url}`);
      return sessionId;
    }
  } catch (error) {
    console.error("[ERROR] CollectingResponseSession:", error.message);
    return undefined;
  }
  return undefined;
}

async function CollectingResponseSessionV2(response, isCollecting) {
  if (!isCollecting) return;

  const url = response.url();
  const status = response.status();
  const request = response.request();
  const resourceType = request.resourceType();

  try {
    console.log(`[DEBUG] Response: ${resourceType} - ${url}`);
    if (resourceType === "xhr" || resourceType === "fetch") {
      // sảnh rất thường hay đổi domain chỉ cần request có session thì sẽ lấy
      // Lấy headers từ request thay vì từ URL
      const headers = request.headers();
      const cookieHeader = headers["cookie"] || headers["Cookie"];

      let sessionId = undefined;

      if (cookieHeader) {
        // Tìm JSESSIONID trong cookie header
        const jsessionidMatch = cookieHeader.match(/JSESSIONID=([^;]+)/);
        sessionId = jsessionidMatch ? jsessionidMatch[1] : undefined;

        if (sessionId) {
          console.log(
            `[SESSION] Found sessionId: ${sessionId} from Request Headers`
          );
          console.log(`[COOKIE] Full cookie: ${cookieHeader}`);
          return sessionId;
        }
      }

      // Nếu không tìm thấy trong cookie, thử tìm trong URL (fallback)
      const urlMatch = url.match(/jsessionid=([^?]+)/i);
      sessionId = urlMatch ? urlMatch[1] : undefined;

      if (sessionId) {
        console.log(`[SESSION] Found sessionId: ${sessionId} from URL`);
        return sessionId;
      }

      console.log(`[SESSION] No sessionId found for URL: ${url}`);
      return undefined;
    }
  } catch (error) {
    console.error("[ERROR] CollectingResponseSession:", error.message);
    return undefined;
  }
  return undefined;
}

async function callQueryInitWebGameHall(sessionId) {
  const url = process.env.URI_REQUEST_DATA + sessionId;

  const headers = {
    "accept-language": "vi-VN,vi;q=0.9",
    accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  };

  const payload = new URLSearchParams();
  payload.append("gameGroupId", 2);

  try {
    const response = await axios.post(url, payload, { headers });
    return response.data;
  } catch (error) {
    console.error("Error calling API:", error.message);
    return null;
  }
}

async function sendTelegramMessage(token, idRecipient, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await axios.post(url, { chat_id: idRecipient, text: message });
  } catch (err) {
    console.error("Lỗi khi gửi Telegram:", err.response?.data || err.message);
  }
}

async function sendTelegramPhoto(token, idRecipient, photoPath, options = {}) {
  const bot = getTelegramBot(token);

  if (!bot || !idRecipient || !photoPath) {
    return false;
  }

  const photoStream = fs.createReadStream(photoPath);
  const fileOptions = {
    filename: path.basename(photoPath),
    contentType: "image/png",
  };

  try {
    await bot.sendPhoto(idRecipient, photoStream, options, fileOptions);
    return true;
  } catch (err) {
    console.error(
      "Lỗi khi gửi ảnh Telegram:",
      err.response?.body || err.response?.data || err.message,
    );
    return false;
  } finally {
    photoStream.destroy();
  }
}

module.exports = {
  callQueryInitWebGameHall,
  CollectingResponseSession,
  CollectingResponseSessionV2,
  sendTelegramMessage,
  sendTelegramPhoto,
  requestData,
};
