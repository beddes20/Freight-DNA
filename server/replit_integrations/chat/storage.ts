import { db } from "../../storage";
import { chatConversations, chatMessages } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export interface IChatStorage {
  getConversation(id: number): Promise<typeof chatConversations.$inferSelect | undefined>;
  getAllConversations(): Promise<(typeof chatConversations.$inferSelect)[]>;
  createConversation(title: string, userId: string): Promise<typeof chatConversations.$inferSelect>;
  deleteConversation(id: number): Promise<void>;
  getMessagesByConversation(conversationId: number): Promise<(typeof chatMessages.$inferSelect)[]>;
  createMessage(conversationId: number, role: string, content: string): Promise<typeof chatMessages.$inferSelect>;
}

export const chatStorage: IChatStorage = {
  async getConversation(id: number) {
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, id));
    return conversation;
  },

  async getAllConversations() {
    return db.select().from(chatConversations).orderBy(desc(chatConversations.createdAt));
  },

  async createConversation(title: string, userId: string) {
    const [conversation] = await db.insert(chatConversations).values({ title, userId }).returning();
    return conversation;
  },

  async deleteConversation(id: number) {
    await db.delete(chatMessages).where(eq(chatMessages.conversationId, id));
    await db.delete(chatConversations).where(eq(chatConversations.id, id));
  },

  async getMessagesByConversation(conversationId: number) {
    return db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(chatMessages.createdAt);
  },

  async createMessage(conversationId: number, role: string, content: string) {
    const [message] = await db.insert(chatMessages).values({ conversationId, role, content }).returning();
    return message;
  },
};

