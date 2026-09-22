import { useQuery } from '@tanstack/react-query';
import { HealthResponseSchema } from '@fac-academy/shared';

/**
 * GET a JSON endpoint on the same origin. Throws an Error carrying `status`
 * for any non-2xx response.
 */
export async function apiGet(path) {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const error = new Error(`Request to ${path} failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => HealthResponseSchema.parse(await apiGet('/api/health')),
  });
}
