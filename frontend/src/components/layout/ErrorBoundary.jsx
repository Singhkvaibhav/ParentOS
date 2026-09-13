import { Component } from "react";
import i18n from "../../i18n";

// Catches render-time errors in the component tree below it so one broken
// component shows a recoverable message instead of a blank white screen.
// Note: this does NOT catch errors in event handlers or async code (React
// error boundaries never do) - those still need their own try/catch, which
// is what showToast is for elsewhere in this app.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled error in the UI:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "3rem 1.5rem", textAlign: "center", fontFamily: "sans-serif" }}>
          <h1 style={{ marginBottom: "0.5rem" }}>{i18n.t("errorBoundary.title")}</h1>
          <p style={{ color: "#8C8468", marginBottom: "1.5rem" }}>
            {i18n.t("errorBoundary.body")}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "0.6rem 1.25rem", borderRadius: "999px", border: "none", background: "#33513F", color: "#FBF9F3", cursor: "pointer" }}
          >
            {i18n.t("errorBoundary.reload")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
