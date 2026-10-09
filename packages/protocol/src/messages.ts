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
  sessionId: z.string(), // 원하는 id(파일마다 고정). 서버가 겹치면 -2, -3을 붙여 welcome으로 알린다
  fileName: z.string(),
  instance: z.string().optional(), // 플러그인을 실행할 때마다 새로 만든다. 같은 창의 재연결과 다른 탭을 가른다
});

export const WelcomeSchema = z.object({ type: z.literal('welcome'), sessionId: z.string().optional() });

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
