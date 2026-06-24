function normalizeConfiguredDomain(rawDomain) {
  if (!rawDomain || typeof rawDomain !== "string" || rawDomain.trim() === "") {
    throw new Error(`ENV DOMAIN không hợp lệ. Giá trị: ${JSON.stringify(rawDomain)}`);
  }

  let parsed;
  try {
    parsed = new URL(rawDomain.trim());
  } catch (error) {
    throw new Error(`ENV DOMAIN không parse được: ${rawDomain.trim()}`);
  }

  return {
    raw: rawDomain.trim(),
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
  };
}

function isBrowserInternalUrl(url) {
  return (
    !url ||
    url === "about:blank" ||
    url.startsWith("about:") ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  );
}

function isUrlAllowed(url, configuredDomain) {
  if (isBrowserInternalUrl(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    return (
      hostname === configuredDomain.hostname ||
      hostname.endsWith(`.${configuredDomain.hostname}`) ||
      url.includes(configuredDomain.raw)
    );
  } catch (_error) {
    return false;
  }
}

async function closePageSafely(page) {
  if (!page || page.isClosed()) {
    return;
  }

  await page.close().catch(() => {});
}

async function enforcePageDomain(page, configuredDomain, logFn, options = {}) {
  if (!page || page.isClosed()) {
    return true;
  }

  const { closePageOnMismatch = true, throwOnMismatch = false, reason = "domain-check" } =
    options;

  const currentUrl = page.url();
  if (isUrlAllowed(currentUrl, configuredDomain)) {
    return true;
  }

  const message = `Detected page outside DOMAIN during ${reason}: ${currentUrl} (allowed: ${configuredDomain.raw})`;
  await logFn(message);

  if (closePageOnMismatch) {
    await closePageSafely(page);
  }

  if (throwOnMismatch) {
    throw new Error(message);
  }

  return false;
}

async function closePagesOutsideDomain(context, configuredDomain, logFn, options = {}) {
  const pages = typeof context?.pages === "function" ? context.pages() : [];

  for (const page of pages) {
    await enforcePageDomain(page, configuredDomain, logFn, {
      reason: "context-bootstrap",
      ...options,
    });
  }
}

function attachDomainGuardToPage(page, configuredDomain, logFn, options = {}) {
  if (!page) {
    return;
  }

  const { throwOnMainFrameMismatch = false, isPrimaryPage = false } = options;

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }

    enforcePageDomain(page, configuredDomain, logFn, {
      closePageOnMismatch: true,
      throwOnMismatch: throwOnMainFrameMismatch && isPrimaryPage,
      reason: "navigation",
    }).catch(async (error) => {
      await logFn(`Domain guard triggered an error: ${error.message}`);
      if (!page.isClosed()) {
        await closePageSafely(page);
      }
    });
  });
}

function attachDomainGuardToContext(context, configuredDomain, logFn, options = {}) {
  if (!context) {
    return;
  }

  const primaryPage = options.primaryPage || null;

  for (const page of context.pages()) {
    attachDomainGuardToPage(page, configuredDomain, logFn, {
      ...options,
      isPrimaryPage: page === primaryPage,
    });
  }

  context.on("page", async (page) => {
    attachDomainGuardToPage(page, configuredDomain, logFn, {
      ...options,
      isPrimaryPage: page === primaryPage,
    });

    await enforcePageDomain(page, configuredDomain, logFn, {
      closePageOnMismatch: true,
      throwOnMismatch: false,
      reason: "new-page",
    });
  });
}

module.exports = {
  attachDomainGuardToContext,
  closePagesOutsideDomain,
  enforcePageDomain,
  normalizeConfiguredDomain,
};
