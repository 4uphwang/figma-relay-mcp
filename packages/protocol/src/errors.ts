export const ERROR_CODES = [
  'NOT_CONNECTED',
  'PORT_IN_USE',
  'NODE_NOT_FOUND',
  'FONT_MISSING',
  'IMAGE_FAILED',
  'TIMEOUT',
  'EXEC_ERROR',
  'INVALID_ARGS',
  'IO_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WireError {
  code: ErrorCode;
  message: string;
  hint?: string;
}
