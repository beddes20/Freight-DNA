const ZOOMINFO_API_BASE = "https://api.zoominfo.com";

const TRANSPORTATION_JOB_TITLES = [
  "Load Planner",
  "Transportation Load Planner",
  "Load Planner/Dispatcher",
  "Transportation Planner",
  "Logistics Coordinator",
  "Transportation Coordinator",
  "Logistics Planner",
  "Transportation Manager",
  "Logistics Manager",
  "Shipping Coordinator",
  "Shipping Supervisor",
  "Supply Chain Planner",
  "Demand Planner",
  "Supply Planner",
  "Distribution Manager",
  "Distribution Supervisor",
];

export interface ZoomInfoContact {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  department: string | null;
  managementLevel: string | null;
  companyName: string | null;
  linkedInUrl: string | null;
}

interface AuthResponse {
  jwt?: string;
  accessToken?: string;
}

interface ZoomInfoSearchResponse {
  data?: {
    result?: Array<{
      data?: ZoomInfoContact[];
    }>;
    outputFields?: ZoomInfoContact[];
  };
  maxResults?: number;
  currentPage?: number;
  totalResults?: number;
}

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

async function getAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  const username = process.env.ZOOMINFO_USERNAME;
  const password = process.env.ZOOMINFO_PASSWORD;
  const clientId = process.env.ZOOMINFO_CLIENT_ID;
  const clientSecret = process.env.ZOOMINFO_CLIENT_SECRET;

  if (!username || !password || !clientId || !clientSecret) {
    const missing: string[] = [];
    if (!username) missing.push("ZOOMINFO_USERNAME");
    if (!password) missing.push("ZOOMINFO_PASSWORD");
    if (!clientId) missing.push("ZOOMINFO_CLIENT_ID");
    if (!clientSecret) missing.push("ZOOMINFO_CLIENT_SECRET");
    throw new Error(`ZoomInfo credentials not fully configured. Missing: ${missing.join(", ")}`);
  }

  const authBody: Record<string, string> = { username, password, client_id: clientId, client_secret: clientSecret };

  const res = await fetch(`${ZOOMINFO_API_BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZoomInfo auth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as AuthResponse;
  const token = data.jwt || data.accessToken;

  if (!token) {
    throw new Error("ZoomInfo auth returned no token");
  }

  cachedToken = token;
  tokenExpiry = now + 55 * 60 * 1000;
  return token;
}

export async function searchZoomInfoContacts(
  companyName: string,
  limit = 20
): Promise<ZoomInfoContact[]> {
  const token = await getAuthToken();

  const body = {
    matchCompanyInput: [{ companyName }],
    jobTitleHierarchyInput: TRANSPORTATION_JOB_TITLES.map((t) => ({ jobTitle: t })),
    outputFields: [
      "id",
      "firstName",
      "lastName",
      "jobTitle",
      "email",
      "phone",
      "mobilePhone",
      "department",
      "managementLevel",
      "companyName",
      "linkedInUrl",
    ],
    rpp: limit,
    page: 1,
    sortBy: "managementLevel",
    sortOrder: "desc",
  };

  const res = await fetch(`${ZOOMINFO_API_BASE}/search/contact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZoomInfo contact search failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as ZoomInfoSearchResponse;

  const contacts: ZoomInfoContact[] =
    data?.data?.result?.[0]?.data ||
    (data?.data?.outputFields as unknown as ZoomInfoContact[]) ||
    [];

  return contacts;
}

export async function testZoomInfoConnection(): Promise<boolean> {
  try {
    await getAuthToken();
    return true;
  } catch {
    return false;
  }
}
