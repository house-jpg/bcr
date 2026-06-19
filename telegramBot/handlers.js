const {
  buildPanelKeyboard,
  buildPanelText,
  formatConfigMessage,
} = require("./panel");

function registerHandlers({
  bot,
  store,
  processManager,
  access,
}) {
  const inputSessions = new Map();

  function isIgnorableTelegramError(error, patterns = []) {
    const message = String(error?.message || "");
    return patterns.some((pattern) => message.includes(pattern));
  }

  async function reply(chatId, text, options = {}) {
    await bot.sendMessage(chatId, text, options);
  }

  async function sendProcessingMessage(chatId) {
    return bot.sendMessage(chatId, "⌛️ Hệ thống đang xử lý...");
  }

  async function deleteTelegramMessage(chatId, messageId) {
    if (!messageId) {
      return;
    }

    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      if (
        isIgnorableTelegramError(error, [
          "message to delete not found",
          "message can't be deleted",
        ])
      ) {
        return;
      }

      throw error;
    }
  }

  async function rejectUnauthorized(chatId) {
    await reply(chatId, "Bạn không có quyền sử dụng bot này.");
  }

  async function isGroupAdmin(chatId, userId) {
    if (!chatId || !userId) {
      return false;
    }

    try {
      const member = await bot.getChatMember(chatId, userId);
      return member?.status === "administrator" || member?.status === "creator";
    } catch (error) {
      process.stderr.write(
        `[telegram-bot] getChatMember failed for ${chatId}/${userId}: ${error.message}\n`,
      );
      return false;
    }
  }

  async function canControlGroup(msg) {
    if (!access.isGroupChat(msg.chat)) {
      return false;
    }

    if (access.isAuthorizedUser(msg.from?.id)) {
      return true;
    }

    return isGroupAdmin(msg.chat.id, msg.from?.id);
  }

  async function canStartInGroup(msg) {
    if (!access.isGroupChat(msg.chat)) {
      return false;
    }

    if (access.isAuthorizedUser(msg.from?.id)) {
      return true;
    }

    return isGroupAdmin(msg.chat.id, msg.from?.id);
  }

  async function answerCallback(query, text) {
    try {
      await bot.answerCallbackQuery(query.id, text ? { text } : {});
    } catch (error) {
      if (
        isIgnorableTelegramError(error, [
          "query is too old",
          "query ID is invalid",
          "response timeout expired",
        ])
      ) {
        return;
      }

      throw error;
    }
  }

  async function sendOrEditPanel(chatId, messageId = null) {
    store.ensureChatConfig();

    const text = buildPanelText({
      chatId,
      getChatConfig: store.getChatConfig,
      makeDefaultConfig: store.makeDefaultConfig,
      status: processManager.buildStatusMessage(),
    });
    const replyMarkup = buildPanelKeyboard({
      chatId,
      getChatConfig: store.getChatConfig,
      makeDefaultConfig: store.makeDefaultConfig,
    });

    if (messageId) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: replyMarkup,
        });
      } catch (error) {
        if (
          isIgnorableTelegramError(error, [
            "message is not modified",
            "message to edit not found",
          ])
        ) {
          return;
        }

        throw error;
      }
      return;
    }

    await bot.sendMessage(chatId, text, {
      reply_markup: replyMarkup,
    });
  }

  async function promptForInput(chatId, field, label) {
    inputSessions.set(String(chatId), { field });
    await reply(chatId, `Nhập ${label}:`);
  }

  async function handlePrivatePanelCallback(query) {
    const chatId = query.message?.chat?.id;
    if (!chatId) {
      await answerCallback(query);
      return;
    }

    store.ensureChatConfig();

    switch (query.data) {
      case "panel:set_table":
        await answerCallback(query);
        await promptForInput(chatId, "tableName", "bàn, ví dụ C15");
        return;
      case "panel:set_total":
        await answerCallback(query);
        await promptForInput(chatId, "total", "tổng lãi, ví dụ 200");
        return;
      case "panel:set_bet_init":
        await answerCallback(query);
        await promptForInput(chatId, "betInit", "tiền cược, ví dụ 5");
        return;
      case "panel:start": {
        const config = store.getChatConfig();
        try {
          await processManager.startScreenshotProcess(config, {
            recipientChatId: chatId,
            targetTitle:
              query.message.chat?.username ||
              query.message.chat?.title ||
              `chat-${chatId}`,
          });
          await answerCallback(query, "Đã start.");
          await sendOrEditPanel(chatId, query.message.message_id);
        } catch (error) {
          await answerCallback(query, error.message);
        }
        return;
      }
      case "panel:status":
        await answerCallback(query, "Đã cập nhật trạng thái.");
        await sendOrEditPanel(chatId, query.message.message_id);
        return;
      case "panel:stop":
        await processManager.stopScreenshotProcess();
        await answerCallback(query, "Đã stop.");
        await sendOrEditPanel(chatId, query.message.message_id);
        return;
      case "panel:refresh":
        await answerCallback(query, "Đã refresh panel.");
        await sendOrEditPanel(chatId, query.message.message_id);
        return;
      default:
        await answerCallback(query);
    }
  }

  async function startBotForChat(msg, startedByLabel) {
    const config = store.ensureChatConfig();
    const processingMessage = await sendProcessingMessage(msg.chat.id);

    try {
      await processManager.startScreenshotProcess(config, {
        recipientChatId: msg.chat.id,
        targetTitle:
          msg.chat.title || msg.chat.username || `chat-${msg.chat.id}`,
      });
      await deleteTelegramMessage(msg.chat.id, processingMessage.message_id);
      logGroupStartAttempt(msg, "started", {
        startedBy: startedByLabel,
      });
    } catch (error) {
      await deleteTelegramMessage(msg.chat.id, processingMessage.message_id);
      logGroupStartAttempt(msg, "failed", {
        startedBy: startedByLabel,
        reason: error.message,
      });
      await reply(
        msg.chat.id,
        [
          `Không thể start bot: ${error.message}`,
          formatConfigMessage(config),
          msg.chat.type === "private"
            ? "Hãy cấu hình bàn, tổng lãi và tiền cược trong /panel trước."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  }

  function logGroupStartAttempt(msg, status, extra = {}) {
    if (!access.isGroupChat(msg.chat)) {
      return;
    }

    const entry = {
      at: new Date().toISOString(),
      status,
      chatId: String(msg.chat.id),
      chatTitle: msg.chat.title || `chat-${msg.chat.id}`,
      chatType: msg.chat.type,
      userId: String(msg.from?.id || ""),
      username: msg.from?.username || "",
      firstName: msg.from?.first_name || "",
      lastName: msg.from?.last_name || "",
      text: String(msg.text || ""),
      ...extra,
    };

    process.stdout.write(
      `[telegram-bot] group /start log: at=${entry.at} group=${entry.chatTitle}(${entry.chatId}) user=${entry.firstName || "unknown"}${entry.lastName ? ` ${entry.lastName}` : ""}${entry.username ? ` @${entry.username}` : ""}(${entry.userId || "unknown"}) status=${entry.status}${entry.reason ? ` reason=${entry.reason}` : ""}\n`,
    );
  }

  function buildCommandRegex(command) {
    return new RegExp(`^\\/${command}(?:@\\w+)?$`, "i");
  }

  bot.onText(buildCommandRegex("start"), async (msg) => {
    if (access.canUsePrivatePanel(msg)) {
      await startBotForChat(msg, "private_panel_user");
      return;
    }

    if (await canStartInGroup(msg)) {
      await startBotForChat(msg, "group_admin_or_owner");
      return;
    }

    logGroupStartAttempt(msg, "rejected", {
      reason: "group_user_not_admin_or_owner",
    });
    await rejectUnauthorized(msg.chat.id);
  });

  bot.onText(/^\/admin(?:@\w+)?$|^\/panel(?:@\w+)?$/i, async (msg) => {
    if (!access.canUsePrivatePanel(msg)) {
      await rejectUnauthorized(msg.chat.id);
      return;
    }

    store.ensureChatConfig();
    await sendOrEditPanel(msg.chat.id);
  });

  bot.onText(buildCommandRegex("status"), async (msg) => {
    if (!access.canUsePrivatePanel(msg) && !(await canControlGroup(msg))) {
      await rejectUnauthorized(msg.chat.id);
      return;
    }

    const config = store.ensureChatConfig();
    await reply(
      msg.chat.id,
      [processManager.buildStatusMessage(), formatConfigMessage(config)].join(
        "\n\n",
      ),
    );
  });

  bot.onText(buildCommandRegex("stop"), async (msg) => {
    if (!access.canUsePrivatePanel(msg) && !(await canControlGroup(msg))) {
      await rejectUnauthorized(msg.chat.id);
      return;
    }

    const processingMessage = await sendProcessingMessage(msg.chat.id);

    try {
      const stopped = await processManager.stopScreenshotProcess();
      await deleteTelegramMessage(msg.chat.id, processingMessage.message_id);
      if (!stopped) {
        await reply(msg.chat.id, "No screenshot flow is running.");
      }
    } catch (error) {
      await deleteTelegramMessage(msg.chat.id, processingMessage.message_id);
      await reply(msg.chat.id, `Không thể stop bot: ${error.message}`);
    }
  });

  bot.onText(/^\/table\s+(.+)$/i, async (msg, match) => {
    if (!access.canUsePrivatePanel(msg) && !(await canControlGroup(msg))) {
      await rejectUnauthorized(msg.chat.id);
      return;
    }

    const rawTableName = String(match?.[1] || "").trim();
    if (!rawTableName) {
      await reply(msg.chat.id, "Please send /table <tableName>.");
      return;
    }

    const config = store.updateChatConfig(msg.chat.id, (current) => ({
      ...current,
      tableName: rawTableName.toUpperCase(),
    }));

    await reply(
      msg.chat.id,
      [`Đã cập nhật bàn.`, formatConfigMessage(config)].join("\n\n"),
    );
  });

  bot.onText(/^\/betConfig\s+(\d+)\s+(\d+)$/i, async (msg, match) => {
    if (!access.canUsePrivatePanel(msg) && !(await canControlGroup(msg))) {
      await rejectUnauthorized(msg.chat.id);
      return;
    }

    const total = Number(match?.[1] || 0);
    const betInit = Number(match?.[2] || 0);

    if (!Number.isFinite(total) || !Number.isFinite(betInit) || betInit <= 0) {
      await reply(
        msg.chat.id,
        "Please send /betConfig <total> <betInit> with valid numbers.",
      );
      return;
    }

    const config = store.updateChatConfig(msg.chat.id, (current) => ({
      ...current,
      betConfig: { total, betInit },
    }));

    await reply(
      msg.chat.id,
      ["Updated bet config.", formatConfigMessage(config)].join("\n\n"),
    );
  });

  bot.on("callback_query", async (query) => {
    const chat = query.message?.chat;
    const from = query.from;

    if (!chat || !from || !access.isAuthorizedUser(from.id)) {
      await answerCallback(query, "Bạn không có quyền.");
      return;
    }

    if (chat.type !== "private") {
      await answerCallback(query, "Panel admin chỉ dùng trong chat riêng với bot.");
      return;
    }

    if (!String(query.data || "").startsWith("panel:")) {
      await answerCallback(query);
      return;
    }

    await handlePrivatePanelCallback(query);
  });

  bot.on("message", async (msg) => {
    if (!access.canUsePrivatePanel(msg)) {
      return;
    }

    const session = inputSessions.get(String(msg.chat.id));
    const text = String(msg.text || "").trim();

    if (!session || !text || text.startsWith("/")) {
      return;
    }

    try {
      let config = store.getChatConfig() || store.ensureChatConfig();

      if (session.field === "tableName") {
        config = store.updateChatConfig(msg.chat.id, (current) => ({
          ...current,
          tableName: text.toUpperCase(),
        }));
      }

      if (session.field === "total") {
        const total = Number(text);
        if (!Number.isFinite(total) || total < 0) {
          throw new Error("Tổng lãi phải là số hợp lệ.");
        }

        config = store.updateChatConfig(msg.chat.id, (current) => ({
          ...current,
          betConfig: {
            ...current.betConfig,
            total,
          },
        }));
      }

      if (session.field === "betInit") {
        const betInit = Number(text);
        if (!Number.isFinite(betInit) || betInit <= 0) {
          throw new Error("Tiền cược phải là số lớn hơn 0.");
        }

        config = store.updateChatConfig(msg.chat.id, (current) => ({
          ...current,
          betConfig: {
            ...current.betConfig,
            betInit,
          },
        }));
      }

      inputSessions.delete(String(msg.chat.id));
      await reply(
        msg.chat.id,
        ["Đã lưu cấu hình.", formatConfigMessage(config)].join("\n\n"),
      );
      await sendOrEditPanel(msg.chat.id);
    } catch (error) {
      await reply(msg.chat.id, error.message);
    }
  });

  bot.on("polling_error", (error) => {
    process.stderr.write(`[telegram-bot] polling error: ${error.message}\n`);
  });
}

module.exports = {
  registerHandlers,
};
