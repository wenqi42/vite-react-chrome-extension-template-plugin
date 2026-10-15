chrome.runtime.onInstalled.addListener(() => {
  console.log("vanilla extension ready");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "vanilla-popup-ready") {
    console.log("vanilla popup connected");
  }
});
