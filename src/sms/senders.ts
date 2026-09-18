// Sending is opt-in. The default sender only records; the provider sender needs credentials.
import type { QueuedMessage, SmsSender } from './dispatch.ts';

/** Records what would be sent. Used by tests and by the demo, so no message ever leaves the machine. */
export function recordingSender(): SmsSender & { sent: QueuedMessage[] } {
  const sent: QueuedMessage[] = [];
  return {
    name: 'recording',
    sent,
    async send(message) {
      sent.push(message);
      return { providerRef: `recorded:${message.id}` };
    },
  };
}

export interface AfricasTalkingConfig {
  username: string;
  apiKey: string;
  /** Sandbox by default; the live host needs a registered sender id. */
  baseUrl?: string;
  from?: string;
}

export class MissingCredentialsError extends Error {
  constructor(missing: string[]) {
    super(`Live sending needs ${missing.join(' and ')}. Set them in the environment, never in the repository.`);
    this.name = 'MissingCredentialsError';
  }
}

/** Reads credentials from the environment, or explains exactly what is missing. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): AfricasTalkingConfig {
  const username = env.AT_USERNAME?.trim();
  const apiKey = env.AT_API_KEY?.trim();
  const missing = [!username && 'AT_USERNAME', !apiKey && 'AT_API_KEY'].filter(Boolean) as string[];
  if (missing.length) throw new MissingCredentialsError(missing);
  const baseUrl = env.AT_BASE_URL?.trim() || undefined;
  if (baseUrl && !/^https:\/\//.test(baseUrl)) {
    throw new MissingCredentialsError([`a https AT_BASE_URL (got ${baseUrl})`]);
  }
  return { username: username!, apiKey: apiKey!, baseUrl, from: env.AT_SENDER_ID?.trim() || undefined };
}

const SANDBOX = 'https://api.sandbox.africastalking.com/version1/messaging';

/**
 * Posts one message in Africa's Talking's form format. `fetchImpl` is injectable so tests
 * assert the request shape without touching the network.
 */
export function africasTalkingSender(config: AfricasTalkingConfig, fetchImpl: typeof fetch = fetch): SmsSender {
  const url = config.baseUrl ?? SANDBOX;
  return {
    name: 'africastalking',
    async send(message: QueuedMessage) {
      const body = new URLSearchParams({ username: config.username, to: message.phone, message: message.body });
      if (config.from) body.set('from', config.from);

      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          apiKey: config.apiKey,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      });

      const text = await response.text();
      if (!response.ok) throw new Error(`Africa's Talking replied ${response.status}: ${text.slice(0, 200)}`);

      let parsed: { SMSMessageData?: { Recipients?: { status?: string; messageId?: string }[] } };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Africa's Talking sent an unreadable reply: ${text.slice(0, 200)}`);
      }

      const recipients = parsed.SMSMessageData?.Recipients ?? [];
      // A 200 with no recipient means nothing was accepted (an empty balance reads like this).
      if (recipients.length === 0) throw new Error(`Africa's Talking accepted no recipient: ${text.slice(0, 200)}`);
      const accepted = recipients.find((recipient) => recipient.status === 'Success');
      if (!accepted) throw new Error(`Africa's Talking rejected the message: ${recipients[0]?.status ?? 'no status'}`);
      return { providerRef: accepted.messageId };
    },
  };
}

/**
 * Which sender a run uses. Sending is opt-in: only `--live` with credentials reaches a network.
 * Exported so the choice is testable, rather than living untested inside an entry point.
 */
export function chooseSender(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SmsSender {
  return argv.includes('--live') ? africasTalkingSender(credentialsFromEnv(env)) : recordingSender();
}
