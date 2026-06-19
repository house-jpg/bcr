const TelegramBot = require("node-telegram-bot-api");

const {
  ADMIN_PANEL_USER_IDS,
  BOT_TOKEN,
  BOT_USERNAME,
  DEFAULT_TABLE_NAME,
  DEFAULT_BET_INIT,
  DEFAULT_TOTAL,
  SCREENSHOT_BOT_ENTRY,
  BROWSER_HEADLESS,
  STORE_PATH,
} = require("./config");
const { createStore } = require("./store");
const { createProcessManager } = require("./processManager");
const { createAccessControl } = require("./access");
const { registerHandlers } = require("./handlers");

if (!BOT_TOKEN) {
  throw new Error("Missing TOKEN_BOT in environment");
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const botState = {
  botUsername: BOT_USERNAME,
};

const store = createStore({
  storePath: STORE_PATH,
  defaultTableName: DEFAULT_TABLE_NAME,
  defaultTotal: DEFAULT_TOTAL,
  defaultBetInit: DEFAULT_BET_INIT,
  logError: (message) => process.stderr.write(`${message}\n`),
});

const processManager = createProcessManager({
  screenshotEntry: SCREENSHOT_BOT_ENTRY,
  screenshotHeadless: BROWSER_HEADLESS,
});

const access = createAccessControl({
  adminPanelUserIds: ADMIN_PANEL_USER_IDS,
});

registerHandlers({
  bot,
  botState,
  store,
  processManager,
  access,
});

bot
  .getMe()
  .then((me) => {
    botState.botUsername = me.username || botState.botUsername;
  })
  .catch((error) => {
    process.stderr.write(`[telegram-bot] getMe failed: ${error.message}\n`);
  });

async function shutdown(signal) {
  process.stdout.write(`[telegram-bot] received ${signal}, shutting down\n`);
  await processManager.stopScreenshotProcess().catch(() => {});
  await bot.stopPolling().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    process.stderr.write(`[telegram-bot] shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    process.stderr.write(`[telegram-bot] shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});
