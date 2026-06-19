function isGroupChat(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function createAccessControl({ adminPanelUserIds }) {
  function isAuthorizedUser(userId) {
    if (adminPanelUserIds.size === 0) {
      return false;
    }

    return adminPanelUserIds.has(String(userId));
  }

  function canUsePrivatePanel(msg) {
    return msg.chat?.type === "private" && isAuthorizedUser(msg.from?.id);
  }

  function canControlGroup(msg) {
    return isGroupChat(msg.chat) && isAuthorizedUser(msg.from?.id);
  }

  return {
    isAuthorizedUser,
    canUsePrivatePanel,
    canControlGroup,
    isGroupChat,
  };
}

module.exports = {
  createAccessControl,
};
