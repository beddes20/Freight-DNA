import cron from "node-cron";
import { storage } from "./storage";

function log(message: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [pto-return] ${message}`);
}

function tomorrowDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

async function checkPtoReturns() {
  log("Checking for PTO reps returning tomorrow...");
  try {
    const tomorrow = tomorrowDateString();
    const allPassoffs = await storage.getPtoPassoffs({ all: true });
    const returning = allPassoffs.filter(p => p.status === "active" && p.endDate === tomorrow);

    for (const passoff of returning) {
      if (!passoff.coveringUserId) continue;
      const owner = await storage.getUser(passoff.createdById);
      if (!owner) continue;

      await storage.createNotification({
        userId: passoff.coveringUserId,
        type: "pto_return",
        title: `Heads up: ${owner.name} returns tomorrow`,
        body: `Their PTO ends ${passoff.endDate}. Make sure any open items are squared away.`,
        link: "/pto-passoff",
        relatedId: passoff.id,
        read: false,
      });

      log(`Notified covering user for ${owner.name}'s passoff (ends ${passoff.endDate})`);
    }

    if (returning.length === 0) log("No returns tomorrow.");
  } catch (err) {
    log(`Error: ${err}`);
  }
}

export function initPtoReturnScheduler() {
  log("PTO return scheduler initialized (daily at 8am CT)");
  cron.schedule("0 8 * * *", checkPtoReturns, { timezone: "America/Chicago" });
}
