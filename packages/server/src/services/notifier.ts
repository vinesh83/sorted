/**
 * Email notification service via Resend.
 * Sends alerts for critical events (Dropbox disconnect, high failure rates, Opus analysis).
 */

const RESEND_API = 'https://api.resend.com/emails';
const FROM_EMAIL = 'Doc Triage <alerts@doctriage.app>';
const TO_EMAIL = 'vinesh@vpatellaw.com';

function getApiKey(): string | null {
  return process.env.RESEND_API_KEY || null;
}

interface EmailParams {
  subject: string;
  html: string;
}

async function sendEmail(params: EmailParams): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log(`[notifier] No RESEND_API_KEY — would have sent: "${params.subject}"`);
    return false;
  }

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        subject: params.subject,
        html: params.html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[notifier] Resend error:', err);
      return false;
    }

    console.log(`[notifier] Email sent: "${params.subject}"`);
    return true;
  } catch (err) {
    console.error('[notifier] Failed to send email:', err);
    return false;
  }
}

// Throttle: track last send time per event type to avoid spam
const lastSent: Record<string, number> = {};
const THROTTLE_MS = 30 * 60 * 1000; // 30 minutes between same-type alerts

function throttled(eventType: string): boolean {
  const now = Date.now();
  if (lastSent[eventType] && now - lastSent[eventType] < THROTTLE_MS) return true;
  lastSent[eventType] = now;
  return false;
}

// ---- Notification functions ----

export async function notifyDropboxDisconnected(minutesDown: number): Promise<void> {
  if (throttled('dropbox_disconnect')) return;
  await sendEmail({
    subject: `[Doc Triage] Dropbox disconnected for ${minutesDown} minutes`,
    html: `
      <h2>Dropbox Watcher Disconnected</h2>
      <p>The Dropbox file watcher has been disconnected for <strong>${minutesDown} minutes</strong>.</p>
      <p>New files will not be detected until the connection is restored.</p>
      <p><strong>Possible causes:</strong></p>
      <ul>
        <li>Dropbox API outage</li>
        <li>Refresh token expired — may need to re-authorize</li>
        <li>Network issue on Railway</li>
      </ul>
      <p><a href="https://sorted-production.up.railway.app/admin">Check Admin Dashboard</a></p>
    `,
  });
}

export async function notifyHighFailureRate(type: string, rate: number, count: number): Promise<void> {
  if (throttled(`high_failure_${type}`)) return;
  await sendEmail({
    subject: `[Doc Triage] High ${type} failure rate: ${rate.toFixed(0)}%`,
    html: `
      <h2>High ${type} Failure Rate</h2>
      <p><strong>${rate.toFixed(1)}%</strong> of ${type} attempts failed in the last hour (${count} failures).</p>
      <p>This may indicate an API issue or a problem with the input documents.</p>
      <p><a href="https://sorted-production.up.railway.app/admin">Check Admin Dashboard</a></p>
    `,
  });
}

export async function notifyOpusAnalysisComplete(
  version: number,
  rulesCount: number,
  correctionsAnalyzed: number,
  cost: number,
): Promise<void> {
  await sendEmail({
    subject: `[Doc Triage] New classification rules v${version} generated`,
    html: `
      <h2>Opus Analysis Complete</h2>
      <p>New classification rules have been generated and are now active.</p>
      <table style="border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 12px; font-weight: bold;">Version</td><td style="padding: 4px 12px;">v${version}</td></tr>
        <tr><td style="padding: 4px 12px; font-weight: bold;">Rules generated</td><td style="padding: 4px 12px;">${rulesCount}</td></tr>
        <tr><td style="padding: 4px 12px; font-weight: bold;">Corrections analyzed</td><td style="padding: 4px 12px;">${correctionsAnalyzed}</td></tr>
        <tr><td style="padding: 4px 12px; font-weight: bold;">Opus cost</td><td style="padding: 4px 12px;">$${cost.toFixed(4)}</td></tr>
      </table>
      <p><a href="https://sorted-production.up.railway.app/admin">View Rules in Admin Dashboard</a></p>
    `,
  });
}

export async function notifyAsanaFailure(docId: number, fileName: string, error: string): Promise<void> {
  if (throttled('asana_failure')) return;
  await sendEmail({
    subject: `[Doc Triage] Asana task creation failed`,
    html: `
      <h2>Asana Task Creation Failed</h2>
      <p><strong>Document:</strong> ${fileName} (ID: ${docId})</p>
      <p><strong>Error:</strong> ${error}</p>
      <p>The paralegal has been shown the error in the UI. They may need to retry or create the task manually.</p>
      <p><a href="https://sorted-production.up.railway.app/admin">Check Admin Dashboard</a></p>
    `,
  });
}
