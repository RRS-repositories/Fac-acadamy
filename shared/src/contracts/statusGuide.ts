import { z } from 'zod';

// Status Guide contract (S05): the firm's client-friendly line for every CRM
// status, as the reference page reads it.
//
// This file ships to the browser, so it holds SHAPES only. The 34 rows
// themselves live in academy.status_guide (seeded in S02 from the prototype)
// and reach the browser over GET /api/status-guide at runtime — never from the
// bundle, and never from a fixture in this repo.

/** One row of academy.status_guide. */
export const StatusGuideRowSchema = z.object({
  /** The CRM status exactly as it appears on the claim. */
  status: z.string(),
  /** What the agent says to the client for that status. */
  clientLine: z.string(),
  /** 1-based display order, unique across the table. */
  sort: z.number().int(),
});
export type StatusGuideRow = z.infer<typeof StatusGuideRowSchema>;

/** GET /api/status-guide. Every row, in `sort` order. */
export const StatusGuideResponseSchema = z.object({
  rows: z.array(StatusGuideRowSchema),
});
export type StatusGuideResponse = z.infer<typeof StatusGuideResponseSchema>;
