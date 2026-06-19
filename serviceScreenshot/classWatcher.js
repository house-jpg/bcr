const path = require("path");

const {
  gameInfoCardTimeoutMs,
  gameInfoCardRecoveryTimeoutMs,
  outputDir,
  recoveryTableName,
  tempOutputDir,
  screenshotRetryCount,
  screenshotRetryDelayMs,
  workerId,
  targetTableName,
  watchPollIntervalMs,
} = require("./config");
const { BrowserSession, isTransientFrameError } = require("./browser");
const { log } = require("./logger");
const {
  ensureDir,
  moveFile,
  removeFileIfExists,
  sleep,
} = require("./utils");
const {
  BET_INIT_AMOUNT,
  pickRandomBetSide,
  sendScreenshotToTelegramByClass,
} = require("../telegramBot/screenshotDelivery");

async function waitForVisible(locator, timeout = 0) {
  const options = { state: "visible" };

  if (timeout > 0) {
    options.timeout = timeout;
  }

  await locator.waitFor(options);
}

function shouldRefreshFrameAfterCaptureError(error) {
  const message = String(error?.message || "");
  return (
    isTransientFrameError(error) ||
    message.includes("element is not visible") ||
    message.includes("waiting for element to be stable") ||
    message.includes("scroll into view action")
  );
}

function shouldRecoverBrowserSession(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "GAME_FRAME_NOT_FOUND" ||
    error?.code === "TABLE_NOT_FOUND" ||
    isTransientFrameError(error) ||
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Page is not available") ||
    message.includes("Unable to refresh current game frame") ||
    message.includes("Unable to access current game frame") ||
    message.includes("Unable to access seamless frame") ||
    message.includes("waiting for locator('iframe#iframeGame')")
  );
}

class ScreenshotClassWatcher {
  constructor(options = {}) {
    this.browser = new BrowserSession();
    this.bootstrapMode = options.bootstrapMode || "manual";
    this.pollTimer = null;
    this.isPolling = false;
    this.isCapturing = false;
    this.lastSnapshotKey = null;
    this.hasActiveResultClass = false;
    this.lastDetectedResultSource = null;
    this.hasLoggedWaitingState = false;
    this.missingGameInfoCardSince = null;
    this.isRecoveringGameInfoCard = false;
    this.isRecoveringBrowserSession = false;
    this.captureSequence = 0;
    this.totalProfit = Number(process.env.SCREENSHOT_BET_TOTAL_AMOUNT || 0);
    this.pendingBetSide = pickRandomBetSide();
    this.pendingBetAmount = BET_INIT_AMOUNT;
  }

  async bootstrap() {
    const bootstrapStartedAt = Date.now();
    log("Class watcher bootstrap started");
    await ensureDir(outputDir);
    await ensureDir(tempOutputDir);

    if (!targetTableName) {
      throw new Error("Missing SCREENSHOT_TABLE_NAME in environment");
    }

    if (this.bootstrapMode === "manual") {
      await this.browser.openManual();
      await this.browser.waitForGameFrameReady();
    } else {
      await this.browser.open();
      await this.browser.waitForGameFrameReady();
    }

    log(`Class watcher ready for table ${targetTableName}`);
    log("Class watcher is running without MongoDB snapshot bootstrap");
    log(`Class watcher bootstrap completed in ${Date.now() - bootstrapStartedAt}ms`);
  }

  buildClassSnapshot(triggerState) {
    const winner = String(triggerState?.winner || "unknown").toUpperCase();
    const timestamp = Date.now();
    const sequence = ++this.captureSequence;

    return {
      tableName: targetTableName,
      statusGame: "CLASS_TRIGGERED",
      latestKey: `${targetTableName}:class:${timestamp}:${sequence}:${winner}`,
      latestRound: {
        id: sequence,
        stampTime: timestamp,
        roadFormat: winner,
      },
      totalRoundCount: sequence,
      hasRounds: true,
    };
  }

