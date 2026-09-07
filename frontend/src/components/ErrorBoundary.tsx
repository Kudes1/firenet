import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

// Граница вокруг страницы: падение одной страницы не должно оставлять
// пользователя с белым экраном и без навигации.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("firenet: unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="page">
          <div className="banner error" data-testid="error-boundary">
            Что-то пошло не так: {this.state.error.message}
          </div>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Попробовать снова
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
