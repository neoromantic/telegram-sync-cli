import { describe, expect, it } from "bun:test";
import { tl } from "@mtcute/bun";
import { isPermanentSyncError } from "./sync-worker-utils";

describe("isPermanentSyncError", () => {
  it("treats 400, 403 and 404 RPC errors, and CHANNEL_PRIVATE with any code, as permanent", () => {
    for (const error of [
      new tl.RpcError(400, "CHANNEL_PRIVATE"),
      new tl.RpcError(400, "PEER_ID_INVALID"),
      new tl.RpcError(403, "CHAT_ADMIN_REQUIRED"),
      new tl.RpcError(404, "NOT_FOUND"),
      new tl.RpcError(406, "CHANNEL_PRIVATE"),
    ]) {
      expect(isPermanentSyncError(error)).toBe(true);
    }
  });

  it("treats account errors, server errors and the rest as transient", () => {
    for (const error of [
      new tl.RpcError(401, "AUTH_KEY_UNREGISTERED"),
      new tl.RpcError(406, "AUTH_KEY_DUPLICATED"),
      new tl.RpcError(420, "FLOOD_WAIT_X"),
      new tl.RpcError(500, "INTERNAL"),
      new tl.RpcError(-503, "Timeout"),
      new Error("connection reset"),
      "string error",
      undefined,
    ]) {
      expect(isPermanentSyncError(error)).toBe(false);
    }
  });
});
