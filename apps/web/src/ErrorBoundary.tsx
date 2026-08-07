import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Stage 1 step 13 — error boundary and global error display.
 *
 * A render crash shows a visible, readable panel rather than a blank page. Blank pages
 * are the worst failure mode in a local-first app: nothing is logged where the user can
 * see it, and "it stopped working" is all the report anyone can give.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="panel panel--error">
        <h1>Something broke while rendering.</h1>
        <p>
          This is a bug in P80, not something you did. Your data is untouched — the
          database is only written by the API and the worker.
        </p>
        {/* Rendered as text, never as HTML. Transcript text is untrusted input
            (§32.6) and can reach an error message through a stack trace. */}
        <pre>{error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
