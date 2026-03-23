import "@fontsource/space-grotesk/700.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/ibm-plex-mono/400.css";

import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
    await Promise.all(registrations.map((registration) => registration.unregister()));

    if ("caches" in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
    }
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
