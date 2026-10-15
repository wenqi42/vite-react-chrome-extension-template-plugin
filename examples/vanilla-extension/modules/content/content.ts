import "./content.css";

const marker = "data-vanilla-extension";
document.documentElement.setAttribute(marker, "loaded");

const badge = document.createElement("div");
badge.id = "vanilla-extension-badge";
badge.textContent = "Vanilla content script loaded";
document.documentElement.append(badge);
