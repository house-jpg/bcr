const { EventEmitter } = require("events");

const SCREENSHOT_EVENT = "screenshot:round-updated";

const screenshotEventBus = new EventEmitter();
screenshotEventBus.setMaxListeners(30);

module.exports = {
  SCREENSHOT_EVENT,
  screenshotEventBus,
};
