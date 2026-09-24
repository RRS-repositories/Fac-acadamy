import { z } from 'zod';

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  redis: z.boolean(),
  flag: z.boolean(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Body returned by content routes while ACADEMY_V2 is off. */
export const FlagOffResponseSchema = z.object({
  flag: z.literal('off'),
});

export type FlagOffResponse = z.infer<typeof FlagOffResponseSchema>;
