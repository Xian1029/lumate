"use client";

import { t } from "@/lib/i18n";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Custom fallback UI. Receives the error and a reset function. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Section name for error logging context (e.g. "quiz", "chat", "notes"). */
  section?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const section = this.props.section ?? "unknown";
    console.error(
      `[ErrorBoundary:${section}] Caught error:`,
      error,
      errorInfo.componentStack,
    );
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        this.props.fallback ?? (
          <div role="alert" className="flex flex-col items-center justify-center p-8 text-center gap-3 animate-fade-in">
            <p className="text-sm font-medium text-destructive">
              {this.props.section
                ? t("ui.section_load_failed")
                : t("ui.something_wrong")}
            </p>
            <button
              onClick={this.reset}
              aria-label={t("ui.retry_loading_this_component")}
              className="text-xs text-brand hover:underline"
            >
              {t("ui.try_again")}
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
