const fs = require("fs");
const path = require("path");
const { sendTelegramPhoto } = require("../utilities/request");
const {
  getBetDisplay,
  removeFileIfExists,
} = require("../serviceScreenshot/utils");

const BET_INIT_AMOUNT = Number(process.env.SCREENSHOT_BET_INIT_AMOUNT || 5000);
const SUBSCRIBER_STORE_PATH = path.resolve(
  __dirname,
  "../runtime/telegram-subscribers.json",
);

function pickRandomBetSide() {
  return Math.random() < 0.5 ? "B" : "P";
}

function formatAmountK(amount) {
  return `${Number(amount || 0)}K`;
}

function resolveRoadFormat(snapshot) {
  return String(snapshot.latestRound?.roadFormat || "").toUpperCase();
}

function resolveRoundFormatFromTriggerWinner(triggerWinner) {
  const normalized = String(triggerWinner || "").toUpperCase();

  if (normalized === "P" || normalized === "B" || normalized === "T") {
    return normalized;
  }

  return "UNKNOWN";
}

function getTargetChatIds() {
  const chatIds = new Set();

  try {
    if (fs.existsSync(SUBSCRIBER_STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SUBSCRIBER_STORE_PATH, "utf8"));
      if (Array.isArray(parsed.chatIds)) {
        parsed.chatIds
          .map((chatId) => String(chatId || "").trim())
          .filter(Boolean)
          .forEach((chatId) => chatIds.add(chatId));
      }
    }
  } catch (_error) {
    // Keep fallback behavior below when the subscriber store is unreadable.
  }

  const fallbackChatId =
    process.env.SCREENSHOT_TELEGRAM_CHAT_ID ||
    process.env.ID_TELEGRAM_RECIPIENT;
  if (fallbackChatId) {
    chatIds.add(String(fallbackChatId).trim());
  }

  return Array.from(chatIds);
}

function buildBetPayload(roundFormat, state) {
  const normalizedRoundFormat = String(roundFormat || "").toUpperCase();
  const isTie = normalizedRoundFormat === "T";
  const currentBetSide = state.pendingBetSide;
  const currentBetAmount = state.pendingBetAmount;
  const totalProfitBefore = state.totalProfit;
  const didWin = !isTie && normalizedRoundFormat === currentBetSide;
  const outcomeDisplay = isTie
    ? "🤝 HOÀ"
    : didWin
      ? "✅ THẮNG"
      : "❌ THUA";

  if (!isTie) {
    state.totalProfit += didWin
      ? currentBetAmount
      : -currentBetAmount;
  }

  const nextBetAmount = isTie
    ? currentBetAmount
    : didWin
      ? BET_INIT_AMOUNT
      : BET_INIT_AMOUNT * 2;
  const nextBetSide = isTie ? currentBetSide : pickRandomBetSide();

  const caption = [
    `KẾT QUẢ: ${outcomeDisplay}`,
    `TỔNG LÃI: ${formatAmountK(state.totalProfit)}`,
    "LỆNH TIẾP THEO",
    `${getBetDisplay(nextBetSide)} ${formatAmountK(nextBetAmount)}`,
    "-------»---★---«-------",
    "‼️ Phân Chia Mức Cược Theo Vốn Của Bạn",
    "➡️ Nên nhớ đi lệnh : 5% -10% để an toàn vốn",
    "👉 Liên hệ admin",
    "=============",
  ].join("\n");

  state.pendingBetSide = nextBetSide;
  state.pendingBetAmount = nextBetAmount;

  return {
    caption,
    betLog: {
      roundFormat: normalizedRoundFormat,
      outcomeDisplay,
      currentBetSide,
      currentBetDisplay: getBetDisplay(currentBetSide),
      currentBetAmount,
      nextBetSide,
      nextBetDisplay: getBetDisplay(nextBetSide),
      nextBetAmount,
      totalProfitBefore,
      totalProfitAfter: state.totalProfit,
      isTie,
      didWin,
    },
  };
}

function buildTelegramCaptionFromApi(snapshot, state) {
  return buildBetPayload(resolveRoadFormat(snapshot), state);
}

function buildTelegramCaptionFromClass(triggerWinner, state) {
  return buildBetPayload(resolveRoundFormatFromTriggerWinner(triggerWinner), state);
}

async function sendScreenshotToTelegramInternal({
  snapshot,
  filePath,
  state,
  log,
  captionPayload,
}) {
  const token = process.env.TOKEN_BOT;
  const recipientChatIds = getTargetChatIds();

  if (!token || recipientChatIds.length === 0) {
    log(
      "Telegram screenshot delivery skipped: missing TOKEN_BOT or subscribed recipient chat ids",
    );
    return false;
  }

  const { caption, betLog } = captionPayload;

  log("Bet state before Telegram send", {
    tableName: snapshot.tableName,
    latestKey: snapshot.latestKey,
    roundFormat: betLog.roundFormat || "unknown",
    outcome: betLog.outcomeDisplay,
    currentBetSide: betLog.currentBetSide,
    currentBetDisplay: betLog.currentBetDisplay,
    currentBetAmount: betLog.currentBetAmount,
    totalProfitBefore: betLog.totalProfitBefore,
    totalProfitAfter: betLog.totalProfitAfter,
    nextBetSide: betLog.nextBetSide,
    nextBetDisplay: betLog.nextBetDisplay,
    nextBetAmount: betLog.nextBetAmount,
    isTie: betLog.isTie,
    didWin: betLog.didWin,
  });

  let successCount = 0;

  for (const recipientChatId of recipientChatIds) {
    const sent = await sendTelegramPhoto(token, recipientChatId, filePath, {
      caption,
    });
    if (sent) {
      successCount += 1;
    }
  }

  if (successCount > 0) {
    await removeFileIfExists(filePath);
    log(`Telegram photo sent: ${filePath}`, {
      recipientCount: recipientChatIds.length,
      successCount,
    });
    return true;
  }

  log(`Telegram photo send failed: ${filePath}`, {
    recipientCount: recipientChatIds.length,
  });
  return false;
}

async function sendScreenshotToTelegramByApi({ snapshot, filePath, state, log }) {
  return sendScreenshotToTelegramInternal({
    snapshot,
    filePath,
    state,
    log,
    captionPayload: buildTelegramCaptionFromApi(snapshot, state),
  });
}

async function sendScreenshotToTelegramByClass({
  snapshot,
  filePath,
  state,
  log,
  triggerWinner,
}) {
  return sendScreenshotToTelegramInternal({
    snapshot,
    filePath,
    state,
    log,
    captionPayload: buildTelegramCaptionFromClass(triggerWinner, state),
  });
}

module.exports = {
  BET_INIT_AMOUNT,
  pickRandomBetSide,
  buildTelegramCaptionFromApi,
  buildTelegramCaptionFromClass,
  sendScreenshotToTelegramByApi,
  sendScreenshotToTelegramByClass,
};
