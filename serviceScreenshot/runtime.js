const { screenshotIntegratedEnabled } = require("./config");
const { SCREENSHOT_EVENT, screenshotEventBus } = require("./events");
const { log } = require("./logger");
const { ScreenshotWatcher } = require("./watcher");

let watcherInstance = null;
let unsubscribeHandler = null;
let isStarting = false;

async function startIntegratedScreenshotService() {
  if (!screenshotIntegratedEnabled) {
    log("Integrated screenshot service is disabled");
    return null;
  }

  if (watcherInstance || isStarting) {
    return watcherInstance;
  }

  isStarting = true;

  try {
    watcherInstance = new ScreenshotWatcher({ watchMode: "event-only" });
    await watcherInstance.start();

    const eventHandler = async (payload) => {
      try {
        await watcherInstance.handleRoundUpdate(payload);
      } catch (error) {
        log(`Integrated screenshot event failed: ${error.message}`);
      }
    };

    screenshotEventBus.on(SCREENSHOT_EVENT, eventHandler);
    unsubscribeHandler = () => {
      screenshotEventBus.off(SCREENSHOT_EVENT, eventHandler);
    };

    log("Integrated screenshot service started");
    return watcherInstance;
  } finally {
    isStarting = false;
  }
}

async function stopIntegratedScreenshotService() {
  if (unsubscribeHandler) {
    unsubscribeHandler();
    unsubscribeHandler = null;
  }

  if (watcherInstance) {
    await watcherInstance.shutdown();
    watcherInstance = null;
  }
}

module.exports = {
  startIntegratedScreenshotService,
  stopIntegratedScreenshotService,
};
