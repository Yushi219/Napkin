// Copy this file to js/config.local.js and paste your own keys.
// config.local.js is git-ignored: keys must never be committed.
//
//   anthropicKey — Claude, used to read the sketch and edit the model
//   geminiKey    — Nano Banana Pro, used for the AI render
//
// Without keys the app still runs: sketch reading falls back to the local
// silhouette engine and renders fall back to local stylisation.
window.NAPKIN_CONFIG = {
  openaiKey: '',        // ChatGPT builder engine (optional)
  anthropicKey: "",
  anthropicModel: "claude-sonnet-5",
  geminiKey: "",
  geminiModel: "gemini-3-pro-image-preview"
};
