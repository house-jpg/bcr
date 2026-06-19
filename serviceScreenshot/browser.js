const { firefox } = require("playwright");

const {
  account,
  autoLoginEnabled,
  autoLoginMaxAttempts,
  autoLoginTimeoutMs,
  autoPasswordAccount,
  autoUsernameAccount,
  actionTimeoutMs,
  defaultTimeout,
  frameTimeoutMs,
  gameFrameRecoveryTimeoutMs,
  gameInfoCardTimeoutMs,
  isHeadless,
  inputTimeoutMs,
  interactionDelayMs,
  lobbyLoadWaitMs,
  loginResponseWaitMs,
  postFrameDelayMs,
  seamlessFrameTimeoutMs,
  tableOpenWaitMs,
  tableSelector,
  targetTableName,
  visibleTimeoutMs,
  hallNotificationWaitMs,
  manualOpenUrl,
  manualWaitRetryMs,
  recoveryTableName,
} = require("./config");
const { log } = require("./logger");
const { sleep } = require("./utils");

function createAutoLoginTimeoutError(timeoutMs) {
  const error = new Error(
    `Auto login timed out after ${timeoutMs}ms and the browser session was reset.`,
  );
  error.code = "AUTO_LOGIN_TIMEOUT";
  return error;
}

function createTableNotFoundError(tableName, attempts) {
  const error = new Error(
    `Unable to find table ${tableName} after ${attempts} scroll attempts.`,
  );
  error.code = "TABLE_NOT_FOUND";
  return error;
}

async function withTimeout(task, timeoutMs, buildError) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task();
  }

  let timeoutId = null;

  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(buildError(timeoutMs));
        }, timeoutMs);

        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function resolveLoginCredentials() {
  if (!autoLoginEnabled) {
    return {
      username: account.username_game,
      password: account.password_game,
      source: "account-config",
    };
  }

  if (!autoUsernameAccount || !autoPasswordAccount) {
    throw new Error(
      "AUTO_LOGIN=true nhưng thiếu AUTO_USERNAME_ACCOUNT hoặc AUTO_PASSWORD_ACCOUNT",
    );
  }

  return {
    username: autoUsernameAccount,
    password: autoPasswordAccount,
    source: "auto-login-env",
  };
}

async function waitForFrame(parentFrame, selector, timeout = frameTimeoutMs) {
  log(`Waiting for frame: ${selector}`);
  await parentFrame.waitForSelector(selector, { timeout, state: "attached" });
  log(`Frame attached: ${selector}`);
  await sleep(postFrameDelayMs);
}

function isExecutionContextDestroyedError(error) {
  return String(error?.message || "").includes("Execution context was destroyed");
}

function isFrameDetachedError(error) {
  return String(error?.message || "").includes("Frame was detached");
}

async function clickIfExists(scope, selector, timeout = 3000) {
  try {
    const locator = scope.locator(selector).first();
    await locator.waitFor({ timeout, state: "visible" });
    await locator.click({ timeout: Math.min(timeout, 1500), force: true });
    await sleep(interactionDelayMs);
    return true;
  } catch (_error) {
    return false;
  }
}

async function clickWithRetry(locator, options = {}) {
  const {
    timeout = actionTimeoutMs,
    forceOnFailure = false,
    clickCount = 1,
  } = options;

  await locator.waitFor({ timeout, state: "visible" });

  try {
    await locator.click({ clickCount, timeout });
    await sleep(interactionDelayMs);
    return true;
  } catch (error) {
    if (!forceOnFailure) {
      throw error;
    }

    await locator.click({ clickCount, timeout, force: true });
    await sleep(interactionDelayMs);
    return true;
  }
}

async function clickXPathIfExists(scope, xpath, timeout = 3000) {
  try {
    const locator = scope.locator(`xpath=${xpath}`).first();
    await locator.waitFor({ timeout, state: "visible" });
    await locator.click({ timeout: Math.min(timeout, 1500), force: true });
    await sleep(interactionDelayMs);
    return true;
  } catch (_error) {
    return false;
  }
}

