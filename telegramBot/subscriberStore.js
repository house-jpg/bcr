const fs = require("fs");
const path = require("path");

function createSubscriberStore({
  storePath,
  logError = () => {},
}) {
  const initialState = {
    version: 1,
    chatIds: [],
  };

  const state = loadStore();

  function normalizeChatId(chatId) {
    return String(chatId || "").trim();
  }

  function loadStore() {
    try {
      if (!fs.existsSync(storePath)) {
        return { ...initialState };
      }

      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const chatIds = Array.isArray(parsed.chatIds)
        ? parsed.chatIds
            .map((chatId) => normalizeChatId(chatId))
            .filter(Boolean)
        : [];

      return {
        version: parsed.version || 1,
        chatIds,
      };
    } catch (error) {
      logError(`[telegram-bot] failed to load subscriber store: ${error.message}`);
      return { ...initialState };
    }
  }

  function saveStore() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
  }

  function getChatIds() {
    return [...state.chatIds];
  }

  function hasChatId(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    return normalizedChatId ? state.chatIds.includes(normalizedChatId) : false;
  }

  function addChatId(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      return false;
    }

    if (state.chatIds.includes(normalizedChatId)) {
      return false;
    }

    state.chatIds.push(normalizedChatId);
    saveStore();
    return true;
  }

  function removeChatId(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      return false;
    }

    const nextChatIds = state.chatIds.filter((entry) => entry !== normalizedChatId);
    if (nextChatIds.length === state.chatIds.length) {
      return false;
    }

    state.chatIds = nextChatIds;
    saveStore();
    return true;
  }

  function clear() {
    if (state.chatIds.length === 0) {
      return false;
    }

    state.chatIds = [];
    saveStore();
    return true;
  }

  return {
    addChatId,
    clear,
    getChatIds,
    hasChatId,
    removeChatId,
  };
}

module.exports = {
  createSubscriberStore,
};
