import { conversationMessagesFactory } from "@tests/support/factories/conversationMessages";
import { conversationFactory } from "@tests/support/factories/conversations";
import { mailboxFactory } from "@tests/support/factories/mailboxes";
import { userFactory } from "@tests/support/factories/users";
import { mockJobs } from "@tests/support/jobsUtils";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { takeUniqueOrThrow } from "@/components/utils/arrays";
import { db } from "@/db/client";
import { conversations, gmailSupportEmails } from "@/db/schema";
import { runAIQuery } from "@/lib/ai";
import {
  createConversation,
  getConversationById,
  getConversationBySlug,
  getConversationBySlugAndMailbox,
  getNonSupportParticipants,
  getRelatedConversations,
  updateConversation,
} from "@/lib/data/conversation";
import { searchEmailsByKeywords } from "@/lib/emailSearchService/searchEmailsByKeywords";
import { conversationChannelId, conversationsListChannelId } from "@/lib/realtime/channels";
import { publishToRealtime } from "@/lib/realtime/publish";
import { updateUserPreferences } from "@/tests/support/helpers/userProfile";

vi.mock("@/components/constants", () => ({
  getBaseUrl: () => "https://example.com",
}));

vi.mock("@/lib/data/conversation", async (importOriginal) => ({
  ...(await importOriginal()),
  MAX_RELATED_CONVERSATIONS_COUNT: 3,
}));

vi.mock("@/lib/emailSearchService/searchEmailsByKeywords", () => ({
  searchEmailsByKeywords: vi.fn(),
}));

vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual("@/lib/ai");
  return {
    ...actual,
    runAIQuery: vi.fn(),
  };
});

vi.mock("@/lib/realtime/publish", () => ({
  publishToRealtime: vi.fn(),
}));

const jobsMock = mockJobs();

describe("createConversation", () => {
  it("creates a new conversation", async () => {
    const conversation = await createConversation({
      subject: "Test Conversation",
      status: "open",
      slug: "test-conversation",
      source: "email",
      assignedToAI: false,
    });

    expect(conversation).toHaveProperty("id");
    expect(conversation.subject).toBe("Test Conversation");
    expect(conversation.status).toBe("open");
    expect(conversation.slug).toBe("test-conversation");
  });
});