async function dismissOverlayTargets(scope, targets = []) {
  await Promise.allSettled(
    targets.map(({ type, value, timeout = 800 }) => {
      if (type === "xpath") {
        return clickXPathIfExists(scope, value, timeout);
      }

      return clickIfExists(scope, value, timeout);
    }),
  );
}

async function fillInput(page, selector, value) {
  log(`Waiting for input: ${selector}`);
  const input = page.locator(selector).first();
  await input.waitFor({ timeout: inputTimeoutMs, state: "visible" });
  log(`Input ready: ${selector}`);
  try {
    await input.click({ clickCount: 3, force: true, timeout: inputTimeoutMs });
    await page.keyboard.press("Backspace");
    await input.fill(value, { timeout: inputTimeoutMs });
  } catch (error) {
    log(`Falling back to direct input set for ${selector}: ${error.message}`);
    await input.evaluate((node, nextValue) => {
      node.focus();
      node.value = "";
      node.value = nextValue;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  }
  await sleep(interactionDelayMs);
  log(`Input filled: ${selector}`);
}

async function pauseWithLog(ms, reason) {
  log(`Pause ${ms}ms: ${reason}`);
  await sleep(ms);
  log(`Pause done: ${reason}`);
}

async function waitForVisible(locator, timeout = 0) {
  const options = { state: "visible" };

  if (timeout > 0) {
    options.timeout = timeout;
  }

  await locator.waitFor(options);
}

async function waitForAttached(locator, timeout = 0) {
  const options = { state: "attached" };

  if (timeout > 0) {
    options.timeout = timeout;
  }

  await locator.waitFor(options);
}

function isTransientFrameError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Frame was detached") ||
    message.includes("Failed to find frame") ||
    message.includes("adoptNode") ||
    message.includes("most likely because of a navigation")
  );
}

function normalizeTableLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function getFreshContentFrame(parentFrame, selector, timeout = frameTimeoutMs) {
  try {
    await waitForFrame(parentFrame, selector, timeout);
  } catch (error) {
    if (selector === "iframe#iframeGame") {
      error.code = "GAME_FRAME_NOT_FOUND";
    }
    throw error;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const elementHandle = await parentFrame.locator(selector).first().elementHandle();
      if (!elementHandle) {
        throw new Error(`Unable to resolve element handle for ${selector}`);
      }

      const frame = await elementHandle.contentFrame();
      if (frame) {
        return frame;
      }
    } catch (error) {
      if (!isExecutionContextDestroyedError(error) || attempt === 3) {
        throw error;
      }

      log(`Frame context refreshed for ${selector}, retry ${attempt}/3`);
      await sleep(postFrameDelayMs);
    }
  }

  throw new Error(`Unable to resolve content frame for ${selector}`);
}

