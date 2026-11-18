import { z } from 'zod'

/** Shared by model parsing, engine validation and the authenticated Client wire. */
export const interpretationSchema = z.object({
  text: z.string().trim().min(1).max(8192),
  kind: z.enum(['correction', 'completion']),
  certainty: z.enum(['confident', 'tentative']),
  explanation: z.string().trim().min(1).max(500),
}).strict()
