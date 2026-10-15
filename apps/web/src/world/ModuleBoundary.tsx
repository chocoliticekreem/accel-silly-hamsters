import { Component, type ReactNode } from "react";

// One broken module must never take down the whole city: it just disappears and logs.
export class ModuleBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[city] module ${this.props.name} crashed`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
