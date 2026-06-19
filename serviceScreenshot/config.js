const os = require("os");
const path = require("path");

const {
  account_1,
  account_2,
  account_3,
  account_4,
  account_5,
} = require("../servicePuppeteer/account.puppeteer");

const ACCOUNT_INDEX = String(process.env.SCREENSHOT_ACCOUNT_INDEX || "1");
const DEFAULT_WORKER_ID = `${os.hostname()}-${process.pid}`;

const ACCOUNT_MAP = {
  1: account_1,
  2: account_2,
  3: account_3,
  4: account_4,
  5: account_5,
};

module.exports = {
  account: ACCOUNT_MAP[ACCOUNT_INDEX] || account_1,
  autoLoginEnabled:
    String(process.env.AUTO_LOGIN || "").toLowerCase() === "true",
  autoUsernameAccount: process.env.AUTO_USERNAME_ACCOUNT || "",
  autoPasswordAccount: process.env.AUTO_PASSWORD_ACCOUNT || "",
  autoLoginTimeoutMs: Number(
    process.env.SCREENSHOT_AUTO_LOGIN_TIMEOUT_MS || 120000,
  ),
  autoLoginMaxAttempts: Number(
    process.env.SCREENSHOT_AUTO_LOGIN_MAX_ATTEMPTS || 2,
  ),
  defaultTimeout: Number(process.env.SCREENSHOT_DEFAULT_TIMEOUT_MS || 60000),
  seamlessFrameTimeoutMs: Number(
    process.env.SCREENSHOT_SEAMLESS_FRAME_TIMEOUT_MS || 60000,
  ),
  frameTimeoutMs: Number(process.env.SCREENSHOT_FRAME_TIMEOUT_MS || 25000),
  actionTimeoutMs: Number(process.env.SCREENSHOT_ACTION_TIMEOUT_MS || 8000),
  inputTimeoutMs: Number(process.env.SCREENSHOT_INPUT_TIMEOUT_MS || 8000),
  visibleTimeoutMs: Number(process.env.SCREENSHOT_VISIBLE_TIMEOUT_MS || 12000),
  postFrameDelayMs: Number(process.env.SCREENSHOT_POST_FRAME_DELAY_MS || 600),
  interactionDelayMs: Number(
    process.env.SCREENSHOT_INTERACTION_DELAY_MS || 200,
  ),
  loginResponseWaitMs: Number(process.env.SCREENSHOT_LOGIN_WAIT_MS || 3000),
  lobbyLoadWaitMs: Number(process.env.SCREENSHOT_LOBBY_WAIT_MS || 10000),
  hallNotificationWaitMs: Number(
    process.env.SCREENSHOT_HALL_NOTIFICATION_WAIT_MS || 2000,
  ),
  tableOpenWaitMs: Number(process.env.SCREENSHOT_TABLE_OPEN_WAIT_MS || 12000),
  gameInfoCardTimeoutMs: Number(
    process.env.SCREENSHOT_GAMEINFO_TIMEOUT_MS || 0,
  ),
  screenshotRetryCount: Number(process.env.SCREENSHOT_RETRY_COUNT || 2),
  screenshotRetryDelayMs: Number(process.env.SCREENSHOT_RETRY_DELAY_MS || 800),
  skipFirstDetectedUpdate:
    process.env.SCREENSHOT_SKIP_FIRST_DETECTED_UPDATE !== "false",
  watchPollIntervalMs: Number(process.env.SCREENSHOT_POLL_INTERVAL_MS || 1500),
  screenshotDebounceMs: Number(process.env.SCREENSHOT_DEBOUNCE_MS || 3000),
  manualCycleTimeoutMs: Number(
    process.env.SCREENSHOT_MANUAL_CYCLE_TIMEOUT_MS || 45000,
  ),
  outputDir: path.resolve(
    __dirname,
    process.env.SCREENSHOT_OUTPUT_DIR || "../screenshots/game-info",
  ),
  tempOutputDir: path.resolve(
    __dirname,
    process.env.SCREENSHOT_TEMP_OUTPUT_DIR || "../screenshots/game-info/.tmp",
  ),
  screenshotClaimCollection:
    process.env.SCREENSHOT_CLAIM_COLLECTION || "screenshot_results",
  screenshotClaimRetentionMs: Number(
    process.env.SCREENSHOT_CLAIM_RETENTION_MS || 7 * 24 * 60 * 60 * 1000,
  ),
  workerId: process.env.SCREENSHOT_WORKER_ID || DEFAULT_WORKER_ID,
  manualOpenUrl:
    process.env.SCREENSHOT_MANUAL_OPEN_URL || process.env.DOMAIN || "",
  manualWaitRetryMs: Number(
    process.env.SCREENSHOT_MANUAL_WAIT_RETRY_MS || 2000,
  ),
  targetTableName:
    process.env.SCREENSHOT_TABLE_NAME || process.env.BOT_INIT_TABLE_NAME || "",
  recoveryTableName:
    process.env.BOT_INIT_TABLE_NAME || process.env.SCREENSHOT_TABLE_NAME || "",
  gameInfoCardRecoveryTimeoutMs: Number(
    process.env.SCREENSHOT_GAMEINFO_RECOVERY_TIMEOUT_MS || 30000,
  ),
  gameFrameRecoveryTimeoutMs: Number(
    process.env.SCREENSHOT_GAMEFRAME_RECOVERY_TIMEOUT_MS || 30000,
  ),
  tableSelector:
    process.env.SCREENSHOT_TABLE_SELECTOR || process.env.CLICK_IN_TABLE_GAME,
  useChangeStream: process.env.SCREENSHOT_USE_CHANGE_STREAM !== "false",
  isHeadless:
    String(process.env.AUTO_LOGIN || "").toLowerCase() === "true"
      ? false
      : process.env.BROWSER_HEADLESS !== "false",
  screenshotIntegratedEnabled:
    process.env.SCREENSHOT_INTEGRATED_ENABLED === "true",
};
