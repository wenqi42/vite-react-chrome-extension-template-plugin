import "./popup.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing popup app root");

app.innerHTML = `
  <h1>Vanilla extension</h1>
  <p id="status">DOM popup loaded.</p>
`;

chrome.runtime.sendMessage({ type: "vanilla-popup-ready" });
