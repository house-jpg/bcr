const path = require("path");
const { spawn } = require("child_process");

function createProcessManager({
  screenshotEntry,
  screenshotHeadless,
  subscriberStore,
}) {
  let screenshotChild = null;
  let currentTableName = null;

  function buildStatusMessage() {
    if (!screenshotChild || screenshotChild.exitCode !== null) {
      return "Screenshot bot is idle.";
    }

    const subscriberCount = subscriberStore?.getChatIds().length || 0;
    return `Screenshot bot is running on table ${currentTableName} for ${subscriberCount} subscribed group(s).`;
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
        resolve(false);
        return;
      }

      const child = screenshotChild;
      screenshotChild = null;
      currentTableName = null;

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

  function isProcessRunning() {
    return Boolean(screenshotChild && screenshotChild.exitCode === null);
  }

  async function startScreenshotProcess(config) {
    if (!isConfigReady(config)) {
      throw new Error(
        "Cấu hình chưa đủ. Cần có bàn, tổng lãi và tiền cược hợp lệ trước khi start.",
      );
    }

    const nextTableName = String(config.tableName).toUpperCase();

    if (isProcessRunning()) {
      if (currentTableName === nextTableName) {
        return false;
      }

      throw new Error(
        `Bot đang chạy bàn ${currentTableName}. Hãy /stop toàn bộ trước khi đổi sang bàn ${nextTableName}.`,
      );
    }

    currentTableName = nextTableName;

    const tableNameForChild = currentTableName;
    const child = spawn("node", [screenshotEntry], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        SCREENSHOT_TABLE_NAME: tableNameForChild,
        BROWSER_HEADLESS: screenshotHeadless,
        SCREENSHOT_INTEGRATED_ENABLED: "false",
        SCREENSHOT_BET_TOTAL_AMOUNT: String(config.betConfig.total),
        SCREENSHOT_BET_INIT_AMOUNT: String(config.betConfig.betInit),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    screenshotChild = child;

    attachPrefixedLogs(child, `screenshot:${currentTableName}`);

    child.once("exit", (code, signal) => {
      process.stdout.write(
        `[screenshot:${tableNameForChild}] exited code=${code} signal=${signal}\n`,
      );
      if (screenshotChild === child) {
        screenshotChild = null;
        currentTableName = null;
      }
    });

    return true;
  }

  return {
    buildStatusMessage,
    isConfigReady,
    isProcessRunning,
    startScreenshotProcess,
    stopScreenshotProcess,
  };
}

module.exports = {
  createProcessManager,
};
