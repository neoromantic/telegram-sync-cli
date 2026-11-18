import { describe, expect, it } from "bun:test";
import { Long, type tl } from "@mtcute/bun";

import { toRawJson } from "../utils/raw-json";
import { extractServiceAction } from "../utils/service-action";

const peerId = { _: "peerUser" as const, userId: 1001 };

function service(
  action: tl.TypeMessageAction,
  extra: Partial<tl.RawMessageService> = {},
): tl.RawMessageService {
  return {
    _: "messageService",
    id: 40,
    peerId,
    date: 1_760_000_000,
    action,
    ...extra,
  };
}

function cached(message: tl.RawMessageService) {
  return extractServiceAction(toRawJson(message));
}

describe("extractServiceAction", () => {
  it("reads an answered voice call with its duration", () => {
    const message = service({
      _: "messageActionPhoneCall",
      callId: Long.fromString("7000000000000000001"),
      reason: { _: "phoneCallDiscardReasonHangup" },
      duration: 1834,
    });

    expect(cached(message)).toEqual({
      type: "phone_call",
      video: false,
      duration: 1834,
      reason: "hangup",
    });
    expect(extractServiceAction(message)).toEqual(cached(message));
  });

  it("reads a video call", () => {
    expect(
      cached(
        service({
          _: "messageActionPhoneCall",
          video: true,
          callId: Long.fromString("7000000000000000002"),
          reason: { _: "phoneCallDiscardReasonDisconnect" },
          duration: 95,
        }),
      ),
    ).toEqual({
      type: "phone_call",
      video: true,
      duration: 95,
      reason: "disconnect",
    });
  });

  it("reads a missed call: no duration", () => {
    expect(
      cached(
        service({
          _: "messageActionPhoneCall",
          callId: Long.fromString("7000000000000000003"),
          reason: { _: "phoneCallDiscardReasonMissed" },
        }),
      ),
    ).toEqual({
      type: "phone_call",
      video: false,
      duration: null,
      reason: "missed",
    });
  });

  it("reads a busy call and one without a reason", () => {
    const busy = cached(
      service({
        _: "messageActionPhoneCall",
        callId: Long.fromString("7000000000000000004"),
        reason: { _: "phoneCallDiscardReasonBusy" },
      }),
    );
    const noReason = cached(
      service({
        _: "messageActionPhoneCall",
        callId: Long.fromString("7000000000000000005"),
      }),
    );

    expect(busy).toMatchObject({ reason: "busy", duration: null });
    expect(noReason).toMatchObject({ reason: null, duration: null });
  });

  it("reads the pinned message from the reply header", () => {
    expect(
      cached(
        service(
          { _: "messageActionPinMessage" },
          { replyTo: { _: "messageReplyHeader", replyToMsgId: 31 } },
        ),
      ),
    ).toEqual({ type: "pin_message", messageId: 31 });
    expect(cached(service({ _: "messageActionPinMessage" }))).toEqual({
      type: "pin_message",
      messageId: null,
    });
  });

  it("reads group changes: created, renamed, users added and removed", () => {
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
    expect(cached(service({ _: "messageActionChatEditTitle", title: "Readers" }))).toEqual({
      type: "chat_edit_title",
      title: "Readers",
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

  it("gives an action it does not map its type name", () => {
    expect(cached(service({ _: "messageActionScreenshotTaken" }))).toEqual({
      type: "screenshot_taken",
    });
    expect(
      cached(
        service({
          _: "messageActionChatEditPhoto",
          photo: { _: "photoEmpty", id: Long.fromInt(1) },
        }),
      ),
    ).toEqual({ type: "chat_edit_photo" });
    expect(cached(service({ _: "messageActionSetMessagesTTL", period: 86_400 }))).toEqual({
      type: "set_messages_ttl",
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
