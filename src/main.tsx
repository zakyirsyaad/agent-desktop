import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PopoutApp } from "./components/PopoutApp";
import { loadAppFonts } from "./lib/fonts";
import { readWindowMode } from "./lib/window-mode";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/geist-mono";
import "./styles/globals.css";

const rootElement = document.getElementById("root");
const mode = readWindowMode(window.location.search);

if (rootElement) {
  void loadAppFonts().then(() => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        {mode.kind === "popout" ? <PopoutApp sessionId={mode.sessionId} /> : <App />}
      </React.StrictMode>
    );
  });
}
