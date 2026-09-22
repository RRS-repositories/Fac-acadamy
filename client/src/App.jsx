import { Route, Routes } from 'react-router-dom';
import ErrorBanner from './components/ErrorBanner.jsx';
import ScrollToTopOnNavigate from './components/ScrollToTopOnNavigate.jsx';
import Home from './pages/Home.jsx';
import NotFound from './pages/NotFound.jsx';

// The router itself lives in main.jsx (BrowserRouter), so tests can wrap
// App in a MemoryRouter instead.
export default function App() {
  return (
    <ErrorBanner>
      <ScrollToTopOnNavigate />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBanner>
  );
}
