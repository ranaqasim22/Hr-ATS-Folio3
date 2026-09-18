import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

@Injectable()
export class GoogleAuthService implements OnModuleInit {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly auth: InstanceType<typeof google.auth.GoogleAuth>;

  constructor(private readonly configService: ConfigService) {
    const keyFile =
      this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_KEY_PATH') ||
      this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_KEY_PATH');

    if (!keyFile) {
      throw new Error(
        'Missing Service Account key path: set GOOGLE_SERVICE_ACCOUNT_KEY_PATH ' +
          '(or reuse GOOGLE_SERVICE_ACCOUNT_KEY_PATH) in .env',
      );
    }

    const impersonateEmail = this.configService.get<string>(
      'GOOGLE_CALENDAR_IMPERSONATE_EMAIL',
    );

    this.auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      // Domain-wide delegation: only takes effect if a Workspace admin has
      // authorized this Service Account's Client ID for this scope in the
      // Admin Console. Leave GOOGLE_CALENDAR_IMPERSONATE_EMAIL unset when
      // the calendar was shared directly with the Service Account's email.
      ...(impersonateEmail ? { clientOptions: { subject: impersonateEmail } } : {}),
    });

    this.logger.log(
      impersonateEmail
        ? `GoogleAuthService initialized (Service Account, impersonating ${impersonateEmail})`
        : 'GoogleAuthService initialized (Service Account, no impersonation)',
    );
  }

  onModuleInit() {
    // Nothing to trigger here on purpose — the token is pulled lazily,
    // only when a real request needs one.
  }

  /**
   * Returns a valid access token for the configured Service Account.
   * Same signature/behavior contract as the previous OAuth2 implementation,
   * so existing callers (CalendarService) don't need to change.
   */
  async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();

    if (!token) {
      throw new Error('Failed to obtain Google access token from Service Account');
    }

    return token;
  }
}