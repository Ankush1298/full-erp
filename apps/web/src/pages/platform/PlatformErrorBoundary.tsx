import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class PlatformErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public override componentDidCatch(_error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="platform-error-boundary-wrapper" role="alert">
          <div className="platform-error-boundary-card">
            <div className="error-icon-badge" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" x2="12" y1="9" y2="13" />
                <line x1="12" x2="12.01" y1="17" y2="17" />
              </svg>
            </div>
            <h2 className="error-card-title">
              {this.props.fallbackTitle || 'Platform Control Center Notice'}
            </h2>
            <p className="error-card-desc">
              An unexpected condition occurred while rendering this platform view. The error has
              been contained by the Platform Error Boundary to protect your session and avoid
              application disruption.
            </p>

            {this.state.error && (
              <div className="error-details-box">
                <code className="error-message-text">
                  {this.state.error.name}: {this.state.error.message}
                </code>
              </div>
            )}

            <div className="error-actions-row">
              <button
                type="button"
                className="platform-btn platform-btn-primary"
                onClick={this.handleReset}
              >
                Retry View
              </button>
              <Link
                to="/platform"
                className="platform-btn platform-btn-secondary"
                onClick={this.handleReset}
              >
                Return to Dashboard
              </Link>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
