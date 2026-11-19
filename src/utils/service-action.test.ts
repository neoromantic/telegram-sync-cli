import { describe, expect, it } from "bun:test";
import { Long, type tl } from "@mtcute/bun";

import { toRawJson } from "./raw-json";
import { extractServiceAction } from "./service-action";

const peerId = { _: "peerUser" as const, userId: 1001 };

function service(action: tl.TypeMessageAction) {
  const result: tl.RawMessageService = {
    _: "messageService",
    id: 40,
    peerId,
    date: 1_760_000_000,
    action,
  };
  return result;
}

function cached(message: tl.RawMessageService) {
  return extractServiceAction(toRawJson(message));
}

describe("extractServiceAction", () => {
  it("leaves out what Telegram didn't say: a call's reason and duration, a pin's message", () => {
    expect(
      cached(
        service({
          _: "messageActionPhoneCall",
          callId: Long.fromString("7000000000000000005"),
        }),
      ),
    ).toEqual({ type: "phone_call", video: false, duration: null, reason: null });
    expect(cached(service({ _: "messageActionPinMessage" }))).toEqual({
      type: "pin_message",
      messageId: null,
    });
  });

  it("reads group changes: created, users added and removed, joined by link", () => {
    expect(
      cached(
        service({
          _: "messageActionChatCreate",
          title: "Example Book Club",
          users: [1001, 1002, 1003],
        }),
      ),
    ).toEqual({
      type: "chat_create",
      title: "Example Book Club",
      userIds: [1001, 1002, 1003],
    });
    expect(cached(service({ _: "messageActionChatAddUser", users: [1004] }))).toEqual({
      type: "chat_add_user",
      userIds: [1004],
    });
    expect(cached(service({ _: "messageActionChatDeleteUser", userId: 1002 }))).toEqual({
      type: "chat_delete_user",
      userId: 1002,
    });
    expect(cached(service({ _: "messageActionChatJoinedByLink", inviterId: 1001 }))).toEqual({
      type: "chat_joined_by_link",
      inviterId: 1001,
    });
  });

  it("is null for ordinary messages and anything that is not a message", () => {
    expect(
      extractServiceAction(JSON.stringify({ _: "message", id: 1, date: 1, message: "hi" })),
    ).toBeNull();
    expect(extractServiceAction("{}")).toBeNull();
    expect(extractServiceAction("not json")).toBeNull();
    expect(extractServiceAction(null)).toBeNull();
    expect(extractServiceAction({ _: "messageService", id: 1, action: null })).toBeNull();
  });
});
