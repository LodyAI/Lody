import { Component, type ReactNode } from 'react';
export class SurfaceErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; onCrash?: (stack: string) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('surface_render_crashed', error, info.componentStack);
    this.props.onCrash?.(info.componentStack ?? error.message);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