  startPolling() {
    if (this.pollTimer) {
      return;
    }

    const poll = async () => {
      if (this.isPolling) {
        this.pollTimer = setTimeout(poll, watchPollIntervalMs);
        return;
      }

      this.isPolling = true;

      try {
        await this.processDomResult();
      } catch (error) {
        log(`Class watcher polling failed: ${error.message}`);
        if (shouldRecoverBrowserSession(error)) {
          await this.recoverBrowserSession(error);
        }
      } finally {
        this.isPolling = false;
      }

      this.pollTimer = setTimeout(poll, watchPollIntervalMs);
    };

    this.pollTimer = setTimeout(poll, watchPollIntervalMs);
    log(`Class watcher polling started every ${watchPollIntervalMs}ms`);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async processDomResult() {
    let triggerState;

    try {
      triggerState = await this.browser.getManualResultTriggerState();
    } catch (error) {
      if (!this.missingGameInfoCardSince) {
        this.missingGameInfoCardSince = Date.now();
      }

      await this.recoverMissingGameInfoCardIfNeeded({
        hasVisibleGameInfoCard: false,
        hasGameInfoCard: false,
      });
      throw error;
    }

    if (triggerState?.hasVisibleGameInfoCard) {
      this.missingGameInfoCardSince = null;
    } else if (!this.missingGameInfoCardSince) {
      this.missingGameInfoCardSince = Date.now();
    }

    await this.recoverMissingGameInfoCardIfNeeded(triggerState);

    if (!triggerState?.detected) {
      if (!this.hasLoggedWaitingState) {
        log("Class trigger not detected yet", {
          hasGameInfoCard: triggerState?.hasGameInfoCard || false,
          hasVisibleGameInfoCard: triggerState?.hasVisibleGameInfoCard || false,
          hasPlayerResult: triggerState?.hasPlayerResult || false,
          hasBankerResult: triggerState?.hasBankerResult || false,
          hasFallbackPlayerWin: triggerState?.hasFallbackPlayerWin || false,
          hasFallbackBankerWin: triggerState?.hasFallbackBankerWin || false,
          hasFallbackTie: triggerState?.hasFallbackTie || false,
          playerClasses: triggerState?.playerClasses || [],
          bankerClasses: triggerState?.bankerClasses || [],
        });
        this.hasLoggedWaitingState = true;
      }

      if (this.hasActiveResultClass) {
        log("Result classes cleared; watcher is ready for next trigger", {
          previousResultSource: this.lastDetectedResultSource || "unknown",
        });
      }

      this.hasActiveResultClass = false;
      this.lastDetectedResultSource = null;
      return;
    }

    if (this.hasActiveResultClass) {
      return;
    }

    this.hasLoggedWaitingState = false;
    this.hasActiveResultClass = true;
    this.lastDetectedResultSource = triggerState.source || "unknown";
    await this.captureFromResultClass(triggerState);
  }

  async recoverMissingGameInfoCardIfNeeded(triggerState) {
    if (triggerState?.hasVisibleGameInfoCard) {
      return;
    }

    if (!recoveryTableName) {
      return;
    }

    if (this.isRecoveringGameInfoCard || !this.missingGameInfoCardSince) {
      return;
    }

    const missingForMs = Date.now() - this.missingGameInfoCardSince;
    if (missingForMs < gameInfoCardRecoveryTimeoutMs) {
      return;
    }

    this.isRecoveringGameInfoCard = true;

    try {
      log(`Missing #gameInfoCard for ${missingForMs}ms, re-entering table ${recoveryTableName}`);
      await this.browser.reenterConfiguredTable(
        `#gameInfoCard missing for ${missingForMs}ms while waiting for class trigger`,
      );
      this.missingGameInfoCardSince = null;
      this.hasLoggedWaitingState = false;
      log(`Recovered table view by re-entering ${recoveryTableName}`);
    } catch (error) {
      log(`Failed to recover missing #gameInfoCard: ${error.message}`);
      this.missingGameInfoCardSince = Date.now();
      if (shouldRecoverBrowserSession(error)) {
        await this.recoverBrowserSession(error);
      }
    } finally {
      this.isRecoveringGameInfoCard = false;
    }
  }

  async recoverBrowserSession(error) {
    if (this.isRecoveringBrowserSession) {
      return;
    }

    this.isRecoveringBrowserSession = true;

    try {
      log(`Recovering class watcher browser session: ${error.message}`);

      try {
        await this.browser.refreshGameFrame();
        await this.browser.closeOverlays();
        log("Recovered class watcher frame state without reopening browser");
        return;
      } catch (refreshError) {
        log(`Frame recovery failed, reopening browser context: ${refreshError.message}`);
      }

      await this.browser.close().catch(() => {});

      if (this.bootstrapMode === "manual") {
        await this.browser.openManual();
      } else {
        await this.browser.open();
      }

      await this.browser.waitForGameFrameReady();
      this.missingGameInfoCardSince = null;
      this.hasLoggedWaitingState = false;
      this.hasActiveResultClass = false;
      this.lastDetectedResultSource = null;
      log("Class watcher browser session recovered");
    } catch (recoverError) {
      log(`Class watcher browser recovery failed: ${recoverError.message}`);
    } finally {
      this.isRecoveringBrowserSession = false;
    }
  }

  async captureFromResultClass(triggerState) {
    if (this.isCapturing) {
      return;
    }

    this.isCapturing = true;

    try {
      const snapshot = this.buildClassSnapshot(triggerState);

      const safeKey = snapshot.latestKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const captureResult = await this.captureWithRetry(snapshot, safeKey);
      this.lastSnapshotKey = snapshot.latestKey;
      const roundFormat = String(snapshot.latestRound?.roadFormat || "unknown").toUpperCase();

      const sent = await sendScreenshotToTelegramByClass({
        snapshot,
        filePath: captureResult.filePath,
        state: this,
        log,
        triggerWinner: triggerState.winner,
      });

      if (sent) {
        log(`${snapshot.tableName} screenshot sent via class trigger`, {
          latestKey: snapshot.latestKey,
          dbRoundFormat: roundFormat,
          resultSource: triggerState.source || "unknown",
          triggerWinner: triggerState.winner || "unknown",
        });
        this.stopPolling();
        log(`${snapshot.tableName} class polling stopped after successful Telegram delivery`);
      } else {
        log(`${snapshot.tableName} screenshot captured but Telegram delivery failed`, {
          latestKey: snapshot.latestKey,
          dbRoundFormat: roundFormat,
          resultSource: triggerState.source || "unknown",
          triggerWinner: triggerState.winner || "unknown",
          filePath: captureResult.filePath,
        });
      }
    } finally {
      this.isCapturing = false;
    }
  }

  async captureWithRetry(snapshot, safeKey) {
    let lastError;
    const visibilityTimeoutMs =
      gameInfoCardTimeoutMs > 0 ? Math.min(gameInfoCardTimeoutMs, 4000) : 4000;

    for (let attempt = 1; attempt <= screenshotRetryCount + 1; attempt += 1) {
      try {
        await this.browser.refreshGameFrame();
        await this.browser.closeOverlays();
        if (!this.browser.gameCurrentFrame) {
          await this.browser.refreshGameFrame().catch(() => {});
        }

        const gameInfoCard = this.browser.gameCurrentFrame
          .locator("#gameInfoCard")
          .first();

        await waitForVisible(gameInfoCard, visibilityTimeoutMs);

        const tempFilePath = path.join(
          tempOutputDir,
          `${safeKey}_${workerId}_${Date.now()}.png`,
        );
        await gameInfoCard.screenshot({ path: tempFilePath });

        const finalFilePath = path.join(outputDir, `${safeKey}.png`);
        await removeFileIfExists(finalFilePath);
        await moveFile(tempFilePath, finalFilePath);
        return {
          filePath: finalFilePath,
        };
      } catch (error) {
        lastError = error;

        if (attempt > screenshotRetryCount) {
          break;
        }

        log(`Class watcher screenshot retry ${attempt}/${screenshotRetryCount}`, {
          reason: error.message,
        });

        if (shouldRefreshFrameAfterCaptureError(error)) {
          await this.browser.refreshGameFrame().catch(() => {});
        }

        await sleep(screenshotRetryDelayMs);
      }
    }

    throw lastError;
  }

  async start() {
    await this.bootstrap();
    this.startPolling();
  }

  async shutdown() {
    this.stopPolling();
    await this.browser.close();
  }
}

module.exports = {
  ScreenshotClassWatcher,
};
