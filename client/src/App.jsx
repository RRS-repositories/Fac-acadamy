import { Route, Routes } from 'react-router-dom';
import ErrorBanner from './components/ErrorBanner.jsx';
import ScrollToTopOnNavigate from './components/ScrollToTopOnNavigate.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import RequireAuth from './auth/RequireAuth.jsx';
import RequireManager from './auth/RequireManager.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/auth/Login.jsx';
import ManagerHome from './pages/manager/ManagerHome.jsx';
import NotFound from './pages/NotFound.jsx';

// The router itself lives in main.jsx (BrowserRouter), so tests can wrap
// App in a MemoryRouter instead. AuthProvider needs the router (for logout).
export default function App() {
  return (
    <ErrorBanner>
      <AuthProvider>
        <ScrollToTopOnNavigate />
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <Home />
              </RequireAuth>
            }
          />
          <Route
            path="/manager"
            element={
              <RequireManager>
                <ManagerHome />
              </RequireManager>
            }
          />
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </ErrorBanner>
  );
}
