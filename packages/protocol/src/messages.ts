import { z } from 'zod';
import { ERROR_CODES } from './errors';

export const WireErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  hint: z.string().optional(),
});

export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string(),
  sessionId: z.string(),
  fileName: z.string(),
});

export const WelcomeSchema = z.object({ type: z.literal('welcome') });

export const RequestSchema = z.object({
  type: z.literal('request'),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
  client: z.string().optional(), // 요청을 보낸 Claude 세션(작업 폴더 이름)
});

export const ResponseSchema = z.union([
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(false), error: WireErrorSchema }),
]);

export const PluginToServerSchema = z.union([HelloSchema, ResponseSchema]);
export const ServerToPluginSchema = z.union([WelcomeSchema, RequestSchema]);

export type Hello = z.infer<typeof HelloSchema>;
export type Request = z.infer<typeof RequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type PluginToServer = z.infer<typeof PluginToServerSchema>;
export type ServerToPlugin = z.infer<typeof ServerToPluginSchema>;
