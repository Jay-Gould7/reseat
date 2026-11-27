import type { IncomingMessage, ServerResponse } from "node:http";
export function createWaitlistApi(env: Record<string, string | undefined>): {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): void;
};
