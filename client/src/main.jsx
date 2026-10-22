import { Component, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing root element");
}

class StartupBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Keep the app usable even when the browser hits a startup error.
  }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ padding: 32, textAlign: "center" }}>
          <h2>Zoomly could not open</h2>
          <p>Reload the page to try again.</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(rootEl).render(
  <StrictMode>
    <StartupBoundary>
      <App />
    </StartupBoundary>
  </StrictMode>
);
