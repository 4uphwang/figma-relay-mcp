import { z } from 'zod';
import { WireErrorSchema } from './messages';

// 허브: 포트를 잡은 백그라운드 프로세스 하나가 Figma 플러그인들과 붙고,
// Claude 세션마다 뜨는 stdio 서버(클라이언트)는 같은 포트에 붙어 요청을 넘긴다.

export const SessionInfoSchema = z.object({ sessionId: z.string(), fileName: z.string(), connectedAt: z.number() });

export const ClientHelloSchema = z.object({
  type: z.literal('client'),
  token: z.string(),
  label: z.string(), // 플러그인 활동 기록에 보이는 이름(작업 폴더)
  build: z.number(),
});

export const CallSchema = z.object({
  type: z.literal('call'),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
  sessionId: z.string().optional(),
  timeoutMs: z.number().optional(),
});

// 클라이언트가 더 새 빌드면 허브를 내리고 새 코드로 다시 띄운다
export const RestartSchema = z.object({ type: z.literal('restart') });

export const ClientToHubSchema = z.union([CallSchema, RestartSchema]);

export const HubWelcomeSchema = z.object({
  type: z.literal('hubWelcome'),
  build: z.number(),
  sessions: z.array(SessionInfoSchema),
});

export const SessionsUpdateSchema = z.object({ type: z.literal('sessions'), sessions: z.array(SessionInfoSchema) });

export const CallResultSchema = z.union([
  z.object({ type: z.literal('callResult'), id: z.string(), ok: z.literal(true), result: z.unknown(), session: SessionInfoSchema, parts: z.number().int().nonnegative() }),
  z.object({ type: z.literal('callResult'), id: z.string(), ok: z.literal(false), error: WireErrorSchema }),
]);

export const HubToClientSchema = z.union([HubWelcomeSchema, SessionsUpdateSchema, CallResultSchema]);

export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type ClientToHub = z.infer<typeof ClientToHubSchema>;
export type HubToClient = z.infer<typeof HubToClientSchema>;
