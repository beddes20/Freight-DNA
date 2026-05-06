import { db } from "../../storage";
import { chatConversations, chatMessages } from "@shared/schema";
import { and, eq, desc } from "drizzle-orm";

export interface IChatStorage {
  getConversationForUser(id: number, userId: string): Promise<typeof chatConversations.$inferSelect | undefined>;
  getAllConversationsForUser(userId: string): Promise<(typeof chatConversations.$inferSelect)[]>;
  createConversation(title: string, userId: string): Promise<typeof chatConversations.$inferSelect>;
  deleteConversationForUser(id: number, userId: string): Promise<boolean>;
  getMessagesByConversation(conversationId: number): Promise<(typeof chatMessages.$inferSelect)[]>;
  createMessage(conversationId: number, role: string, content: string): Promise<typeof chatMessages.$inferSelect>;
}

export const chatStorage: IChatStorage = {
  async getConversationForUser(id: number, userId: string) {
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, userId)));
    return conversation;
  },

  async getAllConversationsForUser(userId: string) {
    return db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.userId, userId))
      .orderBy(desc(chatConversations.createdAt));
  },

  async createConversation(title: string, userId: string) {
    const [conversation] = await db.insert(chatConversations).values({ title, userId }).returning();
    return conversation;
  },

  async deleteConversationForUser(id: number, userId: string) {
    const owned = await db
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, userId)));
    if (owned.length === 0) return false;
    await db.delete(chatMessages).where(eq(chatMessages.conversationId, id));
    await db.delete(chatConversations).where(eq(chatConversations.id, id));
    return true;
  },

  async getMessagesByConversation(conversationId: number) {
    return db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(chatMessages.createdAt);
  },

  async createMessage(conversationId: number, role: string, content: string) {
    const [message] = await db.insert(chatMessages).values({ conversationId, role, content }).returning();
    return message;
  },
};
