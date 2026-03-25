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

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
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

  const clientId = process.env.ZOOMINFO_CLIENT_ID;
  const clientSecret = process.env.ZOOMINFO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const missing: string[] = [];
    if (!clientId) missing.push("ZOOMINFO_CLIENT_ID");
    if (!clientSecret) missing.push("ZOOMINFO_CLIENT_SECRET");
    throw new Error(`ZoomInfo credentials not configured. Missing: ${missing.join(", ")}`);
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const params = new URLSearchParams({ grant_type: "client_credentials" });

  const res = await fetch(`${ZOOMINFO_API_BASE}/gtm/oauth/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ZoomInfo auth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as OAuthTokenResponse;
  const token = data.access_token;

  if (!token) {
    throw new Error("ZoomInfo auth returned no access_token");
  }

  cachedToken = token;
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0
    ? data.expires_in
    : 3600;
  tokenExpiry = now + Math.max(expiresIn - 60, 1) * 1000;
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
