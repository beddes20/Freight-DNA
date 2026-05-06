import { storage } from "../storage";

/**
 * Notifies managers (up the entire chain) and all admins when a positive CRM
 * event occurs.  The actor is always excluded from the notification list.
 */
export async function fanOutCelebration(
  type: "new_account" | "new_contact" | "base_advanced",
  title: string,
  body: string,
  link: string,
  relatedId: string,
  actorId: string,
  organizationId: string
): Promise<void> {
  try {
    const allUsers = await storage.getUsers(organizationId);
    const actor = allUsers.find(u => u.id === actorId);
    const notifyIds = new Set<string>();

    let current = actor;
    while (current?.managerId) {
      const manager = allUsers.find(u => u.id === current!.managerId);
      if (manager) notifyIds.add(manager.id);
      current = manager;
    }

    allUsers.filter(u => u.role === "admin").forEach(u => notifyIds.add(u.id));
    notifyIds.delete(actorId);

    await Promise.all(
      [...notifyIds].map(uid =>
        storage
          .createNotification({ userId: uid, type, title, body, link, relatedId, read: false })
          .catch(() => {})
      )
    );
  } catch (e) {
    console.error("fanOutCelebration error:", e);
  }
}
