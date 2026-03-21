import cron from "node-cron";
import { storage } from "./storage";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [health-alert] ${msg}`);
}

function computeHealthGrade(touchpoints: any[], contacts: any[], rfps: any[], awards: any[], uploads: any[], company: any): { grade: string; score: number } {
  const now = new Date();
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(now.getDate() - 30);
  const thirtyDaysStr = thirtyDaysAgo.toISOString().slice(0, 10);

  const sortedTps = [...touchpoints].sort((a, b) => b.date.localeCompare(a.date));
  const lastTp = sortedTps[0];
  let recencyScore = 0;
  if (lastTp) {
    const daysSince = Math.floor((now.getTime() - new Date(lastTp.date + "T12:00:00").getTime()) / 86400000);
    if (daysSince <= 7) recencyScore = 30;
    else if (daysSince <= 14) recencyScore = 22;
    else if (daysSince <= 30) recencyScore = 15;
    else if (daysSince <= 60) recencyScore = 7;
  }

  const recentCount = touchpoints.filter(t => t.date >= thirtyDaysStr).length;
  let freqScore = 0;
  if (recentCount >= 5) freqScore = 25;
  else if (recentCount >= 3) freqScore = 18;
  else if (recentCount >= 2) freqScore = 12;
  else if (recentCount === 1) freqScore = 7;

  const contactCount = contacts.length;
  let contactScore = 0;
  if (contactCount >= 4) contactScore = 20;
  else if (contactCount === 3) contactScore = 15;
  else if (contactCount === 2) contactScore = 10;
  else if (contactCount === 1) contactScore = 5;

  const activeRfp = rfps.find(r => r.companyId === company.id && (r.status === "open" || r.status === "pending"));
  const hasAward = awards.some(a => a.companyId === company.id);
  const rfpScore = (activeRfp ? 10 : 0) + (hasAward ? 5 : 0);

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const crmNorm = normalize(company.name);
  const aliasNorm = company.financialAlias ? normalize(company.financialAlias) : null;
  let finScore = 0;
  for (const upload of uploads) {
    const rows = (upload.data as any[]) || [];
    for (const row of rows) {
      const custName = normalize(String(row.customerName || ""));
      if (custName === crmNorm || (aliasNorm && custName === aliasNorm)) { finScore = 10; break; }
    }
    if (finScore) break;
  }

  const total = recencyScore + freqScore + contactScore + rfpScore + finScore;
  let grade = "At Risk";
  if (total >= 80) grade = "Excellent";
  else if (total >= 60) grade = "Good";
  else if (total >= 40) grade = "Fair";
  return { grade, score: total };
}

async function checkHealthDrops() {
  log("Running daily health drop check...");
  try {
    const prevSetting = await storage.getSetting("health_grades_yesterday");
    const prevGrades: Record<string, string> = prevSetting ? JSON.parse(prevSetting) : {};

    const [allCompanies, allUsers, allRfps, allAwards, allUploads] = await Promise.all([
      storage.getCompanies(),
      storage.getUsers(),
      storage.getRfps(),
      storage.getAwards(),
      storage.getFinancialUploads(),
    ]);

    const todayGrades: Record<string, string> = {};
    let alertsCreated = 0;

    for (const company of allCompanies) {
      try {
        const [touchpoints, contacts] = await Promise.all([
          storage.getTouchpointsByCompany(company.id),
          storage.getContactsByCompany(company.id),
        ]);

        const { grade } = computeHealthGrade(touchpoints, contacts, allRfps, allAwards, allUploads, company);
        todayGrades[company.id] = grade;

        const prevGrade = prevGrades[company.id];
        const droppedToAtRisk = grade === "At Risk" && prevGrade && prevGrade !== "At Risk";

        if (droppedToAtRisk) {
          const recipients: string[] = [];

          if (company.salesPersonId) recipients.push(company.salesPersonId);

          allUsers.filter(u => u.role === "admin" || u.role === "director" || u.role === "national_account_manager").forEach(u => {
            if (!recipients.includes(u.id)) recipients.push(u.id);
          });

          for (const uid of recipients) {
            await storage.createNotification({
              userId: uid,
              type: "health_drop",
              title: `⚠️ ${company.name} dropped to At Risk`,
              body: `${company.name}'s relationship health dropped from ${prevGrade} to At Risk. Review and schedule a touchpoint.`,
              link: `/companies/${company.id}`,
              relatedId: company.id,
              read: false,
            });
            alertsCreated++;
          }
        }
      } catch (e) {
        // skip individual company errors
      }
    }

    await storage.setSetting("health_grades_yesterday", JSON.stringify(todayGrades));
    log(`Done — ${alertsCreated} alerts created, ${allCompanies.length} companies checked.`);
  } catch (err) {
    log(`Error: ${err}`);
  }
}

export function initHealthAlertScheduler() {
  checkHealthDrops();
  cron.schedule("0 8 * * *", () => checkHealthDrops(), { timezone: "America/Chicago" });
  log("Health alert scheduler initialized (daily at 8am CT).");
}
