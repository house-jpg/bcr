const path = require("path");
const { spawn } = require("child_process");

function createProcessManager({ screenshotEntry, screenshotHeadless }) {
  let screenshotChild = null;
  let currentTableName = null;
  let activeTargetTitle = null;
  let activeRecipientChatId = null;

  function buildStatusMessage() {
    if (!screenshotChild || screenshotChild.exitCode !== null) {
      return "Screenshot bot is idle.";
    }

    const target = activeTargetTitle || activeRecipientChatId || "unknown-chat";
    return `Screenshot bot is running for ${target} on table ${currentTableName}.`;
  }

  function isConfigReady(config) {
    return Boolean(
      config &&
      config.tableName &&
      Number.isFinite(config.betConfig?.total) &&
      Number.isFinite(config.betConfig?.betInit) &&
      config.betConfig.betInit > 0,
    );
  }

  function stopScreenshotProcess() {
    return new Promise((resolve) => {
      if (!screenshotChild || screenshotChild.exitCode !== null) {
        screenshotChild = null;
        currentTableName = null;
        activeTargetTitle = null;
        activeRecipientChatId = null;
        resolve(false);
        return;
      }

      const child = screenshotChild;
      screenshotChild = null;
      currentTableName = null;
      activeTargetTitle = null;
      activeRecipientChatId = null;

      child.once("exit", () => resolve(true));
      child.kill("SIGTERM");

      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
    });
  }

  function attachPrefixedLogs(child, prefix) {
    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[${prefix}] ${chunk}`);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[${prefix}] ${chunk}`);
    });
  }

  async function startScreenshotProcess(config, runtimeMeta = {}) {
    if (!isConfigReady(config)) {
      throw new Error(
        "Cấu hình chưa đủ. Cần có bàn, tổng lãi và tiền cược hợp lệ trước khi start.",
      );
    }

    await stopScreenshotProcess();

    currentTableName = String(config.tableName).toUpperCase();
    activeTargetTitle = runtimeMeta.targetTitle || "unknown-chat";
    activeRecipientChatId = String(runtimeMeta.recipientChatId || "");

    const child = spawn("node", [screenshotEntry], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        SCREENSHOT_TABLE_NAME: currentTableName,
        BROWSER_HEADLESS: screenshotHeadless,
        SCREENSHOT_INTEGRATED_ENABLED: "false",
        SCREENSHOT_BET_TOTAL_AMOUNT: String(config.betConfig.total),
        SCREENSHOT_BET_INIT_AMOUNT: String(config.betConfig.betInit),
        SCREENSHOT_TELEGRAM_CHAT_ID: String(runtimeMeta.recipientChatId || ""),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    screenshotChild = child;

    attachPrefixedLogs(child, `screenshot:${currentTableName}`);

    child.once("exit", (code, signal) => {
      process.stdout.write(
        `[screenshot:${currentTableName}] exited code=${code} signal=${signal}\n`,
      );
      if (screenshotChild === child) {
        screenshotChild = null;
        currentTableName = null;
        activeTargetTitle = null;
        activeRecipientChatId = null;
      }
    });
  }

  return {
    buildStatusMessage,
    isConfigReady,
    startScreenshotProcess,
    stopScreenshotProcess,
  };
}

module.exports = {
  createProcessManager,
};
