import express from 'express';
import type { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface SmsAlertRequestBody {
  recipientName?: string;
  recipientPhone?: string;
  message?: string;
  mode?: 'simulated' | 'backend';
  eventId?: string;
  simulateFailure?: boolean;
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'DriveGuard Telemetry & Alert Relay',
    smsGatewayConfigured: Boolean(process.env.SMS_WEBHOOK_URL),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/alerts/sms', async (req: Request, res: Response) => {
  const body = (req.body || {}) as SmsAlertRequestBody;
  const recipientName = typeof body.recipientName === 'string' ? body.recipientName.trim() : '';
  const recipientPhone = typeof body.recipientPhone === 'string' ? body.recipientPhone.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const mode = body.mode === 'backend' ? 'backend' : 'simulated';
  const eventId = typeof body.eventId === 'string' ? body.eventId : `evt_${Date.now()}`;
  const simulateFailure = Boolean(body.simulateFailure);

  if (!recipientPhone) {
    res.status(400).json({
      status: 'Failed',
      mode,
      eventId,
      error: 'No emergency contact phone number is configured.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const sanitizedPhone = recipientPhone.replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{7,16}$/.test(sanitizedPhone)) {
    res.status(400).json({
      status: 'Failed',
      mode,
      eventId,
      error: 'Emergency contact phone number format is invalid.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (!message) {
    res.status(400).json({
      status: 'Failed',
      mode,
      eventId,
      error: 'Alert message payload cannot be empty.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (mode === 'simulated') {
    await new Promise((resolve) => setTimeout(resolve, 650));

    if (simulateFailure) {
      res.status(502).json({
        status: 'Failed',
        mode: 'simulated',
        eventId,
        recipientName,
        recipientPhone,
        messagePreview: message,
        error: 'Simulated carrier gateway timeout (test failure mode enabled).',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    console.info(`[DriveGuard Simulated SMS] To=${recipientPhone} (${recipientName || 'Contact'}) | Payload="${message}"`);

    res.json({
      status: 'Sent',
      mode: 'simulated',
      eventId,
      deliveryId: `sim_${Date.now().toString(36)}`,
      recipientName,
      recipientPhone,
      messagePreview: message,
      detail: 'Simulated SMS logged locally. No live carrier message was transmitted.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const webhookUrl = process.env.SMS_WEBHOOK_URL;
  const webhookToken = process.env.SMS_WEBHOOK_TOKEN;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;

  if (twilioSid && twilioToken && twilioFrom) {
    try {
      const twilioEndpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Messages.json`;
      const formBody = new URLSearchParams({
        To: sanitizedPhone,
        From: twilioFrom,
        Body: message,
      });
      const basicAuth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

      const twilioResp = await fetch(twilioEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody.toString(),
      });

      const twilioJson = (await twilioResp.json().catch(() => ({}))) as {
        sid?: string;
        message?: string;
      };

      if (!twilioResp.ok) {
        res.status(502).json({
          status: 'Failed',
          mode: 'backend',
          eventId,
          recipientName,
          recipientPhone,
          messagePreview: message,
          error: twilioJson.message || `Twilio API returned HTTP ${twilioResp.status}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        status: 'Sent',
        mode: 'backend',
        eventId,
        deliveryId: twilioJson.sid || `tw_${Date.now().toString(36)}`,
        recipientName,
        recipientPhone,
        messagePreview: message,
        detail: 'Emergency SMS dispatched via Twilio gateway.',
        timestamp: new Date().toISOString(),
      });
      return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Twilio request failed';
      res.status(502).json({
        status: 'Failed',
        mode: 'backend',
        eventId,
        recipientName,
        recipientPhone,
        messagePreview: message,
        error: `Failed to reach Twilio API: ${errMsg}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }
  }

  if (!webhookUrl) {
    res.status(503).json({
      status: 'Failed',
      mode: 'backend',
      eventId,
      recipientName,
      recipientPhone,
      messagePreview: message,
      error: 'Backend SMS gateway is not configured (set TWILIO_* or SMS_WEBHOOK_URL on server). Switch to Simulated SMS Mode for POC testing.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (webhookToken) {
      headers['Authorization'] = `Bearer ${webhookToken}`;
    }

    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: sanitizedPhone,
        recipientName,
        message,
        eventId,
      }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      res.status(502).json({
        status: 'Failed',
        mode: 'backend',
        eventId,
        recipientName,
        recipientPhone,
        messagePreview: message,
        error: `SMS gateway returned HTTP ${upstream.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      status: 'Sent',
      mode: 'backend',
      eventId,
      deliveryId: `sms_${Date.now().toString(36)}`,
      recipientName,
      recipientPhone,
      messagePreview: message,
      detail: 'Alert accepted by configured backend SMS gateway.',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown network error';
    res.status(502).json({
      status: 'Failed',
      mode: 'backend',
      eventId,
      recipientName,
      recipientPhone,
      messagePreview: message,
      error: `Failed to reach backend SMS gateway: ${errMsg}`,
      timestamp: new Date().toISOString(),
    });
  }
});

async function startServer() {
  const port = 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`DriveGuard HMI server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DriveGuard server:', err);
  process.exit(1);
});
