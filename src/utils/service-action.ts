/**
 * What a service message did (a call, a pin, a group change), read from its
 * raw TL message the way extractAttachment reads a file.
 */
/** A call between two users */
export interface PhoneCallAction {
  type: "phone_call";
  video: boolean;
  /** Seconds; null for a call nobody answered */
  duration: number | null;
  /** Why it ended: missed, busy (declined), hangup, disconnect; null if Telegram gave none */
  reason: string | null;
}

/** A group's video chat: started (duration null) or ended */
export interface GroupCallAction {
  type: "group_call";
  duration: number | null;
}

export interface ChatCreateAction {
  type: "chat_create";
  title: string | null;
  userIds: number[];
}

export interface TitleAction {
  type: "channel_create" | "chat_edit_title" | "topic_create";
  title: string | null;
}

export interface ChatAddUserAction {
  type: "chat_add_user";
  userIds: number[];
}

export interface ChatDeleteUserAction {
  type: "chat_delete_user";
  userId: number | null;
}

export interface ChatJoinedByLinkAction {
  type: "chat_joined_by_link";
  inviterId: number | null;
}

export interface PinMessageAction {
  type: "pin_message";
  /** The pinned message; null when Telegram didn't say */
  messageId: number | null;
}

/** Any other action: its type only, such as chat_edit_photo or screenshot_taken */
export interface OtherAction {
  type: string;
}

export type MessageAction =
  | PhoneCallAction
  | GroupCallAction
  | ChatCreateAction
  | TitleAction
  | ChatAddUserAction
  | ChatDeleteUserAction
  | ChatJoinedByLinkAction
  | PinMessageAction
  | OtherAction;

type RawObject = Record<string, unknown>;

function asObject(value: unknown): RawObject | null {
  return typeof value === "object" && value !== null ? (value as RawObject) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => num(id) !== null) : [];
}

/** `messageActionChatEditTitle` with prefix `messageAction` → `chat_edit_title` */
function snakeName(tlName: string, prefix: string): string {
  return tlName
    .slice(prefix.length)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function parse(input: unknown): RawObject | null {
  if (typeof input !== "string") return asObject(input);
  try {
    return asObject(JSON.parse(input));
  } catch {
    return null;
  }
}

/**
 * The action of a service message, null for any other message and for
 * anything that isn't a message; never throws. `type` is the TL name in
 * snake case without `messageAction`, for actions it doesn't map too.
 */
export function extractServiceAction(input: unknown): MessageAction | null {
  const message = parse(input);
  if (message?._ !== "messageService") return null;
  const action = asObject(message.action);
  const tlName = str(action?._);
  if (!action || !tlName?.startsWith("messageAction")) return null;

  switch (tlName) {
    case "messageActionPhoneCall": {
      const reason = str(asObject(action.reason)?._);
      return {
        type: "phone_call",
        video: action.video === true,
        duration: num(action.duration),
        reason: reason ? snakeName(reason, "phoneCallDiscardReason") : null,
      };
    }
    case "messageActionGroupCall":
      return { type: "group_call", duration: num(action.duration) };
    case "messageActionChatCreate":
      return {
        type: "chat_create",
        title: str(action.title),
        userIds: ids(action.users),
      };
    case "messageActionChannelCreate":
      return { type: "channel_create", title: str(action.title) };
    case "messageActionChatEditTitle":
      return { type: "chat_edit_title", title: str(action.title) };
    case "messageActionTopicCreate":
      return { type: "topic_create", title: str(action.title) };
    case "messageActionChatAddUser":
      return { type: "chat_add_user", userIds: ids(action.users) };
    case "messageActionChatDeleteUser":
      return { type: "chat_delete_user", userId: num(action.userId) };
    case "messageActionChatJoinedByLink":
      return { type: "chat_joined_by_link", inviterId: num(action.inviterId) };
    case "messageActionPinMessage":
      // The pinned message is the one the service message replies to
      return {
        type: "pin_message",
        messageId: num(asObject(message.replyTo)?.replyToMsgId),
      };
    default:
      return { type: snakeName(tlName, "messageAction") };
  }
}
