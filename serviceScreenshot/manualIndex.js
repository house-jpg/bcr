const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { autoLoginEnabled } = require("./config");
const { ScreenshotWatcher } = require("./watcher");
const { log } = require("./logger");

async function main() {
  const bootstrapMode = autoLoginEnabled ? "auto-login" : "manual";
  const watcher = new ScreenshotWatcher({
    bootstrapMode,
    useManualStatusTrigger: true,
  });

  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down manual screenshot watcher`);
    await watcher.shutdown();
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

  try {
    log(
      `Starting screenshot watcher in ${bootstrapMode} mode${
        autoLoginEnabled ? " with headless=false" : ""
      }`,
    );
    await watcher.start();
  } catch (error) {
    log(`Manual watcher failed to start: ${error.message}`);
    await watcher.shutdown().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