async function resolveTableHandleByName(frame, tableName) {
  const normalizedTableName = normalizeTableLabel(tableName);
  const textCandidates = [
    frame.getByText(tableName, { exact: true }).first(),
    frame.getByText(tableName).first(),
    frame.locator(`[title="${tableName}"]`).first(),
    frame.locator(`[aria-label="${tableName}"]`).first(),
  ];

  for (const candidate of textCandidates) {
    try {
      await candidate.waitFor({ timeout: 1500, state: "visible" });
      const handle = await candidate.evaluateHandle((node) => {
        return (
          node.closest(
            'button, [role="button"], .cursor-pointer, [class*="cursor-pointer"]',
          ) || node
        );
      });
      const element = handle.asElement();
      if (element) {
        return element;
      }
    } catch (_error) {
      // Try the next strategy.
    }
  }

  try {
    const handle = await frame.evaluateHandle((name) => {
      const normalizedName = String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const nodes = Array.from(document.querySelectorAll("*"));

      for (const node of nodes) {
        const text = (node.textContent || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        if (!text || !text.includes(normalizedName)) {
          continue;
        }

        const clickable =
          node.closest(
            'button, [role="button"], .cursor-pointer, [class*="cursor-pointer"]',
          ) || node;

        if (!(clickable instanceof HTMLElement)) {
          continue;
        }

        const style = window.getComputedStyle(clickable);
        const rect = clickable.getBoundingClientRect();
        const isVisible =
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0;

        if (isVisible) {
          return clickable;
        }
      }

      return null;
    }, normalizedTableName);

    const element = handle.asElement();
    if (element) {
      return element;
    }
  } catch (_error) {
    // Fall through to selector fallback.
  }

  return null;
}

async function scrollHallList(frame, ratio) {
  await frame.evaluate((nextRatio) => {
    const candidates = Array.from(document.querySelectorAll("*")).filter(
      (node) => node instanceof HTMLElement,
    );
    const prioritizedScroller = candidates.find((node) => {
      const className = String(node.className || "");
      const hasScrollableHeight = node.scrollHeight - node.clientHeight > 24;
      return (
        hasScrollableHeight &&
        (className.includes("vue-recycle-scroller") ||
          className.includes("recycle-scroller__item-wrapper") ||
          className.includes("recycle-scroller") ||
          className.includes("scroll"))
      );
    });
    const fallbackScroller = candidates.find((node) => {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY || "";
      return (
        node.scrollHeight - node.clientHeight > 24 &&
        (overflowY === "auto" || overflowY === "scroll")
      );
    });
    const scroller = prioritizedScroller || fallbackScroller || document.scrollingElement;

    if (!(scroller instanceof HTMLElement)) {
      return;
    }

    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextScrollTop = Math.round(maxScrollTop * nextRatio);
    scroller.scrollTop = nextScrollTop;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, ratio);

  await sleep(postFrameDelayMs);
}

async function clickElementHandleWithRetry(elementHandle, options = {}) {
  const { timeout = actionTimeoutMs, clickCount = 1, forceOnFailure = true } = options;

  await elementHandle.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await elementHandle.click({ timeout, clickCount });
    await sleep(interactionDelayMs);
    return true;
  } catch (error) {
    if (!forceOnFailure) {
      throw error;
    }

    await elementHandle.click({ timeout, clickCount, force: true });
    await sleep(interactionDelayMs);
    return true;
  }
}

class BrowserSession {
  constructor() {
    this.browserContext = null;
    this.page = null;
    this.gameCurrentFrame = null;
  }

  async initializeContext(userDataDir, headless) {
    this.browserContext = await firefox.launchPersistentContext(
      userDataDir,
      {
        headless,
        slowMo: 0,
        ignoreHTTPSErrors: true,
        viewport: { width: 1366, height: 768 },
        extraHTTPHeaders: {
          "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
          "User-Agent":
            process.env.USER_AGENT ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
        },
      },
    );

    await this.browserContext.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    this.page = this.browserContext.pages()[0] || (await this.browserContext.newPage());
    this.page.on("dialog", async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });
  }

  async resetBrowserSession(reason) {
    log(`Resetting browser session: ${reason}`);
    await this.browserContext?.close().catch(() => {});
    this.browserContext = null;
    this.page = null;
    this.gameCurrentFrame = null;
  }

  async runAutoLogin() {
    await withTimeout(
      () => this.loginToLobby(),
      autoLoginTimeoutMs,
      createAutoLoginTimeoutError,
    );
  }

  async open() {
    const userDataDir = `./servicePuppeteer/dataDir/${account.userDataDir}_screenshot_watcher`;

    for (let attempt = 1; attempt <= autoLoginMaxAttempts; attempt += 1) {
      log(`Opening screenshot browser context (attempt ${attempt}/${autoLoginMaxAttempts})`);
      await this.initializeContext(userDataDir, isHeadless);

      try {
        log("Browser context ready");
        await this.runAutoLogin();
        await this.enterTargetTable();
        log("Browser session is ready for screenshots");
        return;
      } catch (error) {
        const isAutoLoginTimeout = error?.code === "AUTO_LOGIN_TIMEOUT";
        const isTableNotFound = error?.code === "TABLE_NOT_FOUND";
        const isFinalAttempt = attempt >= autoLoginMaxAttempts;

        await this.resetBrowserSession(
          isAutoLoginTimeout
            ? `auto login timeout on attempt ${attempt}`
            : isTableNotFound
              ? `table not found on attempt ${attempt}: ${error.message}`
            : `bootstrap failure on attempt ${attempt}: ${error.message}`,
        );

        if (isFinalAttempt) {
          throw error;
        }

        log("Retrying browser bootstrap with a fresh browser session", {
          attempt,
          remainingAttempts: autoLoginMaxAttempts - attempt,
          reason: error.message,
        });
      }
    }

    throw new Error("Unable to open browser session");
  }

  async openManual() {
    log("Opening screenshot browser context in manual mode");
    await this.initializeContext(
      `./servicePuppeteer/dataDir/${account.userDataDir}_screenshot_manual`,
      false,
    );

    if (!manualOpenUrl) {
      throw new Error("Missing SCREENSHOT_MANUAL_OPEN_URL or DOMAIN for manual mode");
    }

    log(`Navigating to manual open url: ${manualOpenUrl}`);
    await this.page.goto(manualOpenUrl, {
      waitUntil: "domcontentloaded",
      timeout: defaultTimeout,
    });
    log("Manual mode browser is ready. User can login and navigate to #gameInfoCard");
  }

  async close() {
    await this.resetBrowserSession("close requested");
  }

  async refreshGameFrame() {
    if (!this.page) {
      throw new Error("Page is not available");
    }

    const seamlessFrame = await getFreshContentFrame(
      this.page,
      "#app iframe#seamless-game",
      seamlessFrameTimeoutMs,
    );

    this.gameCurrentFrame = await getFreshContentFrame(
      seamlessFrame,
      "iframe#iframeGame",
      gameFrameRecoveryTimeoutMs,
    );

    if (!this.gameCurrentFrame) {
      throw new Error("Unable to refresh current game frame");
    }

    return this.gameCurrentFrame;
  }

  async waitForGameInfoCardVisible() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.refreshGameFrame();
        const gameInfoCard = this.gameCurrentFrame.locator("#gameInfoCard").first();
        await waitForVisible(gameInfoCard, gameInfoCardTimeoutMs);
        return;
      } catch (error) {
        if (!isTransientFrameError(error) || attempt === 3) {
          throw error;
        }

        log(`Retry waiting for #gameInfoCard after frame refresh ${attempt}/3`, {
          reason: error.message,
        });
        await this.closeOverlays().catch(() => {});
        await sleep(postFrameDelayMs);
      }
    }
  }

  async waitForManualGameInfoCardReady() {
    log("Waiting for user to reach screen containing #gameInfoCard");

    while (true) {
      try {
        await this.refreshGameFrame();
        await this.closeOverlays().catch(() => {});
        const gameInfoCard = this.gameCurrentFrame.locator("#gameInfoCard").first();
        await waitForVisible(gameInfoCard, gameInfoCardTimeoutMs);
        log("Manual mode detected #gameInfoCard");
        return;
      } catch (error) {
        log("Manual mode still waiting for #gameInfoCard", {
          reason: error.message,
        });
        await sleep(manualWaitRetryMs);
      }
    }
  }

  async waitForGameInfoCardAttached() {
    log("Waiting for screen containing #gameInfoCard without visible timeout");

    while (true) {
      try {
        await this.refreshGameFrame();
        await this.closeOverlays().catch(() => {});
        const gameInfoCard = this.gameCurrentFrame.locator("#gameInfoCard").first();
        await waitForAttached(gameInfoCard);
        log("Detected attached #gameInfoCard");
        return;
      } catch (error) {
        log("Still waiting for attached #gameInfoCard", {
          reason: error.message,
        });
        await sleep(manualWaitRetryMs);
      }
    }
  }

  async waitForGameFrameReady() {
    log("Waiting for target game frame");

    while (true) {
      try {
        await this.refreshGameFrame();
        await this.closeOverlays().catch(() => {});
        log("Target game frame is ready");
        return;
      } catch (error) {
        log("Still waiting for target game frame", {
          reason: error.message,
        });
        await sleep(manualWaitRetryMs);
      }
    }
  }

  async prepareManualScreenshotFlow() {
    log("Preparing manual screenshot flow by scanning #gameInfoCard");
    await this.waitForGameInfoCardVisible();
    await this.closeOverlays().catch(() => {});
    log("Manual screenshot flow is ready");
  }

  async getManualResultTriggerState() {
    await this.refreshGameFrame();

    return this.gameCurrentFrame.evaluate(() => {
      const gameInfoCard = document.querySelector("#gameInfoCard");
      const playerResult = document.querySelector(
        "#gameWinnerPlayer .resulf_left",
      );
      const bankerResult = document.querySelector(
        "#gameWinnerBanker .resulf_right",
      );
      const fallbackPlayerWin = document.querySelector(".result_win_blue");
      const fallbackBankerWin = document.querySelector(".result_win_red");
      const fallbackTie = document.querySelector(".result_tie_green");
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const playerClasses = Array.from(playerResult?.classList || []);
      const bankerClasses = Array.from(bankerResult?.classList || []);
      const hasVisibleGameInfoCard = isVisible(gameInfoCard);

      const hasPlayerWin =
        playerClasses.includes("result_win_blue") || Boolean(fallbackPlayerWin);
      const hasBankerWin =
        bankerClasses.includes("result_win_red") || Boolean(fallbackBankerWin);
      const hasTie =
        playerClasses.includes("result_tie_green") ||
        bankerClasses.includes("result_tie_green") ||
        Boolean(fallbackTie);

      if (hasTie) {
        return {
          detected: true,
          winner: "T",
          source: "result_tie_green",
          hasGameInfoCard: Boolean(gameInfoCard),
          hasVisibleGameInfoCard,
          playerClasses,
          bankerClasses,
        };
      }

      if (hasPlayerWin) {
        return {
          detected: true,
          winner: "P",
          source: "result_win_blue",
          hasGameInfoCard: Boolean(gameInfoCard),
          hasVisibleGameInfoCard,
          playerClasses,
          bankerClasses,
        };
      }

      if (hasBankerWin) {
        return {
          detected: true,
          winner: "B",
          source: "result_win_red",
          hasGameInfoCard: Boolean(gameInfoCard),
          hasVisibleGameInfoCard,
          playerClasses,
          bankerClasses,
        };
      }

      return {
        detected: false,
        winner: null,
        source: null,
        hasGameInfoCard: Boolean(gameInfoCard),
        hasVisibleGameInfoCard,
        hasPlayerResult: Boolean(playerResult),
        hasBankerResult: Boolean(bankerResult),
        hasFallbackPlayerWin: Boolean(fallbackPlayerWin),
        hasFallbackBankerWin: Boolean(fallbackBankerWin),
        hasFallbackTie: Boolean(fallbackTie),
        playerClasses,
        bankerClasses,
      };
    });
  }

  async dismissRootOverlays() {
    if (!this.page) {
      return;
    }

    await dismissOverlayTargets(this.page, [
      { type: "selector", value: process.env.CLOSE_DIALOG_WELCOME, timeout: 1200 },
      { type: "selector", value: process.env.SHOW_DIALOG_LOGIN_SUCCESS, timeout: 1200 },
      { type: "selector", value: ".close-btn", timeout: 800 },
      { type: "selector", value: ".notification_closeBtn", timeout: 800 },
      { type: "xpath", value: "/html/body/div[4]/div/div[2]", timeout: 800 },
    ]);

    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.keyboard.press("Escape").catch(() => {});
  }

  async loginToLobby() {
    const credentials = resolveLoginCredentials();

    log(`Navigating to domain: ${process.env.DOMAIN}`);
    await this.page.goto(process.env.DOMAIN, {
      waitUntil: "networkidle",
      timeout: defaultTimeout,
    });
    log("Domain loaded");

    log("Dismissing root overlays before login");
    await this.dismissRootOverlays();
    log("Root overlays dismissed before login");

    const loginButton = this.page.locator(process.env.SHOW_DIALOG_LOGIN).first();
    log(`Opening login modal: ${process.env.SHOW_DIALOG_LOGIN}`);
    await clickWithRetry(loginButton, {
      timeout: actionTimeoutMs,
      forceOnFailure: true,
    });
    log("Login modal opened");

    await fillInput(
      this.page,
      process.env.INPUT_USERNAME_LOGIN,
      credentials.username,
    );
    await fillInput(
      this.page,
      process.env.INPUT_PASSWORD_LOGIN,
      credentials.password,
    );
    log(`Login form filled using ${credentials.source}`);

    log("Submitting login form");
    await clickWithRetry(
      this.page.locator('button[type="submit"].submit_btn').first(),
      {
        timeout: actionTimeoutMs,
        forceOnFailure: true,
      },
    );
    log("Login form submitted");
    await pauseWithLog(loginResponseWaitMs, "wait for login response");
    log("Dismissing overlays after login");
    await this.dismissRootOverlays();
    log("Overlays dismissed after login");

    const liveMenu = this.page
      .locator(
        "div.header_nav_list div.nav_item:nth-child(2) div.nav_item_btn.LIVE div.name1",
      )
      .first();
    log("Opening LIVE menu");
    await clickWithRetry(liveMenu, {
      timeout: actionTimeoutMs,
      forceOnFailure: true,
    });
    log("LIVE menu clicked");

    try {
      log("Waiting for LIVE navigation");
      await this.page.waitForLoadState("networkidle", { timeout: defaultTimeout });
      log("LIVE navigation completed");
    } catch (_error) {
      log("LIVE navigation timeout, continuing");
    }

    log("Scrolling page to find play button");
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pauseWithLog(postFrameDelayMs, "wait after page scroll");

    const playButton = this.page.locator(".play-btn").first();
    log("Waiting for play button");
    await playButton.waitFor({ timeout: visibleTimeoutMs, state: "visible" });
    log("Clicking play button");
    await clickWithRetry(playButton, {
      timeout: actionTimeoutMs,
      forceOnFailure: true,
    });
    await pauseWithLog(lobbyLoadWaitMs, "wait for game lobby to load");
  }

  async reenterConfiguredTable(reason = "gameInfoCard not found in time") {
    const nextTableName = recoveryTableName || targetTableName;

    if (!nextTableName) {
      throw new Error("Missing configured table name for gameInfoCard recovery");
    }

    log(`Re-entering configured table after recovery trigger: ${nextTableName}`, {
      reason,
    });
    await this.enterTargetTable({ preferredTableName: nextTableName });
  }

  async enterTargetTable(options = {}) {
    const { preferredTableName = targetTableName } = options;
    const seamlessIframeSelector = "#app iframe#seamless-game";

    const seamlessFrame = await getFreshContentFrame(
      this.page,
      seamlessIframeSelector,
      seamlessFrameTimeoutMs,
    );
    if (!seamlessFrame) {
      throw new Error("Unable to access seamless frame");
    }

    let gameHallFrame = await getFreshContentFrame(
      seamlessFrame,
      "iframe#iframeGameHall",
    );
    if (!gameHallFrame) {
      throw new Error("Unable to access game hall frame");
    }

    this.gameCurrentFrame = await getFreshContentFrame(
      seamlessFrame,
      "iframe#iframeGame",
    );
    if (!this.gameCurrentFrame) {
      throw new Error("Unable to access current game frame");
    }

    log("Scrolling page before entering table");
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    log("Closing hall notification if present");
    await clickIfExists(
      gameHallFrame,
      "button.size-8.cursor-pointer.outline-none",
      2000,
    );
    await pauseWithLog(hallNotificationWaitMs, "wait after closing hall notification");

    gameHallFrame = await getFreshContentFrame(
      seamlessFrame,
      "iframe#iframeGameHall",
    );
    if (!gameHallFrame) {
      throw new Error("Unable to refresh game hall frame");
    }

    log("Closing overlays before selecting table");
    await this.closeOverlays();
    await dismissOverlayTargets(gameHallFrame, [
      { type: "selector", value: ".close-btn", timeout: 700 },
      { type: "selector", value: ".notification_closeBtn", timeout: 700 },
      { type: "xpath", value: "/html/body/div[4]/div/div[2]", timeout: 700 },
    ]);
    log("Overlays closed before selecting table");

    let enteredByName = false;

    if (preferredTableName) {
      log(`Trying to enter table by name: ${preferredTableName}`);
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const tableHandle = await resolveTableHandleByName(
          gameHallFrame,
          preferredTableName,
        );

        if (tableHandle) {
          await clickElementHandleWithRetry(tableHandle, {
            timeout: actionTimeoutMs,
            clickCount: 2,
            forceOnFailure: true,
          });
          enteredByName = true;
          log(`Entered table by name: ${preferredTableName}`);
          break;
        }

        const ratio = attempt / 8;
        log(
          `Table name not visible yet, scrolling hall list ${attempt}/8 for ${preferredTableName}`,
        );
        await scrollHallList(gameHallFrame, ratio);
      }

      if (!enteredByName) {
        throw createTableNotFoundError(preferredTableName, 8);
      }
    }

    if (!enteredByName) {
      const tableButton = gameHallFrame.locator(tableSelector).first();
      log(`Entering table by selector fallback: ${tableSelector}`);
      await clickWithRetry(tableButton, {
        timeout: actionTimeoutMs,
        clickCount: 2,
        forceOnFailure: true,
      });
      log(`Entered table by selector fallback: ${tableSelector}`);
    }

    await pauseWithLog(tableOpenWaitMs, "wait for selected table to open");

    log("Waiting for #gameInfoCard to become visible");
    await this.waitForGameInfoCardVisible();
    log("#gameInfoCard is visible");
  }

  async closeOverlays() {
    if (!this.page || !this.gameCurrentFrame) {
      return;
    }

    await Promise.allSettled([
      dismissOverlayTargets(this.gameCurrentFrame, [
        { type: "xpath", value: "/div/aside/div[2]/span", timeout: 700 },
        { type: "selector", value: ".close-btn", timeout: 700 },
        { type: "xpath", value: "/html/body/div[4]/div/div[2]", timeout: 700 },
        { type: "selector", value: ".notification_closeBtn", timeout: 700 },
      ]),
      dismissOverlayTargets(this.page, [
        { type: "xpath", value: "/div/aside/div[2]/span", timeout: 700 },
        { type: "selector", value: ".close-btn", timeout: 700 },
        { type: "xpath", value: "/html/body/div[4]/div/div[2]", timeout: 700 },
        { type: "selector", value: ".notification_closeBtn", timeout: 700 },
      ]),
    ]);
  }

  async ensureGameFrame() {
    if (!this.gameCurrentFrame) {
      await this.refreshGameFrame();
    }

    let gameInfoCard = this.gameCurrentFrame.locator("#gameInfoCard").first();

    try {
      await waitForVisible(
        gameInfoCard,
        gameInfoCardTimeoutMs > 0
          ? Math.min(gameInfoCardTimeoutMs, 4000)
          : 0,
      );
      return;
    } catch (error) {
      if (isTransientFrameError(error)) {
        await this.refreshGameFrame();
        gameInfoCard = this.gameCurrentFrame.locator("#gameInfoCard").first();
      }
      await this.closeOverlays();
    }

    await waitForVisible(gameInfoCard, gameInfoCardTimeoutMs);
  }
}

module.exports = {
  BrowserSession,
  isTransientFrameError,
};
