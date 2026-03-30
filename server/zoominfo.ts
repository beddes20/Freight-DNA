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
  access_token?: string;
  token?: string;
  expires_in?: number;
}

interface ZoomInfoSearchResponse {
  data?: ZoomInfoContact[] | {
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

  if (!username || !password || !clientId) {
    const missing: string[] = [];
    if (!username) missing.push("ZOOMINFO_USERNAME");
    if (!password) missing.push("ZOOMINFO_PASSWORD");
    if (!clientId) missing.push("ZOOMINFO_CLIENT_ID");
    throw new Error(`ZoomInfo credentials not configured. Missing: ${missing.join(", ")}`);
  }

  const res = await fetch(`${ZOOMINFO_API_BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, clientId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZoomInfo auth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as AuthResponse;
  const token = data.jwt || data.access_token || data.token;

  if (!token) {
    throw new Error("ZoomInfo auth returned no token");
  }

  cachedToken = token;
  // ZoomInfo JWTs typically expire in 1 hour; use expires_in if provided
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0
    ? data.expires_in
    : 3600;
  tokenExpiry = now + Math.max(expiresIn - 60, 1) * 1000;
  return token;
}

export async function searchZoomInfoContacts(
  companyName: string,
  limit = 25
): Promise<ZoomInfoContact[]> {
  const token = await getAuthToken();

  const body = {
    matchCompanyInput: [{ companyName }],
    jobTitleInput: TRANSPORTATION_JOB_TITLES.map((t) => ({ jobTitle: t })),
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
    // Clear cached token on auth errors so the next call re-authenticates
    if (res.status === 401 || res.status === 403) {
      cachedToken = null;
      tokenExpiry = 0;
    }
    throw new Error(`ZoomInfo contact search failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as ZoomInfoSearchResponse;

  // Handle both flat array and nested result structures
  let contacts: ZoomInfoContact[] = [];
  if (Array.isArray(data?.data)) {
    contacts = data.data as ZoomInfoContact[];
  } else if (data?.data && !Array.isArray(data.data)) {
    const nested = data.data as { result?: Array<{ data?: ZoomInfoContact[] }>; outputFields?: ZoomInfoContact[] };
    contacts = nested.result?.[0]?.data || (nested.outputFields as unknown as ZoomInfoContact[]) || [];
  }

  return contacts;
}

export async function testZoomInfoConnection(): Promise<boolean> {
  try {
    cachedToken = null;
    tokenExpiry = 0;
    await getAuthToken();
    return true;
  } catch {
    return false;
  }
}
