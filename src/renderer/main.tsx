import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import { RendererErrorBoundary } from "./RendererErrorBoundary";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element was not found.");
}
const rootContainer: HTMLElement = rootElement;

// A file dropped anywhere outside a drop target must not make the window
// navigate to it (that would replace the whole UI). The terminal handles its
// own drops and inserts the file paths.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    // Text dragged between inputs never navigates; leave it alone.
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer && type === "dragover") {
      event.dataTransfer.dropEffect = "none";
    }
  });
}

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
      <RendererErrorBoundary>
        <App />
      </RendererErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
