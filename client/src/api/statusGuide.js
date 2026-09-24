import { useQuery } from '@tanstack/react-query';
import { StatusGuideResponseSchema } from '@fac-academy/shared';
import { ApiError, apiGet } from './client.js';

/**
 * The Status Guide rows (S05). The 34 rows live in academy.status_guide and
 * come over the API at runtime — never from the bundle — so the content stays
 * out of this repo and out of the browser's JavaScript.
 */
export async function fetchStatusGuide() {
  const parsed = StatusGuideResponseSchema.safeParse(await apiGet('/api/status-guide'));
  if (!parsed.success) {
    throw new ApiError(200, 'bad_response', 'Unexpected response from server');
  }
  return parsed.data.rows;
}

export function useStatusGuide() {
  return useQuery({
    queryKey: ['status-guide'],
    queryFn: fetchStatusGuide,
    // Reference data: it changes when the firm updates the guide, not per page
    // view, so one fetch per session is plenty.
    staleTime: 5 * 60 * 1000,
  });
}
