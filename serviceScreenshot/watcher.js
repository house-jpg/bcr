const path = require("path");

const {
  gameInfoCardTimeoutMs,
  outputDir,
  tempOutputDir,
  screenshotRetryCount,
  screenshotRetryDelayMs,
  screenshotDebounceMs,
  manualCycleTimeoutMs,
  workerId,
  skipFirstDetectedUpdate,
  targetTableName,
  useChangeStream,
  watchPollIntervalMs,
} = require("./config");
const { BrowserSession, isTransientFrameError } = require("./browser");
const {
  claimScreenshotResult,
  connectMongo,
  disconnectMongo,
  getLatestTableSnapshot,
  watchTableChanges,
} = require("./mongo");
const { log } = require("./logger");
const {
  ensureDir,
  moveFile,
  removeFileIfExists,
  sleep,
  getRoundResultLabel,
} = require("./utils");
const {
  BET_INIT_AMOUNT,
  pickRandomBetSide,
  sendScreenshotToTelegramByApi,
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

const MANUAL_SCREENSHOT_TRIGGER_STATUS = "GP_ONE_CARD_DRAWN";
const MANUAL_SCREENSHOT_CAPTURE_STATUS = "GP_WINNER";
const MANUAL_RESET_STATUS = "GP_NEW_GAME_START";
const BET_TOTAL_AMOUNT = Number(process.env.SCREENSHOT_BET_TOTAL_AMOUNT || 0);

class ScreenshotWatcher {
  constructor(options = {}) {
    this.browser = new BrowserSession();
    this.watchMode = options.watchMode || "db-watch";
    this.bootstrapMode = options.bootstrapMode || "auto-login";
    this.useManualStatusTrigger =
      typeof options.useManualStatusTrigger === "boolean"
        ? options.useManualStatusTrigger
        : this.bootstrapMode === "manual";
    this.lastProcessedKey = null;
    this.lastStatusGame = "";
    this.manualTriggerActive = false;
    this.manualFlowReady = false;
    this.manualTriggerStartedAt = null;
    this.manualTriggerBaseKey = null;
    this.activeManualCycleToken = null;
    this.manualCycleSequence = 0;
    this.pendingSnapshot = null;
    this.scheduledKey = null;
    this.currentCapturingKey = null;
    this.pendingStatusTrigger = null;
    this.hasSkippedInitialDetectedUpdate = false;
    this.isDetectionWarmupReady = false;
    this.lastSnapshotHadRounds = false;
    this.pendingManualCapture = null;
    this.captureTimer = null;
    this.isCapturing = false;
    this.changeStream = null;
    this.pollingInterval = null;
    this.totalProfit = BET_TOTAL_AMOUNT;
    this.pendingBetSide = pickRandomBetSide();
    this.pendingBetAmount = BET_INIT_AMOUNT;
  }

  async bootstrap() {
    const bootstrapStartedAt = Date.now();
    log("Bootstrap started");
    await ensureDir(outputDir);
    await ensureDir(tempOutputDir);
    await connectMongo();

    if (!targetTableName) {
      throw new Error("Missing SCREENSHOT_TABLE_NAME in environment");
    }

    if (this.bootstrapMode === "manual") {
      await this.browser.openManual();
      await this.browser.waitForManualGameInfoCardReady();
    } else {
      await this.browser.open();
    }

    const initialSnapshot = await getLatestTableSnapshot(targetTableName);
    if (!initialSnapshot) {
      throw new Error(`Table ${targetTableName} not found in MongoDB`);
    }

    this.lastProcessedKey = initialSnapshot.latestKey;
    this.lastStatusGame = initialSnapshot.statusGame || "";
    this.lastSnapshotHadRounds = initialSnapshot.hasRounds;
    log(`Watcher ready for table ${targetTableName}`);
    log(`Initial latest key: ${this.lastProcessedKey}`);
    log(`Initial statusGame: ${this.lastStatusGame || "unknown"}`);
    log(
      "Watcher detection warm-up is active. First detected DB change will be skipped.",
    );
    log(`Bootstrap completed in ${Date.now() - bootstrapStartedAt}ms`);
  }

  scheduleCapture(snapshot) {
    this.scheduledKey = snapshot.latestKey;
    this.pendingSnapshot = snapshot;

    if (this.useManualStatusTrigger) {
      if (this.captureTimer) {
        clearTimeout(this.captureTimer);
        this.captureTimer = null;
      }
      const latestSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
      this.scheduledKey = null;
      void this.capture(latestSnapshot);
      return;
    }

    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
    }

    this.captureTimer = setTimeout(async () => {
      this.captureTimer = null;
      const latestSnapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
      this.scheduledKey = null;
      await this.capture(latestSnapshot);
    }, screenshotDebounceMs);
  }

  resetManualTriggerState(options = {}) {
    const { clearScheduledCapture = false, invalidateCycleToken = true } = options;

    this.manualTriggerActive = false;
    this.manualFlowReady = false;
    this.manualTriggerStartedAt = null;
    this.manualTriggerBaseKey = null;
    this.pendingStatusTrigger = null;
    if (invalidateCycleToken) {
      this.activeManualCycleToken = null;
    }

    if (clearScheduledCapture) {
      if (this.captureTimer) {
        clearTimeout(this.captureTimer);
        this.captureTimer = null;
      }
      this.pendingSnapshot = null;
      this.scheduledKey = null;
    }
  }

  async resetProcessState(snapshot = null) {
    await this.clearPendingManualCapture();
    this.resetManualTriggerState({ clearScheduledCapture: true });
    this.pendingSnapshot = null;
    this.scheduledKey = null;
    this.currentCapturingKey = null;

    if (snapshot) {
      this.lastProcessedKey = snapshot.latestKey;
      this.lastSnapshotHadRounds = snapshot.hasRounds;
      this.lastStatusGame = snapshot.statusGame || "";
    }
  }

  async clearPendingManualCapture() {
    if (!this.pendingManualCapture?.filePath) {
      this.pendingManualCapture = null;
      return;
    }

    await removeFileIfExists(this.pendingManualCapture.filePath);
    this.pendingManualCapture = null;
  }

  createManualCycleToken(snapshot) {
    const token = {
      id: ++this.manualCycleSequence,
      latestKey: snapshot.latestKey,
      createdAt: Date.now(),
    };
    this.activeManualCycleToken = token;
    return token;
  }

  getActiveManualCycleToken() {
    return this.activeManualCycleToken;
  }

  isManualCycleTokenActive(token) {
    return Boolean(
      token &&
        this.activeManualCycleToken &&
        token.id === this.activeManualCycleToken.id &&
        token.latestKey === this.activeManualCycleToken.latestKey,
    );
  }

  async expireManualCycleIfNeeded(snapshot, reason) {
    if (!manualCycleTimeoutMs || manualCycleTimeoutMs <= 0) {
      return false;
    }

    if (!this.manualTriggerActive || !this.manualTriggerStartedAt) {
      return false;
    }

    const elapsedMs = Date.now() - this.manualTriggerStartedAt;
    if (elapsedMs < manualCycleTimeoutMs) {
      return false;
    }

    await this.clearPendingManualCapture();
    this.resetManualTriggerState({ clearScheduledCapture: true });
    log(`${snapshot.tableName} manual screenshot cycle expired via ${reason}`, {
      latestKey: snapshot.latestKey,
      currentStatusGame: snapshot.statusGame || "unknown",
      elapsedMs,
      timeoutMs: manualCycleTimeoutMs,
    });
    return true;
  }

  async handleRoundsReset(snapshot, reason) {
    if (snapshot.hasRounds || !this.lastSnapshotHadRounds) {
      this.lastSnapshotHadRounds = snapshot.hasRounds;
      return false;
    }

    this.lastSnapshotHadRounds = false;

    log(`${snapshot.tableName} totalRound became empty via ${reason}, keep current screenshot cycle`, {
      latestKey: snapshot.latestKey,
      totalRoundCount: snapshot.totalRoundCount,
      currentStatusGame: snapshot.statusGame || "unknown",
    });

    return false;
  }

  async captureGameInfoCardToTemp() {
    const tempFilePath = path.join(
      tempOutputDir,
      `manual_stage_${workerId}_${Date.now()}.png`,
    );

    let lastError;
    const manualVisibilityTimeoutMs =
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

        await waitForVisible(gameInfoCard, manualVisibilityTimeoutMs);
        await gameInfoCard.screenshot({ path: tempFilePath });
        return tempFilePath;
      } catch (error) {
        lastError = error;

        if (attempt > screenshotRetryCount) {
          break;
        }

        log(`Manual screenshot stage retry ${attempt}/${screenshotRetryCount}`, {
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

  async stageManualCapture(snapshot, reason, cycleToken) {
    if (!this.useManualStatusTrigger) {
      return false;
    }

    if (!this.isManualCycleTokenActive(cycleToken)) {
      return false;
    }

    if (this.pendingManualCapture?.sourceKey === snapshot.latestKey) {
      return true;
    }

    await this.clearPendingManualCapture();
    const filePath = await this.captureGameInfoCardToTemp();

    if (!this.isManualCycleTokenActive(cycleToken)) {
      await removeFileIfExists(filePath);
      log(`${snapshot.tableName} manual cycle invalidated before staging screenshot`, {
        sourceKey: snapshot.latestKey,
        reason,
        cycleTokenId: cycleToken?.id,
      });
      return false;
    }

    this.pendingManualCapture = {
      filePath,
      sourceKey: snapshot.latestKey,
      stagedAt: Date.now(),
      sourceStatusGame: this.lastStatusGame,
    };

    log(`${snapshot.tableName} staged manual screenshot via ${reason}`, {
      sourceKey: snapshot.latestKey,
      sourceStatusGame: this.lastStatusGame || "unknown",
      filePath,
    });

    return this.pendingManualCapture;
  }

  async finalizePendingManualCapture(snapshot) {
    if (!this.pendingManualCapture?.filePath) {
      return false;
    }

    const safeKey = snapshot.latestKey.replace(/[^a-zA-Z0-9:_-]/g, "_");
    const finalFilePath = path.join(outputDir, `${safeKey}.png`);
    const claim = await claimScreenshotResult({
      latestKey: snapshot.latestKey,
      tableName: snapshot.tableName,
      filePath: finalFilePath,
      workerId,
    });

    if (!claim.won) {
      await this.clearPendingManualCapture();
      this.lastProcessedKey = snapshot.latestKey;
      log(`Manual screenshot ignored because another worker won first`, {
        latestKey: snapshot.latestKey,
        winnerWorkerId: claim.existing?.workerId,
        winnerFilePath: claim.existing?.filePath,
      });
      return true;
    }

    await moveFile(this.pendingManualCapture.filePath, finalFilePath);
    this.pendingManualCapture = null;
    this.lastProcessedKey = snapshot.latestKey;
    log(`Screenshot saved: ${finalFilePath}`);
    await sendScreenshotToTelegramByApi({
      snapshot,
      filePath: finalFilePath,
      state: this,
      log,
    });
    return true;
  }

  shouldFinalizePendingManualCapture(snapshot) {
    if (!this.pendingManualCapture?.filePath) {
      return false;
    }

    return this.pendingManualCapture.sourceKey !== snapshot.latestKey;
  }

  async processSnapshot(reason) {
    const snapshot = await getLatestTableSnapshot(targetTableName);
    if (!snapshot) {
      log(`No snapshot found for table ${targetTableName}`);
      return;
    }

    if (this.useManualStatusTrigger) {
      await this.processManualSnapshot(snapshot, reason);
      return;
    }

    if (await this.handleRoundsReset(snapshot, reason)) {
      return;
    }

    if (!snapshot.hasRounds) {
      this.lastSnapshotHadRounds = false;
      log(`${snapshot.tableName} totalRound is empty, keep waiting`, {
        totalRoundCount: snapshot.totalRoundCount,
      });
      return;
    }

    this.lastSnapshotHadRounds = true;

    if (snapshot.latestKey === this.lastProcessedKey) {
      return;
    }

    if (
      snapshot.latestKey === this.scheduledKey ||
      snapshot.latestKey === this.currentCapturingKey
    ) {
      return;
    }

    if (this.shouldSkipInitialDetectedUpdate(snapshot, reason)) {
      return;
    }

    log(
      `${snapshot.tableName} totalRound updated via ${reason} -> screenshot`,
      {
        latestKey: snapshot.latestKey,
        totalRoundCount: snapshot.totalRoundCount,
      },
    );
    this.scheduleCapture(snapshot);
  }

  async processManualSnapshot(snapshot, reason) {
    const previousStatusGame = this.lastStatusGame;
    const currentStatusGame = snapshot.statusGame || "";
    const hasStatusGameChanged = currentStatusGame !== previousStatusGame;
    const isCurrentKeyInFlight =
      snapshot.latestKey === this.scheduledKey ||
      snapshot.latestKey === this.currentCapturingKey;

    if (await this.handleRoundsReset(snapshot, reason)) {
      return;
    }

    await this.expireManualCycleIfNeeded(snapshot, reason);

    this.lastSnapshotHadRounds = snapshot.hasRounds;

    if (hasStatusGameChanged) {
      this.lastStatusGame = currentStatusGame;

      if (currentStatusGame === MANUAL_RESET_STATUS) {
        await this.resetProcessState(snapshot);
        log(
          `${snapshot.tableName} statusGame changed via ${reason} -> reset previous screenshot cycle state`,
          {
            previousStatusGame: previousStatusGame || "unknown",
            currentStatusGame,
            latestKeyAtStatusChange: snapshot.latestKey,
          },
        );
        return;
      }

      if (
        currentStatusGame !== MANUAL_SCREENSHOT_TRIGGER_STATUS &&
        currentStatusGame !== MANUAL_SCREENSHOT_CAPTURE_STATUS &&
        snapshot.latestKey === this.lastProcessedKey
      ) {
        this.pendingStatusTrigger = null;
        log(
          `${snapshot.tableName} statusGame changed via ${reason}, but latest totalRound is already processed`,
          {
            previousStatusGame: previousStatusGame || "unknown",
            currentStatusGame: currentStatusGame || "unknown",
            latestKey: snapshot.latestKey,
          },
        );
        return;
      }

      if (isCurrentKeyInFlight) {
        this.pendingStatusTrigger = null;
        log(
          `${snapshot.tableName} statusGame changed via ${reason}, but latest totalRound is already in-flight`,
          {
            previousStatusGame: previousStatusGame || "unknown",
            currentStatusGame: currentStatusGame || "unknown",
            latestKey: snapshot.latestKey,
          },
        );
        return;
      }

      if (
        !this.manualTriggerActive &&
        !this.manualFlowReady &&
        this.shouldSkipInitialDetectedUpdate(snapshot, reason)
      ) {
        this.pendingStatusTrigger = null;
        return;
      }

      if (
        currentStatusGame !== MANUAL_SCREENSHOT_TRIGGER_STATUS &&
        currentStatusGame !== MANUAL_SCREENSHOT_CAPTURE_STATUS
      ) {
        if (!this.manualTriggerActive) {
          this.resetManualTriggerState();
        }
        this.pendingStatusTrigger = {
          statusGame: currentStatusGame,
          latestKeyAtStatusChange: snapshot.latestKey,
          detectedAt: Date.now(),
        };
        log(
          `${snapshot.tableName} statusGame changed via ${reason}, waiting for ${MANUAL_SCREENSHOT_TRIGGER_STATUS}`,
          {
            previousStatusGame: previousStatusGame || "unknown",
            currentStatusGame: currentStatusGame || "unknown",
            latestKeyAtStatusChange: snapshot.latestKey,
          },
        );
        return;
      }

      if (currentStatusGame === MANUAL_SCREENSHOT_CAPTURE_STATUS) {
        const cycleToken = this.getActiveManualCycleToken();
        if (!this.manualTriggerActive || !this.manualFlowReady) {
          log(
            `${snapshot.tableName} statusGame changed via ${reason}, skip GP_WINNER because current cycle is not prepared`,
            {
              previousStatusGame: previousStatusGame || "unknown",
              currentStatusGame,
              latestKeyAtStatusChange: snapshot.latestKey,
              manualTriggerActive: this.manualTriggerActive,
              manualFlowReady: this.manualFlowReady,
            },
          );
          return;
        }

        if (!this.isManualCycleTokenActive(cycleToken)) {
          log(
            `${snapshot.tableName} statusGame changed via ${reason}, skip GP_WINNER because cycle token is no longer active`,
            {
              latestKeyAtStatusChange: snapshot.latestKey,
              cycleTokenId: cycleToken?.id,
            },
          );
          return;
        }

        this.manualTriggerBaseKey = snapshot.latestKey;
        const stagedCapture = await this.stageManualCapture(
          snapshot,
          reason,
          cycleToken,
        );
        if (!stagedCapture || !stagedCapture.filePath) {
          return;
        }

        if (!this.isManualCycleTokenActive(cycleToken)) {
          await removeFileIfExists(stagedCapture.filePath);
          log(
            `${snapshot.tableName} skip Telegram send because manual cycle token was invalidated after staging`,
            {
              latestKeyAtStatusChange: snapshot.latestKey,
              cycleTokenId: cycleToken?.id,
            },
          );
          return;
        }

        if (stagedCapture?.filePath) {
          const stagedFilePath = stagedCapture.filePath;
          const latestSnapshot =
            (await getLatestTableSnapshot(targetTableName)) || snapshot;

          if (!this.isManualCycleTokenActive(cycleToken)) {
            await removeFileIfExists(stagedFilePath);
            log(
              `${snapshot.tableName} skip Telegram send because manual cycle token was invalidated before delivery`,
              {
                latestKeyAtStatusChange: snapshot.latestKey,
                cycleTokenId: cycleToken?.id,
              },
            );
            return;
          }

          this.lastProcessedKey = snapshot.latestKey;
          this.resetManualTriggerState({ clearScheduledCapture: true });
          this.pendingManualCapture = null;
          await sendScreenshotToTelegramByApi({
            snapshot: latestSnapshot,
            filePath: stagedFilePath,
            state: this,
            log,
          });
        }
        log(
          `${snapshot.tableName} statusGame changed via ${reason}, screenshot sent at GP_WINNER`,
          {
            previousStatusGame: previousStatusGame || "unknown",
            currentStatusGame: currentStatusGame || "unknown",
            latestKeyAtStatusChange: snapshot.latestKey,
          },
        );
        return;
      }

      this.manualTriggerActive = true;
      this.manualFlowReady = false;
      this.manualTriggerStartedAt = Date.now();
      this.manualTriggerBaseKey = snapshot.latestKey;
      const cycleToken = this.createManualCycleToken(snapshot);
      this.pendingStatusTrigger = {
        statusGame: currentStatusGame,
        latestKeyAtStatusChange: snapshot.latestKey,
        detectedAt: Date.now(),
      };

      log(
        `${snapshot.tableName} statusGame changed via ${reason} -> prepare screenshot flow`,
        {
          previousStatusGame: previousStatusGame || "unknown",
          currentStatusGame: currentStatusGame || "unknown",
          latestKeyAtStatusChange: snapshot.latestKey,
        },
      );
      this.pendingStatusTrigger = null;
      await this.browser.prepareManualScreenshotFlow();

      if (!this.isManualCycleTokenActive(cycleToken)) {
        log(
          `${snapshot.tableName} skip marking manual flow ready because cycle token was invalidated during preparation`,
          {
            latestKeyAtStatusChange: snapshot.latestKey,
            cycleTokenId: cycleToken.id,
          },
        );
        return;
      }

      this.manualFlowReady = true;
      return;
    }
  }

  async handleRoundUpdate(payload = {}) {
    const { tableName, latestKey, totalRoundCount } = payload;

    if (tableName !== targetTableName) {
      return;
    }

    if (!totalRoundCount || totalRoundCount <= 0) {
      log(`${tableName} totalRound is empty, keep waiting`, {
        totalRoundCount: totalRoundCount || 0,
      });
      return;
    }

    if (!latestKey || latestKey === this.lastProcessedKey) {
      return;
    }

    if (
      latestKey === this.scheduledKey ||
      latestKey === this.currentCapturingKey
    ) {
      return;
    }

    const snapshot = {
      tableName,
      latestKey,
      latestRound: payload.round || null,
      totalRoundCount: totalRoundCount || 0,
    };

    if (this.shouldSkipInitialDetectedUpdate(snapshot, "event")) {
      return;
    }

    log(`${tableName} totalRound updated -> screenshot`, {
      latestKey,
    });
    this.scheduleCapture(snapshot);
  }

  shouldSkipInitialDetectedUpdate(snapshot, reason) {
    if (!skipFirstDetectedUpdate) {
      return false;
    }

    if (!this.isDetectionWarmupReady) {
      this.isDetectionWarmupReady = true;
      return false;
    }

    if (!this.hasSkippedInitialDetectedUpdate) {
      this.hasSkippedInitialDetectedUpdate = true;
      this.lastProcessedKey = snapshot.latestKey;
      log(
        `${snapshot.tableName} first detected update via ${reason} -> skip screenshot`,
        {
          latestKey: snapshot.latestKey,
          totalRoundCount: snapshot.totalRoundCount,
        },
      );
      return true;
    }

    return false;
  }

  async capture(snapshot) {
    if (!snapshot || snapshot.latestKey === this.lastProcessedKey) {
      return;
    }

    if (this.isCapturing) {
      this.pendingSnapshot = snapshot;
      return;
    }

    this.isCapturing = true;
    this.currentCapturingKey = snapshot.latestKey;

    try {
      const safeKey = snapshot.latestKey.replace(/[^a-zA-Z0-9:_-]/g, "_");
      const captureResult = await this.captureWithRetry(snapshot, safeKey);
      this.lastProcessedKey = snapshot.latestKey;
      if (captureResult.won) {
        log(`Screenshot saved: ${captureResult.filePath}`);
        await sendScreenshotToTelegramByApi({
          snapshot,
          filePath: captureResult.filePath,
          state: this,
          log,
        });
      } else {
        log(`Screenshot skipped because another worker finished first`, {
          latestKey: snapshot.latestKey,
          winnerWorkerId: captureResult.winnerWorkerId,
          winnerFilePath: captureResult.filePath,
        });
      }
    } catch (error) {
      log(`Capture failed: ${error.message}`);
      try {
        await this.recoverPage();
      } catch (recoverError) {
        log(`Recover page failed: ${recoverError.message}`);
      }
    } finally {
      this.isCapturing = false;
      this.currentCapturingKey = null;

      if (
        this.pendingSnapshot &&
        this.pendingSnapshot.latestKey !== this.lastProcessedKey
      ) {
        const nextSnapshot = this.pendingSnapshot;
        this.pendingSnapshot = null;
        await this.capture(nextSnapshot);
      }
    }
  }

  async captureWithRetry(snapshot, safeKey) {
    let lastError;
    const manualVisibilityTimeoutMs =
      gameInfoCardTimeoutMs > 0 ? Math.min(gameInfoCardTimeoutMs, 4000) : 4000;

    for (let attempt = 1; attempt <= screenshotRetryCount + 1; attempt += 1) {
      try {
        if (this.useManualStatusTrigger) {
          await this.browser.refreshGameFrame();
        } else {
          await this.browser.ensureGameFrame();
        }
        await this.browser.closeOverlays();
        if (!this.browser.gameCurrentFrame) {
          await this.browser.refreshGameFrame().catch(() => {});
        }

        if (!this.useManualStatusTrigger) {
          await this.browser.refreshGameFrame().catch(() => {});
        }

        const gameInfoCard = this.browser.gameCurrentFrame
          .locator("#gameInfoCard")
          .first();

        if (this.useManualStatusTrigger) {
          await waitForVisible(gameInfoCard, manualVisibilityTimeoutMs);
        } else {
          await waitForVisible(gameInfoCard, gameInfoCardTimeoutMs);
        }

        const tempFilePath = path.join(
          tempOutputDir,
          `${safeKey}_${workerId}_${Date.now()}.png`,
        );
        await gameInfoCard.screenshot({ path: tempFilePath });

        const finalFilePath = path.join(outputDir, `${safeKey}.png`);
        const claim = await claimScreenshotResult({
          latestKey: snapshot.latestKey,
          tableName: snapshot.tableName,
          filePath: finalFilePath,
          workerId,
        });

        if (!claim.won) {
          await removeFileIfExists(tempFilePath);
          this.lastProcessedKey = snapshot.latestKey;
          log(`Screenshot ignored because another worker won first`, {
            latestKey: snapshot.latestKey,
            winnerWorkerId: claim.existing?.workerId,
            winnerFilePath: claim.existing?.filePath,
          });
          return {
            won: false,
            filePath: claim.existing?.filePath || finalFilePath,
            winnerWorkerId: claim.existing?.workerId,
          };
        }

        await moveFile(tempFilePath, finalFilePath);
        return {
          won: true,
          filePath: finalFilePath,
          winnerWorkerId: workerId,
        };
      } catch (error) {
        lastError = error;

        if (attempt > screenshotRetryCount) {
          break;
        }

        log(`Screenshot retry ${attempt}/${screenshotRetryCount}`, {
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

  async recoverPage() {
    log("Recovering page state");
    try {
      await this.browser.refreshGameFrame();
      await this.browser.closeOverlays();
      log("Recover frame state completed");
    } catch (_error) {
      await this.browser.close();
      await this.browser.open();
    }
  }

  async startChangeStream() {
    if (!useChangeStream) {
      return false;
    }

    try {
      this.changeStream = watchTableChanges(async (change) => {
        const tableName = change.fullDocument?.tableName;
        if (tableName !== targetTableName) {
          return;
        }

        await this.processSnapshot("change-stream");
      });

      this.changeStream.on("error", async (error) => {
        log(`Change stream error: ${error.message}`);
        await this.stopChangeStream();
        this.startPolling();
      });

      log("Change stream watcher started");
      return true;
    } catch (error) {
      log(`Change stream unavailable: ${error.message}`);
      return false;
    }
  }

  async stopChangeStream() {
    if (!this.changeStream) {
      return;
    }

    await this.changeStream.close().catch(() => {});
    this.changeStream = null;
  }

  startPolling() {
    if (this.pollingInterval) {
      return;
    }

    this.pollingInterval = setInterval(async () => {
      try {
        await this.processSnapshot("polling");
      } catch (error) {
        log(`Polling error: ${error.message}`);
      }
    }, watchPollIntervalMs);

    log(`Polling watcher started every ${watchPollIntervalMs}ms`);
  }

  async start() {
    const startedAt = Date.now();
    await this.bootstrap();

    if (this.watchMode === "event-only") {
      log("Watcher is running in event-only mode");
      return;
    }

    const streamStarted = await this.startChangeStream();
    if (!streamStarted) {
      this.startPolling();
    }

    log(`Watcher start flow completed in ${Date.now() - startedAt}ms`);
  }

  async shutdown() {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    await this.stopChangeStream();
    await this.clearPendingManualCapture();
    await this.browser.close();
    await disconnectMongo();
  }
}

module.exports = {
  ScreenshotWatcher,
};
