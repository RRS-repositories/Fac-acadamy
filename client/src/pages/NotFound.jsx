import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-muted">The page you asked for does not exist.</p>
      <p className="mt-4">
        <Link to="/" className="font-medium text-navy-mid underline">
          Back to the start
        </Link>
      </p>
    </main>
  );
}
