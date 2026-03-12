import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { users } from "../shared/schema";
import bcrypt from "bcrypt";

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  const defaultPassword = await bcrypt.hash("password123", 10);

  async function ensureUser(username: string, name: string, role: string, managerId: string | null): Promise<string> {
    const [existing] = await db.select().from(users).where(eq(users.username, username));
    if (existing) {
      console.log(`  Skipping ${name} (${username}) — already exists`);
      return existing.id;
    }
    const [created] = await db.insert(users).values({
      username,
      password: defaultPassword,
      name,
      role,
      managerId,
    }).returning();
    console.log(`  Created ${name} (${username}) as ${role}`);
    return created.id;
  }

  console.log("Seeding Sam Davis's team:");
  const samId = await ensureUser("sam.davis@company.com", "Sam Davis", "director", null);
  await ensureUser("yuri@company.com", "Yuri", "account_manager", samId);
  await ensureUser("bri.coakley@company.com", "Bri Coakley", "account_manager", samId);
  await ensureUser("ethan.allen@company.com", "Ethan Allen", "account_manager", samId);
  await ensureUser("braden.shinsel@company.com", "Braden Shinsel", "account_manager", samId);
  await ensureUser("legrand.toaia@company.com", "Legrand Toaia", "account_manager", samId);

  console.log("\nSeeding Danny Beddes's team:");
  const dannyId = await ensureUser("danny.beddes@company.com", "Danny Beddes", "director", null);
  const jasonId = await ensureUser("jason.allen@company.com", "Jason Allen", "national_account_manager", dannyId);
  await ensureUser("alex.shumway@company.com", "Alex Shumway", "account_manager", jasonId);
  const jaredId = await ensureUser("jared.reynolds@company.com", "Jared Reynolds", "national_account_manager", dannyId);
  await ensureUser("dallin.meier@company.com", "Dallin Meier", "account_manager", jaredId);
  await ensureUser("taylor.call@company.com", "Taylor Call", "account_manager", dannyId);
  await ensureUser("adan@company.com", "Adan", "account_manager", dannyId);
  await ensureUser("mason.moore@company.com", "Mason Moore", "account_manager", dannyId);
  await ensureUser("kimberly.dornseif@company.com", "Kimberly Dornseif", "account_manager", dannyId);

  console.log("\nDone seeding director teams.");
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