describe("updateConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates an existing conversation", async () => {
    const { conversation } = await conversationFactory.create();

    const result = await updateConversation(conversation.id, { set: { subject: "Updated Subject" } });

    expect(result).not.toBeNull();
    expect(result?.subject).toBe("Updated Subject");
  });

  it("sets closedAt when status changes to closed", async () => {
    const { conversation } = await conversationFactory.create({ status: "open" });

    const result = await updateConversation(conversation.id, { set: { status: "closed" } });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("closed");
    expect(result?.closedAt).toBeInstanceOf(Date);
  });

  it("publishes a realtime event when conversation is updated", async () => {
    await mailboxFactory.create();
    const { conversation } = await conversationFactory.create();
    const result = await updateConversation(conversation.id, { set: { subject: "Updated Subject" } });

    await vi.waitUntil(() => vi.mocked(publishToRealtime).mock.calls.length === 1);

    expect(result).not.toBeNull();
    expect(publishToRealtime).toHaveBeenCalledWith({
      channel: conversationChannelId(conversation.slug),
      event: "conversation.updated",
      data: expect.objectContaining({
        slug: conversation.slug,
        subject: "Updated Subject",
      }),
    });
    expect(publishToRealtime).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation.statusChanged" }),
    );
  });

  it("publishes a realtime event when conversation status changes to closed", async () => {
    await mailboxFactory.create();
    const { conversation } = await conversationFactory.create({ status: "open" });
    const result = await updateConversation(conversation.id, { set: { status: "closed" } });

    await vi.waitUntil(() => vi.mocked(publishToRealtime).mock.calls.length === 2);

    expect(result).not.toBeNull();
    expect(publishToRealtime).toHaveBeenCalledWith({
      channel: conversationChannelId(conversation.slug),
      event: "conversation.updated",
      data: expect.objectContaining({
        id: conversation.id,
        status: "closed",
      }),
    });
    expect(publishToRealtime).toHaveBeenCalledWith({
      channel: conversationsListChannelId(),
      event: "conversation.statusChanged",
      data: {
        id: conversation.id,
        status: "closed",
        assignedToAI: false,
        assignedToId: null,
        previousValues: {
          status: "open",
          assignedToId: null,
          assignedToAI: false,
        },
      },
    });
  });

  it("sends embedding event when status changes to closed", async () => {
    const { conversation } = await conversationFactory.create({ status: "open" });

    await updateConversation(conversation.id, { set: { status: "closed" } });

    expect(jobsMock.triggerEvent).toHaveBeenCalledWith("conversations/embedding.create", {
      conversationSlug: conversation.slug,
    });
  });

  it("does not send embedding event when status is not changed to closed", async () => {
    const { conversation } = await conversationFactory.create({ status: "open" });

    await updateConversation(conversation.id, { set: { subject: "Updated Subject" } });

    expect(jobsMock.triggerEvent).not.toHaveBeenCalled();
  });

  it("sets status to spam without setting closedAt", async () => {
    const { conversation } = await conversationFactory.create({ status: "open" });

    const result = await updateConversation(conversation.id, { set: { status: "spam" } });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("spam");
    expect(result?.closedAt).toBeNull();
  });

  it("does not send embedding event when status changes to spam", async () => {
    const { conversation } = await conversationFactory.create({ status: "open" });

    await updateConversation(conversation.id, { set: { status: "spam" } });

    expect(jobsMock.triggerEvent).not.toHaveBeenCalled();
  });

  it("automatically closes conversation when assigned to AI", async () => {
    const { conversation } = await conversationFactory.create({
      status: "open",
      assignedToId: null,
      assignedToAI: false,
    });

    const result = await updateConversation(conversation.id, {
      set: { assignedToAI: true },
    });

    expect(result).not.toBeNull();
    expect(result?.assignedToAI).toBe(true);
    expect(result?.assignedToId).toBeNull();
    expect(result?.status).toBe("closed");
    expect(result?.closedAt).toBeInstanceOf(Date);
  });

  it("clears human assignment when assigned to AI", async () => {
    const { user } = await userFactory.createRootUser();
    const { conversation } = await conversationFactory.create({
      status: "open",
      assignedToId: user.id,
      assignedToAI: false,
    });

    const result = await updateConversation(conversation.id, {
      set: { assignedToAI: true },
    });

    expect(result).not.toBeNull();
    expect(result?.assignedToAI).toBe(true);
    expect(result?.assignedToId).toBeNull();
    expect(result?.status).toBe("closed");
  });

  it("sets assignedToAI to false when assigning to human", async () => {
    const { user } = await userFactory.createRootUser();
    const { conversation } = await conversationFactory.create({
      status: "open",
      assignedToId: null,
      assignedToAI: true,
    });

    const result = await updateConversation(conversation.id, {
      set: { assignedToId: user.id },
    });

    expect(result).not.toBeNull();
    expect(result?.assignedToId).toBe(user.id);
    expect(result?.assignedToAI).toBe(false);
  });

  describe("auto-assignment based on user preferences", () => {
    const getConversationAssignmentFromDb = async (conversationId: number): Promise<string | null> => {
      const conversation = await getConversationById(conversationId);
      return conversation?.assignedToId || null;
    };

    describe("when auto-assign is enabled", () => {
      it("assigns user on status update", async () => {
        const { user } = await userFactory.createRootUser();
        const { conversation } = await conversationFactory.create({ assignedToId: null });

        const initialAssignment = await getConversationAssignmentFromDb(conversation.id);
        expect(initialAssignment).toBeNull();

        const result = await updateConversation(conversation.id, {
          set: { status: "closed" },
          byUserId: user.id,
          shouldAutoAssign: true,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToAI).toBe(false);
        expect(result?.assignedToId).toBe(user.id);
      });

      it("does not assign user when conversation is already assigned", async () => {
        const { user } = await userFactory.createRootUser();
        const { user: otherUser } = await userFactory.createRootUser();
        const { conversation } = await conversationFactory.create({ assignedToId: otherUser.id });

        await updateUserPreferences(user.id, { autoAssignOnTicketAction: true });

        const initialAssignment = await getConversationAssignmentFromDb(conversation.id);
        expect(initialAssignment).toBe(otherUser.id);

        const result = await updateConversation(conversation.id, {
          set: { status: "closed" },
          byUserId: user.id,
          shouldAutoAssign: true,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToAI).toBe(false);
        expect(result?.assignedToId).toBe(otherUser.id);
      });
    });

    describe("when auto-assign is disabled", () => {
      it("does not assign user when updating conversation status", async () => {
        const { user } = await userFactory.createRootUser();
        const { conversation } = await conversationFactory.create({ assignedToId: null });

        await updateUserPreferences(user.id, { autoAssignOnTicketAction: false });

        const initialAssignment = await getConversationAssignmentFromDb(conversation.id);
        expect(initialAssignment).toBeNull();

        const result = await updateConversation(conversation.id, {
          set: { status: "closed" },
          byUserId: user.id,
          shouldAutoAssign: true,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToAI).toBe(false);
        expect(result?.assignedToId).toBeNull();
      });
    });

    describe("auto-assign constraints", () => {
      it("does not auto-assign when shouldAutoAssign is false", async () => {
        const { user } = await userFactory.createRootUser();
        const { conversation } = await conversationFactory.create({ assignedToId: null });

        await updateUserPreferences(user.id, { autoAssignOnTicketAction: true });

        const result = await updateConversation(conversation.id, {
          set: { status: "closed" },
          byUserId: user.id,
          shouldAutoAssign: false,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToAI).toBe(false);
        expect(result?.assignedToId).toBeNull();
      });

      it("does not auto-assign when byUserId is not provided", async () => {
        const { conversation } = await conversationFactory.create({ assignedToId: null });

        const result = await updateConversation(conversation.id, {
          set: { status: "closed" },
          shouldAutoAssign: true,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToAI).toBe(false);
        expect(result?.assignedToId).toBeNull();
      });

      it("does not auto-assign when explicit assignedToId is provided", async () => {
        const { user } = await userFactory.createRootUser();
        const { user: otherUser } = await userFactory.createRootUser();
        const { conversation } = await conversationFactory.create({ assignedToId: null });

        await updateUserPreferences(user.id, { autoAssignOnTicketAction: true });

        const result = await updateConversation(conversation.id, {
          set: {
            status: "closed",
            assignedToId: otherUser.id,
          },
          byUserId: user.id,
          shouldAutoAssign: true,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToAI).toBe(false);
        expect(result?.assignedToId).toBe(otherUser.id);
      });

      it("does not auto-assign when assignedToAI is being set", async () => {
        const { user } = await userFactory.createRootUser();
        const { conversation } = await conversationFactory.create({ assignedToId: null });

        await updateUserPreferences(user.id, { autoAssignOnTicketAction: true });

        const result = await updateConversation(conversation.id, {
          set: {
            status: "closed",
            assignedToAI: true,
          },
          byUserId: user.id,
          shouldAutoAssign: true,
        });

        expect(result).not.toBeNull();
        expect(result?.assignedToId).toBeNull();
        expect(result?.assignedToAI).toBe(true);
      });
    });
  });
});

describe("getConversationBySlug", () => {
  it("returns a conversation by slug", async () => {
    const { conversation } = await conversationFactory.create({ slug: "test-slug" });

    const result = await getConversationBySlug("test-slug");

    expect(result).not.toBeNull();
    expect(result?.id).toBe(conversation.id);
    expect(result?.slug).toBe("test-slug");
  });

  it("returns null if conversation not found", async () => {
    const result = await getConversationBySlug("non-existent-slug");
    expect(result).toBeNull();
  });
});

describe("getConversationById", () => {
  it("returns a conversation by id", async () => {
    const { conversation } = await conversationFactory.create();

    const result = await getConversationById(conversation.id);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(conversation.id);
  });

  it("returns null if conversation not found", async () => {
    const result = await getConversationById(999999);
    expect(result).toBeNull();
  });
});

describe("getConversationBySlugAndMailbox", () => {
  it("returns a conversation by slug and mailbox id", async () => {
    const { conversation } = await conversationFactory.create({ slug: "test-slug-mailbox" });

    const result = await getConversationBySlugAndMailbox("test-slug-mailbox");

    expect(result).not.toBeNull();
    expect(result?.id).toBe(conversation.id);
    expect(result?.slug).toBe("test-slug-mailbox");
  });

  it("returns null if conversation not found", async () => {
    const result = await getConversationBySlugAndMailbox("non-existent-slug");
    expect(result).toBeNull();
  });
});

describe("getNonSupportParticipants", () => {
  it("returns non-support participants", async () => {
    const gmailSupportEmail = await db
      .insert(gmailSupportEmails)
      .values({
        email: "gmail@example.com",
        accessToken: "123",
        refreshToken: "123",
      })
      .returning({ id: gmailSupportEmails.id })
      .then(takeUniqueOrThrow);
    await userFactory.createRootUser({
      mailboxOverrides: { gmailSupportEmailId: gmailSupportEmail.id },
    });
    const { conversation } = await conversationFactory.create({ emailFrom: "support@example.com" });
    await conversationMessagesFactory.create(conversation.id, {
      emailTo: "user1@example.com",
      emailCc: ["user2@example.com", "support@example.com"],
    });
    await conversationMessagesFactory.create(conversation.id, {
      emailTo: "user3@example.com,user4@example.com,gmail@example.com",
      emailCc: ["user5@example.com"],
    });

    const result = await getNonSupportParticipants(conversation);

    expect(result).toEqual(
      expect.arrayContaining([
        "user1@example.com",
        "user2@example.com",
        "user3@example.com",
        "user4@example.com",
        "user5@example.com",
      ]),
    );
  });

  it("parses the emailTo field", async () => {
    await mailboxFactory.create();
    const { conversation } = await conversationFactory.create({ emailFrom: "support@example.com" });
    await conversationMessagesFactory.create(conversation.id, {
      emailTo:
        "New Example <to1@example.com>, to2@example.com, Support Email <support@example.com>, Acme <to3@example.com>",
    });

    const result = await getNonSupportParticipants(conversation);
    expect(result).toEqual(["to1@example.com", "to2@example.com", "to3@example.com"]);
  });
});

describe("getRelatedConversations", () => {
  it("returns related conversations based on email keywords", async () => {
    await mailboxFactory.create();
    vi.mocked(runAIQuery).mockResolvedValue({ text: "keyword1 keyword2" } as any);
    const { conversation: conversation1 } = await conversationFactory.create({
      emailFrom: "related1@example.com",
      subject: "Related Conversation 1",
      status: "open",
    });
    const { conversation: conversation2 } = await conversationFactory.create({
      emailFrom: "related2@example.com",
      subject: "Related Conversation 2",
      status: "closed",
    });
    const { message: message1 } = await conversationMessagesFactory.create(conversation1.id, {
      role: "user",
      body: "I have a question about my order.",
      status: null,
    });
    const { message: message2 } = await conversationMessagesFactory.create(conversation2.id, {
      role: "user",
      body: "Can you help me with my account?",
      status: null,
    });

    vi.mocked(searchEmailsByKeywords).mockResolvedValue([
      { id: message1.id, conversationId: conversation1.id, cleanedUpText: message1.cleanedUpText },
      { id: message2.id, conversationId: conversation2.id, cleanedUpText: message2.cleanedUpText },
    ]);

    // Get all related conversations
    const result = await getRelatedConversations(conversation1.id);
    expect(result).toHaveLength(1);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversation2.id })]));

    // Get all related conversations with status "open"
    const result2 = await getRelatedConversations(conversation1.id, {
      where: eq(conversations.status, "open"),
    });
    expect(result2).toHaveLength(0);
  });

  it("returns an empty array when the conversaiton has no user message", async () => {
    const { conversation } = await conversationFactory.create();
    await conversationMessagesFactory.create(conversation.id, {
      role: "staff",
      body: "A staff message",
      status: "sent",
    });
    const { conversation: conversation2 } = await conversationFactory.create();
    await conversationMessagesFactory.create(conversation2.id, {
      role: "staff",
      body: "Another staff message",
      status: "sent",
    });
    const result = await getRelatedConversations(conversation.id);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when the subject or body is empty", async () => {
    const { conversation } = await conversationFactory.create({
      emailFrom: "user@example.com",
      subject: "Test Conversation",
    });
    await conversationMessagesFactory.create(conversation.id, {
      role: "user",
      body: "",
      status: null,
    });
    const { conversation: conversation2 } = await conversationFactory.create({
      emailFrom: "user@example.com",
      subject: "Test Conversation 2",
    });
    await conversationMessagesFactory.create(conversation2.id, {
      role: "user",
      body: "User message 2",
      status: null,
    });

    vi.mocked(searchEmailsByKeywords).mockResolvedValue([]);

    const result = await getRelatedConversations(conversation.id);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when conversation ID is not found", async () => {
    const result = await getRelatedConversations(999999);
    expect(result).toHaveLength(0);
  });
});
