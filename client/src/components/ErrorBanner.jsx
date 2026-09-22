import { Component } from 'react';

// Error boundary: if anything below throws while rendering, show a red banner
// with the message instead of a blank page (mirrors the prototype's
// window.onerror banner).
export default class ErrorBanner extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Render error', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div role="alert" className="bg-red px-4 py-3 text-sm font-medium text-white">
          Something went wrong: {error.message || String(error)}
        </div>
      );
    }
    return this.props.children;
  }
}
