import { conversationFactory } from "@tests/support/factories/conversations";
import { userFactory } from "@tests/support/factories/users";
import { mockJobs, mockTriggerEvent } from "@tests/support/jobsUtils";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { conversations, userProfiles } from "@/db/schema";
import type { authUsers } from "@/db/supabaseSchema/auth";
import { bulkUpdateConversations } from "@/jobs/bulkUpdateConversations";

vi.mock("@/lib/data/mailbox", () => ({
  getMailbox: vi.fn().mockResolvedValue({
    id: 1,
    slug: "test-mailbox",
  }),
}));

mockJobs();

let user: typeof authUsers.$inferSelect;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ user } = await userFactory.createRootUser());
});

describe("bulkUpdateConversations", () => {
  describe("with conversation IDs array", () => {
    it("closes multiple conversations with auto-assign", async () => {
      const { conversation: conversation1 } = await conversationFactory.create({
        assignedToId: null,
        status: "open",
      });
      const { conversation: conversation2 } = await conversationFactory.create({
        assignedToId: null,
        status: "open",
      });
      const { conversation: conversation3 } = await conversationFactory.create({
        assignedToId: null,
        status: "open",
      });

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id, conversation2.id, conversation3.id],
        status: "closed",
        userId: user.id,
        shouldAutoAssign: true,
      });

      const updatedConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) =>
          inArray(conversations.id, [conversation1.id, conversation2.id, conversation3.id]),
      });

      updatedConversations.forEach((conv) => {
        expect(conv).toMatchObject({
          status: "closed",
          assignedToId: user.id,
          assignedToAI: false,
        });
        expect(conv.closedAt).toBeInstanceOf(Date);
      });

      expect(mockTriggerEvent).toHaveBeenCalledWith("conversations/embedding.create", {
        conversationSlug: conversation1.slug,
      });
      expect(mockTriggerEvent).toHaveBeenCalledWith("conversations/embedding.create", {
        conversationSlug: conversation2.slug,
      });
      expect(mockTriggerEvent).toHaveBeenCalledWith("conversations/embedding.create", {
        conversationSlug: conversation3.slug,
      });
    });

    it("reopens multiple conversations", async () => {
      const { conversation: conversation1 } = await conversationFactory.create({
        status: "closed",
        closedAt: new Date(),
      });
      const { conversation: conversation2 } = await conversationFactory.create({
        status: "closed",
        closedAt: new Date(),
      });

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id, conversation2.id],
        status: "open",
        userId: user.id,
      });

      const updatedConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) => inArray(conversations.id, [conversation1.id, conversation2.id]),
      });

      updatedConversations.forEach((conv) => {
        expect(conv).toMatchObject({
          status: "open",
        });

        expect(conv.closedAt).toBeInstanceOf(Date);
      });
    });

    it("marks multiple conversations as spam", async () => {
      const { conversation: conversation1 } = await conversationFactory.create({
        status: "open",
      });
      const { conversation: conversation2 } = await conversationFactory.create({
        status: "open",
      });

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id, conversation2.id],
        status: "spam",
        userId: user.id,
      });

      const updatedConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) => inArray(conversations.id, [conversation1.id, conversation2.id]),
      });

      updatedConversations.forEach((conv) => {
        expect(conv).toMatchObject({
          status: "spam",
        });

        expect(conv.closedAt).toBeNull();
      });
    });

    it("assigns conversations to AI", async () => {
      const { conversation: conversation1 } = await conversationFactory.create({
        assignedToId: null,
        assignedToAI: false,
        status: "open",
      });
      const { conversation: conversation2 } = await conversationFactory.create({
        assignedToId: user.id,
        assignedToAI: false,
        status: "open",
      });

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id, conversation2.id],
        assignedToAI: true,
        userId: user.id,
      });

      const updatedConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) => inArray(conversations.id, [conversation1.id, conversation2.id]),
      });

      updatedConversations.forEach((conv) => {
        expect(conv).toMatchObject({
          status: "closed",
          assignedToAI: true,
          assignedToId: null,
        });
        expect(conv.closedAt).toBeInstanceOf(Date);
      });
    });

    it("assigns conversations to specific user", async () => {
      const { user: assigneeUser } = await userFactory.createRootUser();
      const { conversation: conversation1 } = await conversationFactory.create({
        assignedToId: null,
      });
      const { conversation: conversation2 } = await conversationFactory.create({
        assignedToId: null,
      });

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id, conversation2.id],
        assignedToId: assigneeUser.id,
        userId: user.id,
      });

      const updatedConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) => inArray(conversations.id, [conversation1.id, conversation2.id]),
      });

      updatedConversations.forEach((conv) => {
        expect(conv).toMatchObject({
          assignedToId: assigneeUser.id,
          assignedToAI: false,
        });
      });
    });

    it("respects user auto-assign preferences", async () => {
      const { conversation: conversation1 } = await conversationFactory.create({
        assignedToId: null,
        status: "open",
      });

      await db
        .update(userProfiles)
        .set({
          preferences: { autoAssignOnTicketAction: false },
        })
        .where(eq(userProfiles.id, user.id));

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id],
        status: "closed",
        userId: user.id,
        shouldAutoAssign: true,
      });

      const updatedConversation = await db.query.conversations.findFirst({
        where: eq(conversations.id, conversation1.id),
      });

      expect(updatedConversation).toMatchObject({
        status: "closed",
        assignedToId: null,
      });
    });

    it("does not change assignment when conversation is already assigned", async () => {
      const { user: otherUser } = await userFactory.createRootUser();
      const { conversation: conversation1 } = await conversationFactory.create({
        assignedToId: otherUser.id,
        status: "open",
      });

      await bulkUpdateConversations({
        conversationFilter: [conversation1.id],
        status: "closed",
        userId: user.id,
        shouldAutoAssign: true,
      });

      const updatedConversation = await db.query.conversations.findFirst({
        where: eq(conversations.id, conversation1.id),
      });

      expect(updatedConversation).toMatchObject({
        status: "closed",
        assignedToId: otherUser.id,
      });
    });

    it("includes message in conversation events", async () => {
      const { conversation } = await conversationFactory.create({
        status: "open",
      });

      const testMessage = "Bulk closing due to resolution";

      await bulkUpdateConversations({
        conversationFilter: [conversation.id],
        status: "closed",
        userId: user.id,
        message: testMessage,
      });

      const updatedConversation = await db.query.conversations.findFirst({
        where: eq(conversations.id, conversation.id),
      });

      expect(updatedConversation).toMatchObject({
        status: "closed",
      });

      const conversationEvent = await db.query.conversationEvents.findFirst({
        where: (conversationEvents, { eq }) => eq(conversationEvents.conversationId, conversation.id),
      });

      expect(conversationEvent).toMatchObject({
        conversationId: conversation.id,
        byUserId: user.id,
        reason: testMessage,
        type: "update",
      });
    });
  });

  describe("with search schema", () => {
    it("updates conversations matching search criteria", async () => {
      const { conversation: firstOpenConv } = await conversationFactory.create({
        status: "open",
        assignedToId: null,
      });
      const { conversation: secondOpenConv } = await conversationFactory.create({
        status: "open",
        assignedToId: null,
      });
      const { conversation: _closedConv } = await conversationFactory.create({
        status: "closed",
      });
      await bulkUpdateConversations({
        conversationFilter: {
          status: ["open"],
          cursor: null,
          limit: 25,
          sort: null,
          search: null,
          category: null,
        },
        status: "closed",
        userId: user.id,
        shouldAutoAssign: true,
      });

      const openConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) => inArray(conversations.id, [firstOpenConv.id, secondOpenConv.id]),
      });
      openConversations.forEach((conv) => {
        expect(conv).toMatchObject({
          status: "closed",
          assignedToId: user.id,
        });
        expect(conv.closedAt).toBeInstanceOf(Date);
      });
    });

    it("skips conversations that already have the target status", async () => {
      const { conversation: firstClosedConv } = await conversationFactory.create({
        status: "closed",
        closedAt: new Date(),
      });
      const { conversation: secondClosedConv } = await conversationFactory.create({
        status: "closed",
        closedAt: new Date(),
      });

      const originalClosedAt1 = firstClosedConv.closedAt;
      const originalClosedAt2 = secondClosedConv.closedAt;

      await bulkUpdateConversations({
        conversationFilter: {
          status: null,
          cursor: null,
          limit: 25,
          sort: null,
          search: null,
          category: null,
        },
        status: "closed",
        userId: user.id,
      });

      const unchangedConversations = await db.query.conversations.findMany({
        where: (conversations, { inArray }) => inArray(conversations.id, [firstClosedConv.id, secondClosedConv.id]),
      });
      expect(unchangedConversations[0]?.closedAt?.getTime()).toBe(originalClosedAt1?.getTime());
      expect(unchangedConversations[1]?.closedAt?.getTime()).toBe(originalClosedAt2?.getTime());
    });
  });

  describe("return value", () => {
    it("returns message with count of updated conversations", async () => {
      const { conversation: conv1 } = await conversationFactory.create({ status: "open" });
      const { conversation: conv2 } = await conversationFactory.create({ status: "open" });
      const { conversation: conv3 } = await conversationFactory.create({ status: "open" });

      const result = await bulkUpdateConversations({
        conversationFilter: [conv1.id, conv2.id, conv3.id],
        status: "closed",
        userId: user.id,
      });

      expect(result).toMatchObject({
        message: "Updated 3 conversations to status: closed",
      });
    });

    it("returns correct count when some conversations are filtered out", async () => {
      await conversationFactory.create({ status: "open" });
      await conversationFactory.create({ status: "closed" });

      const result = await bulkUpdateConversations({
        conversationFilter: {
          status: ["open"],
          cursor: null,
          limit: 25,
          sort: null,
          search: null,
          category: null,
        },
        status: "closed",
        userId: user.id,
      });

      expect(result).toMatchObject({
        message: "Updated 1 conversations to status: closed",
      });
    });
  });
});
