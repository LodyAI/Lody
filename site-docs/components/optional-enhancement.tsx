'use client';

import { Component, type ReactNode } from 'react';

/** Decorative client features must not replace the page's static content on failure. */
export class OptionalEnhancement extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
