import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PopoutApp } from "./components/PopoutApp";
import { readWindowMode } from "./lib/window-mode";
import "./styles/globals.css";

const rootElement = document.getElementById("root");
const mode = readWindowMode(window.location.search);

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {mode.kind === "popout" ? <PopoutApp sessionId={mode.sessionId} /> : <App />}
    </React.StrictMode>
  );
}
