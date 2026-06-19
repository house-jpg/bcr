const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { autoLoginEnabled } = require("./config");
const { ScreenshotClassWatcher } = require("./classWatcher");
const { log } = require("./logger");
const { sleep } = require("./utils");

const watcherRestartDelayMs = Number(
  process.env.SCREENSHOT_WATCHER_RESTART_DELAY_MS || 5000,
);

async function main() {
  const bootstrapMode = autoLoginEnabled ? "auto-login" : "manual";
  let watcher = null;
  let isShuttingDown = false;

  const shutdown = async (signal) => {
    isShuttingDown = true;
    log(`Received ${signal}, shutting down class screenshot watcher`);
    await watcher?.shutdown().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      log(`Shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      log(`Shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });

  while (!isShuttingDown) {
    watcher = new ScreenshotClassWatcher({
      bootstrapMode,
    });

    try {
      log(
        `Starting class screenshot watcher in ${bootstrapMode} mode${
          autoLoginEnabled ? " with headless=false" : ""
        }`,
      );
      await watcher.start();
      return;
    } catch (error) {
      log(`Class watcher failed to start: ${error.message}`);
      await watcher.shutdown().catch(() => {});

      if (isShuttingDown) {
        return;
      }

      log(
        `Restarting class screenshot watcher in ${watcherRestartDelayMs}ms after bootstrap failure`,
      );
      await sleep(watcherRestartDelayMs);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
