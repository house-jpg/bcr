const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const BOT_TOKEN = process.env.TOKEN_BOT || "";
const SCREENSHOT_TRIGGER = String(process.env.TRIGGER || "class")
  .trim()
  .toLowerCase();

function resolveScreenshotEntry() {
  if (process.env.SCREENSHOT_BOT_ENTRY) {
    return process.env.SCREENSHOT_BOT_ENTRY;
  }

  if (SCREENSHOT_TRIGGER === "api") {
    return "serviceScreenshot/manualIndex.js";
  }

  return "serviceScreenshot/classIndex.js";
}

module.exports = {
  BOT_TOKEN,
  SCREENSHOT_TRIGGER,
  SCREENSHOT_BOT_ENTRY: resolveScreenshotEntry(),
  BROWSER_HEADLESS: process.env.SCREENSHOT_BOT_HEADLESS || "false",
  STORE_PATH: path.resolve(__dirname, "../runtime/telegram-admin-store.json"),
  BOT_USERNAME: process.env.BOT_USERNAME || "",
  ADMIN_PANEL_USER_IDS: new Set(
    [process.env.OWNER_ID, process.env.ADMIN_ID, process.env.ADMIN_IDS]
      .filter(Boolean)
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  DEFAULT_TABLE_NAME: String(
    process.env.BOT_INIT_TABLE_NAME || process.env.SCREENSHOT_TABLE_NAME || "",
  ).trim(),
  DEFAULT_TOTAL: Number(
    process.env.BOT_INIT_TOTAL_AMOUNT ||
      process.env.SCREENSHOT_BET_TOTAL_AMOUNT ||
      0,
  ),
  DEFAULT_BET_INIT: Number(
    process.env.BOT_INIT_BET_INIT_AMOUNT ||
      process.env.SCREENSHOT_BET_INIT_AMOUNT ||
      5000,
  ),
};
