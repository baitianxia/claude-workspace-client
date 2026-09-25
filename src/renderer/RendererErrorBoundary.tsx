import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

interface RendererErrorBoundaryProps {
  children: ReactNode;
  title?: string;
}

interface RendererErrorBoundaryState {
  error: Error | null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Keep a renderer exception from leaving Electron showing only its background
 * color. The retry action handles transient lazy-chunk errors; a full reload
 * handles a stale preload or a failed module cache.
 */
export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return { error: asError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Renderer error", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="renderer-error-screen" role="alert">
        <div className="renderer-error-card">
          <strong>{this.props.title ?? "界面加载失败"}</strong>
          <span>请先重试；如果仍然失败，请重新加载客户端。</span>
          <details>
            <summary>查看错误详情</summary>
            <code>{this.state.error.message}</code>
          </details>
          <div className="renderer-error-actions">
            <button type="button" onClick={this.retry}>重试</button>
            <button type="button" className="primary-button" onClick={this.reload}>
              重新加载客户端
            </button>
          </div>
        </div>
      </div>
    );
  }
}
