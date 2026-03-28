import Stripe from 'stripe';

interface StripeCredentials {
  publishableKey: string;
  secretKey: string;
}

interface ConnectorSettings {
  settings: {
    publishable: string;
    secret: string;
  };
}

interface ConnectorResponse {
  items?: ConnectorSettings[];
}

interface StripeSyncInstance {
  processWebhook: (payload: Buffer, signature: string) => Promise<void>;
  findOrCreateManagedWebhook: (url: string) => Promise<void>;
  syncBackfill: () => Promise<void>;
}

async function getCredentials(): Promise<StripeCredentials> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error('X-Replit-Token not found for repl/depl');
  }

  const connectorName = 'stripe';
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  const targetEnvironment = isProduction ? 'production' : 'development';

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set('include_secrets', 'true');
  url.searchParams.set('connector_names', connectorName);
  url.searchParams.set('environment', targetEnvironment);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X-Replit-Token': xReplitToken
    }
  });

  const data = await response.json() as ConnectorResponse;
  const connection = data.items?.[0];

  if (!connection || !connection.settings.publishable || !connection.settings.secret) {
    throw new Error(`Stripe ${targetEnvironment} connection not found`);
  }

  return {
    publishableKey: connection.settings.publishable,
    secretKey: connection.settings.secret,
  };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey);
}

export async function getStripePublishableKey(): Promise<string> {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey(): Promise<string> {
  const { secretKey } = await getCredentials();
  return secretKey;
}

let stripeSync: StripeSyncInstance | null = null;

export async function getStripeSync(): Promise<StripeSyncInstance> {
  if (!stripeSync) {
    const { StripeSync } = await import('stripe-replit-sync') as { StripeSync: new (opts: object) => StripeSyncInstance };
    const secretKey = await getStripeSecretKey();

    stripeSync = new StripeSync({
      poolConfig: {
        connectionString: process.env.DATABASE_URL!,
        max: 2,
      },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}
