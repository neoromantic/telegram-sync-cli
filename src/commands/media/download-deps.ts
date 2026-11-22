import { getAccountMediaDir } from "../../db";
import { getClientForAccount } from "../../services/telegram";
import { createProgress } from "../../utils/progress";
import { wrapClientCallWithRateLimits } from "../../utils/telegram-rate-limits";
import { openHistory } from "../messages/helpers";
import type { DownloadDeps } from "./download-media";

export function openDownloadDeps(accountId: number, context: string, signal: AbortSignal) {
  const history = openHistory(accountId, context);
  return {
    cacheDb: history.cacheDb,
    mediaDir: getAccountMediaDir(accountId),
    getClient: async () =>
      wrapClientCallWithRateLimits(await getClientForAccount(accountId), { accountId, context }),
    history,
    signal,
    progress: createProgress,
  } satisfies DownloadDeps;
}
