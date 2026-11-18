// Web pages: inject the sentence-focus reader into the page (content.js
// toggles itself if it is already there).
// PDFs and pages we can't inject into: open the built-in reader instead.
const READER = chrome.runtime.getURL("reader/index.html");

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const url = tab.url || "";
  const openReader = (u) =>
    chrome.tabs.create({
      url: READER + (u ? "?url=" + encodeURIComponent(u) : ""),
      index: tab.index + 1,
    });

  if (!/^(https?|file):/.test(url)) return openReader(); // new tab, chrome:// pages
  if (/\.pdf([?#]|$)/i.test(url)) return openReader(url);

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.contentType,
    });
    if (result === "application/pdf") return openReader(url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch {
    openReader(url);
  }
});
