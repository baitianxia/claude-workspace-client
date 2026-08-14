import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element was not found.");
}
const rootContainer: HTMLElement = rootElement;

async function bootstrap(): Promise<void> {
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("preview")
  ) {
    const { installDevelopmentPreview } = await import("./development-preview");
    installDevelopmentPreview();
  }

  createRoot(rootContainer).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
